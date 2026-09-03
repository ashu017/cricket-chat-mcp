// `get_scorecard` and `query_matches` -- the match-grain tools.
//
// These two are where the "runs and wickets live in different tables" rule bites
// hardest, so both keep to it: the scorecard reads its dismissal text from `wickets` at
// ball grain, and `query_matches` narrows through a `SELECT DISTINCT match_id` subquery
// rather than joining the ball grain to the match grain and summing anything.

import { Coverage, Definitions, MatchFilters, type Row, ToolResponse } from "../contracts/index.js";
import {
  BATTING_BASE_SQL,
  BOWLING_BASE_SQL,
  BOWLING_DERIVED_SQL,
  type BoundValue,
  compileFilters,
} from "../core/index.js";
import {
  cleanRows,
  cricinfoLinks,
  type Db,
  datasetWindow,
  definitionsFor,
  examplesBlock,
  MAX_LIMIT,
  prose,
  sqlId,
  type ToolOutcome,
  type ToolSpec,
} from "./base.js";
import * as errors from "./errors.js";
import * as schemas from "./schemas.js";

export const CARDS = ["innings", "batting", "bowling"] as const;

/** The registry entries a card shows: every base metric except the grain counters. */
function cardMetrics(registry: Readonly<Record<string, string>>): string {
  return Object.entries(registry)
    .filter(([name]) => name !== "innings" && name !== "matches")
    .map(([name, expr]) => `${expr} AS ${name}`)
    .join(",\n               ");
}

/**
 * One row per batter per innings, built from the shared metric registry.
 *
 * `dismissal` comes from `wickets` keyed on `player_out_id`, which is why a batter run
 * out at the non-striker's end still gets his dismissal on the right line -- the thing
 * a scorecard is judged on.
 */
function battingCardSql(): string {
  return `
        WITH card AS (
            SELECT d.innings_no,
                   d.batting_team,
                   d.batter_id,
                   min(d.batting_position)::INTEGER AS batting_position,
                   ${cardMetrics(BATTING_BASE_SQL)}
            FROM deliveries d
            WHERE d.match_id = ?
            GROUP BY d.innings_no, d.batting_team, d.batter_id
        ), outs AS (
            SELECT w.innings_no, w.player_out_id,
                   any_value(w.kind) AS dismissal_kind,
                   any_value(w.counts_as_out) AS counts_as_out
            FROM wickets w
            WHERE w.match_id = ?
            GROUP BY w.innings_no, w.player_out_id
        )
        SELECT c.innings_no, c.batting_team, c.batting_position,
               c.batter_id, p.unique_name AS batter,
               c.runs, c.balls_faced, c.fours, c.sixes, c.dots,
               coalesce(o.dismissal_kind, 'not out') AS dismissal
        FROM card c
        LEFT JOIN outs o ON o.innings_no = c.innings_no AND o.player_out_id = c.batter_id
        LEFT JOIN players p ON p.player_id = c.batter_id
        -- \`p.unique_name\`, not \`c.batter\`: the alias belongs to this SELECT, and the
        -- CTE it would have to come from does not carry a name column at all.
        ORDER BY c.innings_no, c.batting_position, p.unique_name
    `;
}

function bowlingCardSql(): string {
  return `
        WITH card AS (
            SELECT d.innings_no, d.bowling_team, d.bowler_id,
                   min(d.over_number)::INTEGER AS first_over,
                   ${cardMetrics(BOWLING_BASE_SQL)}
            FROM deliveries d
            WHERE d.match_id = ?
            GROUP BY d.innings_no, d.bowling_team, d.bowler_id
        )
        SELECT c.innings_no, c.bowling_team, c.bowler_id, p.unique_name AS bowler,
               ${BOWLING_DERIVED_SQL.overs} AS overs, c.runs_conceded, c.wickets, c.dots,
               c.fours_conceded, c.sixes_conceded, ${BOWLING_DERIVED_SQL.economy} AS economy
        FROM card c
        LEFT JOIN players p ON p.player_id = c.bowler_id
        ORDER BY c.innings_no, c.first_over
    `;
}

