import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AdoPullRequest, AdoRepository } from "@agent-ops/shared";
import { api } from "../api/client.js";

/**
 * Cmd-K fuzzy command palette: jump to any repo or active PR instantly. Essential
 * at org scale (1000s of repos). Opens on Cmd/Ctrl-K, filters as you type.
 */
export function CommandPalette({
  org,
  onOpenPr,
  onOpenRepo,
}: {
  org: string;
  onOpenPr: (pr: AdoPullRequest) => void;
  onOpenRepo: (repo: AdoRepository) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
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

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const repos = useQuery({ queryKey: ["repos", org], queryFn: () => api.repos(org), enabled: open });
  const prs = useQuery({
    queryKey: ["prs", org, "all", "active"],
    queryFn: () => api.prs({ org, status: "active", top: 100 }),
    enabled: open,
  });

  const items = useMemo(() => {
    const list: PaletteItem[] = [];
    for (const pr of prs.data?.prs ?? []) {
      list.push({ kind: "pr", label: `!${pr.pullRequestId} ${pr.title}`, sub: pr.repository.name, pr });
    }
    for (const r of repos.data?.repos ?? []) {
      list.push({ kind: "repo", label: r.name, sub: r.project?.name ?? "", repo: r });
    }
    if (!q.trim()) return list.slice(0, 50);
    const needle = q.toLowerCase();
    return list
      .filter((i) => (i.label + " " + i.sub).toLowerCase().includes(needle))
      .slice(0, 50);
  }, [repos.data, prs.data, q]);

  if (!open) return null;

  const choose = (item: PaletteItem) => {
    setOpen(false);
    if (item.kind === "pr") onOpenPr(item.pr);
    else onOpenRepo(item.repo);
  };

  return (
    <div className="palette-backdrop" onClick={() => setOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Jump to a repo or pull request…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, items.length - 1));
            else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
            else if (e.key === "Enter" && items[active]) choose(items[active]);
          }}
        />
        <div className="palette-list">
          {items.map((item, i) => (
            <div
              key={(item.kind === "pr" ? "p" : "r") + i}
              className={`palette-item ${i === active ? "active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(item)}
            >
              <span className={`palette-kind ${item.kind}`}>{item.kind === "pr" ? "PR" : "repo"}</span>
              <span className="palette-label">{item.label}</span>
              {item.sub && <span className="palette-sub">{item.sub}</span>}
            </div>
          ))}
          {items.length === 0 && <div className="palette-empty">No matches</div>}
        </div>
      </div>
    </div>
  );
}

type PaletteItem =
  | { kind: "pr"; label: string; sub: string; pr: AdoPullRequest }
  | { kind: "repo"; label: string; sub: string; repo: AdoRepository };
