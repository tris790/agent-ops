import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

/**
 * Resolves the on-disk layout for the project. Everything runtime-generated lives
 * at the repo root (gitignored): `data/` (SQLite), `worktrees/` (clones), `lsp/`
 * (downloaded language servers). Paths are derived from this file's location so
 * the app works regardless of the cwd it's launched from.
 */

const here = dirname(fileURLToPath(import.meta.url)); // packages/server/src
const repoRoot = resolve(here, "..", "..", "..");

export const paths = {
  repoRoot,
  data: join(repoRoot, "data"),
  worktrees: join(repoRoot, "worktrees"),
  lsp: join(repoRoot, "lsp"),
  webDist: join(repoRoot, "packages", "web", "dist"),
  dbFile: join(repoRoot, "data", "agent-ops.db"),
} as const;

export const config = {
  port: Number(process.env.PORT ?? 4317),
  host: process.env.HOST ?? "127.0.0.1",
  /** Max disk (bytes) for cloned worktrees before LRU eviction kicks in. */
  worktreeDiskCapBytes: Number(process.env.WORKTREE_DISK_CAP ?? 20 * 1024 * 1024 * 1024),
  /** Idle ms before an LSP server is reaped. */
  lspIdleReapMs: Number(process.env.LSP_IDLE_REAP_MS ?? 10 * 60 * 1000),
} as const;

/** Create the runtime directories if missing. Safe to call on every boot. */
export function ensureDirs(): void {
  for (const dir of [paths.data, paths.worktrees, paths.lsp]) {
    mkdirSync(dir, { recursive: true });
  }
}
