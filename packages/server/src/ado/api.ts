import { z } from "zod";
import {
  adoPullRequest,
  adoRepository,
  type AdoPullRequest,
  type AdoRepository,
  type PrStatus,
} from "@agent-ops/shared";
import type { AdoClient } from "./client.js";
import { AuthRequiredError } from "../http.js";

/**
 * High-level Azure DevOps operations composed from the typed client.
 * Project-scoped paths are built per-call; org-scoped paths omit the project.
 */

const connectionData = z
  .object({
    authenticatedUser: z
      .object({ id: z.string(), providerDisplayName: z.string().optional() })
      .passthrough(),
  })
  .passthrough();

/** The authenticated user's identity (id needed for self-vote). Cached by callers.
 *  connectionData is still a preview resource, so it requires the -preview suffix. */
export async function getConnectionData(
  client: AdoClient,
): Promise<{ id: string; displayName?: string }> {
  const data = await client.getOne("_apis/connectionData", connectionData, {
    apiVersion: "7.1-preview",
  });
  const id = data.authenticatedUser.id;
  const name = data.authenticatedUser.providerDisplayName;
  // ADO downgrades a bad/expired PAT to an anonymous identity instead of a 401.
  // Anonymous shows up as the all-zero GUID, the all-"a" GUID (on *.visualstudio.com),
  // or displayName "Anonymous". Treat any of these as auth required.
  if (ANONYMOUS_IDENTITY_IDS.has(id) || name === "Anonymous") {
    throw new AuthRequiredError(client.org);
  }
  return { id, displayName: name };
}

const ANONYMOUS_IDENTITY_IDS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
]);

/** All repositories across all projects in the org. */
export async function listRepositories(client: AdoClient): Promise<AdoRepository[]> {
  // Org-scoped: returns repos for every project the user can see.
  return client.getList("_apis/git/repositories", adoRepository);
}

const adoProject = z
  .object({ id: z.string(), name: z.string() })
  .passthrough();

/** All projects in the org (pipelines are project-scoped). */
export async function listProjects(client: AdoClient): Promise<{ id: string; name: string }[]> {
  return client.getList("_apis/projects", adoProject);
}

/** A single repository (for its remoteUrl / clone URL). */
export async function getRepository(
  client: AdoClient,
  repositoryId: string,
): Promise<AdoRepository> {
  return client.getOne(`_apis/git/repositories/${repositoryId}`, adoRepository);
}

export interface ListPullRequestsOptions {
  project?: string;
  repositoryId?: string;
  status?: PrStatus;
  creatorId?: string;
  reviewerId?: string;
  /** Server-side paging for the infinite "all active" list. */
  top?: number;
  skip?: number;
}

/**
 * A single page of pull requests. When paging (top/skip given) we fetch exactly
 * one page so the UI can lazily load more; otherwise we fetch all.
 */
export async function listPullRequests(
  client: AdoClient,
  opts: ListPullRequestsOptions = {},
): Promise<AdoPullRequest[]> {
  const base = opts.repositoryId
    ? `${proj(opts.project)}_apis/git/repositories/${opts.repositoryId}/pullrequests`
    : `${proj(opts.project)}_apis/git/pullrequests`;

  const query = {
    "searchCriteria.status": opts.status ?? "active",
    "searchCriteria.creatorId": opts.creatorId,
    "searchCriteria.reviewerId": opts.reviewerId,
  };

  // Paged request: one page only (the SPA drives load-more).
  if (opts.top !== undefined || opts.skip !== undefined) {
    return client.getList(base, adoPullRequest, {
      query: { ...query, $top: opts.top ?? 30, $skip: opts.skip ?? 0 },
    });
  }

  return client.getAllPaged(base, adoPullRequest, { query });
}

export async function getPullRequest(
  client: AdoClient,
  repositoryId: string,
  pullRequestId: number,
  project?: string,
): Promise<AdoPullRequest> {
  return client.getOne(
    `${proj(project)}_apis/git/repositories/${repositoryId}/pullrequests/${pullRequestId}`,
    adoPullRequest,
  );
}

/** Project path segment ("project/" or "") for building scoped URLs. */
function proj(project?: string): string {
  return project ? `${encodeURIComponent(project)}/` : "";
}
