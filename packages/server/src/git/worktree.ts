import { join } from "node:path";
import { readdir, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { simpleGit, type SimpleGit } from "simple-git";
import { paths, config } from "../config.js";
import { emit } from "../events.js";
import { getOrgRow } from "../store/orgs.js";
import { patBasicHeader } from "../ado/token-provider.js";
import { cacheGet, cacheSet } from "../store/cache.js";
import { activeWorktreeIds } from "../lsp/manager.js";

/**
 * Git worktree manager — clones repos and checks out PR commits on disk so the
 * LSP layer (step 7) can run real language servers against them.
 *
 * Layout (all under the gitignored `worktrees/`):
 *   worktrees/<org>/<repoId>/.cache/   partial clone (--filter=blob:none, --no-checkout),
 *                                      owns the shared object store
 *   worktrees/<org>/<repoId>/pr-<id>/  linked worktree checked out at the PR's source commit
 *
 * Auth: the PAT is injected per-command via `-c http.extraHeader=...` so it never
 * lands in a remote URL, .git/config, or the reflog.
 */

export interface WorktreeHandle {
  path: string;
}

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
const repoDir = (org: string, repoId: string) =>
  join(paths.worktrees, sanitize(org), sanitize(repoId));
const cacheDir = (org: string, repoId: string) => join(repoDir(org, repoId), ".cache");
const prWorktreePath = (org: string, repoId: string, prId: number) =>
  join(repoDir(org, repoId), `pr-${prId}`);
const worktreeId = (org: string, repoId: string, prId: number) =>
  `${sanitize(org)}/${sanitize(repoId)}/pr-${prId}`;

/** http.extraHeader config carrying the org's PAT; read fresh so re-entered tokens apply. */
function authConfig(org: string): string[] {
  const pat = getOrgRow(org)?.pat;
  if (!pat) throw new Error(`no PAT for org ${org}`);
  return [`http.extraHeader=Authorization: ${patBasicHeader(pat)}`];
}

function git(baseDir: string, org: string): SimpleGit {
  return simpleGit({ baseDir, config: authConfig(org), trimmed: true });
}

function progress(
  id: string,
  phase: "cloning" | "fetching" | "checkingOut" | "ready" | "error",
  message?: string,
  p?: number,
): void {
  emit({ type: "git/progress", worktreeId: id, phase, message, progress: p });
}

// ---- access-time tracking (LRU + future LSP idle reaping) ----

const ACCESS_PREFIX = "wt:access:";
const accessMem = new Map<string, number>();

export function touchWorktree(id: string): void {
  const now = Date.now();
  accessMem.set(id, now);
  cacheSet(`${ACCESS_PREFIX}${id}`, now, now);
}

export function lastAccess(id: string): number | undefined {
  return accessMem.get(id) ?? cacheGet<number>(`${ACCESS_PREFIX}${id}`, Date.now()) ?? undefined;
}

// ---- concurrency: per-worktree dedupe + per-repo serialization ----

const inFlight = new Map<string, Promise<WorktreeHandle>>();
const repoLocks = new Map<string, Promise<unknown>>();

function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  repoLocks.set(
    key,
    next.catch(() => {}),
  );
  return next;
}

// ---- main entry point ----

/**
 * Ensure a worktree for (org, repoId, prId) exists at commitSha; returns its path.
 * Idempotent and concurrency-safe. Emits git/progress through the phases.
 */
export function ensureWorktree(
  org: string,
  repoId: string,
  remoteUrl: string,
  prId: number,
  commitSha: string,
): Promise<WorktreeHandle> {
  const id = worktreeId(org, repoId, prId);
  const existing = inFlight.get(id);
  if (existing) return existing;

  // Mark in-flight up front (and immediately) so eviction never deletes this
  // worktree while we're checking/building it — the IIFE below starts running
  // synchronously, but registering after it would leave the fast-path rev-parse
  // unprotected. Touch first so it sorts as most-recently-used.
  touchWorktree(id);

  const run = async (): Promise<WorktreeHandle> => {
    const wtPath = prWorktreePath(org, repoId, prId);

    // Fast path: already checked out at the right commit (no lock, no network).
    if ((await worktreeHeadSha(wtPath)) === commitSha) {
      touchWorktree(id);
      progress(id, "ready");
      return { path: wtPath };
    }

    return withRepoLock(`${org}/${repoId}`, async () => {
      // Re-check after acquiring the lock (another caller may have finished it).
      if ((await worktreeHeadSha(wtPath)) === commitSha) {
        touchWorktree(id);
        progress(id, "ready");
        return { path: wtPath };
      }
      try {
        await ensureCacheClone(org, repoId, remoteUrl, id);
        await ensureCommitFetched(org, repoId, prId, commitSha, id);
        await addOrMoveWorktree(org, repoId, prId, commitSha, id);
        progress(id, "ready");
        touchWorktree(id);
        void evictToCapacity().catch(() => {});
        return { path: wtPath };
      } catch (err) {
        progress(id, "error", err instanceof Error ? err.message : String(err));
        throw err;
      }
    });
  };

  const work = run();
  inFlight.set(id, work);
  void work.finally(() => inFlight.delete(id));
  return work;
}

async function ensureCacheClone(
  org: string,
  repoId: string,
  remoteUrl: string,
  id: string,
): Promise<void> {
  const cache = cacheDir(org, repoId);
  // A non-bare clone keeps HEAD under .git/. Presence of .git/HEAD => already cloned.
  if (existsSync(join(cache, ".git", "HEAD"))) return;
  progress(id, "cloning");
  // Partial clone (blobs lazily fetched), no working tree in the cache itself.
  await git(paths.worktrees, org).clone(remoteUrl, cache, [
    "--filter=blob:none",
    "--no-checkout",
  ]);
}