const INNINGS_CARD_SQL = `
    SELECT i.innings_no, i.batting_team, i.bowling_team,
           i.total_runs, i.total_wickets,
           i.scheduled_overs, i.target_runs, i.is_chase, i.is_super_over,
           i.is_forfeited, i.is_declared, i.penalty_runs_pre, i.penalty_runs_post
    FROM innings i
    WHERE i.match_id = ?
    ORDER BY i.innings_no
`;

const MATCH_HEADER_SQL = `
    SELECT match_id, format, gender, start_date, end_date, n_days, venue_canonical,
           city, country, competition, season, event_match_number, toss_winner,
           toss_decision, winner, result_type, margin_runs, margin_wickets,
           margin_innings, method, eliminator_winner, balls_per_over, scheduled_overs
    FROM matches WHERE match_id = ?
`;

async function scorecard(db: Db, args: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  const tool = "get_scorecard";
  const matchId = args["match_id"];
  if (typeof matchId !== "string" || matchId.trim() === "") {
    throw errors.error(
      "BAD_ENUM_VALUE",
      tool,
      "match_id is required. Find one with query_matches; it is the Cricsheet " +
        "file number, e.g. '1415755'.",
      {
        field: "match_id",
        received: matchId,
        fixExample: { match_id: "1415755", card: "innings" },
      },
    );
  }
  const card = args["card"] ?? "innings";
  if (typeof card !== "string" || !(CARDS as readonly string[]).includes(card)) {
    throw errors.badEnum(tool, "card", card, [...CARDS]);
  }

  const headerResult = await db.query(MATCH_HEADER_SQL, [matchId]);
  const header = headerResult.rows[0];
  if (header === undefined) {
    throw errors.error(
      "BAD_ENUM_VALUE",
      tool,
      `no match with id ${errors.repr(matchId)} is in this warehouse. Use query_matches to ` +
        `find the match first, or get_data_coverage to check whether the period ` +
        `is covered at all.`,
      { field: "match_id", received: matchId },
    );
  }

  let sql: string;
  let params: BoundValue[];
  if (card === "innings") {
    sql = INNINGS_CARD_SQL;
    params = [matchId];
  } else if (card === "batting") {
    sql = battingCardSql();
    params = [matchId, matchId];
  } else {
    sql = bowlingCardSql();
    params = [matchId];
  }

  const result = await db.query(sql, params);
  const cleaned = cleanRows(result.rows);

  const start = header["start_date"] as string;
  const end = (header["end_date"] as string | null) || start;
  const [first, last] = await datasetWindow(db);

  const ids = result.rows
    .map((row) => row["batter_id"] ?? row["bowler_id"])
    .filter((value): value is string => typeof value === "string" && value !== "");

  const response = ToolResponse.parse({
    columns: result.columns,
    rows: cleaned,
    row_count_total: cleaned.length,
    coverage: Coverage.parse({
      matches_in_scope: 1,
      earliest_date: start,
      latest_date: end,
      dataset_first_date: first,
      dataset_last_date: last,
    }),
    // No grain: a scorecard's `dots` column is the batting one on the batting card and
    // the bowling one on the bowling card, and the unqualified sentence is what the
    // Python implementation echoed for both.
    definitions: definitionsFor(result.columns, {
      notes: [
        resultSentence(header),
        "super-over innings appear here with is_super_over=true; they are " +
          "excluded from every career statistic",
        ...(card === "innings"
          ? [
              "this innings total includes penalty runs, which belong to the team " +
                "and to no batter, so the batting card will not add up to it",
            ]
          : []),
      ],
    }),
    sql_id: sqlId(sql),
    cricinfo_links: await cricinfoLinks(db, ids),
  });
  return { response, sql };
}

