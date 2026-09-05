// ---------------------------------------------------------------------------
// The filter compiler: a validated filter object -> SQL predicates.
// ---------------------------------------------------------------------------
//
// One registry, one loop. Adding a filter is a single `FilterSpec` entry, not a new
// branch, because the version of this that was a twenty-branch `if` chain grew two
// subtly different spellings of the super-over exclusion within a week.
//
// Two rules hold absolutely:
//
// **Every value is a bound parameter.** Not one user string, model string or list
// element is ever formatted into SQL. Only the *column name* and the *operator* come
// from this file's own registry, and both are constants written here rather than
// anything that arrived over the wire. That is what makes the compiler safe by
// construction rather than by review.
//
// **A filter the model invents must fail loudly.** The contract schemas are
// `z.strictObject`, so a hallucinated `bowling_style` is a validation error with the
// real field names attached, not a filter that silently matched everything and an
// answer computed over the wrong population.

import {
  baseFilterShape,
  battingFilterShape,
  bowlingFilterShape,
  matchFilterShape,
} from "../contracts/index.js";

/**
 * Which extra table a filter needs joined. `undefined` means the filter reads a
 * column already denormalised onto `deliveries`, which is the common case and the
 * reason the ingest denormalises at all.
 */
export type Join =
  | "matches"
  | "innings"
  | "bowler_attributes"
  | "batter_attributes"
  | "batting_home_away"
  | "bowling_home_away";

/**
 * Deliberately short, and deliberately without a `between` member: an over range is
 * two specs (`over_from` gte, `over_to` lte), so either bound can be given alone. A
 * single `between_overs` op would have obliged the model to send both.
 *
 * Every member here has a branch in `predicate`, and a test proves it.
 */
export type Op = "in" | "not_in" | "eq" | "gte" | "lte" | "is_true" | "is_false";

/**
 * How one field of a filter model becomes one SQL predicate.
 *
 * `column` is a fully-qualified column reference -- or, where a NULL has to read as a
 * value rather than as no answer, a `coalesce` over one. It is the *only* part of the
 * generated SQL that is not a bound parameter, and it is a literal in this file.
 */
export interface FilterSpec {
  column: string;
  op: Op;
  requiresJoin?: Join;
  /**
   * Prose for the error payload and the tool description. A filter nobody can
   * explain is a filter the model will misuse.
   */
  note?: string;
}

/**
 * Filter field -> how to compile it.
 *
 * Ordered roughly cheapest-first: the leading columns are all denormalised onto
 * `deliveries` and carry zonemaps from the ingest's `ORDER BY match_date`, so a
 * date-bounded query never reads the whole table.
 */
