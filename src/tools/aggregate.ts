// The batting and bowling aggregate query builder.
//
// Both leaderboard tools are the same query with a different metric registry, so they
// share this. It assembles, never computes: every metric expression comes from
// `definitions.ts` and every predicate from `filters.ts`. If you find yourself writing
// `/ 6` or `* 100` in this file, it belongs in `definitions.ts`.
//
// The shape it builds:
//
//     WITH base AS (      -- tier 1, aggregated over `deliveries`
//       ...
//     ), outs AS (        -- batting only: dismissals, at their own grain
//       ...
//     ), joined AS (      -- the two stitched together at GROUP-KEY grain, not ball
//       ...
//     )
//     SELECT ..., <tier 2 arithmetic>, count(*) OVER () AS _qualified
//     FROM joined
//     WHERE <qualification minimums>
//     ORDER BY ... NULLS LAST
//     LIMIT ?
//
// `NULLS LAST` is not cosmetic. An undefined average is NULL, and in DuckDB NULL sorts
// first descending -- so "best average" would return the batters who have never been
// dismissed, which is the Trap D bug wearing a different hat.

import {
  BATTING_BASE_SQL,
  BATTING_DERIVED_SQL,
  BOWLING_BASE_SQL,
  BOWLING_DERIVED_SQL,
  type BoundValue,
  type CompiledFilters,
  DISMISSAL_PREDICATE,
  DISMISSALS_SQL,
  DISMISSED_BATTER_KEY,
  JOIN_SQL,
  type Join,
  WICKETS_BALL_JOIN,
} from "../core/index.js";

export type Grain = "batting" | "bowling";

/**
 * One `group_by` dimension.
 *
 * `outsExpr` exists solely for the batting `player` dimension, where the dismissals
 * CTE must key on the batter who was *out* rather than the batter on strike.
 * Everywhere else the two are the same expression.
 */
export interface GroupDim {
  alias: string;
  expr: string;
  outsExpr?: string;
  requiresJoin?: Join;
  /** True when the alias holds a player id and the query should attach a name. */
  isPlayer?: boolean;
  note?: string;
}

/** The expression the dismissals CTE groups and keys on. */
export function dismissalsExpr(dim: GroupDim): string {
  return dim.outsExpr ?? dim.expr;
}

const SHARED_DIMS = {
  venue: { alias: "venue", expr: "d.venue_canonical" },
  format: { alias: "format", expr: "d.format" },
  competition: { alias: "competition", expr: "d.competition" },
  year: { alias: "year", expr: "year(d.match_date)" },
  season: { alias: "season", expr: "m.season", requiresJoin: "matches" },
  phase: {
    alias: "phase",
    expr: "d.phase",
    note: "NULL for Test and other unlimited-overs formats",
  },
  innings_no: { alias: "innings_no", expr: "d.innings_no" },
} as const satisfies Record<string, GroupDim>;

export const BATTING_DIMS = {
  ...SHARED_DIMS,
  player: {
    alias: "batter_id",
    expr: "d.batter_id",
    // The 4,111-of-85,778 correction, in one field. See DISMISSED_BATTER_KEY.
    outsExpr: DISMISSED_BATTER_KEY,
    isPlayer: true,
  },
  team: { alias: "team", expr: "d.batting_team" },
  opposition: { alias: "opposition", expr: "d.bowling_team" },
  batting_position: {
    alias: "batting_position",
    expr: "d.batting_position",
    note:
      "the striker's position; a non-striker run out is attributed to the " +
      "striker's position, which affects ~5% of dismissals",
  },
  bowling_type_faced: {
    alias: "bowling_type_faced",
    expr: "coalesce(ba_bowl.bowling_type, 'unknown')",
    requiresJoin: "bowler_attributes",
  },
} as const satisfies Record<string, GroupDim>;

export const BOWLING_DIMS = {
  ...SHARED_DIMS,
  player: { alias: "bowler_id", expr: "d.bowler_id", isPlayer: true },
  team: { alias: "team", expr: "d.bowling_team" },
  opposition: { alias: "opposition", expr: "d.batting_team" },
  bowling_type: {
    alias: "bowling_type",
    expr: "coalesce(ba_bowl.bowling_type, 'unknown')",
    requiresJoin: "bowler_attributes",
  },
} as const satisfies Record<string, GroupDim>;

export function dimsFor(grain: Grain): Readonly<Record<string, GroupDim>> {
  return grain === "batting" ? BATTING_DIMS : BOWLING_DIMS;
}

/** Every column a caller may sort by, base and derived, in display order. */
export function metricsFor(grain: Grain): string[] {
  if (grain === "batting") {
    return [...Object.keys(BATTING_BASE_SQL), "dismissals", ...Object.keys(BATTING_DERIVED_SQL)];
  }
  return [...Object.keys(BOWLING_BASE_SQL), ...Object.keys(BOWLING_DERIVED_SQL)];
}

/** Order-preserving dedupe. A join emitted twice is a duplicate-alias crash. */
function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)];
}

export interface BuiltQuery {
  sql: string;
  params: BoundValue[];
  /** The columns the model will see, in order. */
  columns: string[];
}

export interface BuildInput {
  groupBy: readonly string[];
  orderBy: string;
  orderDir: string;
  limit: number;
  havingSql: string;
}

/**
 * Assemble the aggregate query. Returns parameterised SQL and its bindings.
 *
 * `groupBy` may be empty, meaning "one row for everything matched" -- a career total
 * for a filtered player. That case still needs the dismissals CTE joined on
 * *something*, hence the constant `_grp` key: it makes the no-group case the same code
 * path as every other, rather than a second query template that drifts.
 */
