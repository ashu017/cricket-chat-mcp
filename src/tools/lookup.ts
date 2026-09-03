// `resolve_entity`, `get_data_coverage`, `get_career_reference`.
//
// The three tools that answer questions *about* the data rather than out of it.
// `resolve_entity` is the most called of the eight and the cheapest: every other tool
// takes ids, so a turn that mentions a player starts here.

import { Coverage, Definitions, ToolResponse } from "../contracts/index.js";
import type { BoundValue } from "../core/index.js";
import {
  cleanRows,
  cricinfoLinks,
  type Db,
  DEFAULT_LIMIT,
  datasetWindow,
  examplesBlock,
  placeholders,
  prose,
  type QueryResult,
  sqlId,
  type ToolOutcome,
  type ToolSpec,
} from "./base.js";
import * as errors from "./errors.js";

export const ENTITY_KINDS = ["player", "team", "venue", "competition"] as const;

/**
 * Coverage for a tool that computes over no scope at all.
 *
 * `matches_in_scope=0` with the dataset window still populated is the honest shape: a
 * name lookup did not aggregate any matches, but the UI badge and the model still need
 * to know what years the warehouse holds.
 */
async function bareCoverage(db: Db): Promise<Coverage> {
  const [first, last] = await datasetWindow(db);
  return Coverage.parse({
    matches_in_scope: 0,
    dataset_first_date: first,
    dataset_last_date: last,
  });
}

// ---------------------------------------------------------------------------
// resolve_entity
// ---------------------------------------------------------------------------

const PLAYER_SQL = `
    SELECT p.player_id,
           p.unique_name                          AS name,
           count(DISTINCT d.match_id)::INTEGER    AS matches,
           min(d.match_date)                      AS first_match,
           max(d.match_date)                      AS last_match,
           -- The team THIS player was on, which depends on which end he was at.
           -- \`batting_team\` alone would list the sides a bowler bowled *to*, and a
           -- disambiguation column that names the opposition is worse than none.
           list(DISTINCT CASE
                   WHEN d.batter_id = p.player_id THEN d.batting_team
                   ELSE d.bowling_team
               END)[1:4]                          AS teams
    FROM players p
    JOIN deliveries d ON d.batter_id = p.player_id OR d.bowler_id = p.player_id
    WHERE p.unique_name ILIKE ?
    GROUP BY p.player_id, p.unique_name
    ORDER BY matches DESC, name
    LIMIT ?
`;

/**
 * A name in the register with no ball in the warehouse.
 *
 * Kept as a separate query rather than a LEFT JOIN because the answer is different in
 * kind: the player exists but is outside the coverage window, and saying so is the
 * point.
 */
const PLAYER_UNPLAYED_SQL = `
    SELECT p.player_id, p.unique_name AS name, 0::INTEGER AS matches,
           NULL::DATE AS first_match, NULL::DATE AS last_match, []::VARCHAR[] AS teams
    FROM players p
    WHERE p.unique_name ILIKE ?
      AND NOT EXISTS (
          SELECT 1 FROM deliveries d
          WHERE d.batter_id = p.player_id OR d.bowler_id = p.player_id
      )
    ORDER BY name
    LIMIT ?
`;

const SIMPLE_SQL: Readonly<Record<string, string>> = {
  team: `
        SELECT batting_team AS name, count(DISTINCT match_id)::INTEGER AS matches,
               min(match_date) AS first_match, max(match_date) AS last_match
        FROM deliveries WHERE batting_team ILIKE ?
        GROUP BY batting_team ORDER BY matches DESC LIMIT ?
    `,
  // Both tables carry `venue_canonical`, so every reference here is qualified.
  // Unqualified it is an ambiguous-reference error, and `USING (match_id)` does not
  // merge the rest of the overlap.
  venue: `
        SELECT d.venue_canonical AS name, any_value(m.city) AS city,
               count(DISTINCT d.match_id)::INTEGER AS matches,
               min(d.match_date) AS first_match, max(d.match_date) AS last_match
        FROM deliveries d JOIN matches m ON m.match_id = d.match_id
        WHERE d.venue_canonical ILIKE ?
        GROUP BY d.venue_canonical ORDER BY matches DESC LIMIT ?
    `,
  competition: `
        SELECT competition AS name, count(DISTINCT match_id)::INTEGER AS matches,
               min(match_date) AS first_match, max(match_date) AS last_match
        FROM deliveries WHERE competition ILIKE ?
        GROUP BY competition ORDER BY matches DESC LIMIT ?
    `,
};

