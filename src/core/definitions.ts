// ---------------------------------------------------------------------------
// Every cricket definition in the project. Pure, DB-free, IO-free.
// ---------------------------------------------------------------------------
//
// Nothing else in this workspace does metric arithmetic. That rule exists because
// the expensive failure mode here is not a crash, it is a *plausible wrong
// number*: an economy rate that quietly charges byes to the bowler looks exactly
// like a correct one.
//
// Three definitions are easy to get wrong and were wrong in the first draft:
//
//   * **Two different legal-ball denominators.** A bowler's over excludes wides
//     *and* no-balls. A batter's balls-faced excludes wides **only** -- a no-ball
//     is a ball faced, and so are byes and leg-byes. Hence `countsForOver` and
//     `isBallFaced`, never one "legal ball".
//   * **Two different dot balls.** The batter's dot (no run off the bat) and the
//     team's dot (no run at all) disagree on byes and wides. Hence `isDotBatter`
//     and `isDotBall`.
//   * **Fours and sixes must respect `runs.non_boundary`.** Cricsheet sets that
//     flag when 4 or 6 came off the bat *without reaching the rope* -- all-run, or
//     overthrows. Ungated, every boundary percentage is overthrow-inflated.
//
// Each derived column exists twice on purpose: as a function (fast unit tests, no
// database) and as a SQL expression in `DERIVED_COLUMNS`. `definitions.parity.test.ts`
// evaluates both over the same case grid and asserts they agree, so the two cannot
// drift.

import type { Phase, PhaseSource } from "../contracts/index.js";

// `phaseForBall` returns `[Phase | null, PhaseSource]`, so a caller that wants to name that
// type should not have to know it comes from a different module. Same reasoning as the four
// thresholds below: re-export, never restate.
export type { Phase, PhaseSource } from "../contracts/index.js";
// The four qualification/format constants live in the contracts package and are
// re-exported here, unwrapped and unaliased. The dependency is inverted exactly
// once, there, because the agent needs the numbers to write "of the 38 bowlers who
// bowled 120 balls" without importing a query layer. Re-exporting rather than
// restating is what stops a second copy of a threshold appearing; the equality test
// in `definitions.test.ts` fails the build if one ever does.
export {
  MIN_BALLS_BOWLED,
  MIN_BALLS_FACED,
  MIN_INNINGS,
  UNLIMITED_OVERS_FORMATS,
} from "../contracts/index.js";

import { UNLIMITED_OVERS_FORMATS } from "../contracts/index.js";

/** Membership test, built once. `UNLIMITED_OVERS_FORMATS` is a tuple in contracts. */
const UNLIMITED = new Set<string>(UNLIMITED_OVERS_FORMATS);

// ---------------------------------------------------------------------------
// Extras and runs
// ---------------------------------------------------------------------------

/**
 * A single ball can carry several kinds of extra at once -- a no-ball *and*
 * leg-byes, for instance -- so extras are five independent integers, never one
 * bucket.
 */
export const EXTRA_KINDS = ["wides", "noballs", "byes", "legbyes", "penalty"] as const;
export type ExtraKind = (typeof EXTRA_KINDS)[number];

/**
 * Runs charged to the bowler.
 *
 * Byes, leg-byes and penalty runs are **not** the bowler's fault and are not
 * charged. Getting this wrong inflates every economy rate in the warehouse.
 */
export function runsConcededBowler(
  runsBatter: number,
  extrasWides: number,
  extrasNoballs: number,
): number {
  return runsBatter + extrasWides + extrasNoballs;
}

// ---------------------------------------------------------------------------
// The two legal-ball denominators
// ---------------------------------------------------------------------------

export function isWide(extrasWides: number): boolean {
  return extrasWides > 0;
}

export function isNoball(extrasNoballs: number): boolean {
  return extrasNoballs > 0;
}

/** Does this ball count towards the bowler's over? Wides and no-balls do not. */
export function countsForOver(extrasWides: number, extrasNoballs: number): boolean {
  return !(isWide(extrasWides) || isNoball(extrasNoballs));
}

/**
 * Does this ball count towards the batter's balls faced?
 *
 * A wide is not faced. A no-ball **is** -- as are byes and leg-byes, which the
 * batter had to play at.
 */
