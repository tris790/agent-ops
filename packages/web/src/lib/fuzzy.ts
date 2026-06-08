/**
 * Tiny dependency-free fuzzy matcher for filtering large option lists (1–2k users,
 * 1000s of repos/pipelines). Subsequence match with bonuses for contiguity and
 * word-boundary starts, so "rev" ranks "ReviewQueue" above "driver". An empty
 * needle matches everything with score 0 (callers keep the original order).
 */

/**
 * Returns a match score (higher = better) or null when `needle` is not a
 * subsequence of `haystack`. Case-insensitive.
 */
export function fuzzyScore(needle: string, haystack: string): number | null {
  const n = needle.trim().toLowerCase();
  if (!n) return 0;
  const h = haystack.toLowerCase();

  let score = 0;
  let hi = 0;
  let prevMatch = -2; // index in haystack of the previous matched char
  for (let ni = 0; ni < n.length; ni++) {
    const c = n[ni]!;
    const found = h.indexOf(c, hi);
    if (found === -1) return null;
    // Base point for the match.
    score += 1;
    // Contiguity bonus: consecutive matches read as a real substring.
    if (found === prevMatch + 1) score += 3;
    // Word-boundary bonus: match at start, or after a separator/camelCase hump.
    const prev = found > 0 ? haystack[found - 1]! : "";
    const isBoundary =
      found === 0 || /[\s/\\._-]/.test(prev) || (prev === prev.toLowerCase() && haystack[found] !== h[found]);
    if (isBoundary) score += 2;
    prevMatch = found;
    hi = found + 1;
  }
  // Prefer shorter haystacks (tighter matches) as a tie-breaker.
  score -= haystack.length * 0.01;
  return score;
}

/**
 * Filters `items` to those matching `needle` and sorts by descending score.
 * `key` extracts the string to match against. Empty needle = passthrough
 * (unchanged order).
 */
export function fuzzyFilter<T>(items: T[], needle: string, key: (item: T) => string): T[] {
  if (!needle.trim()) return items;
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const score = fuzzyScore(needle, key(item));
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}
