import { json, BadRequestError } from "../http.js";
import { AdoClient } from "../ado/client.js";
import { searchCode } from "../ado/api.js";
import { tokens } from "./ado.js";

/**
 * Global code search via the Azure DevOps Code Search API (org-wide, across all
 * repos). This is intentionally NOT the per-worktree ripgrep search in browse.ts:
 * that only sees repos already cloned locally, whereas this answers from ADO's
 * index over every repo. See {@link searchCode}.
 */
export async function handleSearchRoutes(req: Request, url: URL): Promise<Response | null> {
  if (req.method !== "GET") return null;

  // GET /api/search/code?org=&q=&repo=&path=&top=
  if (url.pathname === "/api/search/code") {
    const org = url.searchParams.get("org");
    const q = url.searchParams.get("q");
    if (!org) throw new BadRequestError("org required");
    if (!q || !q.trim()) throw new BadRequestError("q required");

    const client = AdoClient.forOrg(org, tokens);
    const result = await searchCode(client, {
      text: q,
      repo: url.searchParams.get("repo") ?? undefined,
      path: url.searchParams.get("path") ?? undefined,
      top: Number(url.searchParams.get("top")) || undefined,
    });
    return json(result);
  }

  return null;
}
