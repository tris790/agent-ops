import { useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { AdoPullRequest, ReviewFilters } from "@agent-ops/shared";
import { api } from "../api/client.js";
import { useFilters } from "../api/useFilters.js";
import { MultiSelect, type Option } from "../components/MultiSelect.js";
import { PrRow } from "../components/PrRow.js";

const PAGE_SIZE = 30;

/** Status options for the filter. "active" is the default-on selection. */
const STATUS_OPTIONS: Option[] = [
  { value: "active", label: "Active" },
  { value: "draft", label: "Draft" },
  { value: "completed", label: "Completed" },
];
const DEFAULT_STATUSES = ["active"];

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A label only if it's a real name, not a bare GUID (service/build identities). */
const textualName = (value: string | undefined): string | undefined =>
  value && !GUID_RE.test(value.trim()) ? value : undefined;

/**
 * The home screen: "My pull requests" (authored by me) first, then "All active"
 * as an infinite list. Persistent multi-select filters (users / repos / status)
 * narrow both lists. Single-org.
 */
export function ReviewQueue({
  org,
  meId,
  onOpenPr,
}: {
  org: string;
  meId: string | undefined;
  onOpenPr: (pr: AdoPullRequest) => void;
}) {
  const { filters, setFilters } = useFilters(org);
  const repos = useQuery({ queryKey: ["repos", org], queryFn: () => api.repos(org) });
  // Org-wide user list for the author filter (cached). Falls back to PR authors below.
  const users = useQuery({ queryKey: ["users", org], queryFn: () => api.users(org) });

  // Effective statuses: if nothing chosen yet, fall back to the default (active).
  const statuses = filters.statuses.length ? filters.statuses : DEFAULT_STATUSES;
  // ADO's searchCriteria.status is single-valued; "draft" is a flag, not a status.
  // We request "active" when active or draft is selected, "completed" otherwise,
  // then refine client-side.
  const adoStatus = statuses.includes("active") || statuses.includes("draft")
    ? "active"
    : "completed";

  // My PRs (authored by me).
  const myPrs = useQuery({
    queryKey: ["prs", org, "mine", meId, adoStatus],
    queryFn: () => api.prs({ org, creatorId: meId, status: adoStatus }),
    enabled: !!meId,
  });

  // All PRs of the chosen status, paged.
  const allPrs = useInfiniteQuery({
    queryKey: ["prs", org, "all", adoStatus],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.prs({ org, status: adoStatus, top: PAGE_SIZE, skip: pageParam * PAGE_SIZE }),
    getNextPageParam: (last, pages) => (last.hasMore ? pages.length : undefined),
  });

  const repoOptions: Option[] = useMemo(
    () =>
      (repos.data?.repos ?? [])
        .map((r) => ({ value: r.id, label: r.name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [repos.data],
  );

  const flatAll = useMemo(
    () => allPrs.data?.pages.flatMap((p) => p.prs) ?? [],
    [allPrs.data],
  );

  // User filter options: the full org user list, merged with authors seen across the
  // loaded PRs. The merge guarantees a selectable id always matches some PR's
  // createdBy.id, and keeps the filter working if the org user list fails to load.
  const userOptions: Option[] = useMemo(() => {
    const seen = new Map<string, string>();
    for (const u of users.data?.users ?? []) {
      const label = textualName(u.displayName);
      if (label) seen.set(u.id, label);
    }
    for (const pr of [...(myPrs.data?.prs ?? []), ...flatAll]) {
      // Prefer a real name; never overwrite one with, or introduce, a bare GUID.
      const label = textualName(pr.createdBy.displayName) ?? seen.get(pr.createdBy.id);
      if (label) seen.set(pr.createdBy.id, label);
    }
    return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
  }, [users.data, myPrs.data, flatAll]);

  const applyFilters = (list: AdoPullRequest[]) => filterPrs(list, filters, statuses);

  const myFiltered = applyFilters(myPrs.data?.prs ?? []);
  const allFiltered = applyFilters(flatAll).filter((pr) => pr.createdBy.id !== meId);

  return (
    <div className="queue">
      <div className="filter-bar">
        <MultiSelect
          label="Status"
          options={STATUS_OPTIONS}
          selected={filters.statuses}
          onChange={(statuses) => setFilters({ ...filters, statuses })}
        />
        <MultiSelect
          label="Repository"
          options={repoOptions}
          selected={filters.repos}
          onChange={(repos) => setFilters({ ...filters, repos })}
          searchable
        />
        <MultiSelect
          label="Author"
          options={userOptions}
          selected={filters.users}
          onChange={(users) => setFilters({ ...filters, users })}
          searchable
        />
        {(filters.statuses.length || filters.repos.length || filters.users.length) > 0 && (
          <button
            className="filter-reset"
            onClick={() => setFilters({ users: [], repos: [], statuses: [] })}
          >
            Reset filters
          </button>
        )}
      </div>

      <Section title="My pull requests" count={myFiltered.length} loading={myPrs.isLoading}>
        {myFiltered.length === 0 && !myPrs.isLoading && (
          <p className="empty">No pull requests authored by you.</p>
        )}
        <ul className="pr-list">
          {myFiltered.map((pr) => (
            <PrRow key={pr.pullRequestId} pr={pr} meId={meId} onOpen={onOpenPr} />
          ))}
        </ul>
      </Section>

      <Section title="All active" count={allFiltered.length} loading={allPrs.isLoading}>
        {allFiltered.length === 0 && !allPrs.isLoading && (
          <p className="empty">Nothing here with the current filters.</p>
        )}
        <ul className="pr-list">
          {allFiltered.map((pr) => (
            <PrRow key={pr.pullRequestId} pr={pr} meId={meId} onOpen={onOpenPr} />
          ))}
        </ul>
        {allPrs.hasNextPage && (
          <button
            className="load-more"
            disabled={allPrs.isFetchingNextPage}
            onClick={() => void allPrs.fetchNextPage()}
          >
            {allPrs.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  count,
  loading,
  children,
}: {
  title: string;
  count: number;
  loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="queue-section">
      <h2 className="section-head">
        {title} <span className="section-count">{loading ? "…" : count}</span>
      </h2>
      {children}
    </section>
  );
}

/** Applies repo/user/draft+completed filters client-side. */
function filterPrs(
  list: AdoPullRequest[],
  filters: ReviewFilters,
  statuses: string[],
): AdoPullRequest[] {
  const wantDraft = statuses.includes("draft");
  const wantActive = statuses.includes("active");
  return list.filter((pr) => {
    if (filters.repos.length && !filters.repos.includes(pr.repository.id)) return false;
    if (filters.users.length && !filters.users.includes(pr.createdBy.id)) return false;
    // Draft refinement only applies within the active set.
    if (pr.status === "active") {
      if (pr.isDraft && !wantDraft) return false;
      if (!pr.isDraft && !wantActive && wantDraft) return false;
    }
    return true;
  });
}
