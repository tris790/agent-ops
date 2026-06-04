import type { Subprocess } from "bun";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { getServerSpec, type Lang, type ServerLaunch } from "./registry.js";
import { config } from "../config.js";

/**
 * Spawns and pools language servers, one per (worktree, lang). Each server is a
 * child process speaking LSP over stdio; the WebSocket bridge pipes raw JSON-RPC
 * frames (LSP base protocol: `Content-Length` headers + JSON body) between the
 * browser and the child. Idle servers are reaped after `lspIdleReapMs`.
 */

export interface LspSession {
  key: string;
  lang: Lang;
  rootDir: string;
  proc: Subprocess<"pipe", "pipe", "pipe">;
  /** Subscribers receive parsed LSP messages coming FROM the server. */
  listeners: Set<(msg: unknown) => void>;
  lastActivity: number;
  /** Pending partial stdout buffer for frame reassembly. */
  buffer: Buffer;
  expectedLength: number | null;
  /** True once the client's `initialized` has triggered the server-specific load. */
  bootstrapped: boolean;
  /**
   * Whether the server's project/solution model is loaded enough to answer
   * queries. For most servers this is true immediately; for Roslyn it flips true
   * only after `workspace/projectInitializationComplete`.
   */
  projectReady: boolean;
}

const sessions = new Map<string, LspSession>();

export interface StartResult {
  status: "ready" | "install-required";
  serverName?: string;
}

const sessionKey = (worktreeId: string, lang: Lang) => `${worktreeId}::${lang}`;

/**
 * Ensures a server session exists for (worktreeId, lang) rooted at rootDir.
 * Returns install-required (without starting) when the server isn't installed.
 */
export async function ensureSession(
  worktreeId: string,
  lang: Lang,
  rootDir: string,
): Promise<StartResult> {
  const key = sessionKey(worktreeId, lang);
  const existing = sessions.get(key);
  if (existing) {
    // LSP servers are initialized once per process. If the browser connection
    // went away, a later browser would send initialize again; Roslyn treats that
    // as fatal. Replace stale disconnected sessions before reuse.
    if (existing.listeners.size > 0) return { status: "ready" };
    stopSession(key);
  }

  const spec = getServerSpec(lang);
  if (!spec) throw new Error(`unsupported language: ${lang}`);

  const launch = await spec.resolve();
  if (!launch) return { status: "install-required", serverName: spec.serverName };

  spawnSession(key, lang, launch, rootDir);
  return { status: "ready" };
}

function spawnSession(key: string, lang: Lang, launch: ServerLaunch, rootDir: string): LspSession {
  const proc = Bun.spawn([launch.command, ...launch.args], {
    cwd: rootDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(launch.env ?? {}) },
  });

  const session: LspSession = {
    key,
    lang,
    rootDir,
    proc,
    listeners: new Set(),
    lastActivity: Date.now(),
    buffer: Buffer.alloc(0),
    expectedLength: null,
    bootstrapped: false,
    // Roslyn must wait for projectInitializationComplete; others are ready at once.
    projectReady: lang !== "csharp",
  };
  sessions.set(key, session);

  // Read server stdout, reassemble LSP frames, dispatch parsed messages.
  void pumpStdout(session);
  // Drain stderr (don't dispatch it): chatty servers like rust-analyzer/gopls
  // fill the OS pipe buffer and deadlock the child if stderr is never read.
  void drainStderr(session);
  void proc.exited.then((code) => {
    console.warn(`[agent-ops] LSP session exited: ${key} (${lang}) code=${code}`);
    if (sessions.get(key) === session) sessions.delete(key);
  });

  return session;
}

/** Drains the child's stderr so a full pipe buffer can't wedge it, and logs failures. */
async function drainStderr(session: LspSession): Promise<void> {
  const reader = session.proc.stderr.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) console.warn(`[agent-ops] LSP stderr ${session.key}: ${line}`);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) console.warn(`[agent-ops] LSP stderr ${session.key}: ${pending.trim()}`);
  } catch {
    /* stream closed */
  }
}