/** The all-candidates lists used for did_you_mean when a search finds nothing. */
const ALL_SQL: Readonly<Record<string, string>> = {
  team: "SELECT DISTINCT batting_team FROM deliveries WHERE batting_team IS NOT NULL",
  venue: "SELECT DISTINCT venue_canonical FROM deliveries WHERE venue_canonical IS NOT NULL",
  competition: "SELECT DISTINCT competition FROM deliveries WHERE competition IS NOT NULL",
  player: "SELECT unique_name FROM players",
};

async function resolve(db: Db, args: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  const tool = "resolve_entity";
  const query = args["query"];
  if (typeof query !== "string" || query.trim() === "") {
    throw errors.error(
      "BAD_ENUM_VALUE",
      tool,
      "query is required and must be a non-empty name to search for.",
      { field: "query", received: query, fixExample: { query: "Kohli", kind: "player" } },
    );
  }
  const kind = args["kind"] ?? "player";
  if (typeof kind !== "string" || !(ENTITY_KINDS as readonly string[]).includes(kind)) {
    throw errors.badEnum(tool, "kind", kind, [...ENTITY_KINDS]);
  }
  const limit = intArg(tool, args, "limit", 10, 50);

  const pattern = `%${query.trim()}%`;
  let sql: string;
  let result: QueryResult;
  if (kind === "player") {
    sql = PLAYER_SQL;
    result = await db.query(sql, [pattern, limit]);
    if (result.rows.length === 0) {
      sql = PLAYER_UNPLAYED_SQL;
      result = await db.query(sql, [pattern, limit]);
    }
  } else {
    sql = SIMPLE_SQL[kind] as string;
    result = await db.query(sql, [pattern, limit]);
  }

  const hints: string[] = [];
  if (result.rows.length === 0) {
    const all = await db.query(ALL_SQL[kind] as string);
    const candidates = all.rows
      .map((row) => Object.values(row)[0])
      .filter((value): value is string => typeof value === "string" && value !== "");
    const close = errors.didYouMean(query, candidates, 5);
    if (close.length > 0) {
      hints.push(`no ${kind} matched ${errors.repr(query)}; closest names: ${close.join(", ")}`);
    } else {
      hints.push(
        `no ${kind} matched ${errors.repr(query)}. A substring search was used, so check ` +
          `the spelling; note the register stores players as initials plus ` +
          `surname, e.g. 'V Kohli' rather than 'Virat Kohli'.`,
      );
    }
  }

  const links =
    kind === "player"
      ? await cricinfoLinks(
          db,
          result.rows.map((row) => String(row["player_id"])),
        )
      : [];
  const response = ToolResponse.parse({
    columns: result.columns,
    rows: cleanRows(result.rows),
    row_count_total: result.rows.length,
    coverage: await bareCoverage(db),
    definitions: Definitions.parse({
      notes: [
        "matches counts only matches inside this warehouse's coverage window, " +
          "so it is not a career appearance total",
      ],
    }),
    sql_id: sqlId(sql),
    cricinfo_links: links,
    relaxation_hints: hints,
  });
  return { response, sql };
}

/**
 * An integer argument with a default.
 *
 * The Python original called `int()` on whatever arrived, which raises an uncaught
 * `ValueError` on `limit: "lots"` -- an internal error for what is a malformed call.
 * Rejecting it as a bad value gives the model something it can fix.
 */
function intArg(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  field: string,
  fallback: number,
  max: number,
): number {
  const raw = args[field];
  if (raw === undefined || raw === null) return fallback;
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw errors.badEnum(tool, field, raw, [`an integer between 1 and ${max}`]);
  }
  return value;
}

const RESOLVE_EXAMPLES: Record<string, unknown>[] = [
  { query: "Kohli", kind: "player" },
  { query: "Wankhede", kind: "venue", limit: 5 },
];

export const RESOLVE_DESCRIPTION = `${prose(`
Turn a name into the id and exact spelling the other tools need. Call
    this FIRST for any question that names a player.

DO NOT use this tool for:
- any statistic. It returns identifiers and appearance counts, nothing else -- use
    query_batting_aggregate or query_bowling_aggregate for numbers.
- a player's career totals. The \`matches\` column here counts only matches inside the
    coverage window and is not a career appearance total.
- checking whether a format or date range exists -- use get_data_coverage.

kind values: ${ENTITY_KINDS.join(", ")}. Defaults to player.