/**
 * The match result in one line, assembled from the columns that carry it.
 *
 * Worth doing here rather than leaving to the model: the margin lives in one of three
 * mutually exclusive columns, and a model that picks the wrong one reports a 6-run win
 * as a 6-wicket win.
 */
function resultSentence(header: Row): string {
  const teams = `${String(header["format"])} at ${String(header["venue_canonical"])} on ${String(header["start_date"])}`;
  const methodText = header["method"] ? ` (${String(header["method"])})` : "";
  if (header["result_type"] === "no result") return `${teams}: no result${methodText}`;
  if (header["result_type"] === "tie") {
    const eliminator = header["eliminator_winner"];
    const tail = eliminator ? `, decided by super over in favour of ${String(eliminator)}` : "";
    return `${teams}: tied${tail}`;
  }
  if (header["result_type"] === "draw") return `${teams}: drawn`;
  const winner = header["winner"] || "unknown";
  for (const [column, unit] of [
    ["margin_runs", "runs"],
    ["margin_wickets", "wickets"],
    ["margin_innings", "innings"],
  ] as const) {
    const margin = header[column];
    if (margin !== null && margin !== undefined) {
      return `${teams}: ${String(winner)} won by ${String(margin)} ${unit}${methodText}`;
    }
  }
  return `${teams}: ${String(winner)} won`;
}

const SCORECARD_EXAMPLES: Record<string, unknown>[] = [
  { match_id: "1415755", card: "innings" },
  { match_id: "1415755", card: "batting" },
];

export const SCORECARD_DESCRIPTION = `${prose(`
One match, in scorecard form. Three views, one per call: card="innings"
    for the innings totals and the result, card="batting" for every batter's line,
    card="bowling" for every bowler's figures.

DO NOT use this tool for:
- finding a match. It needs a match_id -- get one from query_matches first.
- statistics across more than one match -- use query_batting_aggregate or
    query_bowling_aggregate. Calling this repeatedly to add up a series is slow and
    will drift from the definitions those tools use.
- a head-to-head record -- use query_matchup.

card values: ${CARDS.join(", ")}. Defaults to innings. To describe a whole match you
    will usually want innings first, then batting and/or bowling only for the side
    the user asked about.

match_id is Cricsheet's file number as a string, e.g. "1415755".

Two things to read carefully. An innings total includes penalty runs, which belong to
    the team and to no batter, so a batting card legitimately does not sum to the
    innings total. And a super-over innings appears here with is_super_over=true --
    describe it as the super over, and remember it counts toward no career
    statistic.`)}

${examplesBlock(SCORECARD_EXAMPLES)}`;

export const SCORECARD_TOOL: ToolSpec = {
  name: "get_scorecard",
  description: SCORECARD_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      match_id: {
        type: "string",
        description: "Cricsheet match id from query_matches, e.g. '1415755'.",
      },
      card: {
        type: "string",
        enum: [...CARDS],
        default: "innings",
        description: "Which view of the match to return.",
      },
    },
    required: ["match_id"],
  },
  handler: scorecard,
  shape: "table",
  examples: SCORECARD_EXAMPLES,
};

// ---------------------------------------------------------------------------
// query_matches
// ---------------------------------------------------------------------------

/**
 * Each predicate binds `subject_team` exactly once, so the caller can append the
 * parameter unconditionally. The three that do not actually need the team still consume
 * it via `? IS NOT NULL` -- a draw is a draw for both sides, but keeping the arity
 * uniform is what stops the parameter list drifting out of step with the placeholders,
 * which is the classic way a parameterised query starts answering a different question
 * than it was asked.
 */
const RESULT_PREDICATES: Readonly<Record<string, string>> = {
  win: "m.winner = ?",
  loss: "m.winner IS NOT NULL AND m.winner <> ?",
  draw: "m.result_type = 'draw' AND ? IS NOT NULL",
  tie: "m.result_type = 'tie' AND ? IS NOT NULL",
  no_result: "m.result_type = 'no result' AND ? IS NOT NULL",
};

