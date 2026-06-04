import type * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import type { LspDescriptor } from "../types.js";

/**
 * Thin LSP client: speaks JSON-RPC over the backend WebSocket bridge and exposes
 * results through Monaco providers (hover, definition, references, diagnostics).
 * Deliberately avoids monaco-languageclient / @codingame/monaco-vscode-api, which
 * replace the monaco-editor engine and would disturb our diff editor. We only need
 * read-only intelligence, which maps 1:1 onto register*Provider + setModelMarkers.
 *
 * Providers are registered ONCE per language (globally) and dispatch to the active
 * connection for the document's URI — so creating/disposing connections per file
 * never leaks stale providers. LSP positions are 0-based; Monaco's are 1-based.
 */

interface LspConnection {
  rootUri: string;
  language: string;
  request(method: string, params: unknown): Promise<unknown>;
}

// One connection per session key (worktreeId::lang); shared across files of a repo.
const connections = new Map<string, Connection>();
// Languages whose Monaco providers have been registered (once each).
const registeredLangs = new Set<string>();
let monacoRef: typeof monaco | null = null;

/** Looks up the connection that owns a given model URI (by rootUri prefix + language). */
function connectionForModel(uri: string, language: string): Connection | null {
  for (const conn of connections.values()) {
    if (conn.language === language && uri.startsWith(conn.rootUri)) return conn;
  }
  return null;
}

/** Registers global Monaco providers for a language (idempotent). */
function ensureProviders(m: typeof monaco, language: string): void {
  monacoRef = m;
  if (registeredLangs.has(language)) return;
  registeredLangs.add(language);

  const toLspPos = (p: monaco.IPosition) => ({ line: p.lineNumber - 1, character: p.column - 1 });
  const toLocations = (result: unknown): monaco.languages.Location[] | null => {
    if (!result) return null;
    const arr = (Array.isArray(result) ? result : [result]) as Array<LspLocation & LspLocationLink>;
    return arr
      .map((loc) => {
        const uri = loc.uri ?? loc.targetUri;
        const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange;
        if (!uri || !range) return null;
        return {
          uri: m.Uri.parse(uri),
          range: {
            startLineNumber: range.start.line + 1,
            startColumn: range.start.character + 1,
            endLineNumber: range.end.line + 1,
            endColumn: range.end.character + 1,
          },
        };
      })
      .filter((x): x is monaco.languages.Location => x != null);
  };
  const requestLocations = async (
    method: string,
    model: monaco.editor.ITextModel,
    position: monaco.IPosition,
  ) => {
    const conn = connectionForModel(model.uri.toString(), language);
    if (!conn) return null;
    await conn.ensureOpen(model);
    const result = await conn
      .request(method, {
        textDocument: { uri: model.uri.toString() },
        position: toLspPos(position),
      })
      .catch(() => null);
    return toLocations(result) ?? undefined;
  };

  m.languages.registerHoverProvider(language, {
    provideHover: async (model, position) => {
      const conn = connectionForModel(model.uri.toString(), language);
      if (!conn) return null;
      await conn.ensureOpen(model);
      const result = (await conn
        .request("textDocument/hover", {
          textDocument: { uri: model.uri.toString() },
          position: toLspPos(position),
        })
        .catch(() => null)) as HoverResult | null;
      if (!result?.contents) return null;
      const value =
        typeof result.contents === "string"
          ? result.contents
          : Array.isArray(result.contents)
            ? result.contents.map((c) => (typeof c === "string" ? c : c.value)).join("\n\n")
            : result.contents.value;
      return { contents: [{ value }] };
    },
  });

  m.languages.registerDefinitionProvider(language, {
    provideDefinition: async (model, position) => {
      return requestLocations("textDocument/definition", model, position);
    },
  });

  m.languages.registerTypeDefinitionProvider(language, {
    provideTypeDefinition: async (model, position) => {
      return requestLocations("textDocument/typeDefinition", model, position);
    },
  });

  m.languages.registerImplementationProvider(language, {
    provideImplementation: async (model, position) => {
      return requestLocations("textDocument/implementation", model, position);
    },
  });

  m.languages.registerReferenceProvider(language, {
    provideReferences: async (model, position, context) => {
      const conn = connectionForModel(model.uri.toString(), language);
      if (!conn) return [];
      await conn.ensureOpen(model);
      const result = await conn
        .request("textDocument/references", {
          textDocument: { uri: model.uri.toString() },
          position: toLspPos(position),
          context: { includeDeclaration: context.includeDeclaration },
        })
        .catch(() => null);
      return toLocations(result) ?? [];
    },
  });
}

