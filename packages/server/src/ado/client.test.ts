import { test, expect, afterEach } from "bun:test";
import { z } from "zod";
import { normalizeOrgBaseUrl } from "@agent-ops/shared";
import { AdoClient } from "./client.js";
import type { TokenProvider } from "./token-provider.js";
import { AuthRequiredError } from "../http.js";

const tokens: TokenProvider = { authHeader: () => Promise.resolve("Basic dummy") };
const noToken: TokenProvider = { authHeader: () => Promise.resolve(null) };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch;
}

const item = z.object({ id: z.number() });

test("missing token throws AuthRequiredError", async () => {
  const client = new AdoClient("org", "https://dev.azure.com/org", noToken);
  await expect(client.getOne("_apis/x", z.object({}))).rejects.toBeInstanceOf(AuthRequiredError);
});

test("appends api-version and builds project-scoped URLs", async () => {
  let seen = "";
  mockFetch((url) => {
    seen = url;
    return new Response(JSON.stringify({ count: 0, value: [] }), { status: 200 });
  });
  const client = new AdoClient("org", "https://dev.azure.com/org", tokens);
  await client.getList("Proj/_apis/git/repositories", item);
  expect(seen).toContain("https://dev.azure.com/org/Proj/_apis/git/repositories");
  expect(seen).toContain("api-version=7.1");
});

test("401 maps to AuthRequiredError (expired PAT)", async () => {
  mockFetch(() => new Response("nope", { status: 401 }));
  const client = new AdoClient("org", "https://dev.azure.com/org", tokens);
  await expect(client.getOne("_apis/x", z.object({}))).rejects.toBeInstanceOf(AuthRequiredError);
});

test("normalizeOrgBaseUrl canonicalizes www./scheme/trailing-slash, leaves valid forms alone", () => {
  expect(normalizeOrgBaseUrl("https://www.dev.azure.com/ClaudeOps")).toBe(
    "https://dev.azure.com/ClaudeOps",
  );
  expect(normalizeOrgBaseUrl("https://www.dev.azure.com/org/")).toBe("https://dev.azure.com/org");
  expect(normalizeOrgBaseUrl("http://dev.azure.com/org")).toBe("https://dev.azure.com/org");
  expect(normalizeOrgBaseUrl("  https://dev.azure.com/org  ")).toBe("https://dev.azure.com/org");
  // Already-canonical forms pass through unchanged.
  expect(normalizeOrgBaseUrl("https://dev.azure.com/org")).toBe("https://dev.azure.com/org");
  expect(normalizeOrgBaseUrl("https://org.visualstudio.com")).toBe("https://org.visualstudio.com");
});

test("sibling-host derivations work after normalizing a www. base URL", () => {
  const base = normalizeOrgBaseUrl("https://www.dev.azure.com/org");
  const client = new AdoClient("org", base, tokens);
  expect(client.almSearchBaseUrl()).toBe("https://almsearch.dev.azure.com/org");
  expect(client.graphBaseUrl()).toBe("https://vssps.dev.azure.com/org");
});

test("almSearchBaseUrl derives the almsearch sibling host for both URL forms", () => {
  expect(
    new AdoClient("org", "https://dev.azure.com/org", tokens).almSearchBaseUrl(),
  ).toBe("https://almsearch.dev.azure.com/org");
  expect(
    new AdoClient("org", "https://org.visualstudio.com", tokens).almSearchBaseUrl(),
  ).toBe("https://org.almsearch.visualstudio.com");
});

test("getAllPaged follows x-ms-continuationtoken across pages", async () => {
  let call = 0;
  mockFetch((url) => {
    call++;
    if (!url.includes("continuationToken")) {
      return new Response(JSON.stringify({ count: 1, value: [{ id: 1 }] }), {
        status: 200,
        headers: { "x-ms-continuationtoken": "page2" },
      });
    }
    // second page, no token -> stop
    return new Response(JSON.stringify({ count: 1, value: [{ id: 2 }] }), { status: 200 });
  });
  const client = new AdoClient("org", "https://dev.azure.com/org", tokens);
  const all = await client.getAllPaged("_apis/git/pullrequests", item);
  expect(all.map((x) => x.id)).toEqual([1, 2]);
  expect(call).toBe(2);
});
