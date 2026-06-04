import { join } from "node:path";
import { json, BadRequestError } from "../http.js";
import { paths } from "../config.js";
import { listTree, readWorktreeFile, searchWorktree } from "../git/files.js";

/**
 * Code browse + search routes, served from the on-disk PR worktree: file tree,
 * file content (incl. unmodified files for go-to-definition targets), and
 * ripgrep search scoped to the worktree.
 */

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
function worktreePath(org: string, repoId: string, prId: number): string {
  return join(paths.worktrees, sanitize(org), sanitize(repoId), `pr-${prId}`);
}

function ids(url: URL): { org: string; repoId: string; prId: number } {
  const org = url.searchParams.get("org");
  const repoId = url.searchParams.get("repositoryId");
  const prId = url.searchParams.get("pullRequestId");
  if (!org || !repoId || !prId) throw new BadRequestError("org, repositoryId, pullRequestId required");
  return { org, repoId, prId: Number(prId) };
}

export async function handleBrowseRoutes(req: Request, url: URL): Promise<Response | null> {
  if (req.method !== "GET") return null;

  // GET /api/browse/tree?org=&repositoryId=&pullRequestId=&path=/
  if (url.pathname === "/api/browse/tree") {
    const { org, repoId, prId } = ids(url);
    const dir = url.searchParams.get("path") ?? "/";
    const nodes = await listTree(worktreePath(org, repoId, prId), dir);
    return json({ nodes });
  }

  // GET /api/browse/file?org=&repositoryId=&pullRequestId=&path=/src/x.ts
  if (url.pathname === "/api/browse/file") {
    const { org, repoId, prId } = ids(url);
    const path = url.searchParams.get("path");
    if (!path) throw new BadRequestError("path required");
    const file = await readWorktreeFile(worktreePath(org, repoId, prId), path);
    return json({ path, ...file });
  }

  // GET /api/browse/search?org=&repositoryId=&pullRequestId=&q=&regex=
  if (url.pathname === "/api/browse/search") {
    const { org, repoId, prId } = ids(url);
    const q = url.searchParams.get("q") ?? "";
    const regex = url.searchParams.get("regex") === "1";
    const hits = await searchWorktree(worktreePath(org, repoId, prId), q, { regex });
    return json({ hits });
  }

  return null;
}
