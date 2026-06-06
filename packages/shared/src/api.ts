import { z } from "zod";
import { reviewerVote } from "./ado.js";

/**
 * The contract between the SPA and our local backend (`/api/*`).
 * Distinct from ADO DTOs: these are our normalized shapes and request bodies.
 */

/** An organization the user has configured (org name + base URL + whether a PAT is stored). */
export const orgConfig = z.object({
  /** Short org name, e.g. "tris790". */
  name: z.string(),
  /** Base URL, e.g. "https://dev.azure.com/tris790" or "https://tris790.visualstudio.com". */
  baseUrl: z.string().url(),
  hasToken: z.boolean(),
});
export type OrgConfig = z.infer<typeof orgConfig>;

export const setTokenRequest = z.object({
  org: z.string(),
  baseUrl: z.string().url(),
  /** Optional when updating an org that already has a stored PAT. */
  pat: z.string().optional(),
});
export type SetTokenRequest = z.infer<typeof setTokenRequest>;

/** Persisted home-screen filter selections (multi-select). */
export const reviewFilters = z.object({
  /** Reviewer/author identity ids to include; empty = all. */
  users: z.array(z.string()).default([]),
  /** Repository ids to include; empty = all. */
  repos: z.array(z.string()).default([]),
  /** PR statuses to include; empty = default (active). */
  statuses: z.array(z.string()).default([]),
});
export type ReviewFilters = z.infer<typeof reviewFilters>;

export const setReviewFiltersRequest = reviewFilters.extend({ org: z.string() });
export type SetReviewFiltersRequest = z.infer<typeof setReviewFiltersRequest>;

/** Marks a file as viewed/unviewed within a PR. */
export const setViewedRequest = z.object({
  org: z.string(),
  repositoryId: z.string(),
  pullRequestId: z.number(),
  path: z.string(),
  viewed: z.boolean(),
});
export type SetViewedRequest = z.infer<typeof setViewedRequest>;

export const voteRequest = z.object({
  org: z.string(),
  repositoryId: z.string(),
  pullRequestId: z.number(),
  vote: reviewerVote,
});
export type VoteRequest = z.infer<typeof voteRequest>;

export const createThreadRequest = z.object({
  org: z.string(),
  repositoryId: z.string(),
  pullRequestId: z.number(),
  content: z.string().min(1),
  filePath: z.string().optional(),
  /** 1-based line in the new (right) side; omitted for a general PR comment. */
  rightLine: z.number().optional(),
  /** Iteration ids to anchor the thread to a specific diff. */
  firstComparingIteration: z.number().optional(),
  secondComparingIteration: z.number().optional(),
  changeTrackingId: z.number().optional(),
});
export type CreateThreadRequest = z.infer<typeof createThreadRequest>;

export const replyThreadRequest = z.object({
  org: z.string(),
  repositoryId: z.string(),
  pullRequestId: z.number(),
  threadId: z.number(),
  content: z.string().min(1),
});
export type ReplyThreadRequest = z.infer<typeof replyThreadRequest>;

export const resolveThreadRequest = z.object({
  org: z.string(),
  repositoryId: z.string(),
  pullRequestId: z.number(),
  threadId: z.number(),
  status: z.enum(["active", "fixed", "wontFix", "closed", "byDesign", "pending"]),
});
export type ResolveThreadRequest = z.infer<typeof resolveThreadRequest>;

/** A changed file in a PR iteration, normalized for the diff UI. */
export const prChange = z.object({
  path: z.string(),
  /** add | edit | delete | rename | ... (raw ADO changeType, may be combined) */
  changeType: z.string(),
  changeTrackingId: z.number().optional(),
  /** Object ids for each blob side (used to skip fetching unchanged content). */
  rightObjectId: z.string().optional(),
  leftObjectId: z.string().optional(),
});
export type PrChange = z.infer<typeof prChange>;

/** The set of changes for an iteration plus the commit SHAs to fetch each side. */
export const prDiffMeta = z.object({
  iterationId: z.number(),
  /** Right side (the proposed code) = source commit. */
  sourceCommit: z.string(),
  /** Left side (the base) = common/target commit. */
  baseCommit: z.string(),
  changes: z.array(prChange),
});
export type PrDiffMeta = z.infer<typeof prDiffMeta>;