export function isBallFaced(extrasWides: number): boolean {
  return !isWide(extrasWides);
}

// ---------------------------------------------------------------------------
// The two dot balls
// ---------------------------------------------------------------------------

/** No run off the bat, on a ball the batter actually faced. */
export function isDotBatter(runsBatter: number, extrasWides: number): boolean {
  return runsBatter === 0 && isBallFaced(extrasWides);
}

/** No run at all, to anyone. A wide is therefore never a dot ball. */
export function isDotBall(runsTotal: number): boolean {
  return runsTotal === 0;
}

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------

/** Four off the bat that actually reached the rope. */
export function isFour(runsBatter: number, nonBoundary: boolean | null | undefined): boolean {
  return runsBatter === 4 && !nonBoundary;
}

export function isSix(runsBatter: number, nonBoundary: boolean | null | undefined): boolean {
  return runsBatter === 6 && !nonBoundary;
}

export function isBoundary(runsBatter: number, nonBoundary: boolean | null | undefined): boolean {
  return isFour(runsBatter, nonBoundary) || isSix(runsBatter, nonBoundary);
}

// ---------------------------------------------------------------------------
// Dismissals
// ---------------------------------------------------------------------------

/** Dismissal kinds credited to the bowler. */
export const BOWLER_CREDITED_KINDS: ReadonlySet<string> = new Set([
  "bowled",
  "caught",
  "caught and bowled",
  "lbw",
  "stumped",
  "hit wicket",
]);

/**
 * Dismissal kinds that are *not* the bowler's. Listed explicitly rather than
 * inferred, so that a kind Cricsheet adds later is an error rather than a silent
 * zero. The unit suite asserts the two sets are disjoint and the ingest verifier
 * asserts every kind in the warehouse is in their union.
 */
export const NON_BOWLER_KINDS: ReadonlySet<string> = new Set([
  "run out",
  "retired hurt",
  "retired out",
  "retired not out",
  "obstructing the field",
  "handled the ball",
  "hit the ball twice",
  "timed out",
]);

export const KNOWN_DISMISSAL_KINDS: ReadonlySet<string> = new Set([
  ...BOWLER_CREDITED_KINDS,
  ...NON_BOWLER_KINDS,
]);

/**
 * Dismissal kinds that do **not** consume one of the batter's "outs". Named rather
 * than inlined in `countsAsDismissalForBattingAverage` so that the ingest can render
 * the same set into SQL: it writes a `counts_as_out` column, and if that column and
 * this function ever disagreed every batting average in the warehouse would be
 * quietly wrong.
 */
export const NOT_OUT_DISMISSAL_KINDS: ReadonlySet<string> = new Set([
  "retired hurt",
  "retired not out",
]);

/**
 * A dismissal kind absent from both allowlists.
 *
 * Thrown rather than defaulted: silently treating an unrecognised kind as "not the
 * bowler's" would undercount wickets with no visible symptom.
 */
export class UnknownDismissalKind extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownDismissalKind";
  }
}

export function isBowlerCredited(kind: string): boolean {
  const normalised = kind.trim().toLowerCase();
  if (BOWLER_CREDITED_KINDS.has(normalised)) return true;
  if (NON_BOWLER_KINDS.has(normalised)) return false;
  throw new UnknownDismissalKind(
    `dismissal kind ${JSON.stringify(kind)} is in neither allowlist; classify it in ` +
      `definitions.ts before ingesting`,
  );
}

/**
 * Does this dismissal consume one of the batter's "outs"?
 *
 * Retirements do not: a retired-not-out batter has not been dismissed, and counting
 * it would deflate the average. `retired out` is a dismissal.
 */
export function countsAsDismissalForBattingAverage(kind: string): boolean {
  const normalised = kind.trim().toLowerCase();
  if (!KNOWN_DISMISSAL_KINDS.has(normalised)) {
    throw new UnknownDismissalKind(`dismissal kind ${JSON.stringify(kind)} is not classified`);
  }
  return !NOT_OUT_DISMISSAL_KINDS.has(normalised);
}

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

