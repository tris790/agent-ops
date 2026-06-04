import { useCallback } from "react";
import { api } from "../api/client.js";
import { Browse } from "./Browse.js";
import type { Route } from "../router.js";

/**
 * Standalone code-browsing screen (the "Code" tab). Browses a repo at a chosen
 * branch — independent of any PR. Ensures the repo's single worktree is checked
 * out at `refName`, then renders the shared Browse (tree + viewer + search).
 */
export function CodeBrowser({
  org,
  repositoryId,
  refName,
  route,
  navigate,
}: {
  org: string;
  repositoryId: string;
  refName: string;
  route: Route;
  navigate: (r: Route, opts?: { replace?: boolean }) => void;
}) {
  const ensure = useCallback(
    () => api.ensureBranchWorktree(org, repositoryId, refName),
    [org, repositoryId, refName],
  );

  return (
    <div className="codebrowser">
      <div className="codebrowser-header">
        <span className="code-repo">{repositoryId}</span>
        <span className="code-ref" title="branch">⎇ {refName}</span>
      </div>
      <Browse
        org={org}
        repositoryId={repositoryId}
        worktreeRef={refName}
        ensure={ensure}
        path={route.file}
        line={route.line}
        onOpenFile={(file, line) =>
          navigate(
            { screen: "code", repoId: repositoryId, ref: refName, file, line },
            { replace: true },
          )
        }
      />
    </div>
  );
}