/** Reads stdout, splitting the `Content-Length` framed stream into JSON messages. */
async function pumpStdout(session: LspSession): Promise<void> {
  const reader = session.proc.stdout.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    session.buffer = Buffer.concat([session.buffer, Buffer.from(value)]);
    drainFrames(session);
  }
}

/** Extracts as many complete LSP frames as are buffered, dispatching each. */
function drainFrames(session: LspSession): void {
  for (;;) {
    if (session.expectedLength == null) {
      const headerEnd = session.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = session.buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // malformed; drop through the header to resync
        session.buffer = session.buffer.subarray(headerEnd + 4);
        continue;
      }
      session.expectedLength = Number(match[1]);
      session.buffer = session.buffer.subarray(headerEnd + 4);
    }
    if (session.buffer.length < session.expectedLength) return;
    const body = session.buffer.subarray(0, session.expectedLength).toString("utf8");
    session.buffer = session.buffer.subarray(session.expectedLength);
    session.expectedLength = null;
    try {
      const msg = JSON.parse(body);
      if (isMethod(msg, "workspace/projectInitializationComplete")) {
        session.projectReady = true;
      }
      // Surface Roslyn load failures (e.g. legacy projects needing Mono) to the log.
      const mm = msg as { method?: string; params?: { message?: string } };
      if (mm.method === "window/_roslyn_showToast" && mm.params?.message) {
        console.warn(`[agent-ops] roslyn ${session.key}: ${mm.params.message}`);
      }
      for (const fn of session.listeners) fn(msg);
    } catch {
      /* ignore unparseable frame */
    }
  }
}

/** Sends an LSP message TO the server (adds the Content-Length framing). */
export function sendToServer(key: string, msg: unknown): void {
  const session = sessions.get(key);
  if (!session) return;
  session.lastActivity = Date.now();
  writeFrame(session, msg);

  // After the client's `initialized` notification, run any server-specific
  // bootstrap (Roslyn needs an explicit solution/project load — see below).
  if (
    !session.bootstrapped &&
    isMethod(msg, "initialized")
  ) {
    session.bootstrapped = true;
    void bootstrapSession(session);
  }
}

/** Writes a raw LSP frame to the server's stdin. */
function writeFrame(session: LspSession, msg: unknown): void {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  session.proc.stdin.write(Buffer.concat([header, body]));
  session.proc.stdin.flush?.();
}

function isMethod(msg: unknown, method: string): boolean {
  return typeof msg === "object" && msg !== null && (msg as { method?: string }).method === method;
}

/**
 * Server-specific post-`initialized` bootstrap. The Roslyn C# server
 * (Microsoft.CodeAnalysis.LanguageServer) does NOT resolve definitions/references
 * from `didOpen` alone — it requires an explicit `solution/open` (when a .sln
 * exists) or `project/open` (all .csproj) notification, after which it emits
 * `workspace/projectInitializationComplete`. We send that here, server-side, so
 * the thin browser client stays generic.
 */
async function bootstrapSession(session: LspSession): Promise<void> {
  if (session.lang !== "csharp") return;
  const { sln, sdkProjects, legacyProjects } = await findDotnetProjects(session.rootDir);
  const toUri = (p: string) => `file://${p}`;

  // Legacy (non-SDK-style, .NET Framework) projects need Mono's MSBuild on Linux;
  // the dotnet SDK alone can't load them. Opening a solution that contains such a
  // project makes Roslyn fail the whole load (and starves even the loadable ones).
  // Strategy: if Mono is present, open the solution (everything loads). Otherwise
  // open only the SDK-style projects directly, which the dotnet SDK can build.
  const monoOk = await hasMono();
  if (legacyProjects.length > 0 && !monoOk) {
    console.warn(
      `[agent-ops] roslyn ${session.key}: ${legacyProjects.length} legacy .NET Framework project(s) skipped (need Mono); loading ${sdkProjects.length} SDK-style project(s)`,
    );
  }

  if (sln && (monoOk || legacyProjects.length === 0)) {
    writeFrame(session, { jsonrpc: "2.0", method: "solution/open", params: { solution: toUri(sln) } });
    return;
  }

  // No usable solution path — open the SDK-style projects directly. (If Mono is
  // missing and everything is legacy, there's nothing we can load without Mono.)
  const openable = monoOk ? [...sdkProjects, ...legacyProjects] : sdkProjects;
  if (openable.length > 0) {
    writeFrame(session, {
      jsonrpc: "2.0",
      method: "project/open",
      params: { projects: openable.map(toUri) },
    });
  } else {
    console.warn(
      `[agent-ops] roslyn ${session.key}: no loadable projects (legacy .NET Framework needs Mono)`,
    );
  }
}

