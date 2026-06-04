import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReviewFilters } from "@agent-ops/shared";
import { api } from "./client.js";

const EMPTY: ReviewFilters = { users: [], repos: [], statuses: [] };

/**
 * Loads and persists the home-screen filter selections for an org. Updates are
 * optimistic (the UI reflects the choice immediately) and saved to SQLite so they
 * survive restarts.
 */
export function useFilters(org: string | undefined) {
  const qc = useQueryClient();
  const key = ["filters", org];

  const query = useQuery({
    queryKey: key,
    queryFn: () => api.getFilters(org!),
    enabled: !!org,
    staleTime: Infinity,
  });

  const mutation = useMutation({
    mutationFn: (next: ReviewFilters) => api.setFilters(org!, next),
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<ReviewFilters>(key);
      qc.setQueryData(key, next);
      return { prev };
    },
    onError: (_e, _next, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
  });

  return {
    filters: query.data ?? EMPTY,
    isLoading: query.isLoading,
    setFilters: (next: ReviewFilters) => mutation.mutate(next),
  };
}
