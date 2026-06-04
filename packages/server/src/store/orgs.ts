import type { OrgConfig, ReviewFilters } from "@agent-ops/shared";
import { db } from "./db.js";

/** Per-org config + PAT storage, filter prefs, and viewed-file state. */

interface OrgRow {
  name: string;
  base_url: string;
  pat: string | null;
  added_at: number;
}

export function upsertOrg(name: string, baseUrl: string, pat: string | undefined, now: number): void {
  const token = pat?.trim() || null;
  db().run(
    `INSERT INTO orgs (name, base_url, pat, added_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       base_url = excluded.base_url,
       pat = COALESCE(excluded.pat, orgs.pat)`,
    [name, baseUrl, token, now],
  );
  db().run(`INSERT OR IGNORE INTO review_filters (org) VALUES (?)`, [name]);
}

export function clearToken(name: string): void {
  db().run(`UPDATE orgs SET pat = NULL WHERE name = ?`, [name]);
}

export function getOrgRow(name: string): OrgRow | null {
  return db().query<OrgRow, [string]>(`SELECT * FROM orgs WHERE name = ?`).get(name) ?? null;
}

export function listOrgs(): OrgConfig[] {
  const rows = db().query<OrgRow, []>(`SELECT * FROM orgs ORDER BY added_at`).all();
  return rows.map((r) => ({ name: r.name, baseUrl: r.base_url, hasToken: r.pat != null }));
}

interface FilterRow {
  users: string;
  repos: string;
  statuses: string;
}

export function getFilters(org: string): ReviewFilters {
  const row = db()
    .query<FilterRow, [string]>(`SELECT users, repos, statuses FROM review_filters WHERE org = ?`)
    .get(org);
  if (!row) return { users: [], repos: [], statuses: [] };
  return {
    users: JSON.parse(row.users) as string[],
    repos: JSON.parse(row.repos) as string[],
    statuses: JSON.parse(row.statuses) as string[],
  };
}

export function setFilters(org: string, f: ReviewFilters): void {
  db().run(
    `INSERT INTO review_filters (org, users, repos, statuses) VALUES (?, ?, ?, ?)
     ON CONFLICT(org) DO UPDATE SET users = excluded.users, repos = excluded.repos, statuses = excluded.statuses`,
    [org, JSON.stringify(f.users), JSON.stringify(f.repos), JSON.stringify(f.statuses)],
  );
}

export function setViewed(
  org: string,
  repoId: string,
  prId: number,
  path: string,
  viewed: boolean,
  now: number,
): void {
  if (viewed) {
    db().run(
      `INSERT OR REPLACE INTO viewed_files (org, repo_id, pr_id, path, viewed_at) VALUES (?, ?, ?, ?, ?)`,
      [org, repoId, prId, path, now],
    );
  } else {
    db().run(
      `DELETE FROM viewed_files WHERE org = ? AND repo_id = ? AND pr_id = ? AND path = ?`,
      [org, repoId, prId, path],
    );
  }
}

export function listViewed(org: string, repoId: string, prId: number): string[] {
  const rows = db()
    .query<{ path: string }, [string, string, number]>(
      `SELECT path FROM viewed_files WHERE org = ? AND repo_id = ? AND pr_id = ?`,
    )
    .all(org, repoId, prId);
  return rows.map((r) => r.path);
}