export function build(grain: Grain, compiled: CompiledFilters, input: BuildInput): BuiltQuery {
  const dims = dimsFor(grain);
  const selected = input.groupBy.map((name) => {
    const dim = dims[name];
    if (dim === undefined) throw new Error(`unknown group_by dimension '${name}'`);
    return dim;
  });

  const baseSql: Readonly<Record<string, string>> =
    grain === "batting" ? BATTING_BASE_SQL : BOWLING_BASE_SQL;
  const derivedSql: Readonly<Record<string, string>> =
    grain === "batting" ? BATTING_DERIVED_SQL : BOWLING_DERIVED_SQL;

  const dimJoins = selected
    .filter((dim) => dim.requiresJoin !== undefined)
    .map((dim) => JOIN_SQL[dim.requiresJoin as Join]);
  const joinSql = dedupe([...compiled.joins, ...dimJoins]).join("\n            ");
  const where = compiled.whereSql;

  // --- tier 1 -------------------------------------------------------------
  const groupKeys = selected.map((dim) => dim.alias);
  const baseSelect = [
    "1 AS _grp",
    ...selected.map((dim) => `${dim.expr} AS ${dim.alias}`),
    ...Object.entries(baseSql).map(([name, expr]) => `${expr} AS ${name}`),
  ].join(",\n                   ");
  // GROUP BY the EXPRESSIONS, not the output aliases. Tempting as the aliases are,
  // `batter_id` is also a real column on `deliveries`, and DuckDB resolves the base
  // column in preference to the alias -- so the dismissals CTE silently grouped by the
  // striker while selecting the dismissed batter. Grouping by the expression is
  // unambiguous, and both copies are generated from the same GroupDim so they cannot
  // drift apart.
  // `_grp` is a literal, so it needs no grouping; with no dimensions at all there is no
  // GROUP BY clause and the aggregate collapses to the single row we want.
  const baseGroupBy = groupClause(selected.map((dim) => dim.expr));
  const outsGroupBy = groupClause(selected.map(dismissalsExpr));

  const ctes = [
    `base AS (
            SELECT ${baseSelect}
            FROM deliveries d
            ${joinSql}
            WHERE ${where}
            ${baseGroupBy}
        )`,
  ];
  const params: BoundValue[] = [...compiled.params];

  // --- dismissals, batting only -------------------------------------------
  if (grain === "batting") {
    const outsSelect = [
      "1 AS _grp",
      ...selected.map((dim) => `${dismissalsExpr(dim)} AS ${dim.alias}`),
      `${DISMISSALS_SQL} AS dismissals`,
    ].join(",\n                   ");
    ctes.push(`outs AS (
            SELECT ${outsSelect}
            FROM deliveries d
            ${WICKETS_BALL_JOIN}
            ${joinSql}
            WHERE ${where} AND ${DISMISSAL_PREDICATE}
            ${outsGroupBy}
        )`);
    // The dismissals CTE repeats the same filters, so it repeats the bindings.
    params.push(...compiled.params);
    const using = ["_grp", ...groupKeys].join(", ");
    ctes.push(`joined AS (
            SELECT b.*, coalesce(o.dismissals, 0)::INTEGER AS dismissals
            FROM base b
            LEFT JOIN outs o USING (${using})
        )`);
  } else {
    ctes.push("joined AS (SELECT * FROM base)");
  }

  // --- tier 2 -------------------------------------------------------------
  const columns: string[] = [];
  const projection: string[] = [];
  for (const dim of selected) {
    columns.push(dim.alias);
    projection.push(`j.${dim.alias}`);
    if (dim.isPlayer === true) {
      columns.push("player_name");
      projection.push("p.unique_name AS player_name");
    }
  }
  for (const name of Object.keys(baseSql)) {
    columns.push(name);
    projection.push(`j.${name}`);
  }
  if (grain === "batting") {
    columns.push("dismissals");
    projection.push("j.dismissals");
  }
  for (const [name, expr] of Object.entries(derivedSql)) {
    columns.push(name);
    projection.push(`${expr} AS ${name}`);
  }

  const playerDim = selected.find((dim) => dim.isPlayer === true);
  const playerJoin =
    playerDim !== undefined ? `LEFT JOIN players p ON p.player_id = j.${playerDim.alias}` : "";

  const scanColumn = grain === "batting" ? "balls_faced" : "balls_bowled";
  const orderSql = `${quoteOrder(input.orderBy)} ${input.orderDir === "asc" ? "ASC" : "DESC"} NULLS LAST`;

  const projectionSql = projection.join(",\n               ");
  const sql = `WITH ${ctes.join(", ")}
        SELECT ${projectionSql},
               count(*) OVER ()::INTEGER AS _qualified,
               (SELECT count(*) FROM base)::INTEGER AS _considered,
               (SELECT coalesce(sum(${scanColumn}), 0) FROM base)::BIGINT AS _scanned
        FROM joined j
        ${playerJoin}
        WHERE ${input.havingSql}
        ORDER BY ${orderSql}
        LIMIT ?`;
  params.push(input.limit);
  return { sql, params, columns };
}

function groupClause(exprs: readonly string[]): string {
  return exprs.length > 0 ? `GROUP BY ${exprs.join(", ")}` : "";
}

/**
 * `orderBy` is validated against the registries before it reaches here.
 *
 * Asserting that again is cheap and this is the one identifier in the module that
 * originates outside it, so it gets a belt as well as braces: anything but a bare
 * alphanumeric identifier cannot be an alias we emitted.
 */
function quoteOrder(orderBy: string): string {
  if (!/^[A-Za-z0-9]+$/.test(orderBy.replace(/_/g, ""))) {
    throw new Error(`order_by '${orderBy}' is not an identifier`);
  }
  return orderBy;
}