/**
 * Fallback over ranges, 1-based and inclusive, used only when a match declares no
 * powerplay array. Keyed by the innings' scheduled over count, because a 50-over
 * innings and a 20-over innings do not share a middle.
 */
export const DEFAULT_PHASE_OVERS: Readonly<Record<number, ReadonlyArray<[Phase, number, number]>>> =
  Object.freeze({
    20: [
      ["powerplay", 1, 6],
      ["middle", 7, 15],
      ["death", 16, 20],
    ],
    50: [
      ["powerplay", 1, 10],
      ["middle", 11, 40],
      ["death", 41, 50],
    ],
  });

/**
 * The 0-based over component of a Cricsheet `over.ball` float.
 *
 * `5.6` is over 5, ball 6. The Python original routed through `Decimal(str(...))` to
 * avoid binary-float noise on values like `0.1`; `Math.trunc` is enough here because
 * the noise only ever pushes the value *up* by ~1e-16 and truncation is downward, so
 * `Math.trunc(0.1 + eps) === 0` either way. Truncation, not `Math.floor`: every
 * Cricsheet over index is non-negative and a negative would be a data error we would
 * rather see than silently round away from zero.
 */
function overOf(overBall: number): number {
  return Math.trunc(overBall);
}

/** One declared powerplay window as Cricsheet writes it: 0-based over.ball floats. */
export interface PowerplayWindow {
  from?: number;
  to?: number;
  type?: string;
}

/**
 * The set of 0-based overs covered by declared powerplays, or `null`.
 *
 * Containment is evaluated per **over**, not per ball. Powerplays are defined in
 * whole overs, so `to` is always the last ball of an over -- and an over that ran to
 * seven balls because of a wide is still entirely inside the powerplay. Comparing
 * ball-for-ball would wrongly exclude that seventh ball.
 *
 * `null` for an absent *or empty* list means "fall back to the default"; an empty set
 * would mean "there is no powerplay", which is a different claim.
 */
export function declaredPowerplayOvers(
  powerplays: readonly PowerplayWindow[] | null | undefined,
): Set<number> | null {
  if (!powerplays || powerplays.length === 0) return null;
  const overs = new Set<number>();
  for (const window of powerplays) {
    if (window.from === undefined || window.to === undefined) continue;
    const start = overOf(window.from);
    const end = overOf(window.to);
    for (let over = start; over <= end; over += 1) overs.add(over);
  }
  return overs.size > 0 ? overs : null;
}

/**
 * How many overs at the end count as the death.
 *
 * Five in a twenty-over innings, ten in a fifty-over one; otherwise the same
 * one-quarter proportion, which is what those two cases already are.
 *
 * `roundHalfEven` rather than `Math.round`, because Python's `round()` is
 * half-to-even and this is the one place the difference is reachable: a 34-over
 * innings gives 8.5, which Python makes 8 and `Math.round` would make 9 -- a
 * one-over shift in where the death begins.
 */
function deathOverCount(scheduledOvers: number): number {
  return Math.max(1, roundHalfEven(scheduledOvers / 4));
}

function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * `[phase, phaseSource]` for one delivery. `overNumber` is 1-based.
 *
 * `phase` is `null` -- honestly unknown, not guessed -- for Tests and multi-day
 * games, for non-six-ball formats such as The Hundred, and for innings whose
 * scheduled length matches no known default. That `null` is what stops a Test query
 * silently returning "powerplay" rows.
 */
export function phaseForBall(args: {
  fmt: string;
  overNumber: number;
  scheduledOvers: number | null;
  ballsPerOver: number;
  powerplays: readonly PowerplayWindow[] | null | undefined;
}): [Phase | null, PhaseSource] {
  const { fmt, overNumber, scheduledOvers, ballsPerOver, powerplays } = args;
  if (UNLIMITED.has(fmt)) return [null, "null"];
  if (ballsPerOver !== 6) return [null, "null"];

  const declared = declaredPowerplayOvers(powerplays);
  if (declared !== null) {
    if (declared.has(overNumber - 1)) return ["powerplay", "declared"];
    // Beyond the powerplay, split what remains. Without a scheduled length we
    // cannot say where death starts, so we decline to guess.
    if (scheduledOvers === null) return [null, "declared"];
    const deathStart = scheduledOvers - deathOverCount(scheduledOvers) + 1;
    return [overNumber >= deathStart ? "death" : "middle", "declared"];
  }

  const ranges = scheduledOvers === null ? undefined : DEFAULT_PHASE_OVERS[scheduledOvers];
  if (ranges === undefined) return [null, "null"];
  for (const [name, lo, hi] of ranges) {
    if (lo <= overNumber && overNumber <= hi) return [name, "default"];
  }
  return [null, "default"];
}

