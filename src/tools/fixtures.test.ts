// The Python implementation is the oracle, and these are its recorded answers.
//
// `tests/fixtures/tool_payloads/*.json` were produced by the shipped Python tools
// against the real warehouse. Every one of them is replayed here through the ported
// tool with the same input, and the whole payload -- shape and numbers -- is compared.
//
// The comparison is not "close enough". It reports every divergence, and each case
// declares the exact set it is allowed to have, with the reason. A new divergence, or
// the disappearance of a declared one, fails the suite. That is the property worth
// having: it makes an accidental change to a metric impossible to land quietly, while
// still recording -- in the one place a reader will look -- the handful of places the
// port deliberately differs from a fixture and why.
//
// Two classes of declared divergence appear below, and no others:
//
//   1. The fixtures are older than the Python they came from. Several metrics
//      (`dots`, `fours_conceded`, `sixes_conceded`, `boundary_conceded_pct`) and the
//      bowling-grain prose for `average`/`strike_rate`/`dot_pct` were added to
//      `definitions.py` after these files were written. The port matches the current
//      Python; the fixture records the older answer. Numbers, never prose, are what
//      these files are the oracle for.
//   2. Two error payloads name a more precise `field` than pydantic could.
//
// Two classes that used to be here are gone, both resolved at integration rather than
// papered over:
//
//   *  `MIN_INNINGS` read 1 in `definitions.py` and 2 in the frozen contract. The
//      contract was wrong and now says 1, so the three cases that declared the seam
//      declare nothing.
//   *  `overs`: the Python SQL rounded where O.B notation must floor, so 533 balls read
//      89.5 -- a figure that cannot occur, since the digit after the point is a ball
//      count out of six. The oracle was fixed, the two affected fixtures were
//      re-recorded, and the port already agreed with the corrected value.
//
// Skipped, not failed, when the warehouse is absent: it is gitignored, so a fresh
// clone has no copy of it and `npm test` must still pass.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { call } from "./registry.js";
import { warehouseAvailable, warehouseSuiteName } from "./testing.js";

const FIXTURES = new URL("../../tests/fixtures/tool_payloads/", import.meta.url);

interface Case {
  /** Fixture file stem, which is also the test name. */
  readonly name: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  /** Every divergence this case is allowed, exactly. Empty means byte-for-byte. */
  readonly known?: readonly string[];
}

/**
 * Metrics that exist in the current `definitions.py` and not in these fixtures.
 *
 * Spelled per grain because the bowling fixtures are missing four entries and the
 * batting ones only `dots`.
 */
const STALE_BATTING_PROSE = [".definitions.metrics.dots: only in the port"];

const STALE_BOWLING_PROSE = [
  ".definitions.metrics.dots: only in the port",
  ".definitions.metrics.fours_conceded: only in the port",
  ".definitions.metrics.sixes_conceded: only in the port",
  ".definitions.metrics.boundary_conceded_pct: only in the port",
  // These three exist in both, but the fixture carries the *batting* sentence for
  // them: the grain-aware lookup came after these files were recorded.
  ".definitions.metrics.average: prose differs",
  ".definitions.metrics.strike_rate: prose differs",
  ".definitions.metrics.dot_pct: prose differs",
];

/** The metric the stale bowling fixtures do not have a column for at all. */
const STALE_BOWLING_COLUMN = [
  ".columns: only in the port: boundary_conceded_pct",
  ".rows[*].boundary_conceded_pct: only in the port",
];

