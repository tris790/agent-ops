import { join } from "node:path";
import { readdir, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { simpleGit, type SimpleGit } from "simple-git";
import { paths, config } from "../config.js";
import { emit } from "../events.js";
import { getOrgRow } from "../store/orgs.js";
import { patBasicHeader } from "../ado/token-provider.js";
import { cacheGet, cacheSet } from "../store/cache.js";
import { activeWorktreeIds, stopSessionsForWorktree } from "../lsp/manager.js";

/**
 * Git worktree manager — clones a repo once and checks out whatever ref is needed
 * (a PR's source commit or a branch) into a single on-disk working tree, so the
 * LSP layer can run real language servers and code browse/search can read files.
 *
 * There is ONE checkout per repo (not per PR). Opening a different PR or branch
 * re-checks-out the same directory in place; only one ref is live at a time.
 *
 * Layout (all under the gitignored `worktrees/`):
 *   worktrees/<org>/<repoId>/.cache/     partial clone (--filter=blob:none, --no-checkout),
 *                                        owns the shared object store
 *   worktrees/<org>/<repoId>/checkout/   linked worktree checked out at the active ref
 *
 * Auth: the PAT is injected per-command via `-c http.extraHeader=...` so it never
 * lands in a remote URL, .git/config, or the reflog.
 */

export interface WorktreeHandle {
  path: string;
  /** The commit SHA the worktree is checked out at. */
  commit: string;
}

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
const repoDir = (org: string, repoId: string) =>
  join(paths.worktrees, sanitize(org), sanitize(repoId));
const cacheDir = (org: string, repoId: string) => join(repoDir(org, repoId), ".cache");
const checkoutPath = (org: string, repoId: string) => join(repoDir(org, repoId), "checkout");
const worktreeId = (org: string, repoId: string) => `${sanitize(org)}/${sanitize(repoId)}`;

const SHA_RE = /^[0-9a-f]{40}$/i;

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
 * Ensure the repo's single worktree is checked out at `ref` — a 40-hex commit
 * SHA (e.g. a PR's source commit) or a branch name. Returns the path + resolved
 * commit. Idempotent and concurrency-safe (serialized per repo). Emits git/progress.
 *
 * `opts.fallbackRefspec` is fetched if a by-SHA fetch fails (the PR route passes
 * `+refs/pull/<id>/head:...` so a source commit reachable only via the PR ref can
 * still be found).
 */
export function ensureWorktreeAtRef(
  org: string,
  repoId: string,
  remoteUrl: string,
  ref: string,
  opts: { fallbackRefspec?: string } = {},
): Promise<WorktreeHandle> {
  const id = worktreeId(org, repoId);
  // Touch up front so eviction never deletes this repo while we build/switch it.
  touchWorktree(id);

  // Always serialize per repo: two callers may want the SAME repo at DIFFERENT
  // refs, so we can't dedupe on a single in-flight promise — they must queue and
  // re-checkout in turn. The lock provides that ordering.
  const work = withRepoLock(`${org}/${repoId}`, async () => {
    const wtPath = checkoutPath(org, repoId);
    try {
      await ensureCacheClone(org, repoId, remoteUrl, id);
      const cache = cacheDir(org, repoId);
      const g = git(cache, org);

      const sha = await resolveRef(g, org, repoId, ref, opts.fallbackRefspec, id);

      // Fast path: already checked out at the right commit.
      if ((await worktreeHeadSha(wtPath)) === sha) {
        touchWorktree(id);
        progress(id, "ready");
        return { path: wtPath, commit: sha };
      }

      stopSessionsForWorktree(id);
      await addOrMoveWorktree(org, repoId, sha, id);
      progress(id, "ready");
      touchWorktree(id);
      void evictToCapacity().catch(() => {});
      return { path: wtPath, commit: sha };
    } catch (err) {
      progress(id, "error", err instanceof Error ? err.message : String(err));
      throw err;
    }
  });

  inFlight.set(id, work);
  void work.finally(() => {
    if (inFlight.get(id) === work) inFlight.delete(id);
  });
  return work;
}

/**
 * Resolves `ref` to a commit SHA, fetching it into the cache clone if absent.
 * A 40-hex ref is fetched by SHA (with optional `fallbackRefspec`); any other ref
 * is treated as a branch and fetched into a remote-tracking ref, then resolved.
 */
async function resolveRef(
  g: SimpleGit,
  org: string,
  repoId: string,
  ref: string,
  fallbackRefspec: string | undefined,
  id: string,
): Promise<string> {
  if (SHA_RE.test(ref)) {
    if (!(await hasCommit(g, ref))) {
      progress(id, "fetching");
      try {
        await g.raw(["fetch", "--filter=blob:none", "--no-tags", "origin", ref]);
      } catch {
        if (fallbackRefspec) {
          await g.raw(["fetch", "--filter=blob:none", "--no-tags", "origin", fallbackRefspec]);
        }
      }
      if (!(await hasCommit(g, ref))) {
        throw new Error(`commit ${ref.slice(0, 8)} not found after fetch`);
      }
    }
    return ref;
  }

  // Branch: always fetch the tip (so we follow the branch as it moves), then resolve.
  progress(id, "fetching");
  await g.raw([
    "fetch",
    "--filter=blob:none",
    "--no-tags",
    "origin",
    `+refs/heads/${ref}:refs/remotes/origin/${ref}`,
  ]);
  const sha = (await g.raw(["rev-parse", `refs/remotes/origin/${ref}`])).trim();
  if (!sha) throw new Error(`branch ${ref} not found after fetch`);
  return sha;
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

async function addOrMoveWorktree(
  org: string,
  repoId: string,
  sha: string,
  id: string,
): Promise<void> {
  const cache = cacheDir(org, repoId);
  const wtPath = checkoutPath(org, repoId);
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

export async function removeWorktree(org: string, repoId: string): Promise<void> {
  const cache = cacheDir(org, repoId);
  const wtPath = checkoutPath(org, repoId);
  const id = worktreeId(org, repoId);
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

/** Removes a legacy per-PR worktree dir (pre one-checkout-per-repo). Best-effort. */
async function removeLegacyDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => {});
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
      // Legacy pr-* dirs have no live access record; reclaim them immediately.
      if (!v.legacy && now - (lastAccess(v.id) ?? 0) < EVICTION_GRACE_MS) continue;
      const size = await dirSize(v.path);
      if (v.legacy) await removeLegacyDir(v.path);
      else await removeWorktree(v.org, v.repoId);
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
  /** A leftover per-PR dir from the old layout — evict by path, not via git. */
  legacy?: boolean;
}

/**
 * Scans the worktrees dir for the per-repo `checkout/` directories, plus any
 * leftover legacy `pr-<id>/` dirs from the old per-PR layout (flagged so eviction
 * reclaims them rather than leaking disk).
 */
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
      const repoPath = join(paths.worktrees, o.name, r.name);
      const entries = await readdir(repoPath, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name === "checkout") {
          out.push({
            id: `${o.name}/${r.name}`,
            path: join(repoPath, e.name),
            org: o.name,
            repoId: r.name,
          });
        } else if (/^pr-\d+$/.test(e.name)) {
          out.push({
            id: `${o.name}/${r.name}/${e.name}`,
            path: join(repoPath, e.name),
            org: o.name,
            repoId: r.name,
            legacy: true,
          });
        }
      }
    }
  }
  return out;
}
