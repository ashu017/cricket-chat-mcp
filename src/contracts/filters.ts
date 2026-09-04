import { z } from "zod";
import {
  BowlingArm,
  BowlingType,
  FormatInput,
  Gender,
  IsoDate,
  MatchResult,
  Phase,
  PlayerId,
  SortDirection,
} from "./scalars.js";
import { UNLIMITED_OVERS_FORMATS } from "./thresholds.js";

// ---------------------------------------------------------------------------
// Tool input models
// ---------------------------------------------------------------------------
//
// Every object here is a `strictObject`, and that is load-bearing. A model that
// invents `bowling_style` must get a correctable error naming the real field, not a
// silently ignored filter and an answer computed over the wrong population.
//
// The shapes are exported as plain field maps rather than as finished schemas
// because the grain models *extend* them. In Python this was subclassing, and the
// `model_validator` ran on every subclass for free. Zod refinements do not survive
// `.extend()`, so the pattern here is: build the shape, extend the shape, then apply
// `withBaseFilterChecks` to the finished object. `assertEveryFilterModelIsChecked`
// in the test suite asserts that every exported filter model went through it.

const unlimited = new Set<string>(UNLIMITED_OVERS_FORMATS);

/** Filters valid at every grain. */
export const baseFilterShape = {
  format: z.array(FormatInput).nonempty().optional(),
  gender: Gender.optional(),
  date_from: IsoDate.optional(),
  date_to: IsoDate.optional(),

  // Named for the innings, never "team"/"opponent" -- those had no defined
  // direction, so "Kohli vs Australia" was ambiguous about who was batting.
  batting_team: z.array(z.string().min(1)).nonempty().optional(),
  bowling_team: z.array(z.string().min(1)).nonempty().optional(),

  venue_canonical: z.array(z.string().min(1)).nonempty().optional(),
  host_country: z.array(z.string().min(1)).nonempty().optional(),
  competition: z.array(z.string().min(1)).nonempty().optional(),
  innings_no: z.array(z.int().min(1).max(4)).nonempty().optional(),
  is_chase: z.boolean().optional(),

  // Ambiguous by nature: both "2019/20" and "2019" occur in the source. Tool
  // descriptions prefer date_from/date_to.
  seasons: z.array(z.string().min(1)).nonempty().optional(),

  // The complements. "His away record" is a question about everything that is *not*
  // one short list, and without these the only way to ask it was to enumerate the
  // other side -- fifteen seasons, or every venue but two -- and then subtract by
  // hand across a dozen calls. Each excludes rows whose value is in the list and
  // KEEPS rows whose value is unrecorded; see the `not_in` compiler branch.
  batting_team_not: z.array(z.string().min(1)).nonempty().optional(),
  bowling_team_not: z.array(z.string().min(1)).nonempty().optional(),
  venue_canonical_not: z.array(z.string().min(1)).nonempty().optional(),
  host_country_not: z.array(z.string().min(1)).nonempty().optional(),
  competition_not: z.array(z.string().min(1)).nonempty().optional(),
  seasons_not: z.array(z.string().min(1)).nonempty().optional(),

  phase: Phase.optional(),
  over_from: z.int().min(1).optional(),
  over_to: z.int().min(1).optional(),

  // Off by default. Super-over innings do not count toward career stats, and
  // including them by accident inflates every T20 strike rate slightly -- small
  // enough to look plausible, which is what makes it dangerous.
  include_super_over: z.boolean().default(false),
} as const;

type BaseFilterFields = {
  format?: readonly string[] | undefined;
  phase?: string | undefined;
  over_from?: number | undefined;
  over_to?: number | undefined;
  date_from?: string | undefined;
  date_to?: string | undefined;
} & {
  // Index signature rather than six optional keys: `EXCLUSION_PAIRS` below is what
  // decides which fields pair up, and listing them twice invites the two lists to
  // disagree.
  [field: string]: unknown;
};

/**
 * Each `_not` field and the positive field it complements.
 *
 * Read by {@link baseFilterChecks} so that asking for a value and excluding the same
 * value is an error rather than an empty answer. Zero rows here would be reported with
 * a relaxation hint naming one of the two fields, which is a true statement that walks
 * the model straight back into the same contradiction.
 */
const EXCLUSION_PAIRS: readonly (readonly [string, string])[] = [
  ["batting_team", "batting_team_not"],
  ["bowling_team", "bowling_team_not"],
  ["venue_canonical", "venue_canonical_not"],
  ["host_country", "host_country_not"],
  ["competition", "competition_not"],
  ["seasons", "seasons_not"],
];

/**
 * The cross-field rules that hold at every grain.
 *
 * Each one attaches to the field the model must change, not to the object, because
 * `ErrorDetail.field` is read straight off the first Zod issue and a correction
 * addressed to the whole object is a correction the model cannot act on.
 */
