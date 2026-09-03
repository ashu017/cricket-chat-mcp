// Python's `difflib.get_close_matches`, reimplemented.
//
// Every `did_you_mean` in the project is this function, and the Python
// implementation's exact output is pinned by three of the committed payload
// fixtures -- `resolve_entity` misses record the suggestions they offered. A
// different similarity measure (Levenshtein, trigram, Jaro-Winkler) would rank
// candidates differently and those fixtures would fail for a reason that has nothing
// to do with cricket.
//
// So this is a faithful port of `difflib.SequenceMatcher.ratio` rather than "some
// fuzzy match": same recursive longest-matching-block decomposition, same 2*M/T
// ratio, same 0.6 cutoff, same tie-break. Written here rather than taken from npm
// because it is 60 lines and a dependency added for 60 lines is a dependency that
// has to be audited, pinned and explained.
//
// Two simplifications, both provably output-identical:
//
// 1.  `isjunk` is always None in our call sites, so the junk-extension passes in
//     `find_longest_match` are dead code and the block the DP finds is already
//     maximal.
// 2.  difflib filters candidates with `real_quick_ratio()` and `quick_ratio()`
//     before `ratio()`. Both are documented upper bounds on `ratio()`, so they are
//     a speed optimisation and cannot change which candidates pass the cutoff.
//
// The autojunk heuristic (treat characters appearing in >1% of a 200+ character
// sequence as junk) is not ported: it only engages at `len(b) >= 200`, and `b` here
// is a player name or a filter field.

interface Match {
  a: number;
  b: number;
  size: number;
}

/**
 * The longest block matching `a[alo:ahi]` against `b[blo:bhi]`, earliest in `a`
 * then earliest in `b`.
 *
 * `b2j` maps a character of `b` to its ascending positions; `j2len` carries, for
 * each position in `b`, the length of the match ending there in the previous
 * iteration -- so the whole thing is a one-row-at-a-time longest-common-substring
 * DP. The `>` in the comparison is what makes it prefer the earliest block of a
 * given length, which is why this and difflib agree on ties.
 *
 * difflib's version also takes `b` itself, for two loops that widen the match across
 * "popular" elements. Those only fire when there is junk, and there is none here --
 * `isjunk` is None and `autojunk` is off for `get_close_matches` on strings this
 * short -- so with no junk the DP block is already maximal and the loops are no-ops.
 * The parameter is left out rather than left unused, so nobody has to work that out
 * twice.
 */
function longestMatch(
  a: string,
  b2j: Map<string, number[]>,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
): Match {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map<number, number>();

  for (let i = alo; i < ahi; i += 1) {
    const nextj2len = new Map<number, number>();
    for (const j of b2j.get(a[i] as string) ?? []) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      nextj2len.set(j, k);
      if (k > bestsize) {
        besti = i - k + 1;
        bestj = j - k + 1;
        bestsize = k;
      }
    }
    j2len = nextj2len;
  }

  return { a: besti, b: bestj, size: bestsize };
}

/** Total characters matched, summed over the recursive block decomposition. */
function matchedCharacters(a: string, b: string, b2j: Map<string, number[]>): number {
  let total = 0;
  // An explicit stack rather than recursion: the queue order does not matter here
  // because only the sum is wanted, and a long pair of strings should not be able
  // to overflow the JS stack.
  const queue: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]];
  while (queue.length > 0) {
    const region = queue.pop();
    if (region === undefined) break;
    const [alo, ahi, blo, bhi] = region;
    const match = longestMatch(a, b2j, alo, ahi, blo, bhi);
    if (match.size === 0) continue;
    total += match.size;
    if (alo < match.a && blo < match.b) queue.push([alo, match.a, blo, match.b]);
    const aEnd = match.a + match.size;
    const bEnd = match.b + match.size;
    if (aEnd < ahi && bEnd < bhi) queue.push([aEnd, ahi, bEnd, bhi]);
  }
  return total;
}

/** Positions of each character of `b`, ascending. `find_longest_match` needs both. */
function indexOfCharacters(b: string): Map<string, number[]> {
  const b2j = new Map<string, number[]>();
  for (let j = 0; j < b.length; j += 1) {
    const character = b[j] as string;
    const positions = b2j.get(character);
    if (positions === undefined) b2j.set(character, [j]);
    else positions.push(j);
  }
  return b2j;
}

/**
 * `SequenceMatcher(None, a, b).ratio()`: 2*M/T, where M is the matched character
 * count and T the combined length. 1.0 for identical strings, 0.0 for disjoint ones.
 */
export function similarityRatio(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 1.0;
  return (2.0 * matchedCharacters(a, b, indexOfCharacters(b))) / total;
}

/**
 * `difflib.get_close_matches(value, candidates, n, cutoff)`.
 *
 * The tie-break matters and is not arbitrary: difflib uses `heapq.nlargest` over
 * `(ratio, candidate)` tuples, so equal ratios are ordered by candidate string
 * DESCENDING. Sorting ascending instead would reverse the suggestions on any query
 * that scores two names equally, which is common for a surname shared by two players.
 */
export function closeMatches(
  value: string,
  candidates: Iterable<string>,
  n = 3,
  cutoff = 0.6,
): string[] {
  const scored: Array<[number, string]> = [];
  for (const candidate of candidates) {
    const ratio = similarityRatio(candidate, value);
    if (ratio >= cutoff) scored.push([ratio, candidate]);
  }
  scored.sort((left, right) => right[0] - left[0] || (right[1] > left[1] ? 1 : -1));
  return scored.slice(0, n).map(([, candidate]) => candidate);
}
