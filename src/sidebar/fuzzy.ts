// Fuzzy file matching for quick open.

/**
 * Score `candidate` against `query` (both matched case-insensitively), or
 * null when the query's characters do not all appear in order. Higher is
 * better: runs of consecutive characters, matches at the start of a path
 * segment or word, and matches in the file name all count for more.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  if (!query) return 0;
  const needle = query.toLowerCase();
  const hay = candidate.toLowerCase();
  const nameStart = candidate.lastIndexOf("/") + 1;
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of needle) {
    const at = hay.indexOf(char, from);
    if (at < 0) return null;
    score += 1;
    if (at === previous + 1) score += 4;
    if (at === 0 || "/._- ".includes(hay[at - 1])) score += 3;
    if (at >= nameStart) score += 2;
    previous = at;
    from = at + 1;
  }
  // Prefer shorter paths among equal matches.
  return score - candidate.length / 200;
}

export function fuzzyFilter(query: string, candidates: string[], limit: number): string[] {
  if (!query) return candidates.slice(0, limit);
  const scored: { candidate: string; score: number }[] = [];
  for (const candidate of candidates) {
    const score = fuzzyScore(query, candidate);
    if (score !== null) scored.push({ candidate, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}