// ---------------------------------------------------------------------------
// Metrics. All return null rather than 0 or Infinity on an empty denominator: a
// batter with no dismissals has an *undefined* average, not an average of zero.
// ---------------------------------------------------------------------------

/**
 * Two decimal places, half away from zero.
 *
 * DuckDB's `round()` is half-away-from-zero and these functions exist to be checked
 * against the SQL, so this matches DuckDB rather than Python's half-to-even. In
 * practice the two agree on every case the parity suite reaches, because an exact
 * binary half at two decimal places is vanishingly rare in a ratio of two integers;
 * where it is reachable the SQL is the thing that shipped the number.
 */
function round2(value: number): number {
  const scaled = value * 100;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return rounded / 100;
}

function ratio(numerator: number, denominator: number, scale = 1.0): number | null {
  if (denominator === 0) return null;
  return round2((scale * numerator) / denominator);
}

export function battingAverage(runs: number, dismissals: number): number | null {
  return ratio(runs, dismissals);
}

export function battingStrikeRate(runs: number, ballsFaced: number): number | null {
  return ratio(runs, ballsFaced, 100.0);
}

/** Runs per over, so the denominator is overs -- balls divided by six. */
export function bowlingEconomy(runsConceded: number, ballsCountingForOver: number): number | null {
  return ratio(runsConceded, ballsCountingForOver, 6.0);
}

export function bowlingAverage(runsConceded: number, wickets: number): number | null {
  return ratio(runsConceded, wickets);
}

/** Balls per wicket. */
export function bowlingStrikeRate(ballsCountingForOver: number, wickets: number): number | null {
  return ratio(ballsCountingForOver, wickets);
}

export function percentage(part: number, whole: number): number | null {
  return ratio(part, whole, 100.0);
}

// ---------------------------------------------------------------------------
// SQL mirror of the derived columns
// ---------------------------------------------------------------------------

/**
 * Column name -> SQL expression, in terms of the already-extracted raw columns
 * `runs_batter`, `runs_total`, `extras_wides`, `extras_noballs` and `non_boundary`.
 * The ingest DDL is generated from this mapping, so it cannot drift from the
 * functions above.
 */
export const DERIVED_COLUMNS = {
  runs_conceded_bowler: "runs_batter + extras_wides + extras_noballs",
  is_wide: "extras_wides > 0",
  is_noball: "extras_noballs > 0",
  counts_for_over: "NOT (extras_wides > 0 OR extras_noballs > 0)",
  is_ball_faced: "NOT (extras_wides > 0)",
  is_dot_batter: "runs_batter = 0 AND NOT (extras_wides > 0)",
  is_dot_ball: "runs_total = 0",
  is_four: "runs_batter = 4 AND NOT coalesce(non_boundary, false)",
  is_six: "runs_batter = 6 AND NOT coalesce(non_boundary, false)",
  is_boundary: "(runs_batter = 4 OR runs_batter = 6) AND NOT coalesce(non_boundary, false)",
} as const satisfies Record<string, string>;

export type DerivedColumn = keyof typeof DERIVED_COLUMNS;

/**
 * The DuckDB type each derived column is declared as in the generated DDL. Listed
 * explicitly rather than inferred from the expression, because an inferred type is
 * one more thing that can silently disagree with the DDL.
 */
export const DERIVED_COLUMN_TYPES = {
  runs_conceded_bowler: "INTEGER",
  is_wide: "BOOLEAN",
  is_noball: "BOOLEAN",
  counts_for_over: "BOOLEAN",
  is_ball_faced: "BOOLEAN",
  is_dot_batter: "BOOLEAN",
  is_dot_ball: "BOOLEAN",
  is_four: "BOOLEAN",
  is_six: "BOOLEAN",
  is_boundary: "BOOLEAN",
} as const satisfies Record<DerivedColumn, "BOOLEAN" | "INTEGER">;

