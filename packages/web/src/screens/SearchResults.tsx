import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CodeSearchHit } from "@agent-ops/shared";
import { api } from "../api/client.js";
import type { Route } from "../router.js";

/**
 * Global code-search results (the bare-query / `file:` path of the command palette).
 * The query lives in the URL hash (q/type/repo), so a search is shareable and
 * participates in browser back/forward. Results come from the ADO Code Search API
 * across every repo in the org — clicking a hit opens that file in the code
 * explorer at the hit's branch (the API gives no line number, so it lands at top).
 */
export function SearchResults({
  org,
  route,
  navigate,
}: {
  org: string;
  route: Route;
  navigate: (r: Route, opts?: { replace?: boolean }) => void;
}) {
  const q = route.q ?? "";
  const type = route.searchType ?? "code";
  const repo = route.searchRepo;

  const results = useQuery({
    queryKey: ["codeSearch", org, q, type, repo ?? ""],
    queryFn: () =>
      type === "file"
        ? api.searchCode(org, q, { path: q, repo })
        : api.searchCode(org, q, { repo }),
    enabled: q.trim().length > 1,
  });

  const grouped = useMemo(() => groupHitsByRepo(results.data?.hits ?? []), [results.data]);

  const openHit = (h: CodeSearchHit) =>
    navigate({ screen: "code", repoId: h.repoId, ref: h.branch || "main", file: h.path });

  return (
    <div className="global-search">
      <div className="global-search-head">
        <h1>
          {type === "file" ? "Files" : "Code"} matching “{q}”
        </h1>
        {repo && <span className="global-search-scope">in {repo}</span>}
      </div>

      {q.trim().length <= 1 && (
        <div className="global-search-empty">Type at least 2 characters to search.</div>
      )}
      {results.isLoading && <div className="global-search-empty">Searching…</div>}
      {results.isError && (
        <div className="global-search-empty">Search failed. Try again.</div>
      )}
      {results.data?.extensionMissing && (
        <div className="global-search-empty">
          Global code search needs the <strong>Code Search</strong> extension installed
          on this Azure DevOps organization.
        </div>
      )}
      {results.data && !results.data.extensionMissing && (
        <>
          <div className="global-search-count">
            {results.data.count} result{results.data.count === 1 ? "" : "s"}
          </div>
          {results.data.hits.length === 0 && (
            <div className="global-search-empty">No matches.</div>
          )}
          {grouped.map(([repoName, hits]) => (
            <div key={repoName} className="global-search-repo">
              <div className="global-search-repo-name">⛁ {repoName}</div>
              {hits.map((h, i) => (
                <div
                  key={h.path + i}
                  className="global-search-hit"
                  onClick={() => openHit(h)}
                  title={`${h.repoName} · ${h.branch}`}
                >
                  <span className="global-search-file">{h.path.replace(/^\//, "")}</span>
                  <span className="global-search-branch">⎇ {h.branch}</span>
                </div>
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/** Groups code-search hits by owning repo, preserving first-seen order. */
function groupHitsByRepo(hits: CodeSearchHit[]): [string, CodeSearchHit[]][] {
  const m = new Map<string, CodeSearchHit[]>();
  for (const h of hits) {
    const arr = m.get(h.repoName) ?? [];
    arr.push(h);
    m.set(h.repoName, arr);
  }
  return [...m.entries()];
}
