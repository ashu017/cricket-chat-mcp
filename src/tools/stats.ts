// The three ball-by-ball stats tools.
//
// `query_batting_aggregate` and `query_bowling_aggregate` are the same function with a
// different metric registry; `query_matchup` is the same query pinned to one batter and
// one bowler. All the SQL comes from `aggregate.ts`, all the arithmetic from
// `definitions.ts`, and all the predicates from `filters.ts` -- what is left here is
// argument handling and assembling a `ToolResponse`.

import {
  type AttributeCoverage,
  BattingFilters,
  BowlingFilters,
  type PhaseSource,
  QueryRequest,
  type Row,
  ToolResponse,
} from "../contracts/index.js";
import {
  type BoundValue,
  compileFilters,
  FILTER_SPECS,
  MIN_BALLS_BOWLED,
  MIN_BALLS_FACED,
  MIN_INNINGS,
} from "../core/index.js";

import * as aggregate from "./aggregate.js";
import {
  attributeCoverage,
  buildCoverage,
  cleanRows,
  cricinfoLinks,
  type Db,
  DEFAULT_LIMIT,
  definitionsFor,
  examplesBlock,
  type JsonSchema,
  MAX_LIMIT,
  prose,
  Qualifier,
  relaxationHints,
  sqlId,
  superOverNote,
  type ToolOutcome,
  type ToolSpec,
} from "./base.js";
import * as errors from "./errors.js";
import * as schemas from "./schemas.js";

/** Bookkeeping columns the query carries and the model must never see. */
const PRIVATE: ReadonlySet<string> = new Set(["_qualified", "_considered", "_scanned", "_grp"]);

/**
 * Which phase definition produced these rows.
 *
 * Reports the weakest provenance present, not the commonest. If any ball in scope had
 * its powerplay length assumed rather than declared, the answer should say the
 * definition was assumed -- averaging that away would be a smaller number and a less
 * honest one.
 */
async function phaseSource(
  db: Db,
  where: string,
  params: readonly BoundValue[],
  joins: string,
): Promise<PhaseSource | null> {
  const result = await db.query(
    `SELECT DISTINCT d.phase_source FROM deliveries d ${joins} WHERE ${where}`,
    params,
  );
  const present = new Set(
    result.rows
      .map((row) => row["phase_source"])
      .filter((value): value is string => Boolean(value)),
  );
  const order: PhaseSource[] = ["default", "declared", "null"];
  for (const candidate of order) {
    if (present.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Enforce the ceiling before the schema does, so the error names the ceiling.
 *
 * `max(200)` on the contract would reject 5000 with "less than or equal to 200", which
 * is true but does not tell the model what to do. LIMIT_EXCEEDED with a `fix_example`
 * does.
 */
function parseLimit(tool: string, args: Readonly<Record<string, unknown>>): number {
  const limit = Object.hasOwn(args, "limit") ? args["limit"] : DEFAULT_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit)) {
    throw errors.badEnum(tool, "limit", limit, ["an integer between 1 and 200"]);
  }
  if (limit > MAX_LIMIT) {
    throw errors.error(
      "LIMIT_EXCEEDED",
      tool,
      `limit=${limit} exceeds the maximum of ${MAX_LIMIT}. Ask a narrower ` +
        `question or add filters rather than requesting more rows; the answer ` +
        `a reader wants is in the top few.`,
      { field: "limit", received: limit, fixExample: { limit: MAX_LIMIT } },
    );
  }
  return limit;
}

/** Strip the bookkeeping columns from a raw result row. */
function publicRows(rows: readonly Row[]): Row[] {
  return cleanRows(
    rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !PRIVATE.has(key)))),
  );
}

/** True when the aggregate returned its all-NULL "nothing matched" row. */
function isEmptyTotal(row: Row | undefined): boolean {
  if (row === undefined) return false;
  const innings = row["innings"];
  return innings === 0 || innings === null || innings === undefined;
}

