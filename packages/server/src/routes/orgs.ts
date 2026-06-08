import { setTokenRequest, setReviewFiltersRequest, normalizeOrgBaseUrl } from "@agent-ops/shared";
import { BadRequestError, json, parseBody } from "../http.js";
import {
  listOrgs,
  upsertOrg,
  clearToken,
  getOrgRow,
  getFilters,
  setFilters,
} from "../store/orgs.js";

/** Routes for managing configured orgs, their PATs, and home-screen filters. */

export async function handleOrgRoutes(req: Request, url: URL): Promise<Response | null> {
  // GET /api/orgs -> list configured orgs (+ whether each has a token)
  if (url.pathname === "/api/orgs" && req.method === "GET") {
    return json({ orgs: listOrgs() });
  }

  // POST /api/token -> store/replace a PAT for an org
  if (url.pathname === "/api/token" && req.method === "POST") {
    const body = await parseBody(req, setTokenRequest);
    const pat = body.pat?.trim();
    if (!pat && !getOrgRow(body.org)?.pat) {
      throw new BadRequestError("personal access token required");
    }
    upsertOrg(body.org, normalizeOrgBaseUrl(body.baseUrl), body.pat, Date.now());
    return json({ ok: true });
  }

  // DELETE /api/token?org=NAME -> clear a stored PAT (forces re-prompt)
  if (url.pathname === "/api/token" && req.method === "DELETE") {
    const org = url.searchParams.get("org");
    if (org) clearToken(org);
    return json({ ok: true });
  }

  // GET /api/filters?org=NAME
  if (url.pathname === "/api/filters" && req.method === "GET") {
    const org = url.searchParams.get("org") ?? "";
    return json(getFilters(org));
  }

  // PUT /api/filters -> persist filter selections
  if (url.pathname === "/api/filters" && req.method === "PUT") {
    const body = await parseBody(req, setReviewFiltersRequest);
    const { org, ...filters } = body;
    setFilters(org, filters);
    return json({ ok: true });
  }

  return null;
}
