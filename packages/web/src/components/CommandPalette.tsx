import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AdoPullRequest, AdoRepository } from "@agent-ops/shared";
import { api } from "../api/client.js";

/**
 * Cmd-K command palette. Opens on Cmd/Ctrl-K and routes by a typed prefix:
 *
 *   repo:<name>   filter repositories (jump to one to browse its default branch)
 *   pr:<text>     filter active pull requests
 *   file:<name>   global file-name search across the org
 *   <anything>    global code-content search across the org (no prefix)
 *
 * `repo:`/`pr:` filter the cached lists client-side and jump on Enter. A bare or
 * `file:` query is a global search: Enter navigates to the shareable search screen
 * (`onSearch`) so the result set has a URL and back/forward works. `openSignal`
 * lets the host open the palette programmatically (the "Code" nav button bumps it).
 */
export function CommandPalette({
  org,
  openSignal,
  onOpenPr,
  onOpenCode,
  onSearch,
}: {
  org: string;
  openSignal?: number;
  onOpenPr: (pr: AdoPullRequest) => void;
  onOpenCode: (repo: AdoRepository) => void;
  onSearch: (q: string, type: "code" | "file") => void;
}) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Global Cmd/Ctrl-K toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Host-triggered open (e.g. the Code nav button).
  useEffect(() => {
    if (openSignal) setOpen(true);
  }, [openSignal]);

  useEffect(() => {
    if (open) {
      setRaw("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const { kind, term } = parseQuery(raw);

  // repo:/pr: filter cached lists; code/file are handled on Enter (global search).
  const repos = useQuery({
    queryKey: ["repos", org],
    queryFn: () => api.repos(org),
    enabled: open,
  });
  const prs = useQuery({
    queryKey: ["prs", org, "all", "active"],
    queryFn: () => api.prs({ org, status: "active", top: 100 }),
    enabled: open,
  });

  const items = useMemo(() => {
    const list: PaletteItem[] = [];
    if (kind === "pr") {
      for (const pr of prs.data?.prs ?? [])
        list.push({ kind: "pr", label: `!${pr.pullRequestId} ${pr.title}`, sub: pr.repository.name, pr });
    } else if (kind === "repo") {
      for (const r of repos.data?.repos ?? [])
        list.push({ kind: "repo", label: r.name, sub: r.project?.name ?? "", repo: r });
    } else {
      // code / file: no list — Enter runs a global search.
      return [];
    }
    const needle = term.toLowerCase().trim();
    const filtered = needle
      ? list.filter((i) => (i.label + " " + i.sub).toLowerCase().includes(needle))
      : list;
    return filtered.slice(0, 50);
  }, [repos.data, prs.data, kind, term]);

  if (!open) return null;

  const runSearch = () => {
    if (term.trim().length < 2) return;
    setOpen(false);
    onSearch(term.trim(), kind === "file" ? "file" : "code");
  };

  const choose = (item: PaletteItem) => {
    setOpen(false);
    if (item.kind === "pr") onOpenPr(item.pr);
    else onOpenCode(item.repo); // repo -> browse its default branch (resolved by host)
  };

  const onEnter = () => {
    if (kind === "code" || kind === "file") runSearch();
    else if (items[active]) choose(items[active]);
  };

  return (
    <div className="palette-backdrop" onClick={() => setOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Search code… (repo: pr: file: to scope)"
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, items.length - 1));
            else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
            else if (e.key === "Enter") onEnter();
          }}
        />
        <div className="palette-list">
          {(kind === "code" || kind === "file") &&
            (term.trim().length < 2 ? (
              <div className="palette-empty">
                Type to {kind === "file" ? "find files" : "search code"} across all repos…
              </div>
            ) : (
              <div
                className="palette-item active"
                onClick={runSearch}
                onMouseEnter={() => setActive(0)}
              >
                <span className="palette-kind">{kind === "file" ? "files" : "code"}</span>
                <span className="palette-label">
                  Search {kind === "file" ? "file names" : "code"} for “{term.trim()}”
                </span>
                <span className="palette-sub">Enter ↵</span>
              </div>
            ))}
          {items.map((item, i) => (
            <div
              key={(item.kind === "pr" ? "p" : "r") + i}
              className={`palette-item ${i === active ? "active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(item)}
            >
              <span className={`palette-kind ${item.kind}`}>
                {item.kind === "pr" ? "PR" : "repo"}
              </span>
              <span className="palette-label">{item.label}</span>
              {item.sub && <span className="palette-sub">{item.sub}</span>}
            </div>
          ))}
          {(kind === "repo" || kind === "pr") && items.length === 0 && (
            <div className="palette-empty">No matches</div>
          )}
        </div>
      </div>
    </div>
  );
}

type QueryKind = "repo" | "pr" | "file" | "code";

/** Splits a leading `repo:`/`pr:`/`file:` prefix off the query; bare = code search. */
export function parseQuery(raw: string): { kind: QueryKind; term: string } {
  const m = /^(repo|pr|file):\s*(.*)$/is.exec(raw.trimStart());
  if (m) return { kind: m[1]!.toLowerCase() as QueryKind, term: m[2] ?? "" };
  return { kind: "code", term: raw.trim() };
}

type PaletteItem =
  | { kind: "pr"; label: string; sub: string; pr: AdoPullRequest }
  | { kind: "repo"; label: string; sub: string; repo: AdoRepository };
