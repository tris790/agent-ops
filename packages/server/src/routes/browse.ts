import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { json, BadRequestError } from "../http.js";
import { paths } from "../config.js";
import { listTree, readWorktreeFile, searchWorktree } from "../git/files.js";
import { ensureWorktreeAtRef } from "../git/worktree.js";
import { getRepository } from "../ado/api.js";
import { AdoClient } from "../ado/client.js";
import { tokens } from "./ado.js";
import { cached } from "../store/cache.js";

/**
 * Code browse + search routes, served from the repo's single on-disk worktree:
 * file tree, file content (incl. unmodified files for go-to-definition targets),
 * ripgrep search, and a branch-worktree ensure (for the standalone Code tab).
 *
 * The worktree is addressed by (org, repoId) only — whoever ensured it (a PR or a
 * branch) decided which ref is checked out; these routes are ref-agnostic readers.
 */

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
function worktreePath(org: string, repoId: string): string {
  return join(paths.worktrees, sanitize(org), sanitize(repoId), "checkout");
}

const metadataSourceRoot = resolve(tmpdir(), "MetadataAsSource");

function isMetadataSourcePath(path: string): boolean {
  const abs = resolve(path);
  const rel = relative(metadataSourceRoot, abs);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
}

async function readMetadataSourceFile(path: string): Promise<{ content: string | null; binary: boolean }> {
  const abs = resolve(path);
  if (!isMetadataSourcePath(abs) || !existsSync(abs)) return { content: null, binary: false };
  const info = await stat(abs);
  if (!info.isFile() || info.size > 5_000_000) return { content: null, binary: false };
  const buf = await readFile(abs);
  if (buf.includes(0)) return { content: null, binary: true };
  return { content: buf.toString("utf8"), binary: false };
}

function ids(url: URL): { org: string; repoId: string } {
  const org = url.searchParams.get("org");
  const repoId = url.searchParams.get("repositoryId");
  if (!org || !repoId) throw new BadRequestError("org, repositoryId required");
  return { org, repoId };
}

export async function handleBrowseRoutes(req: Request, url: URL): Promise<Response | null> {
  // POST /api/browse/worktree?org=&repositoryId=&ref=<branch>
  // Clones the repo (if needed) and checks out the branch into the repo worktree.
  if (url.pathname === "/api/browse/worktree" && req.method === "POST") {
    const { org, repoId } = ids(url);
    const ref = url.searchParams.get("ref");
    if (!ref) throw new BadRequestError("ref required");
    const client = AdoClient.forOrg(org, tokens);
    const repo = await cached(`repo:${org}:${repoId}`, 60 * 60_000, Date.now(), () =>
      getRepository(client, repoId),
    );
    if (!repo.remoteUrl) throw new BadRequestError("repository has no remote URL");
    const handle = await ensureWorktreeAtRef(org, repoId, repo.remoteUrl, ref);
    return json({ path: handle.path, commit: handle.commit });
  }

  if (req.method !== "GET") return null;

  // GET /api/browse/tree?org=&repositoryId=&path=/
  if (url.pathname === "/api/browse/tree") {
    const { org, repoId } = ids(url);
    const dir = url.searchParams.get("path") ?? "/";
    const nodes = await listTree(worktreePath(org, repoId), dir);
    return json({ nodes });
  }

  // GET /api/browse/file?org=&repositoryId=&path=/src/x.ts
  if (url.pathname === "/api/browse/file") {
    const { org, repoId } = ids(url);
    const path = url.searchParams.get("path");
    if (!path) throw new BadRequestError("path required");
    const file = isMetadataSourcePath(path)
      ? await readMetadataSourceFile(path)
      : await readWorktreeFile(worktreePath(org, repoId), path);
    return json({ path, ...file });
  }

  // GET /api/browse/search?org=&repositoryId=&q=&regex=&case=&word=&include=&exclude=&path=
  // `include`/`exclude`/`path` may repeat. `path` restricts to a changed-file set.
  if (url.pathname === "/api/browse/search") {
    const { org, repoId } = ids(url);
    const q = url.searchParams.get("q") ?? "";
    const hits = await searchWorktree(worktreePath(org, repoId), q, {
      regex: url.searchParams.get("regex") === "1",
      caseSensitive: url.searchParams.get("case") === "1",
      wholeWord: url.searchParams.get("word") === "1",
      includeGlobs: url.searchParams.getAll("include"),
      excludeGlobs: url.searchParams.getAll("exclude"),
      paths: url.searchParams.getAll("path"),
    });
    return json({ hits });
  }

  return null;
}
