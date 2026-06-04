import { useState } from "react";
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
  const myVote = pr?.reviewers?.find((r) => r.id === meId)?.vote ?? 0;

  const blocking = policies.filter((p) => p.isBlocking);
  const unmet = blocking.filter((p) => p.status !== "approved");
  const canComplete = pr?.status === "active" && unmet.length === 0;

  return (
    <div className="action-bar">
      <div className="vote-group">
        <VoteButton label="Approve" active={myVote === 10} kind="approve" onClick={() => onVote(10)} />
        <VoteButton
          label="Approve w/ suggestions"
          active={myVote === 5}
          kind="approve"
          onClick={() => onVote(5)}
        />
        <VoteButton
          label="Wait for author"
          active={myVote === -5}
          kind="wait"
          onClick={() => onVote(-5)}
        />
        <VoteButton label="Reject" active={myVote === -10} kind="reject" onClick={() => onVote(-10)} />
        {myVote !== 0 && (
          <button className="btn-ghost sm" disabled={busy} onClick={() => onVote(0)}>
            Reset vote
          </button>
        )}
      </div>

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

function VoteButton({
  label,
  active,
  kind,
  onClick,
}: {
  label: string;
  active: boolean;
  kind: "approve" | "wait" | "reject";
  onClick: () => void;
}) {
  return (
    <button className={`vote-btn ${kind} ${active ? "active" : ""}`} onClick={onClick} title={label}>
      {label}
    </button>
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