async function ensureCommitFetched(
  org: string,
  repoId: string,
  prId: number,
  sha: string,
  id: string,
): Promise<void> {
  const cache = cacheDir(org, repoId);
  const g = git(cache, org);
  if (await hasCommit(g, sha)) return;

  progress(id, "fetching");
  // Primary: fetch the exact commit by SHA (ADO allows any-SHA wants).
  try {
    await g.raw(["fetch", "--filter=blob:none", "--no-tags", "origin", sha]);
  } catch {
    // Fallback: fetch the PR head ref, whose history contains the source commit.
    await g.raw([
      "fetch",
      "--filter=blob:none",
      "--no-tags",
      "origin",
      `+refs/pull/${prId}/head:refs/remotes/origin/pr/${prId}/head`,
    ]);
  }
  if (!(await hasCommit(g, sha))) {
    throw new Error(`commit ${sha.slice(0, 8)} not found after fetch`);
  }
}

async function addOrMoveWorktree(
  org: string,
  repoId: string,
  prId: number,
  sha: string,
  id: string,
): Promise<void> {
  const cache = cacheDir(org, repoId);
  const wtPath = prWorktreePath(org, repoId, prId);
  const g = git(cache, org);
  progress(id, "checkingOut");

  if (existsSync(join(wtPath, ".git"))) {
    // Worktree exists — move it to the target commit.
    await git(wtPath, org).raw(["checkout", "--detach", "--force", sha]);
    return;
  }
  // Orphaned dir (on disk but not registered) — prune then re-add.
  if (existsSync(wtPath)) {
    await rm(wtPath, { recursive: true, force: true });
    await g.raw(["worktree", "prune"]);
  }
  await g.raw(["worktree", "add", "--detach", wtPath, sha]);
}

// ---- helpers ----

async function hasCommit(g: SimpleGit, sha: string): Promise<boolean> {
  try {
    await g.raw(["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function worktreeHeadSha(wtPath: string): Promise<string | null> {
  if (!existsSync(join(wtPath, ".git"))) return null;
  try {
    return (await simpleGit({ baseDir: wtPath, trimmed: true }).raw(["rev-parse", "HEAD"])).trim();
  } catch {
    return null;
  }
}

// ---- removal + LRU eviction ----

export async function removeWorktree(org: string, repoId: string, prId: number): Promise<void> {
  const cache = cacheDir(org, repoId);
  const wtPath = prWorktreePath(org, repoId, prId);
  const id = worktreeId(org, repoId, prId);
  if (existsSync(cache)) {
    await git(cache, org)
      .raw(["worktree", "remove", "--force", wtPath])
      .catch(() => {});
    await git(cache, org)
      .raw(["worktree", "prune"])
      .catch(() => {});
  }
  await rm(wtPath, { recursive: true, force: true }).catch(() => {});
  accessMem.delete(id);
  cacheSet(`${ACCESS_PREFIX}${id}`, 0, 0);
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let ents;
  try {
    ents = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  await Promise.all(
    ents.map(async (e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) total += await dirSize(p);
      else if (e.isFile()) total += (await stat(p).catch(() => ({ size: 0 }))).size;
    }),
  );
  return total;
}

export function diskUsageBytes(): Promise<number> {
  return dirSize(paths.worktrees);
}

/** Worktrees touched within this window are spared from eviction (likely live). */
const EVICTION_GRACE_MS = 5 * 60_000;

let evicting = false;

/** Evicts least-recently-used PR worktrees (never the shared .cache) until under the cap. */
export async function evictToCapacity(capBytes = config.worktreeDiskCapBytes): Promise<string[]> {
  if (evicting) return [];
  evicting = true;
  try {
    let usage = await diskUsageBytes();
    if (usage <= capBytes) return [];

    const victims = await listWorktrees();
    // Oldest first; unknown access time sorts oldest (orphans evicted first).
    victims.sort((a, b) => (lastAccess(a.id) ?? 0) - (lastAccess(b.id) ?? 0));

    // Never evict worktrees that are loading, have a live LSP session, or were
    // touched within the grace window (likely being served/read right now).
    const active = activeWorktreeIds();
    const now = Date.now();

    const evicted: string[] = [];
    for (const v of victims) {
      if (usage <= capBytes) break;
      if (inFlight.has(v.id)) continue;
      if (active.has(v.id)) continue;
      if (now - (lastAccess(v.id) ?? 0) < EVICTION_GRACE_MS) continue;
      const size = await dirSize(v.path);
      await removeWorktree(v.org, v.repoId, v.prId);
      usage -= size;
      evicted.push(v.id);
    }
    return evicted;
  } finally {
    evicting = false;
  }
}

interface WorktreeRef {
  id: string;
  path: string;
  org: string;
  repoId: string;
  prId: number;
}

/** Scans the worktrees dir for pr-<id> directories across all orgs/repos. */
async function listWorktrees(): Promise<WorktreeRef[]> {
  const out: WorktreeRef[] = [];
  const orgs = await readdir(paths.worktrees, { withFileTypes: true }).catch(() => []);
  for (const o of orgs) {
    if (!o.isDirectory()) continue;
    const repos = await readdir(join(paths.worktrees, o.name), { withFileTypes: true }).catch(
      () => [],
    );
    for (const r of repos) {
      if (!r.isDirectory()) continue;
      const prDir = join(paths.worktrees, o.name, r.name);
      const entries = await readdir(prDir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const m = e.isDirectory() && /^pr-(\d+)$/.exec(e.name);
        if (!m) continue;
        const prId = Number(m[1]);
        out.push({
          id: `${o.name}/${r.name}/pr-${prId}`,
          path: join(prDir, e.name),
          org: o.name,
          repoId: r.name,
          prId,
        });
      }
    }
  }
  return out;
}