async function runAggregate(
  db: Db,
  rawArgs: Readonly<Record<string, unknown>>,
  tool: string,
  grain: aggregate.Grain,
): Promise<ToolOutcome> {
  const filtersModel = grain === "batting" ? BattingFilters : BowlingFilters;
  const dims = aggregate.dimsFor(grain);
  const metrics = aggregate.metricsFor(grain);
  const ballsField = grain === "batting" ? "min_balls_faced" : "min_balls_bowled";

  const args: Record<string, unknown> = { ...rawArgs };
  const minBalls = take(args, ballsField);
  const minInnings = take(args, "min_innings");
  // The wrong minimum name is a likely model slip and a silent one: dropped as an
  // unknown key it would return an unqualified leaderboard.
  const other = grain === "batting" ? "min_balls_bowled" : "min_balls_faced";
  if (Object.hasOwn(args, other)) {
    throw errors.error(
      "UNKNOWN_FILTER_FIELD",
      tool,
      `${other} is the ${grain === "batting" ? "bowling" : "batting"} minimum; ` +
        `this tool takes ${ballsField}.`,
      {
        field: other,
        received: args[other],
        allowed: [ballsField, "min_innings"],
        suggestions: [ballsField],
      },
    );
  }

  const limit = parseLimit(tool, args);
  const rawFilters = take(args, "filters") ?? {};

  const parsedFilters = filtersModel.safeParse(rawFilters);
  if (!parsedFilters.success) {
    throw errors.fromValidationError(tool, parsedFilters.error, rawFilters);
  }
  const filters = parsedFilters.data;

  const parsedRequest = QueryRequest.safeParse({ ...args, limit });
  if (!parsedRequest.success) {
    throw errors.fromValidationError(tool, parsedRequest.error, { ...args, limit });
  }
  const request = parsedRequest.data;

  const groupBy = request.group_by ?? [];
  for (const name of groupBy) {
    if (!Object.hasOwn(dims, name)) {
      throw errors.badEnum(tool, "group_by", name, Object.keys(dims).sort());
    }
  }
  const orderBy = request.order_by ?? (grain === "batting" ? "runs" : "wickets");
  if (!metrics.includes(orderBy)) throw errors.badEnum(tool, "order_by", orderBy, metrics);

  const compiled = compileFilters(filters);

  // Trap D applies to *rankings*. A single total for one filtered player is not a
  // ranking, and silently returning nothing because he faced 58 balls at that venue
  // would be a worse failure than an unqualified number. So the minimums attach when a
  // breakdown is requested, or when the caller asks for them.
  const ranked = groupBy.length > 0;
  let qualifier: Qualifier | undefined;
  if (ranked || minBalls !== undefined || minInnings !== undefined) {
    qualifier =
      grain === "batting"
        ? Qualifier.batting(asMinimum(minBalls), asMinimum(minInnings))
        : Qualifier.bowling(asMinimum(minBalls), asMinimum(minInnings));
  }
  const having = qualifier !== undefined ? qualifier.havingSql : "TRUE";

  const built = aggregate.build(grain, compiled, {
    groupBy,
    orderBy,
    orderDir: request.order_dir,
    limit,
    offset: request.offset,
    havingSql: having,
  });
  const result = await db.query(built.sql, built.params);
  let rawRows = result.rows;

  const head = rawRows[0];
  let considered = head !== undefined ? Number(head["_considered"]) : 0;
  let qualified = head !== undefined ? Number(head["_qualified"]) : 0;
  const scanned = head !== undefined ? Number(head["_scanned"]) : 0;

  // With no group_by the aggregate always yields one row, even when nothing matched --
  // a row of NULLs. That is an empty result, not a zero.
  if (!ranked && isEmptyTotal(head)) {
    rawRows = [];
    considered = 0;
    qualified = 0;
  }

  // An empty page past the end of the list looks exactly like an over-restrictive filter
  // -- no rows, and `count(*) OVER ()` never evaluated, so `_qualified` is absent and
  // every total reads zero. Saying "no batter matched" when 140 did and the caller asked
  // for rank 300 is the invisible-wrongness failure, so this asks the same question again
  // for one row at offset 0, purely to recover the real total.
  const overshot = rawRows.length === 0 && request.offset > 0;
  if (overshot) {
    const probe = aggregate.build(grain, compiled, {
      groupBy,
      orderBy,
      orderDir: request.order_dir,
      limit: 1,
      offset: 0,
      havingSql: having,
    });
    const probed = (await db.query(probe.sql, probe.params)).rows[0];
    if (probed !== undefined) {
      considered = Number(probed["_considered"]);
      qualified = Number(probed["_qualified"]);
    }
  }

  const rows = publicRows(rawRows);
  const hints = overshot
    ? [
        `offset=${request.offset} is past the end of this list: ${qualified} row(s) ` +
          `qualified in total, so the last reachable page starts at ` +
          `offset=${Math.max(0, qualified - limit)}.`,
      ]
    : rows.length === 0
      ? await relaxationHints(db, compiled, ranked ? qualifier : undefined)
      : [];

  const playerIds = (
    grain === "batting"
      ? ((filters as BattingFilters).batter_ids ?? [])
      : ((filters as BowlingFilters).bowler_ids ?? [])
  ).slice();
  const playerAlias = dims["player"]?.alias ?? "";
  const named = rows
    .filter((row) => playerAlias in row)
    .map((row) => String(row[playerAlias] ?? ""));

  let attr: AttributeCoverage | null = null;
  const attribute = compiled.attributesUsed[0];
  if (attribute !== undefined) attr = await attributeCoverage(db, attribute, compiled);

  const response = ToolResponse.parse({
    columns: built.columns,
    rows,
    row_count_total: Math.max(qualified, rows.length),
    truncated: qualified > rows.length,
    coverage: await buildCoverage(db, {
      where: compiled.whereSql,
      params: compiled.params,
      joins: compiled.joinSql,
      playerIds,
    }),
    definitions: definitionsFor(built.columns, {
      grain,
      excluded: superOverNote(filters.include_super_over),
      notes: notesFor(grain, groupBy, dims),
      phaseSource:
        filters.phase !== undefined || groupBy.includes("phase")
          ? await phaseSource(db, compiled.whereSql, compiled.params, compiled.joinSql)
          : null,
    }),
    qualification: qualifier !== undefined ? qualifier.toContract(considered, qualified) : null,
    attribute_coverage: attr,
    sql_id: sqlId(built.sql),
    cricinfo_links: await cricinfoLinks(db, [...playerIds, ...named]),
    relaxation_hints: hints,
  });
  return { response, sql: built.sql, deliveriesScanned: scanned };
}

