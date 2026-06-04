/**
 * A single global request gate for all Azure DevOps traffic.
 *
 * ADO meters usage in TSTUs over a sliding 5-minute window (global ceiling 200).
 * Crucially, throttled responses can still arrive as HTTP 200 carrying a
 * `Retry-After` header and `X-RateLimit-*` headers — so we must read headers on
 * every response, not just react to 429s. This gate:
 *   - serializes a small number of concurrent requests,
 *   - delays upcoming requests when the server tells us to (Retry-After / Delay),
 *   - pre-emptively slows down as remaining TSTUs approach zero.
 */

export interface RateLimitState {
  /** Epoch ms before which we should not send the next request. */
  notBefore: number;
  /** Last observed remaining TSTUs (null if unknown). */
  remaining: number | null;
}

const state: RateLimitState = { notBefore: 0, remaining: null };

/** Bounded concurrency so a burst of UI calls can't stampede the API. */
const MAX_CONCURRENT = 6;
let active = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
  active--;
  const next = waiters.shift();
  if (next) {
    active++;
    next();
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/** Reads rate-limit signals off a response and updates the shared gate state. */
export function observeHeaders(headers: Headers, now: number): void {
  const retryAfter = headers.get("Retry-After");
  const delay = headers.get("X-RateLimit-Delay");
  const remaining = headers.get("X-RateLimit-Remaining");

  if (remaining != null) {
    const n = Number(remaining);
    state.remaining = Number.isFinite(n) ? n : state.remaining;
  }

  // Retry-After / Delay are in seconds.
  const waitSec = Math.max(toSeconds(retryAfter), toSeconds(delay));
  if (waitSec > 0) {
    state.notBefore = Math.max(state.notBefore, now + waitSec * 1000);
  }
}

function toSeconds(value: string | null): number {
  if (!value) return 0;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Runs `fn` (a single fetch) under the gate: waits for a concurrency slot and
 * for any server-mandated cool-down, then executes. `fn` is responsible for
 * calling `observeHeaders` on its response.
 */
export async function withRateLimit<T>(fn: () => Promise<T>, now: () => number): Promise<T> {
  await acquire();
  try {
    const wait = state.notBefore - now();
    if (wait > 0) await sleep(wait);
    // Gentle pre-emptive slowdown when we're nearly out of budget.
    if (state.remaining != null && state.remaining <= 5) await sleep(1000);
    return await fn();
  } finally {
    release();
  }
}

/** Test/diagnostic accessor. */
export function rateLimitState(): Readonly<RateLimitState> {
  return state;
}
