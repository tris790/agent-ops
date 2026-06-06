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

/** A Graph subject from `_apis/graph/users`. `descriptor` resolves to the IMS id. */
const graphUser = z
  .object({
    descriptor: z.string(),
    displayName: z.string().optional(),
    mailAddress: z.string().optional(),
    principalName: z.string().optional(),
    directoryAlias: z.string().optional(),
    subjectKind: z.string().optional(),
  })
  .passthrough();

/** An IMS identity from `_apis/identities`. `id` matches a PR's `createdBy.id`. */
const imsIdentity = z
  .object({
    id: z.string(),
    providerDisplayName: z.string().optional(),
    subjectDescriptor: z.string().optional(),
    isContainer: z.boolean().optional(),
  })
  .passthrough();

/**
 * Every user in the org, keyed by the IMS identity id used as a PR's `createdBy.id`
 * (so the author filter matches). The Graph user list exposes only descriptors, so
 * we resolve those to IMS ids via `_apis/identities`. Both live on the vssps host.
 * Cached by callers — this makes several round-trips.
 */
export async function listOrgUsers(
  client: AdoClient,
): Promise<{ id: string; displayName?: string }[]> {
  const graphBase = client.graphBaseUrl();
  const users = await client.getAllPaged(`${graphBase}/_apis/graph/users`, graphUser, {
    apiVersion: "7.1-preview.1",
  });
  // Drop groups/scopes; they are never PR authors. (Service identities are kept.)
  const people = users.filter((u) => u.subjectKind === "user");
  // Best human-readable label per descriptor, from the Graph user (richer than IMS).
  const labelByDescriptor = new Map(people.map((u) => [u.descriptor, graphLabel(u)]));

  const byId = new Map<string, string>();
  for (const batch of chunk(people.map((u) => u.descriptor), 100)) {
    const identities = await client.getList(`${graphBase}/_apis/identities`, imsIdentity, {
      query: { subjectDescriptors: batch.join(",") },
    });
    for (const ident of identities) {
      if (!ident.id || ident.isContainer) continue; // isContainer => group, not a person
      const label =
        textualName(ident.providerDisplayName) ??
        (ident.subjectDescriptor ? labelByDescriptor.get(ident.subjectDescriptor) : undefined);
      // Skip groups (named "[Scope]\Group") and anyone we can't name textually.
      if (label && !/^\[.+]\\/.test(label)) byId.set(ident.id, label);
    }
  }
  return [...byId].map(([id, displayName]) => ({ id, displayName }));
}

/** First human-readable name for a Graph user, or undefined if none. */
function graphLabel(u: z.infer<typeof graphUser>): string | undefined {
  // principalName for AAD users is their email; for service identities it's a GUID.
  return (
    textualName(u.displayName) ??
    textualName(u.mailAddress) ??
    textualName(u.directoryAlias) ??
    textualName(u.principalName)
  );
}

/** A label only if it's a real name — not a bare GUID (service/build identities). */
function textualName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())
    ? undefined
    : value;
}

/** Splits `items` into sub-arrays of at most `size`. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
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

const adoRef = z.object({ name: z.string() }).passthrough();

/**
 * Branch names for a repo (short form, no `refs/heads/` prefix). `search` maps to
 * ADO's `filterContains` for type-ahead at repos with many branches.
 */
export async function listBranches(
  client: AdoClient,
  repositoryId: string,
  search?: string,
): Promise<string[]> {
  const refs = await client.getList(`_apis/git/repositories/${repositoryId}/refs`, adoRef, {
    query: { filter: "heads/", ...(search ? { filterContains: search } : {}) },
  });
  return refs.map((r) => r.name.replace(/^refs\/heads\//, "")).sort((a, b) => a.localeCompare(b));
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
