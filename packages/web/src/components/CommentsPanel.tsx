import { useState } from "react";
import type { AdoThread } from "@agent-ops/shared";
import { Thread } from "./Thread.js";
import { MarkdownComposer } from "./MarkdownComposer.js";

/**
 * Comments-overview panel: all threads for the PR in one place, with a filter for
 * unresolved-only and a composer for a new general comment. Clicking a file-anchored
 * thread jumps to that file in the diff (via onJump).
 */
export function CommentsPanel({
  threads,
  loading,
  busy,
  onReply,
  onSetStatus,
  onNewComment,
  onJump,
}: {
  threads: AdoThread[];
  loading: boolean;
  busy: boolean;
  onReply: (threadId: number, content: string) => void;
  onSetStatus: (threadId: number, status: "active" | "closed") => void;
  onNewComment: (content: string) => void;
  onJump?: (thread: AdoThread) => void;
}) {
  const [unresolvedOnly, setUnresolvedOnly] = useState(false);
  const [composing, setComposing] = useState(false);

  const RESOLVED = new Set(["fixed", "closed", "wontFix", "byDesign"]);
  const shown = unresolvedOnly
    ? threads.filter((t) => !RESOLVED.has(t.status ?? ""))
    : threads;
  const unresolvedCount = threads.filter((t) => !RESOLVED.has(t.status ?? "")).length;

  return (
    <div className="comments-panel">
      <div className="comments-head">
        <span>
          Comments <span className="count-badge">{threads.length}</span>
        </span>
        <label className="unresolved-toggle">
          <input
            type="checkbox"
            checked={unresolvedOnly}
            onChange={(e) => setUnresolvedOnly(e.target.checked)}
          />
          Unresolved ({unresolvedCount})
        </label>
      </div>

      <div className="comments-list">
        {loading && <p className="empty">Loading…</p>}
        {!loading && shown.length === 0 && <p className="empty">No comments.</p>}
        {shown.map((t) => (
          <Thread
            key={t.id}
            thread={t}
            busy={busy}
            onReply={onReply}
            onSetStatus={onSetStatus}
            onJump={onJump}
          />
        ))}
      </div>

      <div className="comments-new">
        {composing ? (
          <MarkdownComposer
            placeholder="Add a general comment…"
            submitLabel="Comment"
            busy={busy}
            onSubmit={(content) => {
              onNewComment(content);
              setComposing(false);
            }}
            onCancel={() => setComposing(false)}
          />
        ) : (
          <button className="btn-ghost" onClick={() => setComposing(true)}>
            + Add comment
          </button>
        )}
      </div>
    </div>
  );
}
