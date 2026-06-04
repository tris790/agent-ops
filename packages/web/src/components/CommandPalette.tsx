import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AdoPullRequest, AdoRepository } from "@agent-ops/shared";
import { api } from "../api/client.js";

/**
 * Cmd-K fuzzy command palette: jump to any repo or active PR instantly. Essential
 * at org scale (1000s of repos). Opens on Cmd/Ctrl-K, filters as you type.
 *
 * Two-step flow: pick a repo to jump to its review queue (`onOpenRepo`), or — to
 * browse code — pick a repo then a branch (`onOpenCode`). `openSignal` lets the
 * host open the palette programmatically (the "Code" nav button bumps it).
 */
export function CommandPalette({
  org,
  openSignal,
  onOpenPr,
  onOpenRepo,
  onOpenCode,
}: {
  org: string;
  openSignal?: number;
  onOpenPr: (pr: AdoPullRequest) => void;
  onOpenRepo: (repo: AdoRepository) => void;
  onOpenCode: (repo: AdoRepository, branch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  // When set, the palette is in branch-pick mode for this repo.
  const [branchRepo, setBranchRepo] = useState<AdoRepository | null>(null);
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
      setQ("");
      setActive(0);
      setBranchRepo(null);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const repos = useQuery({ queryKey: ["repos", org], queryFn: () => api.repos(org), enabled: open });
  const prs = useQuery({
    queryKey: ["prs", org, "all", "active"],
    queryFn: () => api.prs({ org, status: "active", top: 100 }),
    enabled: open,
  });
  const branches = useQuery({
    queryKey: ["branches", org, branchRepo?.id],
    queryFn: () => api.branches(org, branchRepo!.id),
    enabled: open && branchRepo != null,
  });

  const items = useMemo(() => {
    const list: PaletteItem[] = [];
    if (branchRepo) {
      // Branch-pick mode: default branch first, then the rest.
      const def = branchRepo.defaultBranch?.replace(/^refs\/heads\//, "");
      const all = branches.data?.branches ?? [];
      const ordered = def ? [def, ...all.filter((b) => b !== def)] : all;
      for (const b of ordered) list.push({ kind: "branch", label: b, sub: branchRepo.name, branch: b });
    } else {
      for (const pr of prs.data?.prs ?? []) {
        list.push({ kind: "pr", label: `!${pr.pullRequestId} ${pr.title}`, sub: pr.repository.name, pr });
      }
      for (const r of repos.data?.repos ?? []) {
        list.push({ kind: "repo", label: r.name, sub: r.project?.name ?? "", repo: r });
      }
    }
    if (!q.trim()) return list.slice(0, 50);
    const needle = q.toLowerCase();
    return list.filter((i) => (i.label + " " + i.sub).toLowerCase().includes(needle)).slice(0, 50);
  }, [repos.data, prs.data, branches.data, branchRepo, q]);

  if (!open) return null;

  const choose = (item: PaletteItem) => {
    if (item.kind === "pr") {
      setOpen(false);
      onOpenPr(item.pr);
    } else if (item.kind === "branch") {
      setOpen(false);
      onOpenCode(branchRepo!, item.branch);
    } else {
      // Repo chosen: enter branch-pick mode (Enter on a repo browses its code).
      setBranchRepo(item.repo);
      setQ("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  const placeholder = branchRepo
    ? `Pick a branch in ${branchRepo.name}…`
    : "Jump to a repo or pull request…";

  return (
    <div className="palette-backdrop" onClick={() => setOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        {branchRepo && (
          <div className="palette-crumb">
            <button className="palette-back" onClick={() => setBranchRepo(null)}>
              ← repos
            </button>
            <span>{branchRepo.name}</span>
          </div>
        )}
        <input
          ref={inputRef}
          className="palette-input"
          placeholder={placeholder}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, items.length - 1));
            else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
            else if (e.key === "Enter" && items[active]) choose(items[active]);
            else if (e.key === "Backspace" && q === "" && branchRepo) setBranchRepo(null);
          }}
        />
        <div className="palette-list">
          {branchRepo && branches.isLoading && <div className="palette-empty">Loading branches…</div>}
          {items.map((item, i) => (
            <div
              key={(item.kind === "pr" ? "p" : item.kind === "branch" ? "b" : "r") + i}
              className={`palette-item ${i === active ? "active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(item)}
            >
              <span className={`palette-kind ${item.kind}`}>
                {item.kind === "pr" ? "PR" : item.kind === "branch" ? "⎇" : "repo"}
              </span>
              <span className="palette-label">{item.label}</span>
              {item.sub && <span className="palette-sub">{item.sub}</span>}
            </div>
          ))}
          {items.length === 0 && !branches.isLoading && <div className="palette-empty">No matches</div>}
        </div>
      </div>
    </div>
  );
}

type PaletteItem =
  | { kind: "pr"; label: string; sub: string; pr: AdoPullRequest }
  | { kind: "repo"; label: string; sub: string; repo: AdoRepository }
  | { kind: "branch"; label: string; sub: string; branch: string };
