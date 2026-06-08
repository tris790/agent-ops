import { expect, test, describe } from "bun:test";
import { fuzzyScore, fuzzyFilter } from "./fuzzy.js";

describe("fuzzyScore", () => {
  test("returns null when not a subsequence", () => {
    expect(fuzzyScore("xyz", "review")).toBeNull();
  });

  test("empty needle matches everything with score 0", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  test("ranks word-boundary/contiguous matches above scattered ones", () => {
    // "rev" is contiguous + at a boundary in "review", but scattered in "retrieve".
    const boundary = fuzzyScore("rev", "review")!;
    const scattered = fuzzyScore("rev", "retrieve")!;
    expect(boundary).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(boundary).toBeGreaterThan(scattered);
  });
});

describe("fuzzyFilter", () => {
  test("filters out non-matches and sorts by score", () => {
    const items = ["driver", "ReviewQueue", "preview", "unrelated"];
    const out = fuzzyFilter(items, "rev", (s) => s);
    expect(out).not.toContain("unrelated");
    expect(out[0]).toBe("ReviewQueue"); // best (prefix, contiguous) ranks first
  });

  test("empty needle is a passthrough preserving order", () => {
    const items = ["b", "a", "c"];
    expect(fuzzyFilter(items, "", (s) => s)).toEqual(items);
  });
});
