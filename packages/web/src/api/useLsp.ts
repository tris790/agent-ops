import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./client.js";
import type { LspDescriptor } from "../editor/types.js";
import { languageForPath } from "../editor/language.js";

/**
 * Drives the "diff now, nav when ready" flow for a PR: ensure the worktree is
 * cloned/checked out, detect languages, and prepare an LSP session. Returns a
 * per-file `descriptorFor(path)` the editor uses to connect, plus install state
 * so the UI can prompt when a server is missing.
 *
 * Maps Monaco language ids to LSP server langs (the server registry's `lang`).
 */

interface LangStatus {
  lang: string;
  serverName: string;
  installed: boolean;
}

export type NavState = "idle" | "preparing" | "ready" | "install-required" | "error";

/** Monaco language id -> server registry lang. */
function serverLangFor(monacoLang: string): string | null {
  if (["typescript", "typescriptreact", "javascript", "javascriptreact"].includes(monacoLang))
    return "typescript";
  if (monacoLang === "go") return "go";
  if (monacoLang === "rust") return "rust";
  if (monacoLang === "c" || monacoLang === "cpp") return "cpp";
  if (monacoLang === "csharp") return "csharp";
  if (monacoLang === "python") return "python";
  if (monacoLang === "java") return "java";
  if (monacoLang === "ruby") return "ruby";
  if (monacoLang === "php") return "php";
  if (monacoLang === "shell") return "bash";
  if (monacoLang === "yaml") return "yaml";
  if (monacoLang === "json") return "json";
  if (monacoLang === "html") return "html";
  if (monacoLang === "css" || monacoLang === "scss" || monacoLang === "less") return "css";
  if (monacoLang === "dockerfile") return "dockerfile";
  return null;
}

export function useLsp(org: string, repositoryId: string, pullRequestId: number) {
  const [navState, setNavState] = useState<NavState>("idle");
  const [worktreeId, setWorktreeId] = useState<string | null>(null);
  const [langs, setLangs] = useState<LangStatus[]>([]);
  const [rootUri, setRootUri] = useState<string | null>(null);
  const startedSessions = useRef(new Set<string>());

  // Kick off worktree clone + language detection once.
  useEffect(() => {
    let cancelled = false;
    setNavState("preparing");
    // Reset per-PR session memory so a new worktree's servers are started fresh.
    startedSessions.current = new Set();
    (async () => {
      try {
        const wt = await api.ensureWorktree(org, repositoryId, pullRequestId);
        if (cancelled) return;
        setRootUri(`file://${wt.path}`);
        const detected = await api.lspDetect(org, repositoryId, pullRequestId);
        if (cancelled) return;
        setWorktreeId(detected.worktreeId);
        setLangs(detected.languages);
        setNavState(detected.languages.some((l) => !l.installed) ? "install-required" : "ready");
      } catch {
        if (!cancelled) setNavState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [org, repositoryId, pullRequestId]);

  const install = useCallback(
    async (lang: string) => {
      setNavState("preparing");
      try {
        await api.lspInstall(lang);
        const detected = await api.lspDetect(org, repositoryId, pullRequestId);
        setLangs(detected.languages);
        setNavState(detected.languages.some((l) => !l.installed) ? "install-required" : "ready");
      } catch {
        setNavState("error");
      }
    },
    [org, repositoryId, pullRequestId],
  );

  /**
   * Returns the LSP descriptor for a file path if its language server is installed,
   * lazily starting the server session on first use. Null when nav isn't available.
   */
  const descriptorFor = useCallback(
    async (path: string): Promise<LspDescriptor | null> => {
      if (!worktreeId || !rootUri) return null;
      const monacoLang = languageForPath(path);
      const serverLang = serverLangFor(monacoLang);
      if (!serverLang) return null;
      const status = langs.find((l) => l.lang === serverLang);
      if (!status?.installed) return null;

      if (!startedSessions.current.has(serverLang)) {
        const res = await api.lspSession(org, repositoryId, pullRequestId, serverLang);
        if (res.status !== "ready") return null;
        startedSessions.current.add(serverLang);
      }
      return {
        url: `${worktreeId}::${serverLang}`,
        language: monacoLang,
        rootUri,
      };
    },
    [worktreeId, rootUri, langs, org, repositoryId, pullRequestId],
  );

  const missing = langs.filter((l) => !l.installed);

  // `rootUri` is exposed so editors can build a stable worktree-absolute model URI
  // immediately — before the (async) descriptor resolves — avoiding a model-URI
  // change that would force the diff editor to dispose+recreate mid-navigation.
  return { navState, missing, install, descriptorFor, rootUri };
}