/** One row of the per-ball case grid the parity suite evaluates both sides over. */
export interface DeliveryCase {
  runs_batter: number;
  extras_wides: number;
  extras_noballs: number;
  extras_byes: number;
  runs_total: number;
  non_boundary: boolean | null;
}

/**
 * The function counterpart of each SQL expression above, for the parity test. Keys
 * must match `DERIVED_COLUMNS` exactly -- a test asserts that.
 */
export const DERIVED_COLUMN_EQUIVALENTS = {
  runs_conceded_bowler: (r) => runsConcededBowler(r.runs_batter, r.extras_wides, r.extras_noballs),
  is_wide: (r) => isWide(r.extras_wides),
  is_noball: (r) => isNoball(r.extras_noballs),
  counts_for_over: (r) => countsForOver(r.extras_wides, r.extras_noballs),
  is_ball_faced: (r) => isBallFaced(r.extras_wides),
  is_dot_batter: (r) => isDotBatter(r.runs_batter, r.extras_wides),
  is_dot_ball: (r) => isDotBall(r.runs_total),
  is_four: (r) => isFour(r.runs_batter, r.non_boundary),
  is_six: (r) => isSix(r.runs_batter, r.non_boundary),
  is_boundary: (r) => isBoundary(r.runs_batter, r.non_boundary),
} as const satisfies Record<DerivedColumn, (r: DeliveryCase) => number | boolean>;

// ---------------------------------------------------------------------------
// The aggregate layer: metric -> SQL, in two tiers
// ---------------------------------------------------------------------------
// The per-ball expressions above become warehouse *columns*. These turn a group of
// those rows into the numbers a person actually asks for, and they live here for the
// same reason: an economy rate computed one way in a tool and another way in a test
// is a wrong answer that nothing catches.
//
// Two tiers, because the denominators come from two tables. Tier 1 aggregates
// `deliveries`; wicket counts aggregate `wickets` separately, since a ball can carry
// two wickets and joining them un-aggregated double-counts every run. Tier 2 is
// arithmetic over tier-1 results and touches no table at all -- which is exactly why
// it can be checked against the functions above, case for case.

/** Tier 1, batting. Aggregate expressions over `deliveries d`. */
export const BATTING_BASE_SQL = {
  runs: "sum(d.runs_batter)::INTEGER",
  balls_faced: "sum(d.is_ball_faced::INT)::INTEGER",
  fours: "sum(d.is_four::INT)::INTEGER",
  sixes: "sum(d.is_six::INT)::INTEGER",
  dots: "sum(d.is_dot_batter::INT)::INTEGER",
  innings: "count(DISTINCT d.match_id || ':' || d.innings_no)::INTEGER",
  matches: "count(DISTINCT d.match_id)::INTEGER",
} as const satisfies Record<string, string>;

/**
 * Tier 1, bowling. Note the different legal-ball denominator: a bowler's over
 * excludes wides AND no-balls, where balls_faced excludes wides only.
 */
export const BOWLING_BASE_SQL = {
  balls_bowled: "sum(d.counts_for_over::INT)::INTEGER",
  runs_conceded: "sum(d.runs_conceded_bowler)::INTEGER",
  // Credited wickets only. `wicket_count` would include run-outs, which no scorecard
  // has ever given the bowler; the ingest split the two counters for exactly this
  // reason and the denominator of a bowling average needs this one.
  wickets: "sum(d.bowler_wicket_count)::INTEGER",
  dots: "sum(d.is_dot_ball::INT)::INTEGER",
  fours_conceded: "sum(d.is_four::INT)::INTEGER",
  sixes_conceded: "sum(d.is_six::INT)::INTEGER",
  innings: "count(DISTINCT d.match_id || ':' || d.innings_no)::INTEGER",
  matches: "count(DISTINCT d.match_id)::INTEGER",
} as const satisfies Record<string, string>;

