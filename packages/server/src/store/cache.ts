import { db } from "./db.js";

/** Tiny JSON key/value cache with optional TTL, backed by the SQLite `cache` table. */

export function cacheGet<T>(key: string, now: number): T | null {
  const row = db()
    .query<{ value: string; expires_at: number | null }, [string]>(
      `SELECT value, expires_at FROM cache WHERE key = ?`,
    )
    .get(key);
  if (!row) return null;
  if (row.expires_at != null && row.expires_at < now) {
    db().run(`DELETE FROM cache WHERE key = ?`, [key]);
    return null;
  }
  return JSON.parse(row.value) as T;
}

export function cacheSet(key: string, value: unknown, now: number, ttlMs?: number): void {
  const expires = ttlMs != null ? now + ttlMs : null;
  db().run(
    `INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)`,
    [key, JSON.stringify(value), expires],
  );
}

/** Returns the cached value or computes, stores, and returns it. */
export async function cached<T>(
  key: string,
  ttlMs: number,
  now: number,
  compute: () => Promise<T>,
): Promise<T> {
  const hit = cacheGet<T>(key, now);
  if (hit != null) return hit;
  const value = await compute();
  cacheSet(key, value, now, ttlMs);
  return value;
}
