import type { PrStatus } from "@agent-ops/shared";
import { json, errorResponse } from "../http.js";
import { AdoClient } from "../ado/client.js";
import { PatTokenProvider } from "../ado/token-provider.js";
import {
  getConnectionData,
  listBranches,
  listPullRequests,
  listRepositories,
} from "../ado/api.js";
import { cached } from "../store/cache.js";

/** Read routes backed by the Azure DevOps REST API. */

const tokens = new PatTokenProvider();
const now = () => Date.now();

/** Requires `?org=` and returns a configured client (throws AuthRequiredError if no token). */
function clientFromQuery(url: URL): { org: string; client: AdoClient } {
  const org = url.searchParams.get("org") ?? "";
  return { org, client: AdoClient.forOrg(org, tokens) };
}

function numParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export async function handleAdoRoutes(req: Request, url: URL): Promise<Response | null> {
  if (req.method !== "GET") return null;

  // GET /api/me?org= -> authenticated user identity (cached 1h)
  if (url.pathname === "/api/me") {
    const { org, client } = clientFromQuery(url);
    const me = await cached(`me:${org}`, 60 * 60_000, now(), () => getConnectionData(client));
    return json(me);
  }

  // GET /api/repos?org= -> all repositories (cached 5m)
  if (url.pathname === "/api/repos") {
    const { org, client } = clientFromQuery(url);
    const repos = await cached(`repos:${org}`, 5 * 60_000, now(), () => listRepositories(client));
    return json({ repos });
  }

  // GET /api/branches?org=&repositoryId=&search= -> branch names (cached 1m)
  if (url.pathname === "/api/branches") {
    const { org, client } = clientFromQuery(url);
    const repositoryId = url.searchParams.get("repositoryId") ?? "";
    const search = url.searchParams.get("search") ?? undefined;
    if (!repositoryId) return errorResponse("bad-request", "repositoryId required", 400);
    // Only cache the unfiltered list; filtered (type-ahead) queries pass through.
    const branches = search
      ? await listBranches(client, repositoryId, search)
      : await cached(`branches:${org}:${repositoryId}`, 60_000, now(), () =>
          listBranches(client, repositoryId),
        );
    return json({ branches });
  }

  // GET /api/prs?org=&repositoryId=&project=&status=&creatorId=&reviewerId=&top=&skip=
  if (url.pathname === "/api/prs") {
    const { client } = clientFromQuery(url);
    const top = numParam(url, "top");
    const skip = numParam(url, "skip");
    const prs = await listPullRequests(client, {
      project: url.searchParams.get("project") ?? undefined,
      repositoryId: url.searchParams.get("repositoryId") ?? undefined,
      status: (url.searchParams.get("status") as PrStatus | null) ?? undefined,
      creatorId: url.searchParams.get("creatorId") ?? undefined,
      reviewerId: url.searchParams.get("reviewerId") ?? undefined,
      top,
      skip,
    });
    // hasMore is a best-effort hint for the infinite list: a full page likely has more.
    const hasMore = top !== undefined ? prs.length === top : false;
    return json({ prs, hasMore });
  }

  return null;
}

export { tokens };