async function matches(db: Db, rawArgs: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  const tool = "query_matches";
  const args: Record<string, unknown> = { ...rawArgs };
  const limit = Object.hasOwn(args, "limit") ? args["limit"] : 20;
  if (typeof limit !== "number" || !Number.isInteger(limit)) {
    throw errors.badEnum(tool, "limit", limit, ["an integer between 1 and 200"]);
  }
  if (limit > MAX_LIMIT) {
    throw errors.error(
      "LIMIT_EXCEEDED",
      tool,
      `limit=${limit} exceeds the maximum of ${MAX_LIMIT}.`,
      {
        field: "limit",
        received: limit,
        fixExample: { limit: MAX_LIMIT },
      },
    );
  }
  const orderDir = (args["order_dir"] ?? "desc") === "asc" ? "ASC" : "DESC";

  const rawFilters = args["filters"] ?? {};
  const parsed = MatchFilters.safeParse(rawFilters);
  if (!parsed.success) throw errors.fromValidationError(tool, parsed.error, rawFilters);
  const filters = parsed.data;

  const compiled = compileFilters(filters);
  const subject = filters.subject_team;

  // The three subject_* filters are compiled here rather than in the registry: there is
  // no `matches.subject_team` column and there cannot be one, because "did they win" is
  // asked OF a team and either side can be the subject.
  const matchWhere: string[] = [];
  const matchParams: BoundValue[] = [];
  if (subject !== undefined && subject !== "") {
    matchWhere.push("list_contains(t.teams, ?)");
    matchParams.push(subject);
    if (filters.subject_team_result !== undefined) {
      matchWhere.push(RESULT_PREDICATES[filters.subject_team_result] as string);
      matchParams.push(subject);
    }
    if (filters.subject_team_won_toss !== undefined && filters.subject_team_won_toss !== null) {
      matchWhere.push(filters.subject_team_won_toss ? "m.toss_winner = ?" : "m.toss_winner <> ?");
      matchParams.push(subject);
    }
  }

  const sql = `
        WITH scoped AS (
            SELECT DISTINCT d.match_id
            FROM deliveries d
            ${compiled.joinSql}
            WHERE ${compiled.whereSql}
        ), teams AS (
            SELECT match_id, list(DISTINCT batting_team) AS teams
            FROM innings GROUP BY match_id
        )
        SELECT m.match_id, m.format, m.gender, m.start_date, m.n_days,
               t.teams, m.venue_canonical, m.city, m.country, m.competition, m.season,
               m.toss_winner, m.toss_decision, m.winner, m.result_type,
               m.margin_runs, m.margin_wickets, m.margin_innings, m.method,
               m.eliminator_winner,
               count(*) OVER ()::INTEGER AS _total
        FROM matches m
        JOIN scoped s ON s.match_id = m.match_id
        LEFT JOIN teams t ON t.match_id = m.match_id
        ${matchWhere.length > 0 ? `WHERE ${matchWhere.join(" AND ")}` : ""}
        ORDER BY m.start_date ${orderDir}, m.match_id ${orderDir}
        LIMIT ?
    `;
  const result = await db.query(sql, [...compiled.params, ...matchParams, limit]);
  const head = result.rows[0];
  const total = head !== undefined ? Number(head["_total"]) : 0;
  const cleaned = cleanRows(
    result.rows.map((row) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => key !== "_total")),
    ),
  );
  const columns = result.columns.filter((name) => name !== "_total");

  const hints: string[] = [];
  if (cleaned.length === 0) {
    if (subject !== undefined && subject !== "") {
      const known = await db.query(
        "SELECT DISTINCT batting_team FROM deliveries WHERE batting_team IS NOT NULL",
      );
      const candidates = known.rows
        .map((row) => row["batting_team"])
        .filter((value): value is string => typeof value === "string");
      const close = errors.didYouMean(subject, candidates, 5);
      hints.push(
        `no match had ${errors.repr(subject)} as a participant` +
          (close.length > 0 ? `; closest team names: ${close.join(", ")}` : ""),
      );
    }
    hints.push(
      "matches with no recorded deliveries (abandoned without a ball bowled) are " +
        "not in this result at all, because the filters are applied to ball-by-ball " +
        "data; a washout may be missing rather than absent from history",
    );
  }

  const startDates = cleaned
    .map((row) => row["start_date"])
    .filter((value): value is string => typeof value === "string");
  const [first, last] = await datasetWindow(db);

  const response = ToolResponse.parse({
    columns,
    rows: cleaned,
    row_count_total: Math.max(total, cleaned.length),
    truncated: total > cleaned.length,
    coverage: Coverage.parse({
      matches_in_scope: total,
      earliest_date: startDates.length > 0 ? startDates.reduce((a, b) => (a < b ? a : b)) : null,
      latest_date: startDates.length > 0 ? startDates.reduce((a, b) => (a > b ? a : b)) : null,
      dataset_first_date: first,
      dataset_last_date: last,
    }),
    definitions: Definitions.parse({
      notes: [
        "the margin is in exactly one of margin_runs, margin_wickets or " +
          "margin_innings; the other two are null and reporting the wrong one " +
          "turns a 6-run win into a 6-wicket win",
        "result_type='tie' with an eliminator_winner means the match was tied " +
          "and decided by a super over -- it is not a win in the result column",
        "method='D/L' means the target was revised for rain",
        "earliest_date and latest_date describe the rows returned, not the " +
          "whole filtered set, when the result is truncated",
      ],
    }),
    sql_id: sqlId(sql),
    relaxation_hints: hints,
  });
  return { response, sql };
}

