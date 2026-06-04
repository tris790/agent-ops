import type {
  AdoPipeline,
  AdoPullRequest,
  AdoRepository,
  AdoRun,
  AdoThread,
  FileContent,
  OrgConfig,
  PolicyEvaluation,
  PrDiffMeta,
  ReviewFilters,
  ReviewerVote,
  SearchHit,
  SearchOptions,
  TreeNode,
} from "@agent-ops/shared";

/**
 * Thin fetch wrapper for the backend `/api/*` surface. Throws ApiClientError
 * (carrying the structured error code) so callers can special-case auth/required.
 */

export class ApiClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly org?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let code = String(res.status);
    let message = res.statusText;
    let org: string | undefined;
    try {
      const body = (await res.json()) as {
        error?: { code?: string; message?: string; org?: string } | string;
      };
      if (typeof body.error === "string") {
        message = body.error;
      } else if (body.error) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
        org = body.error.org;
      }
    } catch {
      /* non-JSON error */
    }
    throw new ApiClientError(code, message, org);
  }
  return (await res.json()) as T;
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.set(k, String(v));
  return u.toString();
};

export interface Identity {
  id: string;
  displayName?: string;
}

export interface PrPage {
  prs: AdoPullRequest[];
  hasMore: boolean;
}

export interface PrQuery {
  org: string;
  repositoryId?: string;
  project?: string;
  status?: string;
  reviewerId?: string;
  creatorId?: string;
  top?: number;
  skip?: number;
}