/** Read and remove a key, mirroring Python's `dict.pop(key, None)`. */
function take(args: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(args, key)) return undefined;
  const value = args[key];
  delete args[key];
  return value ?? undefined;
}

/**
 * A caller-supplied qualification minimum, or undefined to take the default.
 *
 * Anything that is not an integer is dropped rather than rejected: the value reaches
 * `havingSql`, which interpolates it, and `Math.trunc` there is the last line of
 * defence rather than the only one.
 */
function asMinimum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/** Surface the caveat attached to any dimension actually used. */
function notesFor(
  grain: aggregate.Grain,
  groupBy: readonly string[],
  dims: Readonly<Record<string, aggregate.GroupDim>>,
): string[] {
  const notes = groupBy
    .map((name) => dims[name]?.note)
    .filter((note): note is string => note !== undefined && note !== "");
  notes.push(
    grain === "bowling"
      ? "wickets are bowler-credited only: run outs are excluded, as on a scorecard"
      : "dismissals are attributed to the batter who was out, not the striker, " +
          "so run outs at the non-striker's end count against the right player",
  );
  return notes;
}

// ---------------------------------------------------------------------------
// Tool specs. The description IS the prompt.
// ---------------------------------------------------------------------------

/**
 * The `_not` fields, described once for both grains.
 *
 * Spelled out because the alternative is what the model actually did without them:
 * enumerate the fifteen seasons that are not the two you mean, or the several hundred
 * venues that are not his home ground, and subtract by hand across a dozen calls.
 */