export const FILTER_SPECS = {
  // --- denormalised onto deliveries: no join at all ---
  format: { column: "d.format", op: "in" },
  gender: { column: "d.gender", op: "eq" },
  date_from: { column: "d.match_date", op: "gte", note: "inclusive" },
  date_to: { column: "d.match_date", op: "lte", note: "inclusive" },
  batting_team: { column: "d.batting_team", op: "in" },
  bowling_team: { column: "d.bowling_team", op: "in" },
  venue_canonical: { column: "d.venue_canonical", op: "in" },
  competition: { column: "d.competition", op: "in" },
  innings_no: { column: "d.innings_no", op: "in" },
  // --- the same columns, excluded rather than selected ---
  // "everywhere except his home grounds" was previously ~20 calls plus subtraction,
  // because the only way to express a complement was to enumerate it. Each of these is
  // null-safe -- see the `not_in` branch of `predicate`.
  batting_team_not: { column: "d.batting_team", op: "not_in" },
  bowling_team_not: { column: "d.bowling_team", op: "not_in" },
  venue_canonical_not: { column: "d.venue_canonical", op: "not_in" },
  competition_not: {
    column: "d.competition",
    op: "not_in",
    note: "unlabelled matches (no competition recorded) are KEPT",
  },
  phase: { column: "d.phase", op: "eq", note: "not defined for Test or MDM" },
  // --- ranges over the over number ---
  over_from: { column: "d.over_number", op: "gte", note: "1-based, inclusive" },
  over_to: { column: "d.over_number", op: "lte", note: "1-based, inclusive" },
  // --- batting grain ---
  batter_ids: { column: "d.batter_id", op: "in" },
  batting_position: { column: "d.batting_position", op: "in" },
  // --- bowling grain ---
  bowler_ids: { column: "d.bowler_id", op: "in" },
  // --- curated attributes: these DO need a join, and they are the ones that oblige
  // --- a tool to report attribute_coverage ---
  faced_bowling_type: {
    column: "ba_bowl.bowling_type",
    op: "eq",
    requiresJoin: "bowler_attributes",
  },
  faced_bowling_arm: {
    column: "ba_bowl.bowling_arm",
    op: "eq",
    requiresJoin: "bowler_attributes",
  },
  own_bowling_type: {
    column: "ba_bowl.bowling_type",
    op: "eq",
    requiresJoin: "bowler_attributes",
  },
  own_bowling_arm: {
    column: "ba_bowl.bowling_arm",
    op: "eq",
    requiresJoin: "bowler_attributes",
  },
  // --- match grain ---
  host_country: { column: "m.country", op: "in", requiresJoin: "matches" },
  host_country_not: { column: "m.country", op: "not_in", requiresJoin: "matches" },
  seasons: { column: "m.season", op: "in", requiresJoin: "matches" },
  seasons_not: { column: "m.season", op: "not_in", requiresJoin: "matches" },
  // --- curated home/away: IPL only, and 'unknown' is a real answer ---
  // `coalesce`, not a bare column, because the honest reading of a delivery the curated
  // table does not cover is "we do not know", and that has to be *askable*. Without it
  // `home_away: "unknown"` would match nothing at all while every other value silently
  // dropped the uncovered rows, which is two wrong answers from one omission.
  batting_home_away: {
    column: "coalesce(ha_bat.home_away, 'unknown')",
    op: "eq",
    requiresJoin: "batting_home_away",
    note: "IPL only; 'unknown' elsewhere. 'neutral' is a ground nobody owned, not 'away'",
  },
  bowling_home_away: {
    column: "coalesce(ha_bowl.home_away, 'unknown')",
    op: "eq",
    requiresJoin: "bowling_home_away",
    note: "IPL only; 'unknown' elsewhere. 'neutral' is a ground nobody owned, not 'away'",
  },
  // --- innings grain ---
  is_chase: { column: "i.is_chase", op: "is_true", requiresJoin: "innings" },
} as const satisfies Record<string, FilterSpec>;

export type FilterField = keyof typeof FILTER_SPECS;

/**
 * The joins each `Join` name expands to. Written once here so a filter cannot bring
 * in a subtly different spelling of the same join.
 */
export const JOIN_SQL = {
  matches: "JOIN matches m ON m.match_id = d.match_id",
  innings: "JOIN innings i ON i.match_id = d.match_id AND i.innings_no = d.innings_no",
  bowler_attributes: "LEFT JOIN player_attributes ba_bowl ON ba_bowl.player_id = d.bowler_id",
  batter_attributes: "LEFT JOIN player_attributes ba_bat ON ba_bat.player_id = d.batter_id",
  // `match_home_away` is one row per (match, team), so joining on both columns matches
  // at most one row per delivery. That is the property that matters: a join to this
  // table which could match twice would double every run and wicket in the result, and
  // the total would still look like a plausible number.
  //
  // LEFT, so a delivery from a competition the table does not cover survives with a
  // NULL that the registry's `coalesce` reads as 'unknown'. An inner join would drop
  // every non-IPL ball the moment anything asked for home_away, silently.
  batting_home_away:
    "LEFT JOIN match_home_away ha_bat ON ha_bat.match_id = d.match_id " +
    "AND ha_bat.team = d.batting_team",
  bowling_home_away:
    "LEFT JOIN match_home_away ha_bowl ON ha_bowl.match_id = d.match_id " +
    "AND ha_bowl.team = d.bowling_team",
} as const satisfies Record<Join, string>;

/**
 * Filter fields the compiler handles specially rather than through the registry,
 * listed so `compileFilters` can assert it has not silently ignored anything.
 */
export const SPECIAL_FIELDS: ReadonlySet<string> = new Set([
  "include_super_over", // a default exclusion, not a filter (see below)
  // There is no `matches.subject_team` column and there cannot be: "did they win" is
  // asked *of* a team, and either side of a match can be the subject. query_matches
  // compiles all three against team1/team2 and `winner`.
  "subject_team",
  "subject_team_result",
  "subject_team_won_toss",
]);