// --- Batting dismissals: a separate aggregate, and not by choice ---------------
//
// `dismissals` is the denominator of a batting average and it cannot be an entry in
// BATTING_BASE_SQL, because it is not at that grain. Two facts force it out:
//
//  1. A dismissed batter is not always the striker. 4,111 of the 85,778 dismissals in
//     the T20 warehouse -- 4.8% -- are of the player at the *other* end, almost all
//     run outs. Counting `batter_dismissed_id = batter_id` would not merely
//     undercount; it would credit the dismissal to the wrong batter.
//  2. A retirement is not an out. `retired hurt` and `retired not out` end an innings
//     without a dismissal, and `wickets.counts_as_out` is the column that knows the
//     difference.
//
// So dismissals are counted over `wickets`, joined to `deliveries` **ball-exactly** so
// the query's filters (format, phase, venue) still apply, and keyed on `player_out_id`
// rather than the striker. A ball carrying two wickets correctly yields two rows here;
// that is why this may never be folded into the tier-1 aggregate, where it would
// double every run on that ball.

/**
 * The only safe way to reach `wickets` from `deliveries`: all four key parts.
 * Dropping `ball_in_over` makes it an over-grain join and inflates by ~6x.
 */
export const WICKETS_BALL_JOIN =
  "JOIN wickets w ON w.match_id = d.match_id AND w.innings_no = d.innings_no " +
  "AND w.over_number = d.over_number AND w.ball_in_over = d.ball_in_over";

/** Restricts the join above to dismissals that actually cost a wicket. */
export const DISMISSAL_PREDICATE = "w.counts_as_out";

/** The batter a dismissal belongs to -- NOT `d.batter_id`. See the note above. */
export const DISMISSED_BATTER_KEY = "w.player_out_id";

export const DISMISSALS_SQL = "count(*)::INTEGER";

/**
 * The SQL mirror of `ratio`: NULL on an empty denominator, 2 dp.
 *
 * NULL rather than 0 is the whole point. A batter who has never been dismissed has an
 * *undefined* average; reporting 0 makes him the worst in the list and reporting his
 * run total makes him the best.
 *
 * Both operands are parenthesised. They must be: several of these are compound
 * (`fours + sixes`), and unparenthesised `100.0 * fours + sixes / balls_faced` is
 * valid SQL that silently computes something else entirely.
 */
export function sqlRatio(numerator: string, denominator: string, scale = "1.0"): string {
  return (
    `CASE WHEN coalesce((${denominator}), 0) = 0 THEN NULL ` +
    `ELSE round(${scale} * (${numerator}) / (${denominator}), 2) END`
  );
}

/**
 * Tier 2, batting. Written over tier-1 column names, so `dismissals` here is the
 * pre-aggregated count from `wickets`, never a join onto the ball grain.
 */
export const BATTING_DERIVED_SQL = {
  average: sqlRatio("runs", "dismissals"),
  strike_rate: sqlRatio("runs", "balls_faced", "100.0"),
  boundary_pct: sqlRatio("fours + sixes", "balls_faced", "100.0"),
  dot_pct: sqlRatio("dots", "balls_faced", "100.0"),
  balls_per_boundary: sqlRatio("balls_faced", "fours + sixes"),
} as const satisfies Record<string, string>;

/**
 * Tier 2, bowling. `economy` scales by 6 because the denominator is overs.
 *
 * `overs` uses `//`, DuckDB's floor division, and not the `(balls_bowled / 6)::INTEGER`
 * the Python original wrote. `/` in DuckDB returns a DOUBLE even for two integers, and
 * `::INTEGER` *rounds* it, so 533 balls rendered as "89.5" -- 89 overs and 5 balls,
 * which is more overs than were bowled and not a figure any scorecard prints. Every
 * innings with `balls_bowled % 6 >= 3` was off by one over. `docs/track-notes/n1.md`
 * records the fixture this deviates from.
 */
