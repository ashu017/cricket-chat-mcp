import { z } from "zod";
import { IsoDate, PhaseSource, PlayerId } from "./scalars.js";
import { MIN_BALLS_BOWLED, MIN_BALLS_FACED, MIN_INNINGS } from "./thresholds.js";

// ---------------------------------------------------------------------------
// Response contract
// ---------------------------------------------------------------------------
//
// Two notes that apply to every model below.
//
// `.nullish()` rather than `.optional()` on the nullable fields is deliberate and
// not cosmetic. Pydantic serialises `None` as an explicit `null`, so every payload
// the Python implementation ever wrote -- including the committed transcripts and
// the 24 tool-payload fixtures this port is verified against -- carries
// `"earliest_date": null` rather than omitting the key. Accepting only `undefined`
// would reject the oracle.
//
// Every object is strict. A response with a field nobody reads is a field somebody
// added on one side of the seam and forgot on the other.

export const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type Scalar = z.infer<typeof Scalar>;

/**
 * One table cell: a scalar, or a flat list of them.
 *
 * A deliberate tightening over the Python contract, which typed rows as
 * `dict[str, Any]`. The line is drawn at what the UI can render: a STRUCT or a nested
 * list becomes `[object Object]` in a table, and failing at the seam beats failing in
 * the browser. A flat list does not -- `teams: ["Zimbabwe", "India"]` is a real column
 * on `query_matches` and `resolve_entity`, and it renders as a joined string.
 *
 * The first draft of this schema allowed scalars only and the conformance test
 * rejected three committed fixtures, which is the whole reason that test exists.
 *
 * Renderers must join a list cell explicitly. JavaScript's default coercion happens to
 * produce `Zimbabwe,India` -- no space -- so relying on it looks like a formatting bug.
 */
export const Cell = z.union([Scalar, z.array(Scalar)]);
export type Cell = z.infer<typeof Cell>;

export const Row = z.record(z.string(), Cell);
export type Row = z.infer<typeof Row>;

/**
 * Trap A, attached to every stats response.
 *
 * Every answer states the window it was computed over. `coverage` is read from the
 * warehouse's `coverage` table, never hardcoded, so the UI badge stays true as
 * formats widen.
 */
export const Coverage = z
  .strictObject({
    matches_in_scope: z.int().min(0),
    earliest_date: IsoDate.nullish(),
    latest_date: IsoDate.nullish(),
    dataset_first_date: IsoDate.nullish(),
    dataset_last_date: IsoDate.nullish(),

    /**
     * True when this entity's record probably starts before the ball-by-ball data
     * does. The answer must then state the boundary rather than give a bare number
     * -- a truncated career average is not a career average.
     */
    career_possibly_truncated: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.earliest_date && value.latest_date && value.earliest_date > value.latest_date) {
      ctx.addIssue({
        code: "custom",
        path: ["earliest_date"],
        message: "earliest_date is after latest_date",
      });
    }
    if (value.matches_in_scope === 0 && value.earliest_date != null) {
      ctx.addIssue({
        code: "custom",
        path: ["earliest_date"],
        message: "matches_in_scope is 0 but earliest_date is set",
      });
    }
  });
export type Coverage = z.infer<typeof Coverage>;

/**
 * Which definitions produced these numbers. Echoed on every response.
 *
 * Trap C in one field: an economy rate is only checkable if the reader knows what
 * went in the denominator.
 */
export const Definitions = z.strictObject({
  /** metric name -> the one-sentence definition used, from `definitions.ts`. */
  metrics: z.record(z.string(), z.string()).default({}),
  phase_source: PhaseSource.nullish(),
  /** What was left out, e.g. "super-over innings", "balls with unknown bowling type". */
  excluded: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});
export type Definitions = z.infer<typeof Definitions>;

/**
 * Trap D. Present whenever rows are ranked.
 *
 * Without minimums, `order_by strike_rate` returns whoever faced three balls and hit
 * two sixes. `entities_considered` vs `entities_qualified` is what lets the answer
 * say "lowest of 36 bowlers who..." instead of "lowest".
 */
export const Qualification = z
  .strictObject({
    min_balls_faced: z.int().min(0).nullish(),
    min_balls_bowled: z.int().min(0).nullish(),
    min_innings: z.int().min(0).nullish(),
    entities_considered: z.int().min(0).nullish(),
    entities_qualified: z.int().min(0).nullish(),
  })
  .superRefine((value, ctx) => {
    const { entities_considered: considered, entities_qualified: qualified } = value;
    if (considered != null && qualified != null && qualified > considered) {
      ctx.addIssue({
        code: "custom",
        path: ["entities_qualified"],
        message: `entities_qualified (${qualified}) exceeds entities_considered (${considered})`,
      });
    }
  });