/**
 * Every filter field, in the order the contract declares it.
 *
 * Read off the contract shapes rather than restated, for two reasons. The clause
 * order (and therefore `sql_id`) has to match the Python implementation, which
 * iterated its pydantic models in field-definition order; and a field added to the
 * seam then appears here automatically and throws `UnknownFilterField` below until
 * somebody registers it, which is the loud failure we want.
 *
 * The batting and bowling extras never co-occur on one model, so one flat order
 * reproduces each grain's own order exactly.
 */
export const FILTER_FIELD_ORDER: readonly string[] = Object.freeze([
  ...new Set([
    ...Object.keys(baseFilterShape),
    ...Object.keys(battingFilterShape),
    ...Object.keys(bowlingFilterShape),
    ...Object.keys(matchFilterShape),
  ]),
]);

/**
 * A filter field that no `FilterSpec` and no special case covers.
 *
 * Thrown at compile time, not query time, and deliberately not caught: it means
 * somebody added a field to a filter model and forgot the registry, so every query
 * using it would silently ignore it and return an answer over a wider population than
 * asked for. A test asserts this can never happen for the committed models.
 */
export class UnknownFilterField extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownFilterField";
  }
}

/** A value that can be bound to a DuckDB placeholder. */
export type BoundValue = string | number | boolean;

/** Any validated filter object. Values are whatever the contract shapes produce. */
export type FilterInput = Readonly<Record<string, unknown>>;

/**
 * The pieces a tool needs to assemble a query. No SQL string concatenation of user
 * data happens anywhere but here, and here it is column names only.
 */
export class CompiledFilters {
  constructor(
    readonly where: readonly string[],
    readonly params: readonly BoundValue[],
    readonly joins: readonly string[],
    /**
     * Which curated attributes were filtered on; the tool must report coverage for
     * each. Empty for the overwhelming majority of queries.
     */
    readonly attributesUsed: readonly string[],
    /**
     * Indices into `where` of the predicates that came from a curated attribute
     * filter. Needed because attribute *coverage* has to be measured over the
     * population the attribute filter was applied TO -- see `withoutAttributes`.
     */
    readonly attributeClauses: readonly number[] = [],
    /**
     * Parallel to `where`: the filter field each predicate came from, so a relaxation
     * hint can say "drop `date_from`" rather than quoting `d.match_date >= ?`. The
     * model sent field names and can only act on field names, and SQL text is not
     * something it is ever shown.
     */
    readonly clauseFields: readonly string[] = [],
  ) {}

  /** The filter field behind predicate `index`, or the predicate itself. */
  fieldFor(index: number): string {
    return this.clauseFields[index] ?? this.where[index] ?? "";
  }

  /** Always non-empty, so callers can interpolate it without a branch. */
  get whereSql(): string {
    return this.where.length > 0 ? this.where.join(" AND ") : "TRUE";
  }

  get joinSql(): string {
    return this.joins.join("\n");
  }

  /**
   * The bound parameters belonging to the clauses at `keep`, in order.
   *
   * Each clause contributed a known number of `?` in the order it was appended, so
   * counting placeholders is enough to find its slice. This is the only correct way
   * to drop a predicate after the fact: slicing the parameter list by position would
   * silently mis-bind every later filter.
   */
  paramsFor(keep: readonly number[]): BoundValue[] {
    const out: BoundValue[] = [];
    const wanted = new Set(keep);
    let cursor = 0;
    for (const [i, clause] of this.where.entries()) {
      const n = countPlaceholders(clause);
      if (wanted.has(i)) out.push(...this.params.slice(cursor, cursor + n));
      cursor += n;
    }
    return out;
  }

  /**
   * `[whereSql, params]` with the curated-attribute predicates removed.
   *
   * Attribute coverage asks "of the deliveries this question is about, how many carry
   * the attribute?". Measuring it with `bowling_type = 'spin'` still in the WHERE
   * answers a different and useless question -- every matched row has a known type by
   * construction, so coverage would always report 100%.
   */
  withoutAttributes(): [string, BoundValue[]] {
    const dropped = new Set(this.attributeClauses);
    return this.keeping((i) => !dropped.has(i));
  }

  /** `[whereSql, params]` with one predicate dropped, for relaxation hints. */
  withoutClause(index: number): [string, BoundValue[]] {
    return this.keeping((i) => i !== index);
  }

