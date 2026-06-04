import type { z } from "zod";
import { AuthRequiredError } from "../http.js";
import type { TokenProvider } from "./token-provider.js";
import { getOrgRow } from "../store/orgs.js";
import { observeHeaders, withRateLimit } from "./rate-limit.js";

/**
 * Typed Azure DevOps REST client (api-version 7.1) for a single org.
 *
 * - Auth header comes from a TokenProvider (PAT today, Entra later); a missing
 *   token surfaces as AuthRequiredError so the SPA can prompt.
 * - All traffic goes through the shared rate-limit gate.
 * - Responses are validated with zod at the boundary.
 * - Supports `continuationToken` pagination via `getAllPaged`.
 */

const API_VERSION = "7.1";

export interface AdoListResponse<T> {
  count: number;
  value: T[];
}

/** Per-request options shared across helpers. `apiVersion` overrides the 7.1 default
 *  (e.g. "7.1-preview.1" for endpoints ADO still marks as preview). */
type RequestQuery = Record<string, string | number | undefined>;
interface CallOpts {
  query?: RequestQuery;
  apiVersion?: string;
}

export class AdoClient {
  constructor(
    public readonly org: string,
    private readonly baseUrl: string,
    private readonly tokens: TokenProvider,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Resolves the configured client for an org, or throws AuthRequiredError. */
  static forOrg(org: string, tokens: TokenProvider): AdoClient {
    const row = getOrgRow(org);
    if (!row) throw new AuthRequiredError(org);
    return new AdoClient(org, row.base_url, tokens);
  }

  /** Builds an absolute URL, appending api-version. `pathOrUrl` may be project-scoped. */
  private url(pathOrUrl: string, query?: RequestQuery, apiVersion?: string): string {
    const u = pathOrUrl.startsWith("http")
      ? new URL(pathOrUrl)
      : new URL(this.baseUrl.replace(/\/$/, "") + "/" + pathOrUrl.replace(/^\//, ""));
    if (!u.searchParams.has("api-version")) {
      u.searchParams.set("api-version", apiVersion ?? API_VERSION);
    }
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  private async authHeader(): Promise<string> {
    const header = await this.tokens.authHeader(this.org);
    if (!header) throw new AuthRequiredError(this.org);
    return header;
  }

  /** Low-level request with rate limiting, one 429 retry, and auth mapping. */
  async raw(
    method: string,
    pathOrUrl: string,
    opts: {
      query?: RequestQuery;
      body?: unknown;
      accept?: string;
      apiVersion?: string;
    } = {},
  ): Promise<Response> {
    const url = this.url(pathOrUrl, opts.query, opts.apiVersion);
    const auth = await this.authHeader();

    const doFetch = () =>
      withRateLimit(async () => {
        const res = await fetch(url, {
          method,
          headers: {
            Authorization: auth,
            Accept: opts.accept ?? "application/json",
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
        observeHeaders(res.headers, this.now());
        return res;
      }, this.now);

    let res = await doFetch();

    // A PAT that is expired/invalid comes back as 401/403 -> prompt for a new one.
    // Azure DevOps also silently downgrades a bad PAT to anonymous access, returning
    // HTTP 203 with an HTML sign-in page instead of a clean 401. Detect that too.
    const contentType = res.headers.get("content-type") ?? "";
    if (res.status === 401 || res.status === 403 || res.status === 203 ||
        (res.ok && contentType.includes("text/html"))) {
      throw new AuthRequiredError(this.org);
    }

    // Hard throttle: one polite retry after the server-mandated cool-down.
    if (res.status === 429) {
      res = await doFetch();
      if (res.status === 429) {
        throw new AdoError(this.org, 429, "rate limited by Azure DevOps; try again shortly");
      }
    }

    if (!res.ok) {
      throw new AdoError(this.org, res.status, await readAdoError(res));
    }

    return res;
  }

  /** GET + zod-validate a single object. */
  async getOne<S extends z.ZodTypeAny>(
    pathOrUrl: string,
    schema: S,
    opts: CallOpts = {},
  ): Promise<z.output<S>> {
    const res = await this.raw("GET", pathOrUrl, opts);
    return schema.parse(await res.json());
  }

  /** GET a `{ count, value: [] }` list and validate each item. */
  async getList<S extends z.ZodTypeAny>(
    pathOrUrl: string,
    itemSchema: S,
    opts: CallOpts = {},
  ): Promise<z.output<S>[]> {
    const res = await this.raw("GET", pathOrUrl, opts);
    const body = (await res.json()) as AdoListResponse<unknown>;
    return (body.value ?? []).map((v) => itemSchema.parse(v));
  }

  /**
   * GET every page of a list endpoint using ADO continuation tokens.
   * The server returns the next token in the `x-ms-continuationtoken` header.
   */
  async getAllPaged<S extends z.ZodTypeAny>(
    pathOrUrl: string,
    itemSchema: S,
    opts: CallOpts & { pageSize?: number; maxPages?: number } = {},
  ): Promise<z.output<S>[]> {
    const pageSize = opts.pageSize ?? 200;
    const maxPages = opts.maxPages ?? 50;
    const all: z.output<S>[] = [];
    let token: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      const res = await this.raw("GET", pathOrUrl, {
        apiVersion: opts.apiVersion,
        query: { ...opts.query, $top: pageSize, continuationToken: token },
      });
      const body = (await res.json()) as AdoListResponse<unknown>;
      for (const v of body.value ?? []) all.push(itemSchema.parse(v));
      token = res.headers.get("x-ms-continuationtoken") ?? undefined;
      if (!token || (body.value?.length ?? 0) === 0) break;
    }
    return all;
  }

  /** POST/PATCH/PUT with a JSON body, validating the response. */
  async send<S extends z.ZodTypeAny>(
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    pathOrUrl: string,
    body: unknown,
    schema: S,
    opts: CallOpts = {},
  ): Promise<z.output<S>> {
    const res = await this.raw(method, pathOrUrl, { body, ...opts });
    return schema.parse(await res.json());
  }
}

/** Extracts a human-readable message from an ADO error response (JSON or text). */
async function readAdoError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return res.statusText;
  try {
    const body = JSON.parse(text) as { message?: string };
    return body.message ?? text;
  } catch {
    return text;
  }
}

/** Non-auth ADO failures (4xx/5xx) the SPA can show as a generic error. */
export class AdoError extends Error {
  constructor(
    public readonly org: string,
    public readonly status: number,
    message: string,
  ) {
    super(`ADO ${status}: ${message}`);
  }
}
