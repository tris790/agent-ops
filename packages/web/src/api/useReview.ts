import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReviewerVote } from "@agent-ops/shared";
import { api } from "./client.js";

/**
 * Review data + mutations for a PR: comment threads, voting, and completion.
 * Mutations invalidate the relevant queries so the UI reflects ADO's new state.
 */
export function useReview(org: string, repositoryId: string, pullRequestId: number) {
  const qc = useQueryClient();
  const ids = { org, repositoryId, pullRequestId };
  const threadsKey = ["threads", org, repositoryId, pullRequestId];
  const prKey = ["pr", org, repositoryId, pullRequestId];
  const policiesKey = ["policies", org, repositoryId, pullRequestId];

  const threads = useQuery({
    queryKey: threadsKey,
    queryFn: () => api.threads(org, repositoryId, pullRequestId),
  });
  const policies = useQuery({
    queryKey: policiesKey,
    queryFn: () => api.policies(org, repositoryId, pullRequestId),
  });

  const invalidateThreads = () => qc.invalidateQueries({ queryKey: threadsKey });
  const invalidatePr = () => qc.invalidateQueries({ queryKey: prKey });

  const createThread = useMutation({
    mutationFn: (v: { content: string; filePath?: string; rightLine?: number }) =>
      api.createThread({ ...ids, ...v }),
    onSuccess: invalidateThreads,
  });
  const reply = useMutation({
    mutationFn: (v: { threadId: number; content: string }) => api.replyThread({ ...ids, ...v }),
    onSuccess: invalidateThreads,
  });
  const setStatus = useMutation({
    mutationFn: (v: { threadId: number; status: "active" | "closed" }) =>
      api.setThreadStatus({ ...ids, ...v }),
    onSuccess: invalidateThreads,
  });
  const vote = useMutation({
    mutationFn: (v: ReviewerVote) => api.vote(org, repositoryId, pullRequestId, v),
    onSuccess: invalidatePr,
  });
  const complete = useMutation({
    mutationFn: (v: { mergeStrategy?: string; deleteSourceBranch?: boolean }) =>
      api.completePr({ ...ids, ...v }),
    onSuccess: invalidatePr,
  });
  const abandon = useMutation({
    mutationFn: () => api.abandonPr(org, repositoryId, pullRequestId),
    onSuccess: invalidatePr,
  });

  return {
    threads: threads.data?.threads ?? [],
    threadsLoading: threads.isLoading,
    policies: policies.data?.policies ?? [],
    createThread,
    reply,
    setStatus,
    vote,
    complete,
    abandon,
  };
}
