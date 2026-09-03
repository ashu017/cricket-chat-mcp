// The SQL and the functions must agree, case for case.
//
// Every derived column exists twice in `definitions.ts`: as a function, and as a SQL
// expression the ingest renders into the warehouse. That duplication is deliberate --
// the functions make unit tests fast and the SQL makes the warehouse fast -- but two
// copies of a definition drift, and a drifted definition produces a plausible wrong
// number rather than a crash. This suite is the thing that stops the drift.
//
// Tier 1 (per-ball flags) runs against an in-memory DuckDB over a synthetic case grid.
// Tier 2 (metric arithmetic) is pure SQL arithmetic over tier-1 aliases, so it can be
// evaluated the same way with no table at all.
//
// `agree` requires the *same type*, not merely equal truthiness. Without that a SQL
// NULL passes as a Python/JS `false` and the two definitions can disagree on every
// ball where `non_boundary` is unset -- which is nearly every ball in the warehouse.

import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BATTING_BASE_SQL,
  BATTING_DERIVED_SQL,
  BOWLING_BASE_SQL,
  BOWLING_DERIVED_SQL,
  DERIVED_COLUMN_EQUIVALENTS,
  DERIVED_COLUMN_TYPES,
  DERIVED_COLUMNS,
  DERIVED_METRIC_EQUIVALENTS,
  type DeliveryCase,
  type MetricRow,
} from "./definitions.js";

/**
 * The per-ball case grid, mirroring `tests/test_definitions_sql_parity.py`.
 *
 * The interesting axes are the ones the definitions branch on: runs off the bat
 * (including both boundary values), wides, no-balls, byes present or absent, and all
 * three states of `non_boundary` -- including NULL, which is the common case.
 */
function cases(): DeliveryCase[] {
  const out: DeliveryCase[] = [];
  for (const runsBatter of [0, 1, 2, 3, 4, 6]) {
    for (const wides of [0, 1, 2]) {
      for (const noballs of [0, 1]) {
        for (const byes of [0, 4]) {
          for (const nonBoundary of [null, false, true]) {
            out.push({
              runs_batter: runsBatter,
              extras_wides: wides,
              extras_noballs: noballs,
              extras_byes: byes,
              runs_total: runsBatter + wides + noballs + byes,
              non_boundary: nonBoundary,
            });
          }
        }
      }
    }
  }
  return out;
}

/** Same value AND same type. See the note at the top of the file. */
function agree(sqlValue: unknown, fnValue: unknown): boolean {
  if (typeof sqlValue === "bigint" && typeof fnValue === "number") {
    // DuckDB returns INTEGER as a JS number, but a widened sum can arrive as BigInt.
    return sqlValue === BigInt(fnValue);
  }
  if (typeof sqlValue !== typeof fnValue) return false;
  return sqlValue === fnValue;
}

describe("derived-column registries", () => {
  it("cover exactly the same columns", () => {
    const columns = Object.keys(DERIVED_COLUMNS).sort();
    expect(Object.keys(DERIVED_COLUMN_TYPES).sort()).toEqual(columns);
    expect(Object.keys(DERIVED_COLUMN_EQUIVALENTS).sort()).toEqual(columns);
  });

  it("has not lost a column to a bad merge", () => {
    expect(Object.keys(DERIVED_COLUMNS).length).toBeGreaterThanOrEqual(10);
  });
});

describe("tier 1: per-ball SQL matches the functions", () => {
  let instance: DuckDBInstance;
  let connection: Awaited<ReturnType<DuckDBInstance["connect"]>>;
  const grid = cases();

  beforeAll(async () => {
    // In-memory: this suite must not touch the real warehouse, and it needs no data
    // beyond the grid it builds itself.
    instance = await DuckDBInstance.create(":memory:");
    connection = await instance.connect();
    await connection.run(
      `CREATE TABLE grid (
         case_id INTEGER,
         runs_batter INTEGER,
         extras_wides INTEGER,
         extras_noballs INTEGER,
         extras_byes INTEGER,
         runs_total INTEGER,
         non_boundary BOOLEAN
       )`,
    );
    const appender = await connection.createAppender("grid");
    for (const [index, row] of grid.entries()) {
      appender.appendInteger(index);
      appender.appendInteger(row.runs_batter);
      appender.appendInteger(row.extras_wides);
      appender.appendInteger(row.extras_noballs);
      appender.appendInteger(row.extras_byes);
      appender.appendInteger(row.runs_total);
      if (row.non_boundary === null) appender.appendNull();
      else appender.appendBoolean(row.non_boundary);
      appender.endRow();
    }
    appender.closeSync();
  });

  afterAll(() => {
    connection?.closeSync();
    instance?.closeSync();
  });

  it.each(Object.keys(DERIVED_COLUMNS))("%s agrees on every case", async (column) => {
    const expression = DERIVED_COLUMNS[column as keyof typeof DERIVED_COLUMNS];
    const fn = DERIVED_COLUMN_EQUIVALENTS[column as keyof typeof DERIVED_COLUMN_EQUIVALENTS];
    const reader = await connection.runAndReadAll(
      `SELECT case_id, ${expression} AS value FROM grid ORDER BY case_id`,
    );
    const rows = reader.getRowObjects();
    expect(rows.length).toBe(grid.length);

    const disagreements: string[] = [];
    for (const row of rows) {
      const index = Number(row["case_id"]);
      const source = grid[index];
      if (source === undefined) throw new Error(`case ${index} is not in the grid`);
      const expected = fn(source);
      if (!agree(row["value"], expected)) {
        disagreements.push(
          `${JSON.stringify(source)}: SQL gave ${String(row["value"])} ` +
            `(${typeof row["value"]}), the function gave ${String(expected)} ` +
            `(${typeof expected})`,
        );
      }
    }
    expect(disagreements).toEqual([]);
  });

  it.each(Object.entries(DERIVED_COLUMN_TYPES))(
    "%s is really a %s in DuckDB",
    async (column, declared) => {
      // The declared type is what the ingest DDL is generated from. An expression that
      // actually returns something else means the warehouse column silently casts.
      const expression = DERIVED_COLUMNS[column as keyof typeof DERIVED_COLUMNS];
      const reader = await connection.runAndReadAll(
        `SELECT ${expression} AS value FROM grid LIMIT 1`,
      );
      expect(String(reader.columnType(0)).toUpperCase()).toBe(declared);
    },
  );
});