Names in the register are initials plus surname: "V Kohli", "JC Buttler",
    "SR Tendulkar" -- not "Virat Kohli". Search is a case-insensitive substring
    match, so pass the surname alone when unsure. If several people share a surname
    you will get several rows; disambiguate with \`matches\`,
    \`first_match\`/\`last_match\` and \`teams\` before picking one, and if it is
    genuinely ambiguous ask the user rather than guessing.

Teams, venues and competitions have no ids -- resolve them to get the exact string
    to pass to filters.batting_team, filters.venue_canonical or filters.competition,
    because a near-miss spelling matches nothing and returns a confident zero.

limit defaults to 10, maximum 50.`)}

${examplesBlock(RESOLVE_EXAMPLES)}`;

export const RESOLVE_TOOL: ToolSpec = {
  name: "resolve_entity",
  description: RESOLVE_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Name or part of a name. Surname alone is usually best.",
      },
      kind: {
        type: "string",
        enum: [...ENTITY_KINDS],
        default: "player",
        description: "What sort of thing to look up.",
      },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
    },
    required: ["query"],
  },
  handler: resolve,
  shape: "table",
  examples: RESOLVE_EXAMPLES,
};

// ---------------------------------------------------------------------------
// get_data_coverage
// ---------------------------------------------------------------------------

const COVERAGE_SQL = `
    SELECT format, gender, first_date, last_date, match_count, delivery_count
    FROM coverage
    ORDER BY format, gender
`;

async function coverage(db: Db): Promise<ToolOutcome> {
  const result = await db.query(COVERAGE_SQL);
  const response = ToolResponse.parse({
    columns: result.columns,
    rows: cleanRows(result.rows),
    row_count_total: result.rows.length,
    coverage: await bareCoverage(db),
    definitions: Definitions.parse({
      notes: [
        "these are the only formats and date ranges in this warehouse; a " +
          "question about anything outside them cannot be answered from the " +
          "ball-by-ball data and should be answered by saying so",
        "match_count and delivery_count include super-over deliveries, which " +
          "the stats tools exclude by default",
      ],
    }),
    sql_id: sqlId(COVERAGE_SQL),
  });
  return { response, sql: COVERAGE_SQL };
}

const DATA_COVERAGE_EXAMPLES: Record<string, unknown>[] = [{}, {}];

export const DATA_COVERAGE_DESCRIPTION = `${prose(`
What data this warehouse actually holds: every format and gender, with
    its first and last date, match count and delivery count.

Call this BEFORE answering any question that assumes a period or format exists, and
    whenever a stats query comes back empty. It is the difference between "there is
    no record of that" and "that is outside the data I have", which are very
    different answers to give a user.

DO NOT use this tool for:
- a specific player's date range -- that is resolve_entity, or the coverage block on
    any stats response.
- statistics of any kind.

Takes no arguments.

The critical use: if a user asks about a year or a format that is not listed here,
    say plainly that the data does not cover it. Do not answer from memory, and do
    not report a zero from another tool as though it were a finding -- a zero outside
    the coverage window means "not recorded here", not "never happened".`)}

Example 1:
{}

Example 2 (identical -- this tool takes no input):
{}`;

export const DATA_COVERAGE_TOOL: ToolSpec = {
  name: "get_data_coverage",
  description: DATA_COVERAGE_DESCRIPTION,
  inputSchema: { type: "object", properties: {}, required: [] },
  handler: (db) => coverage(db),
  shape: "tiles",
  examples: DATA_COVERAGE_EXAMPLES,
};

// ---------------------------------------------------------------------------
// get_career_reference
// ---------------------------------------------------------------------------

const CAREER_SQL_BASE = `
    SELECT c.player_id, c.player_name, c.format, c.matches, c.innings, c.runs,
           c.batting_average, c.wickets, c.bowling_average, c.source_url, c.as_of
    FROM career_reference c
