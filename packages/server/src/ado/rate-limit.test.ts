import { test, expect } from "bun:test";
import { observeHeaders, rateLimitState, withRateLimit } from "./rate-limit.js";

function headers(h: Record<string, string>): Headers {
  return new Headers(h);
}

test("observeHeaders records remaining TSTUs", () => {
  observeHeaders(headers({ "X-RateLimit-Remaining": "42" }), 1000);
  expect(rateLimitState().remaining).toBe(42);
});

test("Retry-After pushes notBefore into the future", () => {
  const now = 10_000;
  observeHeaders(headers({ "Retry-After": "3" }), now);
  expect(rateLimitState().notBefore).toBeGreaterThanOrEqual(now + 3000);
});

test("withRateLimit waits until notBefore before running", async () => {
  // Force a cool-down 50ms out.
  const base = 100_000;
  observeHeaders(headers({ "Retry-After": "0.05" }), base);
  // Retry-After of 0.05 is below 1s granularity; simulate via X-RateLimit-Delay instead.
  observeHeaders(headers({ "X-RateLimit-Delay": "1" }), base);

  let ran = false;
  let virtual = base;
  const clock = () => virtual;
  const p = withRateLimit(
    () => {
      ran = true;
      return Promise.resolve("ok");
    },
    clock,
  );
  // Advance virtual clock past the cool-down so the internal sleep resolves.
  virtual = base + 2000;
  const result = await p;
  expect(result).toBe("ok");
  expect(ran).toBe(true);
});

test("concurrency is bounded", async () => {
  let inflight = 0;
  let peak = 0;
  const tasks = Array.from({ length: 20 }, () =>
    withRateLimit(async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
    }, () => Date.now()),
  );
  await Promise.all(tasks);
  expect(peak).toBeLessThanOrEqual(6);
});