/** A live JSON-RPC connection to one language server session. */
class Connection {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: unknown) => void; timer: number }>();
  private openDocs = new Map<string, Promise<void>>();
  private readonly workspaceFolders: Array<{ uri: string; name: string }>;
  ready: Promise<void>;
  /** Resolves when the server's project model is loaded enough to answer queries.
   *  Most servers: immediately after `initialized`. Roslyn (C#): only after
   *  `workspace/projectInitializationComplete`. */
  projectReady: Promise<void>;
  private markProjectReady!: () => void;

  constructor(
    private readonly m: typeof monaco,
    readonly key: string,
    readonly rootUri: string,
    readonly language: string,
  ) {
    this.projectReady = new Promise((res) => (this.markProjectReady = res));
    this.workspaceFolders = [{ uri: rootUri, name: "workspace" }];
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(`${proto}//${location.host}/lsp?key=${encodeURIComponent(key)}`);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("error", () => reject(new Error("LSP socket error")));
      this.ws.addEventListener("close", () => this.failAllPending());
      this.ws.addEventListener("message", (ev) => this.onMessage(ev));
      this.ws.addEventListener("open", async () => {
        await this.request("initialize", {
          processId: null,
          clientInfo: { name: "agent-ops", version: "0.1.0" },
          rootUri,
          workspaceFolders: this.workspaceFolders,
          capabilities: {
            workspace: {
              workspaceFolders: true,
              configuration: true,
            },
            textDocument: {
              hover: { contentFormat: ["markdown", "plaintext"] },
              definition: { linkSupport: true },
              typeDefinition: { linkSupport: true },
              implementation: { linkSupport: true },
              references: {},
              publishDiagnostics: {},
            },
          },
        });
        this.notify("initialized", {});
        // C# (Roslyn) only answers queries after projectInitializationComplete;
        // the backend sends solution/open|project/open on our `initialized`. For
        // every other server the project is usable right away.
        if (this.language !== "csharp") this.markProjectReady();
        resolve();
      });
    });
  }

  private onMessage(ev: MessageEvent): void {
    let msg: {
      id?: number | string;
      result?: unknown;
      error?: unknown;
      method?: string;
      params?: unknown;
    };
    try {
      msg = JSON.parse(ev.data as string);
    } catch {
      return;
    }

    // Response to one of our requests (has id, no method). Resolve with result;
    // an error response resolves to null so providers fall back cleanly.
    if (msg.method == null && msg.id != null && typeof msg.id === "number") {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        window.clearTimeout(pending.timer);
        pending.resolve(msg.error ? null : msg.result);
      }
      return;
    }

    // Server-initiated request (has method AND id) — must be answered or the
    // server (e.g. Roslyn/clangd registering capabilities) blocks.
    if (msg.method != null && msg.id != null) {
      this.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: this.serverRequestResult(msg.method, msg.params),
        }),
      );
      return;
    }

    // Server notifications.
    if (msg.method === "textDocument/publishDiagnostics") {
      this.onDiagnostics(msg.params as PublishDiagnosticsParams);
    } else if (msg.method === "workspace/projectInitializationComplete") {
      this.markProjectReady();
    }
  }

  /** Rejects/clears all in-flight requests (called when the socket closes). */
  private failAllPending(): void {
    for (const { resolve, timer } of this.pending.values()) {
      window.clearTimeout(timer);
      resolve(null);
    }
    this.pending.clear();
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, 15_000);
      this.pending.set(id, { resolve, timer });
    });
  }

  notify(method: string, params: unknown): void {
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private serverRequestResult(method: string, params: unknown): unknown {
    if (method === "workspace/workspaceFolders") return this.workspaceFolders;
    if (method === "workspace/configuration") {
      const items = Array.isArray((params as { items?: unknown[] } | null)?.items)
        ? (params as { items: unknown[] }).items
        : [];
      return items.map(() => null);
    }
    return null;
  }

  /**
   * Opens a model's document on the server, returning a shared promise so
   * concurrent callers (e.g. attach + the first hover) await the same didOpen +
   * project-load settle rather than racing past it.
   */
  ensureOpen(model: monaco.editor.ITextModel): Promise<void> {
    const uri = model.uri.toString();
    const existing = this.openDocs.get(uri);
    if (existing) return existing;
    const p = (async () => {
      await this.ready;
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: this.language, version: 1, text: model.getValue() },
      });
      // Wait for the project model to load before the first query. For Roslyn this
      // gates on projectInitializationComplete (can take a while on big solutions);
      // we cap the wait so a stuck load doesn't hang features forever.
      await Promise.race([
        this.projectReady,
        new Promise((r) => setTimeout(r, this.language === "csharp" ? 120_000 : 1_500)),
      ]);
    })();
    // Don't cache a poisoned promise: if open fails, allow a later retry.
    this.openDocs.set(
      uri,
      p.catch((err) => {
        this.openDocs.delete(uri);
        throw err;
      }),
    );
    return this.openDocs.get(uri)!;
  }

  private onDiagnostics(params: PublishDiagnosticsParams): void {
    const model = this.m.editor.getModel(this.m.Uri.parse(params.uri));
    if (!model) return;
    const sev = (s?: number) => {
      const M = this.m.MarkerSeverity;
      return s === 1 ? M.Error : s === 2 ? M.Warning : s === 3 ? M.Info : M.Hint;
    };
    this.m.editor.setModelMarkers(
      model,
      "lsp",
      params.diagnostics.map((d) => ({
        severity: sev(d.severity),
        message: d.message,
        startLineNumber: d.range.start.line + 1,
        startColumn: d.range.start.character + 1,
        endLineNumber: d.range.end.line + 1,
        endColumn: d.range.end.character + 1,
      })),
    );
  }

  dispose(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Ensures a connection + providers exist for a descriptor, opens the given model,
 * and returns a disposer that releases this caller's hold. Connections are shared
 * by session key and ref-counted so multiple open files reuse one socket.
 */
const refCounts = new Map<string, number>();

export async function attachLsp(
  m: typeof monaco,
  desc: LspDescriptor,
  model: monaco.editor.ITextModel,
): Promise<() => void> {
  ensureProviders(m, desc.language);

  let conn = connections.get(desc.url);
  if (!conn) {
    conn = new Connection(m, desc.url, desc.rootUri, desc.language);
    connections.set(desc.url, conn);
  }
  refCounts.set(desc.url, (refCounts.get(desc.url) ?? 0) + 1);

  await conn.ensureOpen(model);

  return () => {
    const n = (refCounts.get(desc.url) ?? 1) - 1;
    if (n <= 0) {
      refCounts.delete(desc.url);
      // Keep the browser-side LSP connection warm for the page lifetime. Some
      // servers, notably Roslyn, crash if a kept-alive backend process receives
      // a second initialize after an editor unmount/remount cycle.
    } else {
      refCounts.set(desc.url, n);
    }
  };
}

// ---- LSP wire types (minimal) ----
interface LspPosition {
  line: number;
  character: number;
}
interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
interface LspLocation {
  uri?: string;
  range?: LspRange;
}
interface LspLocationLink {
  targetUri?: string;
  targetRange?: LspRange;
  targetSelectionRange?: LspRange;
}
interface HoverResult {
  contents: string | { value: string } | Array<string | { value: string }>;
}
interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: Array<{ range: LspRange; message: string; severity?: number }>;
}