const EXCLUSION_HELP =
  "Six fields take an exclusion instead of a selection: batting_team_not, " +
  "bowling_team_not, venue_canonical_not, host_country_not, competition_not and " +
  "seasons_not. Each drops rows whose value is in the list and KEEPS rows whose " +
  "value was never recorded, so competition_not still counts matches with no " +
  "competition name. Use one to ask about everything except a short list -- " +
  "'away from his home grounds' is venue_canonical_not, not an enumeration of every " +
  "other venue. Passing the same value to a field and its _not twin is an error, " +
  "not an empty answer.";

const BATTING_FILTER_HELP =
  "Ball-by-ball filters. batter_ids takes Cricsheet player ids (8 hex chars) from " +
  "resolve_entity, never names. batting_team is the team the batter played FOR; " +
  "bowling_team is the opposition. faced_bowling_type/faced_bowling_arm describe " +
  "the BOWLER the batter faced, and are only known for a curated subset of " +
  "bowlers -- the response reports attribute_coverage so you can say how much of " +
  "the data was labelled. " +
  EXCLUSION_HELP;

const BOWLING_FILTER_HELP =
  "Ball-by-ball filters. bowler_ids takes Cricsheet player ids (8 hex chars) from " +
  "resolve_entity, never names. bowling_team is the team the bowler played FOR; " +
  "batting_team is the opposition. own_bowling_type/own_bowling_arm describe the " +
  "bowler themselves and are only known for a curated subset -- the response " +
  "reports attribute_coverage. " +
  EXCLUSION_HELP;

const BATTING_EXAMPLES: Record<string, unknown>[] = [
  {
    filters: { format: ["IT20"], date_from: "2020-01-01", phase: "death" },
    group_by: ["player"],
    order_by: "strike_rate",
    order_dir: "desc",
    limit: 10,
  },
  {
    filters: {
      batter_ids: ["99b75528"],
      format: ["IT20"],
      faced_bowling_type: "spin",
    },
  },
];

const BOWLING_EXAMPLES: Record<string, unknown>[] = [
  {
    filters: { format: ["IT20"], phase: "death", date_from: "2021-01-01" },
    group_by: ["player"],
    order_by: "economy",
    order_dir: "asc",
    limit: 10,
  },
  {
    filters: { bowler_ids: ["201fef33"], format: ["IT20"] },
    group_by: ["year"],
    order_by: "wickets",
    order_dir: "desc",
  },
];

const BATTING_DIM_NAMES = Object.keys(aggregate.BATTING_DIMS).sort().join(", ");
const BOWLING_DIM_NAMES = Object.keys(aggregate.BOWLING_DIMS).sort().join(", ");

export const BATTING_DESCRIPTION = `${prose(`
Batting statistics computed from ball-by-ball data: runs, strike rate,
    average, boundary and dot percentages, for any slice of the data.

DO NOT use this tool for:
- bowling figures (economy, wickets, overs) -- use query_bowling_aggregate.
- one specific batter against one specific bowler -- use query_matchup, which
    handles the small-sample warning.
- a single match's card -- use get_scorecard.
- a list of matches, results or margins -- use query_matches.
- career totals for a player who debuted before ball-by-ball coverage -- use
    get_career_reference for the cited career figure, and read
    coverage.career_possibly_truncated on this response before calling any total a
    "career" total.
- turning a name into an id -- use resolve_entity first. Passing a name in
    batter_ids is an error.

group_by values: ${BATTING_DIM_NAMES}.
order_by values: ${aggregate.metricsFor("batting").join(", ")}.
format values: Test, ODI, T20, IT20, MDM, ODM. Note T20 means domestic/franchise T20
    and IT20 means men's or women's international T20 -- if the user says "T20
    cricket" generally, pass BOTH.
phase values: powerplay, middle, death. Not defined for Test/MDM and passing it with
    those formats is an error.
gender values: male, female.
faced_bowling_type values: pace, spin, unknown. faced_bowling_arm values: left,
    right, unknown. Both describe the bowler being faced and are known only for a
    curated subset, so the response reports attribute_coverage -- quote it.
order_dir values: asc, desc. desc is the default and is what "best" means for runs
    and strike_rate; use asc for a metric that is better when lower.