const CASES: readonly Case[] = [
  {
    name: "01_resolve_entity_player",
    tool: "resolve_entity",
    input: { query: "Kohli", kind: "player" },
  },
  {
    name: "02_resolve_entity_venue",
    tool: "resolve_entity",
    input: { query: "Wankhede", kind: "venue" },
  },
  { name: "03_get_data_coverage", tool: "get_data_coverage", input: { format: ["IT20"] } },
  {
    name: "04_batting_death_leaderboard",
    tool: "query_batting_aggregate",
    input: {
      filters: { format: ["IT20"], phase: "death", date_from: "2020-01-01" },
      group_by: ["player"],
      order_by: "strike_rate",
      limit: 10,
    },
    known: STALE_BATTING_PROSE,
  },
  {
    name: "05_batting_one_player_vs_spin",
    tool: "query_batting_aggregate",
    input: { filters: { batter_ids: ["99b75528"], format: ["IT20"], faced_bowling_type: "spin" } },
    known: STALE_BATTING_PROSE,
  },
  {
    name: "06_bowling_powerplay_leaderboard",
    tool: "query_bowling_aggregate",
    input: {
      filters: { format: ["IT20"], phase: "powerplay", date_from: "2021-01-01" },
      group_by: ["player"],
      order_by: "economy",
      order_dir: "asc",
      limit: 10,
    },
    known: [...STALE_BOWLING_COLUMN, ...STALE_BOWLING_PROSE],
  },
  {
    name: "07_bowling_by_year",
    tool: "query_bowling_aggregate",
    input: {
      filters: { bowler_ids: ["201fef33"] },
      group_by: ["year"],
      order_by: "wickets",
      limit: 20,
    },
    known: [...STALE_BOWLING_COLUMN, ...STALE_BOWLING_PROSE],
  },
  {
    name: "08_matchup",
    tool: "query_matchup",
    input: { batter_id: "52d1dbc8", bowler_id: "201fef33" },
    known: STALE_BATTING_PROSE,
  },
  {
    name: "09_scorecard_innings",
    tool: "get_scorecard",
    input: { match_id: "1415755", card: "innings" },
  },
  {
    name: "10_scorecard_batting",
    tool: "get_scorecard",
    input: { match_id: "1415755", card: "batting" },
  },
  {
    name: "11_scorecard_bowling",
    tool: "get_scorecard",
    input: { match_id: "1415755", card: "bowling" },
    known: [
      ".definitions.metrics.fours_conceded: only in the port",
      ".definitions.metrics.sixes_conceded: only in the port",
    ],
  },
  {
    name: "12_matches_india_wins",
    tool: "query_matches",
    input: {
      filters: { subject_team: "India", subject_team_result: "win", date_from: "2024-01-01" },
      limit: 10,
    },
  },
  {
    name: "13_matches_by_venue",
    tool: "query_matches",
    input: {
      filters: { format: ["T20"], venue_canonical: ["Wankhede Stadium, Mumbai"] },
      limit: 5,
    },
  },
  {
    name: "14_matchup_powerplay",
    tool: "query_matchup",
    input: {
      batter_id: "5d2eda89",
      bowler_id: "bc969efb",
      filters: { format: ["IT20", "T20"], phase: "powerplay" },
    },
    known: STALE_BATTING_PROSE,
  },
  {
    name: "15_career_reference",
    tool: "get_career_reference",
    input: { player_name: "Tendulkar" },
  },
  {
    name: "16_error_phase_not_applicable_to_format",
    tool: "query_batting_aggregate",
    input: { filters: { format: ["Test"], phase: "death" } },
    // pydantic attached a model-level validator's error to the model; the frozen
    // contract attaches it to the field that has to change. Strictly better for the
    // model, which is told what to edit. `received` is the whole filters object in
    // both, so the fixture still pins what was rejected.
    known: ['.error.field: "input" != "phase"'],
  },
  { name: "17_error_limit_exceeded", tool: "query_batting_aggregate", input: { limit: 500 } },
  { name: "18_error_needs_entity_resolution", tool: "get_career_reference", input: {} },
  {
    name: "19_error_unknown_filter_field",
    tool: "query_batting_aggregate",
    input: { filters: { bowling_style: "spin" } },
    // Six filter fields the Python never had. The port offers the complement of each
    // list-valued filter, so `allowed` legitimately names six more fields than the
    // fixture recorded. The rest of the payload -- code, field, received, did_you_mean,
    // fix_example -- still matches exactly, which is what this case is the oracle for.
    known: [
      ".error.allowed: only in the port: batting_team_not",
      ".error.allowed: only in the port: bowling_team_not",
      ".error.allowed: only in the port: competition_not",
      ".error.allowed: only in the port: host_country_not",
      ".error.allowed: only in the port: seasons_not",
      ".error.allowed: only in the port: venue_canonical_not",
    ],
  },
  {
    name: "20_error_missing_subject_team",
    tool: "query_matches",
    input: { filters: { subject_team_result: "win", format: ["IT20"] } },
    known: ['.error.field: "input" != "subject_team_result"'],
  },
  {
    name: "21_empty_with_relaxation_hints",
    tool: "query_batting_aggregate",
    input: {
      filters: {
        format: ["IT20"],
        batter_ids: ["99b75528"],
        venue_canonical: ["Wankhede Stadium, Mumbai"],
        phase: "death",
        date_from: "2025-01-01",
      },
    },
    known: STALE_BATTING_PROSE,
  },
  {
    name: "22_resolve_miss_did_you_mean",
    tool: "resolve_entity",
    input: { query: "Virat Kohli", kind: "player" },
  },
  {
    name: "23_error_bad_enum_value",
    tool: "get_scorecard",
    input: { match_id: "1415755", card: "scorecard" },
  },
  {
    name: "24_error_order_by_required",
    tool: "query_batting_aggregate",
    input: { group_by: ["player"], limit: 20 },
  },
];

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `null` and absent are the same answer.
 *
 * pydantic's `model_dump()` writes every optional field, so a fixture carries
 * `"qualification": null`; zod's parse output simply omits it, and `JSON.stringify`
 * then drops the key. Both serialise to a payload the frontend reads identically.
 * Normalising here rather than declaring ~40 per-fixture exceptions keeps the declared
 * lists about real divergences.
 *
 * This cannot hide a genuine difference: if one side has a value where the other has
 * null, the key survives on one side only and is reported.
 */
