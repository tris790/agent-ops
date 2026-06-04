import { Database } from "bun:sqlite";
import { paths } from "../config.js";

/**
 * Single SQLite connection for all local persistence: per-org PAT + base URL,
 * home-screen filter prefs, per-PR viewed-file state, and a metadata cache.
 * WAL mode keeps reads snappy while a write is in flight.
 */

let _db: Database | null = null;

export function db(): Database {
  if (_db) return _db;
  const d = new Database(paths.dbFile, { create: true });
  d.exec("PRAGMA journal_mode = WAL;");
  d.exec("PRAGMA foreign_keys = ON;");
  migrate(d);
  _db = d;
  return d;
}

function migrate(d: Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS orgs (
      name      TEXT PRIMARY KEY,
      base_url  TEXT NOT NULL,
      pat       TEXT,                 -- null when unset/cleared; user is prompted
      added_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS review_filters (
      org       TEXT PRIMARY KEY REFERENCES orgs(name) ON DELETE CASCADE,
      users     TEXT NOT NULL DEFAULT '[]',  -- JSON arrays
      repos     TEXT NOT NULL DEFAULT '[]',
      statuses  TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS viewed_files (
      org        TEXT NOT NULL,
      repo_id    TEXT NOT NULL,
      pr_id      INTEGER NOT NULL,
      path       TEXT NOT NULL,
      viewed_at  INTEGER NOT NULL,
      PRIMARY KEY (org, repo_id, pr_id, path)
    );

    -- Generic key/value cache for ADO metadata (repos, identities, PR lists).
    CREATE TABLE IF NOT EXISTS cache (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,        -- JSON
      expires_at INTEGER               -- epoch ms; null = no expiry
    );

    -- Draft comments/reviews so a half-written review survives restarts.
    CREATE TABLE IF NOT EXISTS drafts (
      org        TEXT NOT NULL,
      repo_id    TEXT NOT NULL,
      pr_id      INTEGER NOT NULL,
      draft_key  TEXT NOT NULL,        -- e.g. "thread:<file>:<line>" or "review"
      content    TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (org, repo_id, pr_id, draft_key)
    );
  `);
}