Defaults you must mention when reporting a ranking: rows are qualified at
    min_balls_faced=${MIN_BALLS_FACED} and
    min_innings=${MIN_INNINGS} whenever group_by is set, so the list is
    "the best of those who faced at least ${MIN_BALLS_FACED} balls" --
    say so. Pass min_balls_faced explicitly to change it. limit defaults to 20 and
    cannot exceed ${MAX_LIMIT}. order_by is REQUIRED when group_by is set.
    Super-over innings are excluded unless include_super_over is true.

offset skips rows before the page you get back, which is the only way to see past
    ${MAX_LIMIT}: row_count_total says how many qualified, and offset=${MAX_LIMIT}
    with limit=${MAX_LIMIT} is the second page of that many. Reach for it when the
    user asks where someone ranks rather than who is top.`)}

${examplesBlock(BATTING_EXAMPLES)}`;

export const BOWLING_DESCRIPTION = `${prose(`
Bowling statistics computed from ball-by-ball data: wickets, economy,
    bowling average and strike rate, dot percentage, overs, for any slice of the
    data.

DO NOT use this tool for:
- batting figures (runs, strike rate as a batter) -- use query_batting_aggregate.
- one specific bowler against one specific batter -- use query_matchup.
- a single match's card -- use get_scorecard.
- a list of matches, results or margins -- use query_matches.
- turning a name into an id -- use resolve_entity first. Passing a name in
    bowler_ids is an error.

group_by values: ${BOWLING_DIM_NAMES}.
order_by values: ${aggregate.metricsFor("bowling").join(", ")}. economy and average
    are better when LOWER, so pass order_dir="asc" for "most economical" or "best
    average"; wickets and dot_pct are better when higher.
format values: Test, ODI, T20, IT20, MDM, ODM. T20 is domestic/franchise, IT20 is
    international -- pass both if the user means T20 cricket generally.
phase values: powerplay, middle, death. Not defined for Test/MDM.
gender values: male, female.

Definitions that matter: wickets counts bowler-credited dismissals only (run outs
    excluded, as on a scorecard). balls_bowled excludes wides AND no-balls, which is
    the legal-ball count an over is measured in -- it is a different denominator
    from a batter's balls_faced, which excludes wides only.

Defaults you must mention when reporting a ranking: rows are qualified at
    min_balls_bowled=${MIN_BALLS_BOWLED} and
    min_innings=${MIN_INNINGS} whenever group_by is set -- say "of the
    bowlers who bowled at least ${MIN_BALLS_BOWLED} balls". Pass
    min_balls_bowled to change it. limit defaults to 20, maximum ${MAX_LIMIT}.
    order_by is REQUIRED when group_by is set. Super overs excluded unless
    include_super_over is true.

offset skips rows before the page returned, and is the only way to reach past
    ${MAX_LIMIT} rows; row_count_total says how many qualified in total.`)}

${examplesBlock(BOWLING_EXAMPLES)}`;

function battingSchema(): JsonSchema {
  const schema = schemas.aggregateSchema({
    filters: BattingFilters,
    groupByValues: Object.keys(aggregate.BATTING_DIMS).sort(),
    orderByValues: aggregate.metricsFor("batting"),
    filtersDescription: BATTING_FILTER_HELP,
  });
  const properties = schema["properties"] as Record<string, unknown>;
  properties["min_balls_faced"] = {
    type: "integer",
    minimum: 0,
    description:
      `Qualification minimum, default ${MIN_BALLS_FACED} when ` +
      `group_by is set. Lower it only if the user asked for a small sample, ` +
      `and say so in the answer.`,
  };
  properties["min_innings"] = {
    type: "integer",
    minimum: 0,
    description: `Qualification minimum, default ${MIN_INNINGS}.`,
  };
  return schema;
}

function bowlingSchema(): JsonSchema {
  const schema = schemas.aggregateSchema({
    filters: BowlingFilters,
    groupByValues: Object.keys(aggregate.BOWLING_DIMS).sort(),
    orderByValues: aggregate.metricsFor("bowling"),
    filtersDescription: BOWLING_FILTER_HELP,
  });
  const properties = schema["properties"] as Record<string, unknown>;
  properties["min_balls_bowled"] = {
    type: "integer",
    minimum: 0,
    description: `Qualification minimum, default ${MIN_BALLS_BOWLED} when group_by is set.`,
  };
  properties["min_innings"] = {
    type: "integer",
    minimum: 0,
    description: `Qualification minimum, default ${MIN_INNINGS}.`,
  };
  return schema;
}

