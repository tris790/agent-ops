import { join } from "node:path";
import { json, BadRequestError } from "../http.js";
import { paths } from "../config.js";
import { emit } from "../events.js";
import { detectLanguages, getServerSpec, type Lang } from "../lsp/registry.js";
import { ensureSession } from "../lsp/manager.js";

/**
 * HTTP routes for the LSP layer: detect a worktree's languages, check/install
 * servers, and prepare a session. The actual JSON-RPC traffic flows over the
 * `/lsp/...` WebSocket (handled in index.ts).
 */

/** Worktree path for an (org, repoId) — mirrors git/worktree.ts layout. */
function worktreePath(org: string, repoId: string): string {
  const sanitize = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(paths.worktrees, sanitize(org), sanitize(repoId), "checkout");
}
function worktreeId(org: string, repoId: string): string {
  const sanitize = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${sanitize(org)}/${sanitize(repoId)}`;
}

export async function handleLspRoutes(req: Request, url: URL): Promise<Response | null> {
  // GET /api/lsp/detect?org=&repositoryId=
  if (url.pathname === "/api/lsp/detect" && req.method === "GET") {
    const { org, repoId } = ids(url);
    const dir = worktreePath(org, repoId);
    const langs = await detectLanguages(dir);
    const statuses = await Promise.all(
      langs.map(async (lang) => {
        const spec = getServerSpec(lang)!;
        const installed = (await spec.resolve()) != null;
        return { lang, serverName: spec.serverName, installed };
      }),
    );
    return json({ languages: statuses, worktreeId: worktreeId(org, repoId) });
  }

  // POST /api/lsp/install?lang=  -> install a server into lsp/<lang>/
  if (url.pathname === "/api/lsp/install" && req.method === "POST") {
    const lang = (url.searchParams.get("lang") ?? "") as Lang;
    const spec = getServerSpec(lang);
    if (!spec) throw new BadRequestError(`unsupported language: ${lang}`);
    try {
      if (await spec.resolve()) return json({ ok: true });
      await spec.install((phase, message) =>
        emit({
          type: "lsp/install-progress",
          language: lang,
          phase: phase as "downloading" | "extracting" | "ready" | "error",
          message,
        }),
      );
      return json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: "lsp/install-progress", language: lang, phase: "error", message });
      return json({ ok: false, error: message }, { status: 500 });
    }
  }

  // POST /api/lsp/session?org=&repositoryId=&lang=
  // Ensures a server session is ready (or reports install-required).
  if (url.pathname === "/api/lsp/session" && req.method === "POST") {
    const { org, repoId } = ids(url);
    const lang = (url.searchParams.get("lang") ?? "") as Lang;
    const dir = worktreePath(org, repoId);
    const wid = worktreeId(org, repoId);
    const result = await ensureSession(wid, lang, dir);
    if (result.status === "install-required") {
      emit({
        type: "lsp/install-required",
        worktreeId: wid,
        language: lang,
        serverName: result.serverName ?? lang,
      });
    }
    return json(result);
  }

  return null;
}

function ids(url: URL): { org: string; repoId: string } {
  const org = url.searchParams.get("org");
  const repoId = url.searchParams.get("repositoryId");
  if (!org || !repoId) throw new BadRequestError("org, repositoryId required");
  return { org, repoId };
}