`;

async function career(db: Db, args: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  const tool = "get_career_reference";
  const where: string[] = [];
  const params: BoundValue[] = [];

  const playerIds = args["player_ids"];
  const name = args["player_name"];
  const format = args["format"];
  if (isTruthy(playerIds)) {
    if (!Array.isArray(playerIds)) {
      throw errors.badEnum(tool, "player_ids", playerIds, ["an array of player ids"]);
    }
    where.push(`c.player_id IN (${placeholders(playerIds)})`);
    params.push(...(playerIds as BoundValue[]));
  }
  if (isTruthy(name)) {
    where.push("c.player_name ILIKE ?");
    params.push(`%${String(name)}%`);
  }
  if (isTruthy(format)) {
    where.push("c.format = ?");
    params.push(format as BoundValue);
  }
  if (where.length === 0) {
    throw errors.error(
      "NEEDS_ENTITY_RESOLUTION",
      tool,
      "give at least one of player_ids, player_name or format; this table is a " +
        "hand-curated reference, not something to list in full.",
      { fixExample: { player_name: "Tendulkar" } },
    );
  }

  const sql = `${CAREER_SQL_BASE} WHERE ${where.join(" AND ")} ORDER BY c.player_name, c.format`;
  const result = await db.query(sql, params);
  const cleaned = cleanRows(result.rows);

  const hints: string[] = [];
  if (cleaned.length === 0) {
    hints.push(
      "this reference table holds RETIRED players only, and only about a hundred " +
        "of them -- a miss means the player is not curated, not that the figures " +
        "do not exist. Say so rather than substituting a warehouse total, which " +
        "would cover only the years this dataset spans.",
    );
  }

  const first = cleaned[0];
  const response = ToolResponse.parse({
    columns: result.columns,
    rows: cleaned,
    row_count_total: cleaned.length,
    coverage: await bareCoverage(db),
    definitions: Definitions.parse({
      notes: [
        "hand-transcribed full-career figures from ESPNcricinfo, NOT computed " +
          "from this warehouse -- quote them as the career record and cite " +
          "source_url",
        "a blank cell means the figure was not transcribed, never zero",
        "innings means batting innings",
      ],
    }),
    // provenance='reference' is what tells the UI to render these as cited rather than
    // computed. A hand-typed figure that reads as a computed one is worse than no
    // figure, so it may not be set without a source_url.
    provenance: first !== undefined ? "reference" : "computed",
    source_url: first !== undefined ? first["source_url"] : null,
    sql_id: sqlId(sql),
    cricinfo_links: await cricinfoLinks(
      db,
      result.rows.map((row) => String(row["player_id"])),
    ),
    relaxation_hints: hints,
  });
  return { response, sql };
}

/** Python truthiness, for the three optional narrowings. */
function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0) return false;
  if (typeof value === "string") return value !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

const CAREER_EXAMPLES: Record<string, unknown>[] = [
  { player_name: "Tendulkar" },
  { player_ids: ["d2c2b2d5"], format: "Test" },
];

export const CAREER_DESCRIPTION = `${prose(`
Full-career totals for about a hundred retired greats, transcribed by
    hand from ESPNcricinfo with a source_url on every row. This is the ONLY tool that
    knows anything from before the ball-by-ball coverage window.

Use it whenever a question asks for a career total, career average or career wickets
    for a player who retired, and whenever a stats response comes back with
    coverage.career_possibly_truncated=true. Summing this warehouse gives Tendulkar a
    fraction of his career and that fraction is indistinguishable from a total unless
    you check here.

DO NOT use this tool for:
- active players. It deliberately contains none -- a stale "career runs" for a
    current player would be wrong the next time he bats. Use
    query_batting_aggregate and state the window.
- anything sliced by venue, phase, opposition or year. There is one row per player
    per format and no ball-by-ball detail behind it.
- computing anything. These are transcribed figures; report them as cited, with
    source_url.

format values: Test, ODI, IT20, T20 -- the same spellings as everywhere else.

At least one of player_ids, player_name or format is required. player_name is a
    case-insensitive substring, so "Tendulkar" works without the initials.

If a player is absent, say the reference does not cover them. Do not fall back to a
    warehouse total and present it as a career figure.`)}

${examplesBlock(CAREER_EXAMPLES)}`;

export const CAREER_TOOL: ToolSpec = {
  name: "get_career_reference",
  description: CAREER_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      player_ids: {
        type: "array",
        items: { type: "string", pattern: "^[0-9a-f]{8}$" },
        description: "Cricsheet player ids from resolve_entity.",
      },
      player_name: {
        type: "string",
        description: "Case-insensitive substring of the name, e.g. 'Tendulkar'.",
      },
      format: {
        type: "string",
        enum: ["Test", "ODI", "IT20", "T20"],
        description: "Restrict to one format.",
      },
      limit: { type: "integer", minimum: 1, maximum: 200, default: DEFAULT_LIMIT },
    },
    required: [],
  },
  handler: career,
  shape: "table",
  examples: CAREER_EXAMPLES,
};