let monoChecked: boolean | null = null;
async function hasMono(): Promise<boolean> {
  if (monoChecked != null) return monoChecked;
  try {
    const proc = Bun.spawn(["which", "mono"], { stdout: "pipe", stderr: "ignore" });
    monoChecked = (await proc.exited) === 0;
  } catch {
    monoChecked = false;
  }
  return monoChecked;
}

interface DotnetProjects {
  sln: string | null;
  sdkProjects: string[];
  legacyProjects: string[];
}

/**
 * Finds the .sln and classifies .csproj files as SDK-style (`<Project Sdk=...>`,
 * loadable by the dotnet SDK) vs legacy (old MSBuild xmlns, needs Mono).
 */
async function findDotnetProjects(root: string): Promise<DotnetProjects> {
  let sln: string | null = null;
  const sdkProjects: string[] = [];
  const legacyProjects: string[] = [];
  const skip = new Set([".git", "node_modules", "bin", "obj", ".vs"]);

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) await walk(full, depth + 1);
      } else if (e.name.endsWith(".sln") && !sln) {
        sln = full;
      } else if (e.name.endsWith(".csproj")) {
        const head = await readProjectHead(full);
        if (/<Project\s+Sdk=/i.test(head)) sdkProjects.push(full);
        else legacyProjects.push(full);
      }
    }
  }
  await walk(root, 0);
  return { sln, sdkProjects, legacyProjects };
}

/** Reads the first chunk of a .csproj to detect SDK-style vs legacy. */
async function readProjectHead(path: string): Promise<string> {
  try {
    return (await Bun.file(path).text()).slice(0, 400);
  } catch {
    return "";
  }
}

/** Subscribes to messages from the server; returns an unsubscribe fn. */
export function subscribe(key: string, fn: (msg: unknown) => void): () => void {
  const session = sessions.get(key);
  if (!session) return () => {};
  session.listeners.add(fn);
  session.lastActivity = Date.now();
  return () => {
    session.listeners.delete(fn);
    // Refresh activity on disconnect so a tab close / network blip starts the
    // idle countdown fresh, rather than reaping a still-warm server immediately.
    session.lastActivity = Date.now();
  };
}

export function getSessionKey(worktreeId: string, lang: Lang): string {
  return sessionKey(worktreeId, lang);
}

/** Worktree ids that currently have a live language-server session. */
export function activeWorktreeIds(): Set<string> {
  const ids = new Set<string>();
  for (const key of sessions.keys()) {
    const wid = key.split("::")[0];
    if (wid) ids.add(wid);
  }
  return ids;
}

export function hasSession(key: string): boolean {
  return sessions.has(key);
}

/** Stops a session (used on shutdown/eviction). */
export function stopSession(key: string): void {
  const s = sessions.get(key);
  if (!s) return;
  try {
    s.proc.kill();
  } catch {
    /* already dead */
  }
  sessions.delete(key);
}

// Idle reaper: kill servers with no recent activity to bound memory.
setInterval(() => {
  const now = Date.now();
  for (const [key, s] of sessions) {
    if (s.listeners.size === 0 && now - s.lastActivity > config.lspIdleReapMs) {
      stopSession(key);
    }
  }
}, 60_000).unref?.();
