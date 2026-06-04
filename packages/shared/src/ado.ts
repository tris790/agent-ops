import { z } from "zod";

/**
 * Schemas for the subset of Azure DevOps REST (api-version 7.1) DTOs we consume.
 * These validate at the proxy boundary so the rest of the app trusts the shapes.
 * Most ADO responses carry many more fields than we model; `.passthrough()` keeps
 * extras around without forcing us to enumerate them.
 */

export const adoIdentityRef = z
  .object({
    id: z.string(),
    displayName: z.string().optional(),
    uniqueName: z.string().optional(),
    imageUrl: z.string().optional(),
  })
  .passthrough();
export type AdoIdentityRef = z.infer<typeof adoIdentityRef>;

export const adoProjectRef = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .passthrough();
export type AdoProjectRef = z.infer<typeof adoProjectRef>;

export const adoRepository = z
  .object({
    id: z.string(),
    name: z.string(),
    defaultBranch: z.string().optional(),
    remoteUrl: z.string().optional(),
    webUrl: z.string().optional(),
    size: z.number().optional(),
    project: adoProjectRef.optional(),
  })
  .passthrough();
export type AdoRepository = z.infer<typeof adoRepository>;

export const prStatus = z.enum(["active", "abandoned", "completed", "all", "notSet"]);
export type PrStatus = z.infer<typeof prStatus>;

/** Reviewer vote values per the ADO API. */
export const reviewerVote = z.union([
  z.literal(10), // approved
  z.literal(5), //  approved with suggestions
  z.literal(0), //  no vote
  z.literal(-5), // waiting for author
  z.literal(-10), // rejected
]);
export type ReviewerVote = z.infer<typeof reviewerVote>;

export const adoReviewer = adoIdentityRef.and(
  z
    .object({
      vote: z.number().optional(),
      isRequired: z.boolean().optional(),
      hasDeclined: z.boolean().optional(),
    })
    .passthrough(),
);
export type AdoReviewer = z.infer<typeof adoReviewer>;

export const adoGitCommitRef = z
  .object({
    commitId: z.string(),
    comment: z.string().optional(),
  })
  .passthrough();

export const adoPullRequest = z
  .object({
    pullRequestId: z.number(),
    title: z.string(),
    description: z.string().optional(),
    status: prStatus,
    isDraft: z.boolean().optional(),
    createdBy: adoIdentityRef,
    creationDate: z.string(),
    sourceRefName: z.string(),
    targetRefName: z.string(),
    mergeStatus: z.string().optional(),
    lastMergeSourceCommit: adoGitCommitRef.optional(),
    reviewers: z.array(adoReviewer).optional(),
    repository: adoRepository,
    url: z.string().optional(),
  })
  .passthrough();
export type AdoPullRequest = z.infer<typeof adoPullRequest>;

export const adoIteration = z
  .object({
    id: z.number(),
    description: z.string().optional(),
    sourceRefCommit: adoGitCommitRef.optional(),
    targetRefCommit: adoGitCommitRef.optional(),
    commonRefCommit: adoGitCommitRef.optional(),
    createdDate: z.string().optional(),
  })
  .passthrough();
export type AdoIteration = z.infer<typeof adoIteration>;

/** A single changed file within an iteration. */
export const adoChangeEntry = z
  .object({
    changeTrackingId: z.number().optional(),
    changeId: z.number().optional(),
    item: z
      .object({
        path: z.string().optional(),
        gitObjectType: z.string().optional(),
        objectId: z.string().optional(),
        originalObjectId: z.string().optional(),
        isFolder: z.boolean().optional(),
      })
      .passthrough(),
    /** add | edit | delete | rename | ... (may be combined, e.g. "edit, rename") */
    changeType: z.string(),
  })
  .passthrough();
export type AdoChangeEntry = z.infer<typeof adoChangeEntry>;

/** Position inside a file for a comment thread. line is 1-based, offset is 0-based. */
export const commentPosition = z.object({
  line: z.number(),
  offset: z.number(),
});
export type CommentPosition = z.infer<typeof commentPosition>;

export const threadContext = z
  .object({
    filePath: z.string(),
    leftFileStart: commentPosition.nullish(),
    leftFileEnd: commentPosition.nullish(),
    rightFileStart: commentPosition.nullish(),
    rightFileEnd: commentPosition.nullish(),
  })
  .passthrough();
export type ThreadContext = z.infer<typeof threadContext>;

export const commentThreadStatus = z.enum([
  "unknown",
  "active",
  "fixed",
  "wontFix",
  "closed",
  "byDesign",
  "pending",
]);
export type CommentThreadStatus = z.infer<typeof commentThreadStatus>;

export const adoComment = z
  .object({
    id: z.number(),
    parentCommentId: z.number().optional(),
    content: z.string().optional(),
    commentType: z.string().optional(),
    author: adoIdentityRef,
    publishedDate: z.string().optional(),
    lastUpdatedDate: z.string().optional(),
    isDeleted: z.boolean().optional(),
  })
  .passthrough();
export type AdoComment = z.infer<typeof adoComment>;

export const adoThread = z
  .object({
    id: z.number(),
    status: z.string().optional(),
    comments: z.array(adoComment),
    threadContext: threadContext.nullish(),
    isDeleted: z.boolean().optional(),
    lastUpdatedDate: z.string().optional(),
    publishedDate: z.string().optional(),
  })
  .passthrough();
export type AdoThread = z.infer<typeof adoThread>;

export const adoPolicyEvaluation = z
  .object({
    evaluationId: z.string().optional(),
    status: z.string().optional(), // queued | running | approved | rejected | notApplicable
    configuration: z
      .object({
        type: z.object({ displayName: z.string().optional() }).passthrough().optional(),
        isBlocking: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type AdoPolicyEvaluation = z.infer<typeof adoPolicyEvaluation>;

export const adoPipeline = z
  .object({
    id: z.number(),
    name: z.string(),
    folder: z.string().optional(),
  })
  .passthrough();
export type AdoPipeline = z.infer<typeof adoPipeline>;

export const adoRun = z
  .object({
    id: z.number(),
    name: z.string().optional(),
    state: z.string().optional(), // inProgress | completed | ...
    result: z.string().optional(), // succeeded | failed | canceled
    createdDate: z.string().optional(),
    finishedDate: z.string().optional(),
  })
  .passthrough();
export type AdoRun = z.infer<typeof adoRun>;