function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (inner === null || inner === undefined) continue;
    out[key] = dropNulls(inner);
  }
  return out;
}

/** Array indices collapsed, so a divergence on every row is declared once. */
function generic(path: string): string {
  return path.replace(/\[\d+\]/g, "[*]");
}

function key(path: string): string {
  return path.split(".").at(-1) ?? "";
}

/**
 * `list(DISTINCT batting_team)` has no ORDER BY and DuckDB does not promise one, so the
 * two team names in a match arrive in either order -- two consecutive runs of the
 * Python itself disagreed. Sorted on both sides: the set is the fact, the order is not.
 */
function sortTeams(value: unknown, path: string): unknown {
  if (key(generic(path)) === "teams" && Array.isArray(value)) {
    return [...value].sort();
  }
  return value;
}

/**
 * Arrays of names compared as sets, then as an order.
 *
 * Used for `.columns` and for an error's `.allowed` list, both of which are name lists
 * where the interesting fact is which names are present. Positionally, one name added
 * near the front shifts every entry after it and reports two dozen divergences that all
 * say the same thing; a declared list of those is unreadable and would have to be
 * rewritten by hand the next time a field is added. Naming the added and missing entries
 * says it once. The order check still runs when both sides carry the same names, so a
 * genuine reordering is not hidden.
 */
function nameDiffs(label: string, expected: string[], actual: string[], out: Set<string>): void {
  for (const name of expected) {
    if (!actual.includes(name)) out.add(`${label}: only in the fixture: ${name}`);
  }
  for (const name of actual) {
    if (!expected.includes(name)) out.add(`${label}: only in the port: ${name}`);
  }
  // Only meaningful once both carry the same names; a stale fixture that is missing a
  // column would otherwise report an order difference that says nothing.
  if (expected.length === actual.length && expected.some((name, i) => name !== actual[i])) {
    out.add(`${label}: order differs: ${expected.join(",")} != ${actual.join(",")}`);
  }
}

/** Paths whose arrays are name lists, compared by {@link nameDiffs}. */
const NAME_LISTS: ReadonlySet<string> = new Set([".columns", ".error.allowed"]);

function walk(rawExpected: unknown, rawActual: unknown, path: string, out: Set<string>): void {
  // A hash of the generated SQL text. The TypeScript generator emits semantically
  // identical but not byte-identical SQL, so this can never match across languages --
  // and six of these fixtures already disagree with the Python that produced them.
  if (path === ".sql_id") return;

  const expected = sortTeams(rawExpected, path);
  const actual = sortTeams(rawActual, path);

  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (NAME_LISTS.has(path)) {
      nameDiffs(path, expected.map(String), actual.map(String), out);
      return;
    }
    if (expected.length !== actual.length) {
      out.add(`${generic(path)}: length ${expected.length} != ${actual.length}`);
    }
    for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
      walk(expected[i], actual[i], `${path}[${i}]`, out);
    }
    return;
  }

  if (isObject(expected) && isObject(actual)) {
    for (const name of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      const where = `${generic(path)}.${name}`;
      if (!Object.hasOwn(expected, name)) out.add(`${where}: only in the port`);
      else if (!Object.hasOwn(actual, name)) out.add(`${where}: only in the fixture`);
      else walk(expected[name], actual[name], `${path}.${name}`, out);
    }
    return;
  }

  if (JSON.stringify(expected) === JSON.stringify(actual)) return;
  // Metric prose is long and is pinned exactly by the core definitions tests; naming
  // the metric is enough here, and keeps a declared list readable.
  if (path.startsWith(".definitions.metrics.")) out.add(`${path}: prose differs`);
  else out.add(`${path}: ${JSON.stringify(expected)} != ${JSON.stringify(actual)}`);
}

function divergences(expected: unknown, actual: unknown): string[] {
  const out = new Set<string>();
  walk(dropNulls(expected), dropNulls(actual), "", out);
  return [...out].sort();
}

// ---------------------------------------------------------------------------

describe.skipIf(!warehouseAvailable())(warehouseSuiteName("recorded Python payloads"), () => {
  it("covers every fixture file", () => {
    const stems = CASES.map((one) => one.name);
    expect(new Set(stems).size).toBe(CASES.length);
    // The file list is the contract: a fixture added to the tree and not replayed here
    // is a fixture nobody is checking.
    const present = readdirSync(fileURLToPath(FIXTURES))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""))
      .sort();
    expect(stems.slice().sort()).toEqual(present);
  });

  for (const one of CASES) {
    it(one.name, async () => {
      const fixture: unknown = JSON.parse(
        readFileSync(new URL(`${one.name}.json`, FIXTURES), "utf8"),
      );
      const result = await call(one.tool, one.input);
      expect(divergences(fixture, result.payload)).toEqual([...(one.known ?? [])].sort());
    });
  }
});