export const BATTING_TOOL: ToolSpec = {
  name: "query_batting_aggregate",
  description: BATTING_DESCRIPTION,
  inputSchema: battingSchema(),
  handler: (db, args) => runAggregate(db, args, "query_batting_aggregate", "batting"),
  shape: "table",
  examples: BATTING_EXAMPLES,
};

export const BOWLING_TOOL: ToolSpec = {
  name: "query_bowling_aggregate",
  description: BOWLING_DESCRIPTION,
  inputSchema: bowlingSchema(),
  handler: (db, args) => runAggregate(db, args, "query_bowling_aggregate", "bowling"),
  shape: "table",
  examples: BOWLING_EXAMPLES,
};

// ---------------------------------------------------------------------------
// query_matchup
// ---------------------------------------------------------------------------

export const MATCHUP_MIN_BALLS = 30;

// Real ids, and deliberately so: a model that copies an example verbatim should get a
// correct answer about the players in it rather than an empty result about nobody.
// 52d1dbc8/201fef33 are BL Mooney and DB Sharma; 5d2eda89/bc969efb are S Mandhana and
// A Gardner.
const MATCHUP_EXAMPLES: Record<string, unknown>[] = [
  { batter_id: "52d1dbc8", bowler_id: "201fef33", filters: { format: ["IT20"] } },
  {
    batter_id: "5d2eda89",
    bowler_id: "bc969efb",
    filters: { format: ["IT20", "T20"], phase: "powerplay" },
  },
];

export const MATCHUP_DESCRIPTION = `${prose(`
One batter against one bowler: the balls between them, and what
    happened.

DO NOT use this tool for:
- a batter against a TYPE of bowling ("Kohli vs spin") -- that is
    query_batting_aggregate with filters.faced_bowling_type="spin".
- a batter against a TEAM -- query_batting_aggregate with filters.bowling_team.
- either player's overall figures -- query_batting_aggregate or
    query_bowling_aggregate.
- names. batter_id and bowler_id are Cricsheet ids (8 hex chars) from
    resolve_entity.

Read the result honestly. Head-to-head samples are small: two international players
    may have faced each other for 40 balls across a decade, and a strike rate over
    40 balls is close to noise. The response sets
    qualification.min_balls_faced=${MATCHUP_MIN_BALLS} as a guide and always reports
    balls_faced -- if it is under ${MATCHUP_MIN_BALLS}, say the sample is too small to
    conclude from rather than declaring a winner.

format values: Test, ODI, T20, IT20, MDM, ODM. phase values: powerplay, middle,
    death. gender values: male, female.
faced_bowling_type values: pace, spin, unknown -- but do not set it here; a matchup
    is already pinned to one bowler, so filtering on his type can only return the
    same rows or none.
Super overs are excluded unless include_super_over is true.`)}

${examplesBlock(MATCHUP_EXAMPLES)}`;

