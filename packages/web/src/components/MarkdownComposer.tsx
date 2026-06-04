import { useState } from "react";
import { marked } from "marked";

/**
 * Comment composer with a Write/Preview toggle. Renders markdown via `marked`.
 * Image paste/attach (ADO attachments) is a planned enhancement; the textarea
 * already accepts pasted text and the contract leaves room for it.
 */
export function MarkdownComposer({
  initial = "",
  placeholder = "Leave a comment…",
  submitLabel = "Comment",
  busy = false,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  placeholder?: string;
  submitLabel?: string;
  busy?: boolean;
  onSubmit: (content: string) => void;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [tab, setTab] = useState<"write" | "preview">("write");

  return (
    <div className="composer">
      <div className="composer-tabs">
        <button className={tab === "write" ? "active" : ""} onClick={() => setTab("write")}>
          Write
        </button>
        <button
          className={tab === "preview" ? "active" : ""}
          onClick={() => setTab("preview")}
          disabled={!value.trim()}
        >
          Preview
        </button>
      </div>
      {tab === "write" ? (
        <textarea
          className="composer-input"
          placeholder={placeholder}
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter submits.
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && value.trim()) {
              onSubmit(value.trim());
            }
          }}
        />
      ) : (
        <div
          className="composer-preview markdown"
          dangerouslySetInnerHTML={{ __html: marked.parse(value) as string }}
        />
      )}
      <div className="composer-actions">
        {onCancel && (
          <button className="btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
        <button
          className="btn-primary"
          disabled={!value.trim() || busy}
          onClick={() => onSubmit(value.trim())}
        >
          {busy ? "…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

/** Renders trusted-enough markdown (PR comments) to HTML. */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="markdown" dangerouslySetInnerHTML={{ __html: marked.parse(source) as string }} />
  );
}