describe("tier 2: metric SQL matches the functions", () => {
  let instance: DuckDBInstance;
  let connection: Awaited<ReturnType<DuckDBInstance["connect"]>>;

  beforeAll(async () => {
    instance = await DuckDBInstance.create(":memory:");
    connection = await instance.connect();
  });

  afterAll(() => {
    connection?.closeSync();
    instance?.closeSync();
  });

  /**
   * Tier-1 aggregate rows to evaluate tier 2 over.
   *
   * The zeroes are the point: every one of these metrics has a denominator that can be
   * zero for a real player, and "null, not zero" is the definitional claim under test.
   */
  const battingRows: MetricRow[] = [
    { runs: 0, balls_faced: 0, fours: 0, sixes: 0, dots: 0, dismissals: 0 },
    { runs: 300, balls_faced: 210, fours: 30, sixes: 8, dots: 60, dismissals: 7 },
    { runs: 45, balls_faced: 33, fours: 4, sixes: 1, dots: 12, dismissals: 0 },
    { runs: 12, balls_faced: 40, fours: 0, sixes: 0, dots: 31, dismissals: 3 },
    { runs: 1284, balls_faced: 903, fours: 111, sixes: 53, dots: 302, dismissals: 41 },
  ];

  const bowlingRows: MetricRow[] = [
    {
      balls_bowled: 0,
      runs_conceded: 0,
      wickets: 0,
      dots: 0,
      fours_conceded: 0,
      sixes_conceded: 0,
    },
    {
      balls_bowled: 24,
      runs_conceded: 24,
      wickets: 0,
      dots: 8,
      fours_conceded: 2,
      sixes_conceded: 0,
    },
    {
      balls_bowled: 533,
      runs_conceded: 641,
      wickets: 29,
      dots: 180,
      fours_conceded: 61,
      sixes_conceded: 24,
    },
    {
      balls_bowled: 120,
      runs_conceded: 150,
      wickets: 4,
      dots: 41,
      fours_conceded: 13,
      sixes_conceded: 7,
    },
  ];

  const grains = [
    { grain: "batting", sql: BATTING_DERIVED_SQL, base: BATTING_BASE_SQL, rows: battingRows },
    { grain: "bowling", sql: BOWLING_DERIVED_SQL, base: BOWLING_BASE_SQL, rows: bowlingRows },
  ] as const;

  for (const { grain, sql, rows } of grains) {
    const metrics = Object.keys(sql).filter(
      (metric) => `${grain}.${metric}` in DERIVED_METRIC_EQUIVALENTS,
    );

    it.each(metrics)(`${grain}.%s agrees on every row`, async (metric) => {
      const expression = (sql as Record<string, string>)[metric];
      const fn =
        DERIVED_METRIC_EQUIVALENTS[`${grain}.${metric}` as keyof typeof DERIVED_METRIC_EQUIVALENTS];

      const disagreements: string[] = [];
      for (const row of rows) {
        // The tier-2 expressions are written over tier-1 *aliases*, so a SELECT that
        // defines those aliases is exactly the environment they run in for real.
        const aliases = Object.entries(row)
          .map(([name, value]) => `${value === null ? "NULL" : value} AS ${name}`)
          .join(", ");
        const reader = await connection.runAndReadAll(
          `SELECT ${expression} AS value FROM (SELECT ${aliases})`,
        );
        const value = reader.getRowObjects()[0]?.["value"] ?? null;
        const expected = fn(row);
        const actual = value === null ? null : Number(value);
        if (actual !== expected) {
          disagreements.push(
            `${JSON.stringify(row)}: SQL gave ${String(actual)}, the function gave ` +
              `${String(expected)}`,
          );
        }
      }
      expect(disagreements).toEqual([]);
    });
  }

  it("renders overs as O.B, never rounding a part-over up into a whole one", () => {
    // The Python original wrote `(balls_bowled / 6)::INTEGER`, and `/` in DuckDB is a
    // DOUBLE division that `::INTEGER` then ROUNDS -- so 533 balls came out as "89.5",
    // which is 89 overs and 5 balls, more overs than were bowled. Floor division is the
    // fix, and this is the case that proves it.
    expect(BOWLING_DERIVED_SQL.overs).toContain("//");
  });

  it.each([
    [0, "0.0"],
    [5, "0.5"],
    [6, "1.0"],
    [24, "4.0"],
    [27, "4.3"],
    [533, "88.5"],
  ])("renders %i balls as %s overs", async (balls, expected) => {
    const reader = await connection.runAndReadAll(
      `SELECT ${BOWLING_DERIVED_SQL.overs} AS value FROM (SELECT ${balls}::INTEGER AS balls_bowled)`,
    );
    expect(reader.getRowObjects()[0]?.["value"]).toBe(expected);
  });
});