const MATCHES_EXAMPLES: Record<string, unknown>[] = [
  {
    filters: {
      subject_team: "India",
      subject_team_result: "win",
      format: ["IT20"],
      date_from: "2024-01-01",
    },
    limit: 10,
  },
  {
    filters: { venue_canonical: ["Wankhede Stadium, Mumbai"], format: ["T20"] },
    order_dir: "desc",
    limit: 5,
  },
];

export const MATCHES_DESCRIPTION = `${prose(`
A list of matches with their results: who played, who won, by what
    margin, where and when.

DO NOT use this tool for:
- any per-player statistic -- use query_batting_aggregate or
    query_bowling_aggregate.
- one match's detail -- use get_scorecard with the match_id this returns.
- a team's win/loss COUNT. This returns rows, up to ${MAX_LIMIT} of them; read
    row_count_total for the true total rather than counting the rows you were given.

subject_team is the team the question is asked from, and subject_team_result /
    subject_team_won_toss are meaningless without it -- passing either alone is an
    error, because "won" needs to name who won. subject_team_result values: win,
    loss, draw, tie, no_result. Note that a tie decided by a super over has
    result_type="tie" and an eliminator_winner, so it is NOT a win.

format values: Test, ODI, T20, IT20, MDM, ODM. gender values: male, female. Team and
    venue names must be exact -- resolve them with resolve_entity first, because a
    near-miss spelling silently matches nothing.

limit defaults to 20, maximum ${MAX_LIMIT}. Results are newest first unless
    order_dir="asc".

One caveat worth stating to a user: filters are applied to ball-by-ball data, so a
    match abandoned without a ball bowled is not in this list at all.`)}

${examplesBlock(MATCHES_EXAMPLES)}`;

export const MATCHES_TOOL: ToolSpec = {
  name: "query_matches",
  description: MATCHES_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      filters: {
        ...schemas.modelSchema(MatchFilters),
        description:
          "Match filters. subject_team names the team the result is " +
          "expressed from; subject_team_result and subject_team_won_toss " +
          "require it.",
      },
      order_dir: {
        type: "string",
        enum: ["asc", "desc"],
        default: "desc",
        description: "By start date. desc is newest first.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_LIMIT,
        default: 20,
      },
    },
    required: [],
  },
  handler: matches,
  shape: "table",
  examples: MATCHES_EXAMPLES,
};
