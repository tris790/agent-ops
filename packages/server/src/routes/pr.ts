import { setViewedRequest } from "@agent-ops/shared";
import { json, parseBody, BadRequestError } from "../http.js";
import { AdoClient } from "../ado/client.js";
import { PatTokenProvider } from "../ado/token-provider.js";
import { getPullRequest, getRepository } from "../ado/api.js";
import { getPrDiffMeta, getFileContent } from "../ado/diff.js";
import { listViewed, setViewed } from "../store/orgs.js";
import { ensureWorktree } from "../git/worktree.js";
import { cached } from "../store/cache.js";

/** PR detail routes: single PR, diff metadata, per-file content, viewed-state. */

const tokens = new PatTokenProvider();

function client(url: URL): AdoClient {
  const org = url.searchParams.get("org") ?? "";
  return AdoClient.forOrg(org, tokens);
}

function required(url: URL, name: string): string {
  const v = url.searchParams.get(name);
  if (!v) throw new BadRequestError(`missing required query param: ${name}`);
  return v;
}

export async function handlePrRoutes(req: Request, url: URL): Promise<Response | null> {
  // GET /api/pr?org=&repositoryId=&pullRequestId=
  if (url.pathname === "/api/pr" && req.method === "GET") {
    const repositoryId = required(url, "repositoryId");
    const prId = Number(required(url, "pullRequestId"));
    const pr = await getPullRequest(client(url), repositoryId, prId);
    return json(pr);
  }

  // GET /api/pr/diff?org=&repositoryId=&pullRequestId=&iterationId=
  if (url.pathname === "/api/pr/diff" && req.method === "GET") {
    const repositoryId = required(url, "repositoryId");
    const prId = Number(required(url, "pullRequestId"));
    const iterationId = url.searchParams.get("iterationId");
    const meta = await getPrDiffMeta(
      client(url),
      repositoryId,
      prId,
      iterationId ? Number(iterationId) : undefined,
    );
    return json(meta);
  }

  // GET /api/pr/file?org=&repositoryId=&path=&commit=
  if (url.pathname === "/api/pr/file" && req.method === "GET") {
    const repositoryId = required(url, "repositoryId");
    const path = required(url, "path");
    const commit = url.searchParams.get("commit") ?? "";
    const file = await getFileContent(client(url), repositoryId, path, commit);
    return json(file);
  }

  // GET /api/pr/viewed?org=&repositoryId=&pullRequestId=
  if (url.pathname === "/api/pr/viewed" && req.method === "GET") {
    const org = url.searchParams.get("org") ?? "";
    const repositoryId = required(url, "repositoryId");
    const prId = Number(required(url, "pullRequestId"));
    return json({ paths: listViewed(org, repositoryId, prId) });
  }

  // POST /api/pr/viewed  { org, repositoryId, pullRequestId, path, viewed }
  if (url.pathname === "/api/pr/viewed" && req.method === "POST") {
    const body = await parseBody(req, setViewedRequest);
    setViewed(body.org, body.repositoryId, body.pullRequestId, body.path, body.viewed, Date.now());
    return json({ ok: true });
  }

  // POST /api/pr/worktree?org=&repositoryId=&pullRequestId=
  // Clones the repo (if needed) and checks out the PR's source commit on disk.
  // Progress streams over /events. Returns the worktree path once ready.
  if (url.pathname === "/api/pr/worktree" && req.method === "POST") {
    const org = url.searchParams.get("org") ?? "";
    const repositoryId = required(url, "repositoryId");
    const prId = Number(required(url, "pullRequestId"));
    const c = client(url);
    const repo = await cached(`repo:${org}:${repositoryId}`, 60 * 60_000, Date.now(), () =>
      getRepository(c, repositoryId),
    );
    if (!repo.remoteUrl) throw new BadRequestError("repository has no remote URL");
    const meta = await getPrDiffMeta(c, repositoryId, prId);
    const handle = await ensureWorktree(org, repositoryId, repo.remoteUrl, prId, meta.sourceCommit);
    return json({ path: handle.path, commit: meta.sourceCommit });
  }

  return null;
}
