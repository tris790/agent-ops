# agent-ops

A fast, local replacement for the Azure DevOps web frontend — built for reviewing PRs,
browsing code, and (fast-follow) running pipelines, with **real LSP code navigation** while you
review (go-to-definition, find-references, hover, diagnostics — including jumping from a diff
into unmodified repo files, just like VS Code).

It runs entirely on your machine: clone this repo, run one command, open the page.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- `git` (used for cloning repos you review)
- `ripgrep` (`rg`) for in-repo code search
- Language toolchains for the repos you open (the app downloads the matching language
  servers into `lsp/` on demand)

## Quick start

```bash
bun install

# dev (two processes: Bun backend + Vite SPA with hot reload)
bun run dev

# or production-style: build the SPA, then serve everything from the backend
bun run build
bun run start
```

Dev SPA: <http://127.0.0.1:5317> · Backend/API: <http://127.0.0.1:4317>

On first use you'll add an organization and a **Personal Access Token** (PAT). The PAT is
stored locally in `data/agent-ops.db` and is never written to source, URLs, or logs. When a
token is missing or expired the app prompts you for a new one.

> Generate a PAT at `https://<your-org>.visualstudio.com/_usersSettings/tokens` (or
> `https://dev.azure.com/<org>/_usersSettings/tokens`). Scope it to Code (read/write) and
> Build as needed. Never paste a PAT into chat or commit it.

## Layout

```
packages/
  server/   Bun backend — ADO REST proxy, git, LSP bridge, SQLite, serves the SPA
  web/      React 19 + Vite + TanStack + Monaco SPA
  shared/   zod schemas + TS types shared by both (one source of truth)
lsp/         downloaded language servers      (gitignored)
worktrees/   cloned repos / per-PR worktrees  (gitignored)
data/        SQLite database                  (gitignored)
```

## Configuration (env)

| Var                  | Default                  | Purpose                              |
| -------------------- | ------------------------ | ------------------------------------ |
| `PORT`               | `4317`                   | Backend port                         |
| `HOST`               | `127.0.0.1`              | Backend bind address                 |
| `WORKTREE_DISK_CAP`  | `20 GiB`                 | Disk cap before worktree LRU eviction|
| `LSP_IDLE_REAP_MS`   | `600000`                 | Idle time before a language server is reaped |
| `BACKEND_URL`        | `http://127.0.0.1:4317`  | (dev) Vite proxy target              |

## Status

Scaffold + backend skeleton in place. See the implementation plan for the build order
(auth/ADO client → review queue → PR diff → review actions → git worktrees → LSP → browse/search
→ UI → pipelines).
