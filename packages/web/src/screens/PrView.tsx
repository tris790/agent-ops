import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdoThread, PrChange } from "@agent-ops/shared";
import { api } from "../api/client.js";
import { useReview } from "../api/useReview.js";
import { useLsp } from "../api/useLsp.js";
import { DiffView, type DiffLayout } from "../editor/index.js";
import type { LspDescriptor, InlineComment } from "../editor/types.js";
import { languageForPath } from "../editor/language.js";
import { PrActionBar } from "../components/PrActionBar.js";
import { CommentsPanel } from "../components/CommentsPanel.js";
import { Browse } from "./Browse.js";
import { useEffect } from "react";
import type { Route } from "../router.js";
import { Resizable } from "../components/Resizable.js";
import { ViewModeMenu, useFileViewMode } from "../components/ViewModeMenu.js";
import { usePersistedState } from "../usePersistedState.js";

/**
 * PR review screen: a files-changed list (with per-file "viewed" checkboxes and
 * progress) beside a Monaco diff of the selected file. Diff content comes from the
 * ADO Items API at each side's commit SHA (Step 6 will swap to the worktree).
 */
export function PrView({
  org,
  repositoryId,
  pullRequestId,
  meId,
  route,
  navigate,
  onBack,
}: {
  org: string;
  repositoryId: string;
  pullRequestId: number;
  meId: string | undefined;
  route: Route;
  navigate: (r: Route, opts?: { replace?: boolean }) => void;
  onBack: () => void;
}) {
  const pr = useQuery({
    queryKey: ["pr", org, repositoryId, pullRequestId],
    queryFn: () => api.pr(org, repositoryId, pullRequestId),
  });
  const diff = useQuery({
    queryKey: ["prdiff", org, repositoryId, pullRequestId],
    queryFn: () => api.prDiff(org, repositoryId, pullRequestId),
  });
  const viewed = useQuery({
    queryKey: ["prviewed", org, repositoryId, pullRequestId],
    queryFn: () => api.prViewed(org, repositoryId, pullRequestId),
  });
  const review = useReview(org, repositoryId, pullRequestId);
  const lsp = useLsp(org, repositoryId, pullRequestId);

  // Persisted UI prefs (survive F5).
  const [layout, setLayout] = usePersistedState<DiffLayout>("prDiffLayout", "side-by-side");
  const [showComments, setShowComments] = usePersistedState("prShowComments", true);

  // Mode + selected file + line all derive from the URL so the view is shareable
  // and back/forward-correct. File/mode changes use replace() to avoid flooding
  // history with every click; explicit jumps (go-to-def) push a new entry.
  const mode = route.mode ?? "diff";
  const changes = diff.data?.changes ?? [];
  const current = route.file ?? changes[0]?.path ?? null;
  const viewedSet = useMemo(() => new Set(viewed.data?.paths ?? []), [viewed.data]);

  const base = { screen: "pr" as const, repoId: repositoryId, prId: pullRequestId };
  const setMode = (m: "diff" | "browse") =>
    navigate({ ...base, mode: m, file: route.file, line: route.line }, { replace: true });
  const setSelected = (file: string) =>
    navigate({ ...base, mode, file }, { replace: true });

  // Opening a go-to-definition target switches to the browse view at that file
  // (pushed as a new history entry so Back returns to the diff).
  const navigateToFile = (path: string, line: number) => {
    navigate({ ...base, mode: "browse", file: path, line });
    return true;
  };

  const reviewBusy =
    review.reply.isPending ||
    review.setStatus.isPending ||
    review.createThread.isPending ||
    review.vote.isPending ||
    review.complete.isPending ||
    review.abandon.isPending;

  // Comment count for the current file (shown beside it).
  const jumpToThread = (t: AdoThread) => {
    const f = t.threadContext?.filePath;
    if (f) setSelected(f);
  };

  return (
    <div className="prview">
      <div className="prview-header">
        <button className="back-btn" onClick={onBack}>
          ← Queue
        </button>
        <span className="pr-id">!{pullRequestId}</span>
        <span className="prview-title">{pr.data?.title ?? "…"}</span>
        {pr.data && <span className={`chip status-${pr.data.status}`}>{pr.data.status}</span>}
        <div className="layout-toggle">
          <button className={mode === "diff" ? "active" : ""} onClick={() => setMode("diff")}>
            Diff
          </button>
          <button className={mode === "browse" ? "active" : ""} onClick={() => setMode("browse")}>
            Browse
          </button>
        </div>
        {mode === "diff" && (
          <div className="layout-toggle">
            {(["side-by-side", "inline", "whole-file", "word"] as DiffLayout[]).map((l) => (
              <button
                key={l}
                className={l === layout ? "active" : ""}
                onClick={() => setLayout(l)}
                title={LAYOUT_LABEL[l]}
              >
                {LAYOUT_LABEL[l]}
              </button>
            ))}
          </div>
        )}
        <NavStatus
          state={lsp.navState}
          missing={lsp.missing}
          onInstall={lsp.install}
        />
        <button
          className={showComments ? "nav-btn active" : "nav-btn"}
          onClick={() => setShowComments(!showComments)}
        >
          Comments
        </button>
      </div>

      <PrActionBar
        pr={pr.data}
        meId={meId}
        policies={review.policies}
        busy={reviewBusy}
        onVote={(v) => review.vote.mutate(v)}
        onComplete={(strategy, del) =>
          review.complete.mutate({ mergeStrategy: strategy, deleteSourceBranch: del })
        }
        onAbandon={() => review.abandon.mutate()}
      />

      {mode === "browse" ? (
        <Browse
          org={org}
          repositoryId={repositoryId}
          pullRequestId={pullRequestId}
          path={route.file}
          line={route.line}
          onOpenFile={(path, line) =>
            navigate({ ...base, mode: "browse", file: path, line }, { replace: true })
          }
        />
      ) : (
        <div className="prview-body">
          <FileTree
            changes={changes}
            current={current}
            viewedSet={viewedSet}
            loading={diff.isLoading}
            onSelect={setSelected}
            org={org}
            repositoryId={repositoryId}
            pullRequestId={pullRequestId}
          />
          <div className="prview-diff">
            {current && diff.data ? (
              <FileDiff
                org={org}
                repositoryId={repositoryId}
                path={current}
                sourceCommit={diff.data.sourceCommit}
                baseCommit={diff.data.baseCommit}
                layout={layout}
                rootUri={lsp.rootUri ?? undefined}
                descriptorFor={lsp.descriptorFor}
                onNavigate={navigateToFile}
                inlineComments={inlineCommentsFor(review.threads, current)}
                onAddComment={(line, content) =>
                  review.createThread.mutate({ content, filePath: current, rightLine: line })
                }
              />
            ) : (
              <div className="editor-loading">{diff.isLoading ? "Loading diff…" : "No file selected"}</div>
            )}
          </div>
          {showComments && (
            <CommentsPanel
              threads={review.threads}
              loading={review.threadsLoading}
              busy={reviewBusy}
              onReply={(threadId, content) => review.reply.mutate({ threadId, content })}
              onSetStatus={(threadId, status) => review.setStatus.mutate({ threadId, status })}
              onNewComment={(content) => review.createThread.mutate({ content })}
              onJump={jumpToThread}
            />
          )}
        </div>
      )}
    </div>
  );
}