  private keeping(predicate: (index: number) => boolean): [string, BoundValue[]] {
    const keep: number[] = [];
    for (let i = 0; i < this.where.length; i += 1) if (predicate(i)) keep.push(i);
    const where = keep.map((i) => this.where[i]).join(" AND ") || "TRUE";
    return [where, this.paramsFor(keep)];
  }

  hasJoin(name: Join): boolean {
    return this.joins.includes(JOIN_SQL[name]);
  }

  /**
   * A copy with one field's predicate compiled against a different column.
   *
   * Exists for exactly one problem, and it is the batting dismissals CTE. That CTE
   * counts rows at the *wicket* grain, where the row belongs to `w.player_out_id`, but
   * the WHERE it inherits was compiled for the *ball* grain, where `batter_ids` means
   * `d.batter_id` -- the striker. Those are not the same player on 4.8% of dismissals,
   * so `batter_ids: [X] ` + `group_by: ["year"]` counted every wicket that fell while X
   * was on strike, including his partners': more dismissals than innings, which is
   * physically impossible and was reachable in one call.
   *
   * Only the clause text changes. The bindings are untouched and in the same order, so
   * `paramsFor`'s placeholder-counting invariant still holds and the caller can keep
   * pushing `params` exactly as before. A field that was never filtered on is a no-op.
   */
  retargeted(field: FilterField, column: string): CompiledFilters {
    const from = FILTER_SPECS[field].column;
    const where = this.where.map((clause, index) => {
      if (this.clauseFields[index] !== field) return clause;
      if (!clause.includes(from)) {
        // The registry and the compiled SQL have drifted, which means this method
        // quietly stopped retargeting anything and the caller is back to the wrong
        // grain. That is precisely the failure this method exists to prevent, so it
        // throws rather than returning a clause it did not rewrite.
        throw new UnknownFilterField(
          `cannot retarget '${field}': its predicate does not mention ${from}`,
        );
      }
      return clause.replaceAll(from, column);
    });
    return new CompiledFilters(
      where,
      this.params,
      this.joins,
      this.attributesUsed,
      this.attributeClauses,
      this.clauseFields,
    );
  }

  /**
   * A copy with one more predicate appended.
   *
   * `query_matchup` needs a `bowler_ids` predicate on a `BattingFilters` object, where
   * the field does not exist. Returning a new instance rather than mutating this one
   * keeps `paramsFor`'s placeholder-counting invariant intact by construction: the
   * clause and its bindings are appended together or not at all.
   */
  withClause(clause: string, params: readonly BoundValue[], field: string): CompiledFilters {
    return new CompiledFilters(
      [...this.where, clause],
      [...this.params, ...params],
      this.joins,
      this.attributesUsed,
      this.attributeClauses,
      [...this.clauseFields, field],
    );
  }
}

/** Which curated attribute column each attribute filter measures coverage for. */
const ATTRIBUTE_COLUMNS: Readonly<Record<string, string>> = Object.freeze({
  faced_bowling_type: "bowling_type",
  own_bowling_type: "bowling_type",
  faced_bowling_arm: "bowling_arm",
  own_bowling_arm: "bowling_arm",
});

/**
 * Compile a validated filter object into predicates and bound parameters.
 *
 * The input is already validated -- the contract schema has rejected unknown fields,
 * checked that `phase` is not being asked of a Test, and normalised `T20I` to `IT20`.
 * This function's job is purely mechanical.
 */
