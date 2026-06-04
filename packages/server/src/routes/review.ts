import {
  createThreadRequest,
  replyThreadRequest,
  resolveThreadRequest,
  voteRequest,
  completePrRequest,
  abandonPrRequest,
  createPrRequest,
  editPrRequest,
} from "@agent-ops/shared";
import { json, parseBody, BadRequestError, AuthRequiredError } from "../http.js";
import { AdoClient } from "../ado/client.js";
import { PatTokenProvider } from "../ado/token-provider.js";
import { getConnectionData, getPullRequest } from "../ado/api.js";
import {
  listThreads,
  createThread,
  replyToThread,
  setThreadStatus,
  castVote,
  completePr,
  abandonPr,
  createPr,
  editPr,
  getPolicyEvaluations,
} from "../ado/review.js";
import { cached } from "../store/cache.js";

/** PR review action routes: threads, votes, complete/abandon, create/edit, policies. */

const tokens = new PatTokenProvider();
const now = () => Date.now();

function client(org: string): AdoClient {
  return AdoClient.forOrg(org, tokens);
}
function required(url: URL, name: string): string {
  const v = url.searchParams.get(name);
  if (!v) throw new BadRequestError(`missing required query param: ${name}`);
  return v;
}

/** The authenticated user's reviewer id, needed for self-vote. */
async function selfId(org: string, c: AdoClient): Promise<string> {
  const me = await cached(`me:${org}`, 60 * 60_000, now(), () => getConnectionData(c));
  if (!me.id) throw new AuthRequiredError(org);
  return me.id;
}

export async function handleReviewRoutes(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;

  // GET /api/pr/threads?org=&repositoryId=&pullRequestId=
  if (p === "/api/pr/threads" && req.method === "GET") {
    const org = required(url, "org");
    const repositoryId = required(url, "repositoryId");
    const prId = Number(required(url, "pullRequestId"));
    return json({ threads: await listThreads(client(org), repositoryId, prId) });
  }

  // POST /api/pr/threads -> create a thread
  if (p === "/api/pr/threads" && req.method === "POST") {
    const b = await parseBody(req, createThreadRequest);
    const thread = await createThread(client(b.org), b.repositoryId, b.pullRequestId, {
      content: b.content,
      filePath: b.filePath,
      rightLine: b.rightLine,
      firstComparingIteration: b.firstComparingIteration,
      secondComparingIteration: b.secondComparingIteration,
      changeTrackingId: b.changeTrackingId,
    });
    return json(thread);
  }

  // POST /api/pr/threads/reply
  if (p === "/api/pr/threads/reply" && req.method === "POST") {
    const b = await parseBody(req, replyThreadRequest);
    const thread = await replyToThread(
      client(b.org),
      b.repositoryId,
      b.pullRequestId,
      b.threadId,
      b.content,
    );
    return json(thread);
  }

  // POST /api/pr/threads/status -> resolve/reopen
  if (p === "/api/pr/threads/status" && req.method === "POST") {
    const b = await parseBody(req, resolveThreadRequest);
    const thread = await setThreadStatus(
      client(b.org),
      b.repositoryId,
      b.pullRequestId,
      b.threadId,
      b.status,
    );
    return json(thread);
  }

  // POST /api/pr/vote
  if (p === "/api/pr/vote" && req.method === "POST") {
    const b = await parseBody(req, voteRequest);
    const c = client(b.org);
    await castVote(c, b.repositoryId, b.pullRequestId, await selfId(b.org, c), b.vote);
    return json({ ok: true });
  }

  // POST /api/pr/complete
  if (p === "/api/pr/complete" && req.method === "POST") {
    const b = await parseBody(req, completePrRequest);
    const pr = await completePr(
      client(b.org),
      b.repositoryId,
      b.pullRequestId,
      b.mergeStrategy,
      b.deleteSourceBranch,
    );
    return json(pr);
  }

  // POST /api/pr/abandon
  if (p === "/api/pr/abandon" && req.method === "POST") {
    const b = await parseBody(req, abandonPrRequest);
    return json(await abandonPr(client(b.org), b.repositoryId, b.pullRequestId));
  }

  // POST /api/pr/create
  if (p === "/api/pr/create" && req.method === "POST") {
    const b = await parseBody(req, createPrRequest);
    const pr = await createPr(client(b.org), b.repositoryId, {
      title: b.title,
      description: b.description,
      sourceRefName: b.sourceRefName,
      targetRefName: b.targetRefName,
      reviewerIds: b.reviewerIds,
      isDraft: b.isDraft,
    });
    return json(pr);
  }

  // POST /api/pr/edit
  if (p === "/api/pr/edit" && req.method === "POST") {
    const b = await parseBody(req, editPrRequest);
    const patch: Record<string, unknown> = {};
    if (b.title !== undefined) patch.title = b.title;
    if (b.description !== undefined) patch.description = b.description;
    if (b.targetRefName !== undefined) patch.targetRefName = b.targetRefName;
    if (b.isDraft !== undefined) patch.isDraft = b.isDraft;
    return json(await editPr(client(b.org), b.repositoryId, b.pullRequestId, patch));
  }

  // GET /api/pr/policies?org=&repositoryId=&pullRequestId=
  if (p === "/api/pr/policies" && req.method === "GET") {
    const org = required(url, "org");
    const repositoryId = required(url, "repositoryId");
    const prId = Number(required(url, "pullRequestId"));
    const c = client(org);
    const pr = await getPullRequest(c, repositoryId, prId);
    const project = pr.repository.project;
    if (!project) return json({ policies: [] });
    const policies = await getPolicyEvaluations(c, project.name, project.id, prId);
    return json({ policies });
  }

  return null;
}
