import { useQuery } from "@tanstack/react-query";
import { api } from "./client.js";

/**
 * Resolves the single active org (the one with a stored token, else the first
 * configured) and the authenticated identity. Single-org by design: the user
 * sets the org + PAT in config; the rest of the app reads it from here.
 */
export function useActiveOrg() {
  const orgs = useQuery({ queryKey: ["orgs"], queryFn: api.listOrgs });
  const list = orgs.data?.orgs ?? [];
  const active = list.find((o) => o.hasToken) ?? list[0] ?? null;
  return { org: active, orgs: list, isLoading: orgs.isLoading };
}

export function useIdentity(org: string | undefined) {
  return useQuery({
    queryKey: ["me", org],
    queryFn: () => api.me(org!),
    enabled: !!org,
    retry: false,
    staleTime: 60 * 60_000,
  });
}