export type Qualification = z.infer<typeof Qualification>;

/** The project defaults, so no tool hardcodes its own minimums. */
export function qualificationDefaults(
  overrides: Partial<Qualification> = {},
): z.output<typeof Qualification> {
  return Qualification.parse({
    min_balls_faced: MIN_BALLS_FACED,
    min_balls_bowled: MIN_BALLS_BOWLED,
    min_innings: MIN_INNINGS,
    ...overrides,
  });
}

/**
 * Trap B. Present on any answer filtered by a curated attribute.
 *
 * A "vs spin" answer computed over the 24% of deliveries whose bowler we have
 * labelled is not wrong, but presenting it as complete is.
 */
export const AttributeCoverage = z
  .strictObject({
    attribute: z.string().min(1),
    known_deliveries: z.int().min(0),
    total_deliveries: z.int().min(0),
  })
  .superRefine((value, ctx) => {
    if (value.known_deliveries > value.total_deliveries) {
      ctx.addIssue({
        code: "custom",
        path: ["known_deliveries"],
        message: "known_deliveries exceeds total_deliveries",
      });
    }
  });
export type AttributeCoverage = z.infer<typeof AttributeCoverage>;

/**
 * The labelled fraction, or `null` when nothing matched.
 *
 * A function rather than a getter because these objects are plain parsed JSON --
 * they cross the SSE boundary and come back from `JSON.parse`, where a class
 * property would not survive.
 */
export function attributeFraction(coverage: AttributeCoverage | null | undefined): number | null {
  if (!coverage || coverage.total_deliveries === 0) return null;
  return Math.round((coverage.known_deliveries / coverage.total_deliveries) * 10_000) / 10_000;
}

/** A player and where to check the work. Rendered inline on the name. */
export const CricinfoLink = z.strictObject({
  player_id: PlayerId,
  name: z.string().min(1),
  url: z.string().url(),
});
export type CricinfoLink = z.infer<typeof CricinfoLink>;

export const Provenance = z.enum(["computed", "reference"]);
export type Provenance = z.infer<typeof Provenance>;

/**
 * What every stats tool returns, and what the model and the UI both read.
 *
 * `sql` is deliberately absent: the full SQL is 300-800 tokens per call and the
 * model does not need it to write prose. It travels to the UI on the `tool_result`
 * SSE event instead, keyed by `sql_id`.
 */
export const ToolResponse = z
  .strictObject({
    columns: z.array(z.string().min(1)),
    rows: z.array(Row),
    row_count_total: z.int().min(0),
    truncated: z.boolean().default(false),

    coverage: Coverage,
    definitions: Definitions,
    qualification: Qualification.nullish(),
    attribute_coverage: AttributeCoverage.nullish(),

    /**
     * `reference` marks hand-curated cited totals (Trap A). The UI MUST render these
     * distinguishably, with their `source_url` -- a hand-typed figure that reads as a
     * computed one is worse than no figure.
     */
    provenance: Provenance.default("computed"),
    source_url: z.string().url().nullish(),

    sql_id: z.string().min(1).nullish(),
    cricinfo_links: z.array(CricinfoLink).default([]),

    /**
     * An empty result is not an error. These say which filter to loosen, e.g.
     * "date_from=2020 excludes all 41 of this player's matches".
     */
    relaxation_hints: z.array(z.string()).default([]),
  })
  .superRefine((value, ctx) => {
    const declared = new Set(value.columns);
    for (const [i, row] of value.rows.entries()) {
      const extra = Object.keys(row).filter((key) => !declared.has(key));
      if (extra.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["rows", i],
          message: `row ${i} has keys not in columns: ${extra.sort().join(", ")}`,
        });
      }
    }
    if (value.row_count_total < value.rows.length) {
      ctx.addIssue({
        code: "custom",
        path: ["row_count_total"],
        message:
          `row_count_total (${value.row_count_total}) is less than the ` +
          `${value.rows.length} rows returned`,
      });
    }
    if (value.truncated && value.row_count_total === value.rows.length) {
      ctx.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "truncated is true but every row was returned",
      });
    }
    if (value.provenance === "reference" && !value.source_url) {
      ctx.addIssue({
        code: "custom",
        path: ["source_url"],
        message: "a reference response must carry its source_url",
      });
    }
  });
export type ToolResponse = z.infer<typeof ToolResponse>;