export function compileFilters(filters: FilterInput): CompiledFilters {
  const where: string[] = [];
  const params: BoundValue[] = [];
  const attributes: string[] = [];
  const attributeClauses: number[] = [];
  const clauseFields: string[] = [];
  const needed: Join[] = [];

  // Trap: super overs are excluded BY DEFAULT and the exclusion is a predicate like
  // any other. Including them silently inflates every T20 strike rate by a little --
  // little enough to look plausible, which is what makes it dangerous.
  if (filters["include_super_over"] !== true) {
    where.push("NOT d.is_super_over");
    clauseFields.push("include_super_over");
  }

  for (const field of fieldsOf(filters)) {
    const value = filters[field];
    if (value === undefined || value === null || SPECIAL_FIELDS.has(field)) continue;
    const spec: FilterSpec | undefined = (FILTER_SPECS as Record<string, FilterSpec>)[field];
    if (spec === undefined) {
      throw new UnknownFilterField(
        `'${field}' is a filter field with no FilterSpec. Add one to FILTER_SPECS or to ` +
          `SPECIAL_FIELDS; leaving it out means every query silently ignores it.`,
      );
    }
    // An empty list is not "match nothing"; it is a caller who built a filter and put
    // nothing in it. Treat as absent rather than returning zero rows and an
    // inexplicable empty answer.
    if (Array.isArray(value) && value.length === 0) continue;

    const [clause, bound] = predicate(spec, value);
    if (field in ATTRIBUTE_COLUMNS) {
      const column = ATTRIBUTE_COLUMNS[field];
      if (column !== undefined) attributes.push(column);
      attributeClauses.push(where.length);
    }
    where.push(clause);
    clauseFields.push(field);
    params.push(...bound);
    if (spec.requiresJoin !== undefined && !needed.includes(spec.requiresJoin)) {
      needed.push(spec.requiresJoin);
    }
  }

  return new CompiledFilters(
    where,
    params,
    needed.map((name) => JOIN_SQL[name]),
    [...new Set(attributes)].sort(),
    attributeClauses,
    clauseFields,
  );
}

/**
 * The fields to compile, in contract order, followed by anything the caller supplied
 * that the contract does not declare.
 *
 * The tail is what makes an unregistered field loud. Contract order alone would skip a
 * key the schema has never heard of, and skipping is the one behaviour we cannot
 * afford: a filter that is quietly dropped answers a wider question than was asked.
 */
function fieldsOf(filters: FilterInput): string[] {
  const declared = new Set(FILTER_FIELD_ORDER);
  return [...FILTER_FIELD_ORDER, ...Object.keys(filters).filter((key) => !declared.has(key))];
}

/**
 * One spec plus one value -> one predicate and its bound parameters.
 *
 * Every branch emits `?` placeholders. The only interpolation is `spec.column`, which
 * is a constant from `FILTER_SPECS`.
 */
function predicate(spec: FilterSpec, value: unknown): [string, BoundValue[]] {
  switch (spec.op) {
    case "in": {
      const values = (Array.isArray(value) ? value : [value]) as BoundValue[];
      return [`${spec.column} IN (${values.map(() => "?").join(", ")})`, values];
    }
    case "not_in": {
      const values = (Array.isArray(value) ? value : [value]) as BoundValue[];
      const list = values.map(() => "?").join(", ");
      // `col NOT IN (...)` evaluates to NULL, not TRUE, when `col` is NULL, and a WHERE
      // keeps only TRUE -- so the obvious spelling silently discards every row whose
      // column is unset. 66 IT20 matches carry no `competition` at all, so
      // `competition_not: ["Indian Premier League"]` written the obvious way would drop
      // the unlabelled bilaterals as well as the IPL, and the count would look
      // plausible. The IS NULL arm is the whole point of this branch.
      return [`(${spec.column} IS NULL OR ${spec.column} NOT IN (${list}))`, values];
    }
    case "eq":
      return [`${spec.column} = ?`, [value as BoundValue]];
    case "gte":
      return [`${spec.column} >= ?`, [value as BoundValue]];
    case "lte":
      return [`${spec.column} <= ?`, [value as BoundValue]];
    case "is_true":
      // A tri-state boolean filter: true means "only chases", false means "only
      // non-chases". Compiling false to no predicate at all would silently widen the
      // question, so both directions are explicit.
      return [value ? spec.column : `NOT ${spec.column}`, []];
    case "is_false":
      return [value ? `NOT ${spec.column}` : spec.column, []];
    default: {
      const unreachable: never = spec.op;
      throw new UnknownFilterField(`FilterSpec op '${String(unreachable)}' has no compiler branch`);
    }
  }
}

function countPlaceholders(clause: string): number {
  let n = 0;
  for (const character of clause) if (character === "?") n += 1;
  return n;
}

/**
 * Every filter field a tool will accept, for the `allowed` list on an error.
 *
 * Read off the registry rather than hand-listed, so an error payload cannot advertise
 * a filter that does not exist or omit one that does.
 */
export function knownFields(): string[] {
  return [...new Set([...Object.keys(FILTER_SPECS), ...SPECIAL_FIELDS])].sort();
}
