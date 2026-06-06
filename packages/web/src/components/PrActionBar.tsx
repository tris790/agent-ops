import { useEffect, useRef, useState } from "react";
import type { AdoPullRequest, PolicyEvaluation, ReviewerVote } from "@agent-ops/shared";

/**
 * Approve/vote + complete/abandon controls with a policy panel. Completion is
 * blocked while any blocking policy is unmet (admin can still see the reason).
 */
export function PrActionBar({
  pr,
  meId,
  policies,
  busy,
  onVote,
  onComplete,
  onAbandon,
}: {
  pr: AdoPullRequest | undefined;
  meId: string | undefined;
  policies: PolicyEvaluation[];
  busy: boolean;
  onVote: (v: ReviewerVote) => void;
  onComplete: (mergeStrategy: string, deleteSourceBranch: boolean) => void;
  onAbandon: () => void;
}) {
  const [showComplete, setShowComplete] = useState(false);
  const myVote = (pr?.reviewers?.find((r) => r.id === meId)?.vote ?? 0) as ReviewerVote;

  const blocking = policies.filter((p) => p.isBlocking);
  const unmet = blocking.filter((p) => p.status !== "approved");
  const canComplete = pr?.status === "active" && unmet.length === 0;

  return (
    <div className="action-bar">
      <VoteMenu myVote={myVote} busy={busy} onVote={onVote} />

      {policies.length > 0 && (
        <div className="policy-panel">
          {policies.map((p, i) => (
            <span key={i} className={`policy ${p.status}`} title={p.isBlocking ? "blocking" : "optional"}>
              {p.status === "approved" ? "✓" : p.status === "rejected" ? "✕" : "•"} {p.name}
            </span>
          ))}
        </div>
      )}

      <div className="action-buttons">
        <button
          className="btn-primary"
          disabled={!canComplete || busy}
          title={unmet.length ? `Blocked by: ${unmet.map((p) => p.name).join(", ")}` : "Complete PR"}
          onClick={() => setShowComplete((s) => !s)}
        >
          Complete
        </button>
        <button
          className="btn-danger"
          disabled={pr?.status !== "active" || busy}
          onClick={() => {
            if (confirm("Abandon this pull request?")) onAbandon();
          }}
        >
          Abandon
        </button>
      </div>

      {showComplete && (
        <CompleteDialog
          busy={busy}
          onClose={() => setShowComplete(false)}
          onConfirm={(strategy, del) => {
            onComplete(strategy, del);
            setShowComplete(false);
          }}
        />
      )}
    </div>
  );
}

type VoteOption = { vote: ReviewerVote; label: string; kind: "approve" | "wait" | "reject" };

const VOTE_OPTIONS: VoteOption[] = [
  { vote: 10, label: "Approve", kind: "approve" },
  { vote: 5, label: "Approve w/ suggestions", kind: "approve" },
  { vote: -5, label: "Wait for author", kind: "wait" },
  { vote: -10, label: "Reject", kind: "reject" },
];

/** Single dropdown merging the four vote actions; the trigger reflects the current vote. */
function VoteMenu({
  myVote,
  busy,
  onVote,
}: {
  myVote: ReviewerVote;
  busy: boolean;
  onVote: (v: ReviewerVote) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const current = VOTE_OPTIONS.find((o) => o.vote === myVote);
  const pick = (v: ReviewerVote) => {
    onVote(v);
    setOpen(false);
  };

  return (
    <div className="vote-menu" ref={ref}>
      <button
        className={`vote-btn ${current?.kind ?? ""} ${current ? "active" : ""}`}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
        title="Set your vote"
      >
        {current?.label ?? "Vote"} ▾
      </button>
      {open && (
        <div className="vote-menu-pop">
          {VOTE_OPTIONS.map((o) => (
            <button
              key={o.vote}
              className={`${o.kind} ${o.vote === myVote ? "active" : ""}`}
              onClick={() => pick(o.vote)}
            >
              {o.label}
            </button>
          ))}
          {myVote !== 0 && (
            <button className="reset" onClick={() => pick(0)}>
              Reset vote
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function CompleteDialog({
  busy,
  onClose,
  onConfirm,
}: {
  busy: boolean;
  onClose: () => void;
  onConfirm: (mergeStrategy: string, deleteSourceBranch: boolean) => void;
}) {
  const [strategy, setStrategy] = useState("noFastForward");
  const [del, setDel] = useState(false);
  return (
    <div className="complete-dialog">
      <label>
        Merge strategy
        <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
          <option value="noFastForward">Merge (no fast-forward)</option>
          <option value="squash">Squash</option>
          <option value="rebase">Rebase</option>
          <option value="rebaseMerge">Semi-linear (rebase + merge)</option>
        </select>
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={del} onChange={(e) => setDel(e.target.checked)} />
        Delete source branch
      </label>
      <div className="dialog-actions">
        <button className="btn-ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn-primary" onClick={() => onConfirm(strategy, del)} disabled={busy}>
          {busy ? "Completing…" : "Confirm complete"}
        </button>
      </div>
    </div>
  );
}
