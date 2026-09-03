import { z } from "zod";

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/**
 * Cricsheet's 8-hex identifier. Typed so that a model passing `"Kohli"` fails
 * loudly with "call resolve_entity first" instead of matching nothing and
 * returning a confident zero.
 */
export const PlayerId = z
  .string()
  .regex(/^[0-9a-f]{8}$/, "not a Cricsheet player id -- call resolve_entity first");
export type PlayerId = z.infer<typeof PlayerId>;

/**
 * A calendar date as `YYYY-MM-DD`, and deliberately a string rather than a `Date`.
 *
 * Three reasons, all of which bit the Python side in one form or another:
 * 1.  It round-trips through JSON unchanged, so a payload written by a tool and a
 *     payload read back from a committed transcript are byte-identical.
 * 2.  `new Date("2003-11-16")` is UTC midnight, and formatting it in any timezone
 *     west of Greenwich renders the day before. A stats app that reports the wrong
 *     match date is wrong in the most embarrassing possible way.
 * 3.  ISO-8601 dates sort correctly as strings, so every "is this before that"
 *     check in this file is a plain `<=` with no parsing and no timezone.
 *
 * `z.iso.date()` rejects impossible calendars (`2003-02-30`), not just bad shapes.
 */
export const IsoDate = z.iso.date();
export type IsoDate = z.infer<typeof IsoDate>;

export const FORMATS = ["Test", "ODI", "T20", "IT20", "MDM", "ODM"] as const;
export const Format = z.enum(FORMATS);
export type Format = z.infer<typeof Format>;

export const Gender = z.enum(["male", "female"]);
export type Gender = z.infer<typeof Gender>;

export const Phase = z.enum(["powerplay", "middle", "death"]);
export type Phase = z.infer<typeof Phase>;

export const PhaseSource = z.enum(["declared", "default", "null"]);
export type PhaseSource = z.infer<typeof PhaseSource>;

export const BowlingType = z.enum(["pace", "spin", "unknown"]);
export type BowlingType = z.infer<typeof BowlingType>;

export const BowlingArm = z.enum(["right", "left", "unknown"]);
export type BowlingArm = z.infer<typeof BowlingArm>;

export const MatchResult = z.enum(["win", "loss", "draw", "tie", "no_result"]);
export type MatchResult = z.infer<typeof MatchResult>;

export const SortDirection = z.enum(["asc", "desc"]);
export type SortDirection = z.infer<typeof SortDirection>;

/** The four shapes a tool result can be drawn as, before any rows have arrived. */
export const ResultShape = z.enum(["tiles", "table", "chart", "unknown"]);
export type ResultShape = z.infer<typeof ResultShape>;

/**
 * The model will not emit our exact enum values, so normalise rather than reject.
 *
 * Note the deliberate asymmetry: `T20I` means *international* T20 (`IT20`), while a
 * bare `T20` stays domestic/franchise T20. Tool descriptions must tell the model to
 * pass **both** when the user means "T20 cricket" generally -- this is a real
 * ambiguity and silently widening it here would be a definition change made in a
 * validator, which is exactly the wrong place for one.
 */
export const FORMAT_ALIASES: Readonly<Record<string, Format>> = Object.freeze({
  test: "Test",
  tests: "Test",
  "test match": "Test",
  odi: "ODI",
  odis: "ODI",
  "one day international": "ODI",
  t20: "T20",
  t20s: "T20",
  t20i: "IT20",
  t20is: "IT20",
  it20: "IT20",
  "international t20": "IT20",
  mdm: "MDM",
  "first class": "MDM",
  "first-class": "MDM",
  odm: "ODM",
  "list a": "ODM",
});

/**
 * Map a model-supplied format (or list of them) onto our enum where an alias is
 * recognised, and pass anything else through untouched so the enum -- not this
 * function -- produces the error message with the `allowed` list in it.
 */
export function normaliseFormat(value: unknown): unknown {
  if (typeof value === "string") {
    return FORMAT_ALIASES[value.trim().toLowerCase()] ?? value;
  }
  if (Array.isArray(value)) return value.map(normaliseFormat);
  return value;
}

/**
 * `Format` with the alias map applied first. Used by the filter models; the bare
 * `Format` stays exported for anything that must reject an alias.
 */
export const FormatInput = z.preprocess(normaliseFormat, Format);
