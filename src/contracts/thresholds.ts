/**
 * The four constants the *contract* itself needs, and nothing else.
 *
 * ## Why these live here and not in `definitions.ts`
 *
 * In the Python implementation `contracts.py` imported `MIN_BALLS_FACED`,
 * `MIN_BALLS_BOWLED`, `MIN_INNINGS` and `UNLIMITED_OVERS_FORMATS` from
 * `definitions.py`. That direction is not available to us: `src/contracts`
 * is the package every other package depends on, so it must not depend on
 * `src/core`, and `definitions.ts` lives in core.
 *
 * So the dependency is inverted exactly once, here, for exactly these four values —
 * and `core/definitions.ts` **re-exports them** so that the project rule
 * "`definitions` is the one place you look up a definition" still holds for every
 * reader. Nothing else moves. Every metric expression, every SQL fragment and every
 * piece of user-facing prose stays in `definitions.ts`.
 *
 * The test that keeps this honest is in core: it asserts that
 * `definitions.MIN_BALLS_FACED === contracts.MIN_BALLS_FACED` for all four, so a
 * second copy of a threshold cannot appear without failing.
 */

/**
 * Trap D, batting side. A leaderboard ordered by strike rate with no minimum
 * returns whoever faced three balls and hit two sixes.
 */
export const MIN_BALLS_FACED = 60;

/** Trap D, bowling side. Higher than the batting minimum: four overs is one T20 spell. */
export const MIN_BALLS_BOWLED = 120;

/**
 * Applied alongside the ball minimum, so one enormous innings cannot qualify a player.
 *
 * One, not two: the ball minimum is what actually enforces Trap D, and a second innings
 * on top of 60 balls faced excludes a genuine 60-ball innings while admitting nothing a
 * leaderboard wants. `definitions.py` has said 1 since it was written and every recorded
 * payload echoes 1; this file said 2, which is the kind of divergence that only shows up
 * as a `qualification` block disagreeing with the rows above it.
 */
export const MIN_INNINGS = 1;

/**
 * Formats with no over limit, and therefore no powerplay and no phase.
 *
 * A `phase` filter combined with any of these is rejected at the contract boundary
 * rather than silently returning nothing: "Tendulkar's Test powerplay average" is a
 * question with no answer, and a confident zero is the worst possible reply to it.
 */
export const UNLIMITED_OVERS_FORMATS = ["Test", "MDM"] as const;