/** Content for one side of a file, or null if the file doesn't exist on that side. */
export const fileContent = z.object({
  path: z.string(),
  content: z.string().nullable(),
  /** True when the blob looks binary (content omitted). */
  binary: z.boolean().default(false),
});
export type FileContent = z.infer<typeof fileContent>;

/** PR completion request. */
export const completePrRequest = z.object({
  org: z.string(),
  repositoryId: z.string(),
  pullRequestId: z.number(),
  mergeStrategy: z.enum(["noFastForward", "squash", "rebase", "rebaseMerge"]).default("noFastForward"),
  deleteSourceBranch: z.boolean().default(false),
});
export type CompletePrRequest = z.infer<typeof completePrRequest>;

export const abandonPrRequest = z.object({
  org: z.string(),
  repositoryId: z.string(),
  pullRequestId: z.number(),
});
export type AbandonPrRequest = z.infer<typeof abandonPrRequest>;

/** Create a new PR. */
export const createPrRequest = z.object({
  org: z.string(),
  repositoryId: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  sourceRefName: z.string(), // refs/heads/...
  targetRefName: z.string(),
  reviewerIds: z.array(z.string()).default([]),
  isDraft: z.boolean().default(false),
});
export type CreatePrRequest = z.infer<typeof createPrRequest>;

/** Edit PR metadata (any subset). */
export const editPrRequest = z.object({
  org: z.string(),
  repositoryId: z.string(),
  pullRequestId: z.number(),
  title: z.string().optional(),
  description: z.string().optional(),
  targetRefName: z.string().optional(),
  isDraft: z.boolean().optional(),
});
export type EditPrRequest = z.infer<typeof editPrRequest>;

/** A policy evaluation, normalized for the merge-blocking panel. */
export const policyEvaluation = z.object({
  name: z.string(),
  status: z.string(), // approved | rejected | running | queued | notApplicable
  isBlocking: z.boolean(),
});
export type PolicyEvaluation = z.infer<typeof policyEvaluation>;

/** A node in the repo file tree. */
export const treeNode = z.object({
  path: z.string(), // repo-relative, leading slash
  name: z.string(),
  isFolder: z.boolean(),
});
export type TreeNode = z.infer<typeof treeNode>;

/** A code-search hit (ripgrep over a worktree). */
export const searchHit = z.object({
  path: z.string(),
  line: z.number(),
  column: z.number(), // 1-based start column of the match
  endColumn: z.number(), // 1-based column just past the match (for highlighting)
  preview: z.string(),
});
export type SearchHit = z.infer<typeof searchHit>;

/** VSCode-style search options (mirrored into ripgrep flags server-side). */
export const searchOptions = z.object({
  regex: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
  wholeWord: z.boolean().default(false),
  includeGlobs: z.array(z.string()).default([]),
  excludeGlobs: z.array(z.string()).default([]),
  /** When set, search is restricted to these repo-relative paths (PR changed files). */
  paths: z.array(z.string()).default([]),
});
export type SearchOptions = z.infer<typeof searchOptions>;

/** Branch names (short form, no refs/heads/ prefix) for a repository. */
export const branchList = z.object({ branches: z.array(z.string()) });
export type BranchList = z.infer<typeof branchList>;

/**
 * A global code-search hit from the Azure DevOps Code Search API (org-wide, across
 * all repos). Unlike {@link searchHit}, this carries the owning repo/branch but no
 * line number — the Code Search API returns char offsets, not lines, so a clicked
 * hit opens the file at its branch (the viewer lands at the top).
 */
export const codeSearchHit = z.object({
  path: z.string(), // repo-relative, leading slash (e.g. "/src/app.ts")
  fileName: z.string(),
  repoId: z.string(),
  repoName: z.string(),
  project: z.string(),
  branch: z.string(), // short form, no refs/heads/ prefix
  snippet: z.string().optional(),
});
export type CodeSearchHit = z.infer<typeof codeSearchHit>;

/** Global code-search response. `extensionMissing` flags an org without Code Search. */
export const codeSearchResult = z.object({
  count: z.number(),
  hits: z.array(codeSearchHit),
  extensionMissing: z.boolean().optional(),
});
export type CodeSearchResult = z.infer<typeof codeSearchResult>;

/** Standard error envelope returned by the backend. */
export const apiError = z.object({
  error: z.object({
    code: z.string(), // e.g. "auth/required", "ado/rate-limited", "internal"
    message: z.string(),
    /** When code === "auth/required", which org needs a token. */
    org: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof apiError>;