async function runMatchup(
  db: Db,
  rawArgs: Readonly<Record<string, unknown>>,
): Promise<ToolOutcome> {
  const tool = "query_matchup";
  const args: Record<string, unknown> = { ...rawArgs };
  const batterId = take(args, "batter_id");
  const bowlerId = take(args, "bowler_id");
  for (const [field, value] of [
    ["batter_id", batterId],
    ["bowler_id", bowlerId],
  ] as const) {
    if (value === undefined || value === null || value === "" || value === false) {
      throw errors.error(
        "NEEDS_ENTITY_RESOLUTION",
        tool,
        `${field} is required: a matchup needs both players named by id.`,
        { field, fixExample: MATCHUP_EXAMPLES[0] ?? null },
      );
    }
  }

  const rawFilters: Record<string, unknown> = { ...((take(args, "filters") as object) ?? {}) };
  // Both ids go through the filter compiler, so they are bound parameters and validated
  // by the same PlayerId pattern as everywhere else.
  rawFilters["batter_ids"] = [batterId];
  rawFilters["bowler_ids"] = [bowlerId];
  const battingInput = Object.fromEntries(
    Object.entries(rawFilters).filter(([key]) => key !== "bowler_ids"),
  );
  const parsedBatting = BattingFilters.safeParse(battingInput);
  if (!parsedBatting.success) {
    throw errors.fromValidationError(tool, parsedBatting.error, battingInput);
  }
  const parsedBowler = BowlingFilters.safeParse({ bowler_ids: [bowlerId] });
  if (!parsedBowler.success) {
    throw errors.fromValidationError(tool, parsedBowler.error, { bowler_ids: [bowlerId] });
  }
  const filters = parsedBatting.data;

  // bowler_id is not a BattingFilters field, so add its predicate explicitly -- still a
  // bound parameter, still a column name from the registry.
  const compiled = compileFilters(filters).withClause(
    `${FILTER_SPECS.bowler_ids.column} = ?`,
    [bowlerId as string],
    "bowler_ids",
  );

  const built = aggregate.build("batting", compiled, {
    groupBy: [],
    orderBy: "runs",
    orderDir: "desc",
    limit: 1,
    offset: 0,
    havingSql: "TRUE",
  });
  const result = await db.query(built.sql, built.params);
  let rawRows = result.rows;
  const head = rawRows[0];
  const scanned = head !== undefined ? Number(head["_scanned"]) : 0;
  if (isEmptyTotal(head)) rawRows = [];

  const rows = publicRows(rawRows);
  const ballsCell = rows[0]?.["balls_faced"];
  const balls = typeof ballsCell === "number" ? ballsCell : 0;

  const response = ToolResponse.parse({
    columns: built.columns,
    rows,
    row_count_total: rows.length,
    coverage: await buildCoverage(db, {
      where: compiled.whereSql,
      params: compiled.params,
      joins: compiled.joinSql,
      playerIds: [batterId as string, bowlerId as string],
    }),
    definitions: definitionsFor(built.columns, {
      // The cell is the BATTER's record against this bowler -- it is built on the
      // batting grain, so `dots` here means balls the batter failed to score off, not
      // balls the bowling side conceded nothing on.
      grain: "batting",
      excluded: superOverNote(filters.include_super_over),
      notes: [
        `${balls} balls between these two in scope; head-to-head samples ` +
          `are small and a rate computed over fewer than ${MATCHUP_MIN_BALLS} ` +
          `balls should not be presented as a conclusion`,
      ],
      phaseSource:
        filters.phase !== undefined
          ? await phaseSource(db, compiled.whereSql, compiled.params, compiled.joinSql)
          : null,
    }),
    qualification: Qualifier.batting(MATCHUP_MIN_BALLS, 1).toContract(
      rows.length > 0 ? 1 : 0,
      balls >= MATCHUP_MIN_BALLS ? 1 : 0,
    ),
    sql_id: sqlId(built.sql),
    cricinfo_links: await cricinfoLinks(db, [batterId as string, bowlerId as string]),
    relaxation_hints: rows.length === 0 ? await relaxationHints(db, compiled) : [],
  });
  return { response, sql: built.sql, deliveriesScanned: scanned };
}

export const MATCHUP_TOOL: ToolSpec = {
  name: "query_matchup",
  description: MATCHUP_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      batter_id: {
        type: "string",
        pattern: "^[0-9a-f]{8}$",
        description: "Cricsheet player id from resolve_entity, not a name.",
      },
      bowler_id: {
        type: "string",
        pattern: "^[0-9a-f]{8}$",
        description: "Cricsheet player id from resolve_entity, not a name.",
      },
      filters: {
        ...schemas.modelSchema(BattingFilters),
        description:
          "Optional narrowing. Do not set batter_ids or bowler_ids here; " +
          "use the top-level batter_id and bowler_id.",
      },
    },
    required: ["batter_id", "bowler_id"],
  },
  handler: runMatchup,
  shape: "tiles",
  examples: MATCHUP_EXAMPLES,
};