export function baseFilterChecks(value: BaseFilterFields, ctx: z.RefinementCtx): void {
  if (value.phase !== undefined && value.format?.length) {
    const offenders = value.format.filter((f) => unlimited.has(f));
    if (offenders.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["phase"],
        message:
          `phase is not defined for ${offenders.join(", ")}: there is no powerplay in ` +
          `an unlimited-overs match. Drop the phase filter or drop those formats.`,
      });
    }
  }
  if (value.phase !== undefined && (value.over_from !== undefined || value.over_to !== undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["phase"],
      message:
        "phase and over_from/over_to are mutually exclusive: phase is already an " +
        "over range. Use one or the other.",
    });
  }
  if (value.over_from !== undefined && value.over_to !== undefined) {
    if (value.over_from > value.over_to) {
      ctx.addIssue({
        code: "custom",
        path: ["over_from"],
        message: `over_from (${value.over_from}) is after over_to (${value.over_to})`,
      });
    }
  }
  for (const [positive, negative] of EXCLUSION_PAIRS) {
    const included = value[positive];
    const excluded = value[negative];
    if (!Array.isArray(included) || !Array.isArray(excluded)) continue;
    const both = included.filter((item) => (excluded as unknown[]).includes(item));
    if (both.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: [negative],
        message:
          `${both.map((item) => JSON.stringify(item)).join(", ")} appears in both ` +
          `${positive} and ${negative}, so nothing can match. Use ${positive} alone to ` +
          `select those values, or ${negative} alone to exclude them.`,
      });
    }
  }
  // ISO-8601 dates compare correctly as strings, which is most of the reason
  // `IsoDate` is a string. See scalars.ts.
  if (value.date_from !== undefined && value.date_to !== undefined) {
    if (value.date_from > value.date_to) {
      ctx.addIssue({
        code: "custom",
        path: ["date_from"],
        message: `date_from (${value.date_from}) is after date_to (${value.date_to})`,
      });
    }
  }
}

/** Attach {@link baseFilterChecks} to a finished filter object. */
export function withBaseFilterChecks<S extends z.ZodType<BaseFilterFields>>(schema: S) {
  return schema.superRefine(baseFilterChecks);
}

export const BaseFilters = withBaseFilterChecks(z.strictObject(baseFilterShape));
export type BaseFilters = z.infer<typeof BaseFilters>;

/** Batting grain. `faced_bowling_type` is the type the batter *faced*. */
export const battingFilterShape = {
  ...baseFilterShape,
  batter_ids: z.array(PlayerId).nonempty().optional(),
  batting_position: z.array(z.int().min(1).max(11)).nonempty().optional(),
  faced_bowling_type: BowlingType.optional(),
  faced_bowling_arm: BowlingArm.optional(),
} as const;

export const BattingFilters = withBaseFilterChecks(z.strictObject(battingFilterShape));
export type BattingFilters = z.infer<typeof BattingFilters>;

/**
 * Bowling grain. `own_bowling_type` is the bowler's own type.
 *
 * Split from {@link BattingFilters} because one shared model made `bowling_type` mean
 * two different things depending on the tool, and `batting_position` meaningless on
 * half of them.
 */
export const bowlingFilterShape = {
  ...baseFilterShape,
  bowler_ids: z.array(PlayerId).nonempty().optional(),
  own_bowling_type: BowlingType.optional(),
  own_bowling_arm: BowlingArm.optional(),
} as const;

export const BowlingFilters = withBaseFilterChecks(z.strictObject(bowlingFilterShape));
export type BowlingFilters = z.infer<typeof BowlingFilters>;

/** Match grain. `subject_team` is the team the result is expressed from. */
export const matchFilterShape = {
  ...baseFilterShape,
  subject_team: z.string().min(1).optional(),
  subject_team_result: MatchResult.optional(),
  subject_team_won_toss: z.boolean().optional(),
} as const;

export const MatchFilters = withBaseFilterChecks(z.strictObject(matchFilterShape)).superRefine(
  (value, ctx) => {
    if (value.subject_team !== undefined) return;
    for (const field of ["subject_team_result", "subject_team_won_toss"] as const) {
      if (value[field] !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} requires subject_team: 'won' is meaningless without naming who won.`,
        });
      }
    }
  },
);
export type MatchFilters = z.infer<typeof MatchFilters>;

// ---------------------------------------------------------------------------
// The query envelope
// ---------------------------------------------------------------------------

/** Server-side ceiling on `limit`, and the second half of Trap D. */
export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 20;

/**
 * The shared shape of the aggregate queries.
 *
 * Each tool narrows `group_by` to its own enum and `filters` to its own grain, so
 * this exports the *shape* plus the one rule that holds everywhere. `group_by` is
 * `z.string()` here only because a per-tool enum replaces it; a tool that ships the
 * bare shape has skipped the narrowing and `tools lint` fails it.
 */
export const queryRequestShape = {
  group_by: z.array(z.string().min(1)).optional(),
  order_by: z.string().min(1).optional(),
  order_dir: SortDirection.default("desc"),
  limit: z.int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  // Rows past the ceiling were previously unreachable: with 1,400 qualified batters and
  // a hard `limit` of 200, ranks 201 and beyond existed in `row_count_total` and could
  // not be fetched at all. Flipping `order_dir` reached the other end of the list and
  // nothing reached the middle. Paging is the honest fix, and it costs no tokens per
  // call -- unlike raising MAX_LIMIT, which is why that stays where it is.
  offset: z.int().min(0).default(0),
} as const;

/**
 * Trap D's other half, and the most common malformed call there is.
 *
 * An unordered `group_by: ["player"]` returns thousands of rows in arbitrary order
 * -- 100k+ tokens of context for an answer that needed ten rows.
 */
export function queryRequestChecks(
  value: { group_by?: readonly string[] | undefined; order_by?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.group_by?.length && value.order_by === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["order_by"],
      message:
        "order_by is required when group_by is set: an unordered group_by=player " +
        "returns thousands of rows in arbitrary order.",
    });
  }
}

export const QueryRequest = z.strictObject(queryRequestShape).superRefine(queryRequestChecks);
export type QueryRequest = z.infer<typeof QueryRequest>;