const LAYOUT_LABEL: Record<DiffLayout, string> = {
  "side-by-side": "Side by side",
  inline: "Inline",
  "whole-file": "Whole file",
  word: "Word",
};

function FileTree({
  changes,
  current,
  viewedSet,
  loading,
  onSelect,
  org,
  repositoryId,
  pullRequestId,
}: {
  changes: PrChange[];
  current: string | null;
  viewedSet: Set<string>;
  loading: boolean;
  onSelect: (path: string) => void;
  org: string;
  repositoryId: string;
  pullRequestId: number;
}) {
  const qc = useQueryClient();
  const setViewed = useMutation({
    mutationFn: ({ path, v }: { path: string; v: boolean }) =>
      api.setPrViewed(org, repositoryId, pullRequestId, path, v),
    onMutate: async ({ path, v }) => {
      const key = ["prviewed", org, repositoryId, pullRequestId];
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<{ paths: string[] }>(key);
      const next = new Set(prev?.paths ?? []);
      if (v) next.add(path);
      else next.delete(path);
      qc.setQueryData(key, { paths: [...next] });
      return { prev, key };
    },
    onError: (_e, _v, ctx) => ctx && qc.setQueryData(ctx.key, ctx.prev),
  });

  const reviewedCount = changes.filter((c) => viewedSet.has(c.path)).length;
  const [viewMode, setViewMode] = useFileViewMode("prFileViewMode");

  const renderRow = (c: PrChange, indent = 0) => {
    const isViewed = viewedSet.has(c.path);
    const label = viewMode === "tree" ? c.path.split("/").pop()! : c.path.replace(/^\//, "");
    return (
      <li
        key={c.path}
        className={`${c.path === current ? "sel " : ""}${isViewed ? "viewed" : ""}`}
        style={{ paddingLeft: 8 + indent * 12 }}
        onClick={() => onSelect(c.path)}
      >
        <input
          type="checkbox"
          checked={isViewed}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setViewed.mutate({ path: c.path, v: e.target.checked })}
          title="Mark viewed"
        />
        <span className={`change-badge ${changeKind(c.changeType)}`}>
          {changeKind(c.changeType)[0]?.toUpperCase()}
        </span>
        <span className="file-path" title={c.path}>
          {label}
        </span>
      </li>
    );
  };

  return (
    <Resizable storageKey="prFileTreeWidth" defaultWidth={320} min={200} max={640}>
      <aside className="file-tree">
        <div className="file-tree-head">
          <span>Files</span>
          <span className="file-progress">
            {loading ? "…" : `${reviewedCount}/${changes.length} viewed`}
          </span>
          <ViewModeMenu mode={viewMode} onChange={setViewMode} />
        </div>
        <ul>
          {viewMode === "list"
            ? changes.map((c) => renderRow(c))
            : groupByFolder(changes).map((g) => (
                <li key={g.folder} className="tree-group">
                  {g.folder && <div className="tree-folder">{g.folder}</div>}
                  <ul>{g.files.map((c) => renderRow(c, g.folder ? 1 : 0))}</ul>
                </li>
              ))}
        </ul>
      </aside>
    </Resizable>
  );
}

