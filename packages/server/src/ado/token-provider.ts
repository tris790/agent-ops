import { getOrgRow } from "../store/orgs.js";

/**
 * Abstraction over how we obtain an auth credential for an org. Today: a stored
 * PAT (Basic auth). Tomorrow: an Entra ID access token (Bearer). Keeping this
 * behind an interface means the ADO client never needs to know which.
 */
export interface TokenProvider {
  /** Returns the ready-to-use `Authorization` header value, or null if none available. */
  authHeader(org: string): Promise<string | null>;
}

/** Encodes a PAT as ADO Basic auth: base64(":" + pat). */
export function patBasicHeader(pat: string): string {
  return "Basic " + Buffer.from(":" + pat).toString("base64");
}

export class PatTokenProvider implements TokenProvider {
  // eslint-disable-next-line @typescript-eslint/require-await
  async authHeader(org: string): Promise<string | null> {
    const row = getOrgRow(org);
    if (!row?.pat) return null;
    return patBasicHeader(row.pat);
  }
}

// Future: class EntraTokenProvider implements TokenProvider { ... Bearer ... }