export const BOWLING_DERIVED_SQL = {
  economy: sqlRatio("runs_conceded", "balls_bowled", "6.0"),
  average: sqlRatio("runs_conceded", "wickets"),
  strike_rate: sqlRatio("balls_bowled", "wickets"),
  dot_pct: sqlRatio("dots", "balls_bowled", "100.0"),
  // The batting side has had `boundary_pct` since M1a and this was simply never
  // written, which made the one question this project leads with -- "who concedes
  // fewest boundaries in T20 death overs" -- unaskable as a leaderboard: the numbers
  // existed as `fours_conceded` and `sixes_conceded`, but nothing could order by the
  // rate, so a model had to eyeball two absolute counts across bowlers who bowled
  // different numbers of balls.
  //
  // The denominator is `balls_bowled`, which excludes wides AND no-balls, so it is NOT
  // the same denominator as batting `boundary_pct` (balls faced, which counts a
  // no-ball). A boundary off a no-ball is therefore in the numerator and not the
  // denominator. That is deliberate: it is exactly the convention `economy` already
  // uses -- no-ball runs are charged, the no-ball is not counted in the over -- and
  // every scorecard in cricket agrees. METRIC_DEFINITIONS says so out loud.
  boundary_conceded_pct: sqlRatio("fours_conceded + sixes_conceded", "balls_bowled", "100.0"),
  overs: "((balls_bowled // 6)::INTEGER || '.' || (balls_bowled % 6)::VARCHAR)",
} as const satisfies Record<string, string>;

/** The tier-1 aggregate values a tier-2 expression is computed from. */
export type MetricRow = Record<string, number | null>;

function need(row: MetricRow, key: string): number {
  const value = row[key];
  if (value === null || value === undefined) {
    throw new Error(`tier-2 metric needs tier-1 column ${key}, which is absent from the row`);
  }
  return value;
}

/**
 * The function counterpart of every tier-2 expression, keyed identically, for the
 * parity test. Each takes a map of tier-1 values.
 *
 * Grain-qualified, because `average`, `strike_rate` and `dot_pct` exist on both sides
 * and mean different things.
 */
export const DERIVED_METRIC_EQUIVALENTS = {
  "batting.average": (r) => battingAverage(need(r, "runs"), need(r, "dismissals")),
  "batting.strike_rate": (r) => battingStrikeRate(need(r, "runs"), need(r, "balls_faced")),
  "batting.boundary_pct": (r) =>
    percentage(need(r, "fours") + need(r, "sixes"), need(r, "balls_faced")),
  "batting.dot_pct": (r) => percentage(need(r, "dots"), need(r, "balls_faced")),
  "batting.balls_per_boundary": (r) =>
    ratio(need(r, "balls_faced"), need(r, "fours") + need(r, "sixes")),
  "bowling.economy": (r) => bowlingEconomy(need(r, "runs_conceded"), need(r, "balls_bowled")),
  "bowling.average": (r) => bowlingAverage(need(r, "runs_conceded"), need(r, "wickets")),
  "bowling.strike_rate": (r) => bowlingStrikeRate(need(r, "balls_bowled"), need(r, "wickets")),
  "bowling.dot_pct": (r) => percentage(need(r, "dots"), need(r, "balls_bowled")),
  "bowling.boundary_conceded_pct": (r) =>
    percentage(need(r, "fours_conceded") + need(r, "sixes_conceded"), need(r, "balls_bowled")),
} as const satisfies Record<string, (r: MetricRow) => number | null>;

// ---------------------------------------------------------------------------
// What each metric MEANS, in one sentence
// ---------------------------------------------------------------------------
// Echoed on every response as `Definitions.metrics`. Trap C is not solved by computing
// the number correctly; it is solved by the answer stating which denominator it used,
// so a reader can tell a real disagreement from a definitional one. These strings are
// user-facing prose, not doc comments.