export const api = {
  health: () => request<{ ok: boolean; version: string }>("/api/health"),

  listOrgs: () => request<{ orgs: OrgConfig[] }>("/api/orgs"),
  setToken: (org: string, baseUrl: string, pat?: string) =>
    request<{ ok: true }>("/api/token", {
      method: "POST",
      body: JSON.stringify({ org, baseUrl, pat }),
    }),

  getFilters: (org: string) => request<ReviewFilters>(`/api/filters?${qs({ org })}`),
  setFilters: (org: string, f: ReviewFilters) =>
    request<{ ok: true }>("/api/filters", {
      method: "PUT",
      body: JSON.stringify({ org, ...f }),
    }),

  me: (org: string) => request<Identity>(`/api/me?${qs({ org })}`),
  repos: (org: string) => request<{ repos: AdoRepository[] }>(`/api/repos?${qs({ org })}`),
  prs: (params: PrQuery) => request<PrPage>(`/api/prs?${qs({ ...params })}`),

  pr: (org: string, repositoryId: string, pullRequestId: number) =>
    request<AdoPullRequest>(`/api/pr?${qs({ org, repositoryId, pullRequestId })}`),
  prDiff: (org: string, repositoryId: string, pullRequestId: number, iterationId?: number) =>
    request<PrDiffMeta>(`/api/pr/diff?${qs({ org, repositoryId, pullRequestId, iterationId })}`),
  prFile: (org: string, repositoryId: string, path: string, commit: string) =>
    request<FileContent>(`/api/pr/file?${qs({ org, repositoryId, path, commit })}`),
  prViewed: (org: string, repositoryId: string, pullRequestId: number) =>
    request<{ paths: string[] }>(`/api/pr/viewed?${qs({ org, repositoryId, pullRequestId })}`),
  setPrViewed: (
    org: string,
    repositoryId: string,
    pullRequestId: number,
    path: string,
    viewed: boolean,
  ) =>
    request<{ ok: true }>("/api/pr/viewed", {
      method: "POST",
      body: JSON.stringify({ org, repositoryId, pullRequestId, path, viewed }),
    }),

  // ---- review actions ----
  threads: (org: string, repositoryId: string, pullRequestId: number) =>
    request<{ threads: AdoThread[] }>(
      `/api/pr/threads?${qs({ org, repositoryId, pullRequestId })}`,
    ),
  createThread: (body: {
    org: string;
    repositoryId: string;
    pullRequestId: number;
    content: string;
    filePath?: string;
    rightLine?: number;
  }) => request<AdoThread>("/api/pr/threads", { method: "POST", body: JSON.stringify(body) }),
  replyThread: (body: {
    org: string;
    repositoryId: string;
    pullRequestId: number;
    threadId: number;
    content: string;
  }) =>
    request<AdoThread>("/api/pr/threads/reply", { method: "POST", body: JSON.stringify(body) }),
  setThreadStatus: (body: {
    org: string;
    repositoryId: string;
    pullRequestId: number;
    threadId: number;
    status: "active" | "fixed" | "wontFix" | "closed" | "byDesign" | "pending";
  }) =>
    request<AdoThread>("/api/pr/threads/status", { method: "POST", body: JSON.stringify(body) }),
  vote: (org: string, repositoryId: string, pullRequestId: number, vote: ReviewerVote) =>
    request<{ ok: true }>("/api/pr/vote", {
      method: "POST",
      body: JSON.stringify({ org, repositoryId, pullRequestId, vote }),
    }),
  completePr: (body: {
    org: string;
    repositoryId: string;
    pullRequestId: number;
    mergeStrategy?: string;
    deleteSourceBranch?: boolean;
  }) => request<AdoPullRequest>("/api/pr/complete", { method: "POST", body: JSON.stringify(body) }),
  abandonPr: (org: string, repositoryId: string, pullRequestId: number) =>
    request<AdoPullRequest>("/api/pr/abandon", {
      method: "POST",
      body: JSON.stringify({ org, repositoryId, pullRequestId }),
    }),
  policies: (org: string, repositoryId: string, pullRequestId: number) =>
    request<{ policies: PolicyEvaluation[] }>(
      `/api/pr/policies?${qs({ org, repositoryId, pullRequestId })}`,
    ),

  // ---- worktree + LSP ----
  ensureWorktree: (org: string, repositoryId: string, pullRequestId: number) =>
    request<{ path: string; commit: string }>(
      `/api/pr/worktree?${qs({ org, repositoryId, pullRequestId })}`,
      { method: "POST" },
    ),
  lspDetect: (org: string, repositoryId: string, ref?: string) =>
    request<{
      languages: { lang: string; serverName: string; installed: boolean }[];
      worktreeId: string;
    }>(`/api/lsp/detect?${qs({ org, repositoryId, ref })}`),
  lspInstall: (lang: string) =>
    request<{ ok: boolean; error?: string }>(`/api/lsp/install?${qs({ lang })}`, {
      method: "POST",
    }),
  lspSession: (org: string, repositoryId: string, lang: string, ref?: string) =>
    request<{ status: "ready" | "install-required"; serverName?: string }>(
      `/api/lsp/session?${qs({ org, repositoryId, lang, ref })}`,
      { method: "POST" },
    ),
  /** Clone (if needed) + check out a branch into the repo's single worktree. */
  ensureBranchWorktree: (org: string, repositoryId: string, ref: string) =>
    request<{ path: string; commit: string }>(
      `/api/browse/worktree?${qs({ org, repositoryId, ref })}`,
      { method: "POST" },
    ),
  branches: (org: string, repositoryId: string, search?: string) =>
    request<{ branches: string[] }>(`/api/branches?${qs({ org, repositoryId, search })}`),

  // ---- code browse + search ----
  tree: (org: string, repositoryId: string, path = "/") =>
    request<{ nodes: TreeNode[] }>(`/api/browse/tree?${qs({ org, repositoryId, path })}`),
  browseFile: (org: string, repositoryId: string, path: string) =>
    request<{ path: string; content: string | null; binary: boolean }>(
      `/api/browse/file?${qs({ org, repositoryId, path })}`,
    ),
  search: (org: string, repositoryId: string, q: string, opts: Partial<SearchOptions> = {}) => {
    const u = new URLSearchParams({ org, repositoryId, q });
    if (opts.regex) u.set("regex", "1");
    if (opts.caseSensitive) u.set("case", "1");
    if (opts.wholeWord) u.set("word", "1");
    for (const g of opts.includeGlobs ?? []) u.append("include", g);
    for (const g of opts.excludeGlobs ?? []) u.append("exclude", g);
    for (const p of opts.paths ?? []) u.append("path", p);
    return request<{ hits: SearchHit[] }>(`/api/browse/search?${u.toString()}`);
  },

  // ---- pipelines ----
  projects: (org: string) =>
    request<{ projects: { id: string; name: string }[] }>(`/api/projects?${qs({ org })}`),
  pipelines: (org: string, project: string) =>
    request<{ pipelines: AdoPipeline[] }>(`/api/pipelines?${qs({ org, project })}`),
  pipelineRuns: (org: string, project: string, pipelineId: number) =>
    request<{ runs: AdoRun[] }>(`/api/pipelines/runs?${qs({ org, project, pipelineId })}`),
  pipelineLogs: (org: string, project: string, pipelineId: number, runId: number) =>
    request<{ logs: string }>(`/api/pipelines/logs?${qs({ org, project, pipelineId, runId })}`),
  queuePipeline: (org: string, project: string, pipelineId: number, refName?: string) =>
    request<AdoRun>("/api/pipelines/queue", {
      method: "POST",
      body: JSON.stringify({ org, project, pipelineId, refName }),
    }),
};
