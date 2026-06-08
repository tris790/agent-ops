import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AdoRepository } from "@agent-ops/shared";
import { api } from "../api/client.js";
import { fuzzyFilter } from "../lib/fuzzy.js";
import { useVirtualList } from "./useVirtualList.js";

/** Fixed row height in px — must match `.palette-item.virt { height }` in styles.css. */
const ROW_H = 38;

/** A row in the picker: a project (no repo) or a repo (carries the AdoRepository). */
type PickerItem = { id: string; label: string; repo?: AdoRepository };

/**
 * Code-browse picker for the "Code" nav button. A two-step modal: pick a project,
 * then pick a repo in that project — selecting a repo browses its default branch
 * (the host resolves the branch and navigates). Reuses the command-palette dark
 * styling. Unlike the Cmd-K palette (search-first), this is a guided drill-down.
 */
export function CodePicker({
  org,
  openSignal,
  onOpenCode,
}: {
  org: string;
  openSignal?: number;
  onOpenCode: (repo: AdoRepository) => void;
}) {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Host-triggered open (the Code nav button bumps openSignal).
  useEffect(() => {
    if (openSignal) {
      setOpen(true);
      setProjectId(null);
    }
  }, [openSignal]);

  // Reset transient state and focus the filter whenever we enter a step.
  useEffect(() => {
    if (!open) return;
    setFilter("");
    setActive(0);
    const id = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [open, projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const projects = useQuery({
    queryKey: ["projects", org],
    queryFn: () => api.projects(org),
    enabled: open,
  });
  const repos = useQuery({
    queryKey: ["repos", org],
    queryFn: () => api.repos(org),
    enabled: open,
  });

  const step: "project" | "repo" = projectId ? "repo" : "project";

  const items = useMemo<PickerItem[]>(() => {
    if (step === "project") {
      const all = (projects.data?.projects ?? []).map((p) => ({ id: p.id, label: p.name }));
      return fuzzyFilter(all, filter, (i) => i.label);
    }
    const all = (repos.data?.repos ?? [])
      .filter((r) => r.project?.id === projectId)
      .map((r) => ({ id: r.id, label: r.name, repo: r }));
    return fuzzyFilter(all, filter, (i) => i.label);
  }, [step, projectId, filter, projects.data, repos.data]);

  const { scrollRef, onScroll, range, topPad, bottomPad, scrollToIndex } = useVirtualList(
    items.length,
    ROW_H,
  );

  if (!open) return null;

  const choose = (item: PickerItem) => {
    if (step === "project") {
      setProjectId(item.id);
    } else if (item.repo) {
      setOpen(false);
      onOpenCode(item.repo); // host navigates to the repo's default branch
    }
  };

  const projectName =
    projects.data?.projects.find((p) => p.id === projectId)?.name ?? "";

  const loading = step === "project" ? projects.isLoading : repos.isLoading;

  return (
    <div className="palette-backdrop" onClick={() => setOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="codepicker-crumbs">
          <button
            type="button"
            className={`codepicker-crumb ${step === "project" ? "active" : ""}`}
            onClick={() => setProjectId(null)}
          >
            Projects
          </button>
          {step === "repo" && (
            <>
              <span className="codepicker-sep">›</span>
              <span className="codepicker-crumb active">{projectName}</span>
            </>
          )}
        </div>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder={step === "project" ? "Filter projects…" : "Filter repos…"}
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              const next = Math.min(active + 1, items.length - 1);
              setActive(next);
              scrollToIndex(next);
            } else if (e.key === "ArrowUp") {
              const next = Math.max(active - 1, 0);
              setActive(next);
              scrollToIndex(next);
            } else if (e.key === "Enter") {
              if (items[active]) choose(items[active]);
            } else if (e.key === "Backspace" && filter === "" && step === "repo") {
              setProjectId(null); // back to project list when filter is empty
            }
          }}
        />
        <div className="palette-list" ref={scrollRef} onScroll={onScroll}>
          {loading && <div className="palette-empty">Loading…</div>}
          {!loading && <div style={{ height: topPad }} />}
          {!loading &&
            items.slice(range.start, range.end).map((item, i) => {
              const realIndex = range.start + i;
              return (
                <div
                  key={item.id}
                  className={`palette-item virt ${realIndex === active ? "active" : ""}`}
                  onMouseEnter={() => setActive(realIndex)}
                  onClick={() => choose(item)}
                >
                  <span className={`palette-kind ${step}`}>
                    {step === "project" ? "proj" : "repo"}
                  </span>
                  <span className="palette-label">{item.label}</span>
                </div>
              );
            })}
          {!loading && <div style={{ height: bottomPad }} />}
          {!loading && items.length === 0 && (
            <div className="palette-empty">
              No {step === "project" ? "projects" : "repos"}
              {filter ? " match" : ""}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
