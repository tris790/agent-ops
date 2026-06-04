import type { AdoPullRequest } from "@agent-ops/shared";

const shortBranch = (ref: string) => ref.replace("refs/heads/", "");

/** Relative "time ago" for PR creation date. */
function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

/** Maps a reviewer vote value to a small status chip. */
function voteChip(pr: AdoPullRequest, meId?: string) {
  const mine = pr.reviewers?.find((r) => r.id === meId);
  const vote = mine?.vote ?? 0;
  if (vote >= 10) return <span className="chip approve">approved</span>;
  if (vote === 5) return <span className="chip approve">approved w/ sugg.</span>;
  if (vote === -5) return <span className="chip wait">waiting</span>;
  if (vote === -10) return <span className="chip reject">rejected</span>;
  return null;
}

export function PrRow({
  pr,
  meId,
  onOpen,
}: {
  pr: AdoPullRequest;
  meId?: string;
  onOpen: (pr: AdoPullRequest) => void;
}) {
  return (
    <li className="pr-row" onClick={() => onOpen(pr)}>
      <div className="pr-row-main">
        <span className="pr-id">!{pr.pullRequestId}</span>
        <span className="pr-title">{pr.title}</span>
        {pr.isDraft && <span className="chip draft">draft</span>}
        {voteChip(pr, meId)}
      </div>
      <div className="pr-meta">
        <span className="pr-repo">{pr.repository.name}</span>
        <span>·</span>
        <span>{pr.createdBy.displayName}</span>
        <span>·</span>
        <span className="pr-branch">
          {shortBranch(pr.sourceRefName)} → {shortBranch(pr.targetRefName)}
        </span>
        <span>·</span>
        <span>{timeAgo(pr.creationDate)}</span>
      </div>
    </li>
  );
}