export const METRIC_DEFINITIONS: Readonly<Record<string, string>> = Object.freeze({
  // batting
  runs:
    "Runs off the bat only. Byes, leg-byes, wides and no-ball penalties are the " +
    "team's, not the batter's.",
  balls_faced:
    "Balls faced excludes wides only. A no-ball IS a ball faced, and so is a ball " +
    "from which byes or leg-byes were taken.",
  dismissals:
    "Times out, counted from the wickets table. Retired hurt and retired not out are " +
    "NOT dismissals and do not consume an average.",
  "batting.average":
    "Runs off the bat divided by dismissals. Undefined (null), not zero, for a batter " +
    "who has never been dismissed.",
  "batting.strike_rate": "Runs per 100 balls faced.",
  fours:
    "Fours that reached the boundary. All-run fours and overthrows are excluded via " +
    "Cricsheet's non_boundary flag.",
  sixes: "Sixes that reached the boundary, with the same non_boundary exclusion.",
  boundary_pct: "Percentage of balls faced that went for four or six.",
  "batting.dots":
    "Balls faced off which the batter scored nothing. A ball that yielded only byes " +
    "or leg-byes is still a dot for the batter.",
  "batting.dot_pct":
    "Percentage of balls faced off which the batter scored nothing; a ball that " +
    "yielded only byes is still a dot for the batter.",
  balls_per_boundary: "Balls faced per boundary hit.",
  // bowling
  balls_bowled:
    "Legal balls bowled: excludes both wides and no-balls, a different denominator " +
    "from a batter's balls faced.",
  runs_conceded:
    "Runs charged to the bowler: off the bat, plus wides, plus no-ball penalties. " +
    "Byes and leg-byes are NOT charged to the bowler.",
  wickets:
    "Wickets credited to the bowler. Run outs, obstruction, retirements and timed out " +
    "are dismissals but are not the bowler's.",
  "bowling.average":
    "Runs conceded divided by wickets taken. Undefined (null), not zero, for a bowler " +
    "who has taken none.",
  "bowling.strike_rate":
    "Legal balls bowled per wicket taken -- for a bowler this is a rate of striking, " +
    "so LOWER is better, the opposite of a batter's strike rate.",
  economy: "Runs conceded per over, where an over is six legal balls.",
  "bowling.dots":
    "Balls off which the batting side scored nothing at all. Note this is the TEAM's " +
    "dot, so it is not the same count as a batter's: a wide is never a dot here, but " +
    "a ball that went for leg-byes is a dot for the batter and not for the bowler.",
  "bowling.dot_pct": "Percentage of legal balls off which no run of any kind was scored.",
  fours_conceded:
    "Fours hit off this bowler that reached the boundary, with the same non_boundary " +
    "exclusion as a batter's fours.",
  sixes_conceded: "Sixes hit off this bowler that reached the boundary.",
  boundary_conceded_pct:
    "Fours and sixes conceded as a percentage of LEGAL balls bowled. The denominator " +
    "excludes wides and no-balls, so it is not the same denominator as a batter's " +
    "boundary %, which counts a no-ball as a ball faced. This follows the economy-rate " +
    "convention: a boundary off a no-ball is charged to the bowler, while the no-ball " +
    "itself does not count towards his over.",
  overs:
    "Overs bowled, written O.B -- '4.3' is four overs and three balls, not four and a " +
    "half overs.",
  // grain and scope
  innings: "Distinct innings, counted as match plus innings number.",
  matches: "Distinct matches.",
});

/**
 * The prose for one metric, disambiguated by grain when the name is shared.
 *
 * Four names mean two different things depending on the grain, and a flat lookup got
 * all four wrong on the bowling side: `average` echoed "runs off the bat divided by
 * dismissals" next to a bowling average, and `strike_rate` echoed "runs per 100 balls"
 * next to a figure where lower is better. Trap C is not solved by computing the number
 * correctly -- it is solved by the sentence that travels with it being true, so a flat
 * key here defeated the mechanism for the whole bowling tool.
 *
 * `dots` is the sharpest case, because the two definitions disagree on real balls
 * rather than merely reading oddly: a leg-bye is a dot for the batter and not for the
 * bowler, and a wide is a dot for neither.
 *
 * Returns undefined for an unknown metric, and deliberately does NOT fall back to the
 * bare key for a grain-qualified one: a caller that forgets `grain` loses the sentence
 * rather than printing the wrong one. The unit suite asserts every metric each tool
 * can report has prose for its own grain, so "forgot to add it" fails the suite
 * instead of failing quietly in front of a user.
 */
export function metricDefinition(name: string, grain?: string | null): string | undefined {
  if (grain !== undefined && grain !== null) {
    const qualified = METRIC_DEFINITIONS[`${grain}.${name}`];
    if (qualified !== undefined) return qualified;
  }
  return METRIC_DEFINITIONS[name];
}
