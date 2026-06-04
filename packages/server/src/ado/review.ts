import { z } from "zod";
import {
  adoThread,
  adoPullRequest,
  type AdoThread,
  type AdoPullRequest,
  type PolicyEvaluation,
  type ReviewerVote,
} from "@agent-ops/shared";
import type { AdoClient } from "./client.js";

/**
 * PR review write/read operations: comment threads, votes, completion, creation,
 * metadata edits, and policy evaluations (for the merge-blocking panel).
 */

const repoPr = (repositoryId: string, prId: number) =>
  `_apis/git/repositories/${repositoryId}/pullRequests/${prId}`;

/** Normalizes a thread filePath to a leading-slash form for consistent matching. */
function normalizePath(p?: string | null): string | undefined {
  if (!p) return undefined;
  return p.startsWith("/") ? p : `/${p}`;
}

/** Lists threads, dropping system threads (vote/join notifications) the UI shouldn't show. */
export async function listThreads(
  client: AdoClient,
  repositoryId: string,
  prId: number,
): Promise<AdoThread[]> {
  const threads = await client.getList(`${repoPr(repositoryId, prId)}/threads`, adoThread);
  return threads
    .filter((t) => !t.isDeleted)
    .filter((t) => {
      // Keep threads that have at least one non-system, non-deleted comment.
      const real = t.comments.filter((c) => c.commentType !== "system" && !c.isDeleted);
      return real.length > 0;
    })
    .map((t) => ({
      ...t,
      threadContext: t.threadContext
        ? { ...t.threadContext, filePath: normalizePath(t.threadContext.filePath) ?? "" }
        : t.threadContext,
    }));
}

export interface CreateThreadInput {
  content: string;
  filePath?: string;
  rightLine?: number;
  firstComparingIteration?: number;
  secondComparingIteration?: number;
  changeTrackingId?: number;
}

/** Creates a new comment thread (general or anchored to a file line on the right side). */
export async function createThread(
  client: AdoClient,
  repositoryId: string,
  prId: number,
  input: CreateThreadInput,
): Promise<AdoThread> {
  const body: Record<string, unknown> = {
    comments: [{ parentCommentId: 0, content: input.content, commentType: 1 }],
    status: 1, // active
  };

  if (input.filePath && input.rightLine != null) {
    body.threadContext = {
      filePath: input.filePath,
      rightFileStart: { line: input.rightLine, offset: 1 },
      rightFileEnd: { line: input.rightLine, offset: 1 },
    };
    if (input.firstComparingIteration != null && input.secondComparingIteration != null) {
      body.pullRequestThreadContext = {
        changeTrackingId: input.changeTrackingId,
        iterationContext: {
          firstComparingIteration: input.firstComparingIteration,
          secondComparingIteration: input.secondComparingIteration,
        },
      };
    }
  }

  return client.send("POST", `${repoPr(repositoryId, prId)}/threads`, body, adoThread);
}

/** Adds a reply comment to an existing thread. */
export async function replyToThread(
  client: AdoClient,
  repositoryId: string,
  prId: number,
  threadId: number,
  content: string,
): Promise<AdoThread> {
  const comment = z.object({ id: z.number() }).passthrough();
  await client.send(
    "POST",
    `${repoPr(repositoryId, prId)}/threads/${threadId}/comments`,
    { parentCommentId: 0, content, commentType: 1 },
    comment,
  );
  // Return the refreshed thread.
  return client.getOne(`${repoPr(repositoryId, prId)}/threads/${threadId}`, adoThread);
}

const THREAD_STATUS: Record<string, number> = {
  active: 1,
  fixed: 2,
  wontFix: 3,
  closed: 4,
  byDesign: 5,
  pending: 6,
};

/** Updates a thread's status (resolve = fixed/closed, reopen = active, etc.). */
export async function setThreadStatus(
  client: AdoClient,
  repositoryId: string,
  prId: number,
  threadId: number,
  status: keyof typeof THREAD_STATUS,
): Promise<AdoThread> {
  return client.send(
    "PATCH",
    `${repoPr(repositoryId, prId)}/threads/${threadId}`,
    { status: THREAD_STATUS[status] },
    adoThread,
  );
}

/** Casts the authenticated user's vote on a PR. */
export async function castVote(
  client: AdoClient,
  repositoryId: string,
  prId: number,
  reviewerId: string,
  vote: ReviewerVote,
): Promise<void> {
  await client.send(
    "PUT",
    `${repoPr(repositoryId, prId)}/reviewers/${reviewerId}`,
    { vote, id: reviewerId },
    z.object({}).passthrough(),
  );
}

/** Completes (merges) a PR with the given strategy. */
export async function completePr(
  client: AdoClient,
  repositoryId: string,
  prId: number,
  mergeStrategy: string,
  deleteSourceBranch: boolean,
): Promise<AdoPullRequest> {
  // Need the current source commit to complete.
  const pr = await client.getOne(repoPr(repositoryId, prId), adoPullRequest);
  return client.send(
    "PATCH",
    repoPr(repositoryId, prId),
    {
      status: "completed",
      lastMergeSourceCommit: pr.lastMergeSourceCommit,
      completionOptions: { mergeStrategy, deleteSourceBranch },
    },
    adoPullRequest,
  );
}

export async function abandonPr(
  client: AdoClient,
  repositoryId: string,
  prId: number,
): Promise<AdoPullRequest> {
  return client.send("PATCH", repoPr(repositoryId, prId), { status: "abandoned" }, adoPullRequest);
}

export interface CreatePrInput {
  title: string;
  description?: string;
  sourceRefName: string;
  targetRefName: string;
  reviewerIds: string[];
  isDraft: boolean;
}

export async function createPr(
  client: AdoClient,
  repositoryId: string,
  input: CreatePrInput,
): Promise<AdoPullRequest> {
  return client.send(
    "POST",
    `_apis/git/repositories/${repositoryId}/pullrequests`,
    {
      title: input.title,
      description: input.description,
      sourceRefName: input.sourceRefName,
      targetRefName: input.targetRefName,
      isDraft: input.isDraft,
      reviewers: input.reviewerIds.map((id) => ({ id })),
    },
    adoPullRequest,
  );
}

export async function editPr(
  client: AdoClient,
  repositoryId: string,
  prId: number,
  patch: Record<string, unknown>,
): Promise<AdoPullRequest> {
  return client.send("PATCH", repoPr(repositoryId, prId), patch, adoPullRequest);
}

const adoPolicyEval = z
  .object({
    status: z.string().optional(),
    configuration: z
      .object({
        isBlocking: z.boolean().optional(),
        type: z.object({ displayName: z.string().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** Fetches normalized policy evaluations for the merge-blocking panel. */
export async function getPolicyEvaluations(
  client: AdoClient,
  project: string,
  projectId: string,
  prId: number,
): Promise<PolicyEvaluation[]> {
  const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${prId}`;
  const evals = await client.getList(
    `${encodeURIComponent(project)}/_apis/policy/evaluations`,
    adoPolicyEval,
    { query: { artifactId }, apiVersion: "7.1-preview.1" },
  );
  return evals.map((e) => ({
    name: e.configuration?.type?.displayName ?? "Policy",
    status: e.status ?? "unknown",
    isBlocking: e.configuration?.isBlocking ?? false,
  }));
}
