import { useState } from "react";
import type { AdoThread } from "@agent-ops/shared";
import { Markdown, MarkdownComposer } from "./MarkdownComposer.js";

/** Thread statuses that count as resolved (collapsed by default). */
const RESOLVED = new Set(["fixed", "closed", "wontFix", "byDesign"]);

/**
 * One comment thread: its comments, a reply composer, and resolve/reopen control.
 * Used in the comments-overview panel and (later) inline in the diff.
 */
export function Thread({
  thread,
  busy,
  onReply,
  onSetStatus,
  onJump,
}: {
  thread: AdoThread;
  busy?: boolean;
  onReply: (threadId: number, content: string) => void;
  onSetStatus: (threadId: number, status: "active" | "closed") => void;
  onJump?: (thread: AdoThread) => void;
}) {
  const [replying, setReplying] = useState(false);
  const isResolved = RESOLVED.has(thread.status ?? "");
  const comments = thread.comments.filter((c) => c.commentType !== "system" && !c.isDeleted);
  const file = thread.threadContext?.filePath;
  const line = thread.threadContext?.rightFileStart?.line;

  return (
    <div className={`thread ${isResolved ? "resolved" : ""}`}>
      {file && (
        <div className="thread-anchor" onClick={() => onJump?.(thread)}>
          <span className="thread-file">{file.replace(/^\//, "")}</span>
          {line != null && <span className="thread-line">:{line}</span>}
        </div>
      )}
      <div className="thread-comments">
        {comments.map((c) => (
          <div key={c.id} className="comment">
            <div className="comment-head">
              <span className="comment-author">{c.author.displayName}</span>
              {c.publishedDate && (
                <span className="comment-date">
                  {new Date(c.publishedDate).toLocaleDateString()}
                </span>
              )}
            </div>
            <Markdown source={c.content ?? ""} />
          </div>
        ))}
      </div>
      <div className="thread-actions">
        {replying ? (
          <MarkdownComposer
            placeholder="Reply…"
            submitLabel="Reply"
            busy={busy}
            onSubmit={(content) => {
              onReply(thread.id, content);
              setReplying(false);
            }}
            onCancel={() => setReplying(false)}
          />
        ) : (
          <>
            <button className="btn-ghost sm" onClick={() => setReplying(true)}>
              Reply
            </button>
            {isResolved ? (
              <button className="btn-ghost sm" onClick={() => onSetStatus(thread.id, "active")}>
                Reopen
              </button>
            ) : (
              <button className="btn-ghost sm" onClick={() => onSetStatus(thread.id, "closed")}>
                Resolve
              </button>
            )}
            <span className={`thread-status ${thread.status}`}>{thread.status}</span>
          </>
        )}
      </div>
    </div>
  );
}
