import { join, relative, sep } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { SearchHit, TreeNode } from "@agent-ops/shared";
import { paths } from "../config.js";

/**
 * Reads repo content from an on-disk worktree (tree, file, ripgrep search).
 * Everything is constrained to live under `paths.worktrees` so a malicious path
 * can't escape the sandbox. Used by code browse and to open go-to-definition
 * targets in unmodified files.
 */

const IGNORE_DIRS = new Set([".git", "node_modules", "dist", ".next", "target", "bin", "obj"]);

/** Validates that `worktreePath` is inside the worktrees dir; throws otherwise. */
function assertInWorktrees(worktreePath: string): void {
  const rel = relative(paths.worktrees, worktreePath);
  if (rel.startsWith("..") || rel.startsWith(sep) || rel === "") {
    throw new Error("path escapes worktrees directory");
  }
}

/** Resolves a repo-relative path (leading slash ok) against the worktree, safely. */
function resolveInWorktree(worktreePath: string, repoRelPath: string): string {
  const clean = repoRelPath.replace(/^\/+/, "");
  const abs = join(worktreePath, clean);
  const rel = relative(worktreePath, abs);
  if (rel.startsWith("..") || rel.startsWith(sep)) {
    throw new Error("path escapes worktree");
  }
  return abs;
}

/** Lists one directory level of the tree at `dirPath` (repo-relative). */
export async function listTree(worktreePath: string, dirPath = "/"): Promise<TreeNode[]> {
  assertInWorktrees(worktreePath);
  const abs = resolveInWorktree(worktreePath, dirPath);
  const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
  const base = dirPath === "/" ? "" : dirPath.replace(/\/$/, "");
  return entries
    .filter((e) => !(e.isDirectory() && IGNORE_DIRS.has(e.name)) && !e.name.startsWith(".git"))
    .map((e) => ({
      path: `${base}/${e.name}`,
      name: e.name,
      isFolder: e.isDirectory(),
    }))
    .sort((a, b) =>
      a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1,
    );
}

/** Reads a file's text content from the worktree (null if missing/binary). */
export async function readWorktreeFile(
  worktreePath: string,
  repoRelPath: string,
): Promise<{ content: string | null; binary: boolean }> {
  assertInWorktrees(worktreePath);
  const abs = resolveInWorktree(worktreePath, repoRelPath);
  if (!existsSync(abs)) return { content: null, binary: false };
  const info = await stat(abs);
  if (!info.isFile() || info.size > 5_000_000) return { content: null, binary: false };
  const buf = await readFile(abs);
  if (buf.includes(0)) return { content: null, binary: true };
  return { content: buf.toString("utf8"), binary: false };
}

/** Runs ripgrep over the worktree, returning JSON match hits. */
export async function searchWorktree(
  worktreePath: string,
  query: string,
  opts: { maxHits?: number; regex?: boolean } = {},
): Promise<SearchHit[]> {
  assertInWorktrees(worktreePath);
  if (!query.trim()) return [];
  const maxHits = opts.maxHits ?? 200;

  const args = [
    "--json",
    "--max-count",
    "5", // per-file cap
    "--smart-case",
  ];
  if (!opts.regex) args.push("--fixed-strings");
  args.push("--", query, ".");

  const proc = Bun.spawn(["rg", ...args], {
    cwd: worktreePath,
    stdout: "pipe",
    stderr: "pipe",
  });

  const out = await new Response(proc.stdout).text();
  await proc.exited; // rg exits 1 when no matches — not an error for us

  const hits: SearchHit[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    let evt: RgEvent;
    try {
      evt = JSON.parse(line) as RgEvent;
    } catch {
      continue;
    }
    if (evt.type !== "match") continue;
    const d = evt.data;
    const submatch = d.submatches[0];
    hits.push({
      path: "/" + d.path.text.replace(/^\.\//, ""),
      line: d.line_number,
      column: (submatch?.start ?? 0) + 1,
      preview: d.lines.text.replace(/\n$/, "").slice(0, 200),
    });
    if (hits.length >= maxHits) break;
  }
  return hits;
}

// ---- ripgrep --json event shape (subset) ----
interface RgEvent {
  type: string;
  data: {
    path: { text: string };
    line_number: number;
    lines: { text: string };
    submatches: Array<{ start: number; end: number }>;
  };
}