/** Groups changed files by their parent folder for the tree view. */
function groupByFolder(changes: PrChange[]): { folder: string; files: PrChange[] }[] {
  const map = new Map<string, PrChange[]>();
  for (const c of changes) {
    const folder = c.path.replace(/^\//, "").split("/").slice(0, -1).join("/");
    const arr = map.get(folder) ?? [];
    arr.push(c);
    map.set(folder, arr);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([folder, files]) => ({ folder, files }));
}

/** Builds inline-comment view data for a file from the PR's threads. */
function inlineCommentsFor(threads: AdoThread[], filePath: string): InlineComment[] {
  const RESOLVED = new Set(["fixed", "closed", "wontFix", "byDesign"]);
  return threads
    .filter((t) => t.threadContext?.filePath === filePath && t.threadContext?.rightFileStart?.line)
    .map((t) => ({
      threadId: t.id,
      line: t.threadContext!.rightFileStart!.line,
      resolved: RESOLVED.has(t.status ?? ""),
      comments: t.comments
        .filter((c) => c.commentType !== "system" && !c.isDeleted)
        .map((c) => ({ author: c.author.displayName ?? "?", content: c.content ?? "" })),
    }));
}

function FileDiff({
  org,
  repositoryId,
  path,
  sourceCommit,
  baseCommit,
  layout,
  rootUri,
  descriptorFor,
  onNavigate,
  inlineComments,
  onAddComment,
}: {
  org: string;
  repositoryId: string;
  path: string;
  sourceCommit: string;
  baseCommit: string;
  layout: DiffLayout;
  rootUri?: string;
  descriptorFor: (path: string) => Promise<LspDescriptor | null>;
  onNavigate: (path: string, line: number) => boolean;
  inlineComments: InlineComment[];
  onAddComment: (line: number, content: string) => void;
}) {
  const right = useQuery({
    queryKey: ["file", org, repositoryId, path, sourceCommit],
    queryFn: () => api.prFile(org, repositoryId, path, sourceCommit),
  });
  const left = useQuery({
    queryKey: ["file", org, repositoryId, path, baseCommit],
    queryFn: () => api.prFile(org, repositoryId, path, baseCommit),
  });

  // Resolve the LSP descriptor for this file (null until worktree+server ready).
  const [descriptor, setDescriptor] = useState<LspDescriptor | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDescriptor(null);
    descriptorFor(path)
      .then((d) => {
        if (!cancelled) setDescriptor(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path, descriptorFor]);

  if (right.isLoading || left.isLoading) {
    return <div className="editor-loading">Loading diff…</div>;
  }
  if (right.data?.binary || left.data?.binary) {
    return <div className="editor-loading">Binary file — diff not shown.</div>;
  }

  return (
    <DiffView
      path={path}
      language={languageForPath(path)}
      original={left.data?.content ?? null}
      modified={right.data?.content ?? null}
      layout={layout}
      rootUri={rootUri}
      lsp={descriptor ?? undefined}
      onNavigate={onNavigate}
      inlineComments={inlineComments}
      onAddComment={onAddComment}
    />
  );
}

/** Nav-readiness pill + install prompt for missing language servers. */
function NavStatus({
  state,
  missing,
  onInstall,
}: {
  state: ReturnType<typeof useLsp>["navState"];
  missing: ReturnType<typeof useLsp>["missing"];
  onInstall: (lang: string) => void;
}) {
  if (state === "install-required" && missing.length > 0) {
    return (
      <div className="nav-status install">
        {missing.map((m) => (
          <button
            key={m.lang}
            className="install-btn"
            onClick={() => onInstall(m.lang)}
            title={`Install ${m.serverName} to enable code navigation`}
          >
            Install {m.serverName}
          </button>
        ))}
      </div>
    );
  }
  const label =
    state === "ready"
      ? "● nav ready"
      : state === "preparing"
        ? "○ preparing nav…"
        : state === "error"
          ? "nav unavailable"
          : "";
  if (!label) return null;
  return <span className={`nav-status ${state}`}>{label}</span>;
}

/** Normalizes ADO's combined changeType (e.g. "edit, rename") to a single kind. */
function changeKind(changeType: string): "add" | "delete" | "edit" | "rename" {
  const t = changeType.toLowerCase();
  if (t.includes("add")) return "add";
  if (t.includes("delete")) return "delete";
  if (t.includes("rename")) return "rename";
  return "edit";
}
