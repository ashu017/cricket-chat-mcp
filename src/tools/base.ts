// Shared machinery for the tools. No cricket arithmetic lives here.
//
// Every tool is thin on purpose. The definitions are in `src/core`'s
// `definitions.ts`, the predicates are in its `filters.ts`, and what is left --
// opening the warehouse, attaching the coverage window, applying the qualification
// minimums, shaping an error the model can act on -- is here, once.
//
// The rule that keeps it honest: a tool module may assemble SQL out of names taken
// from these registries and bind values as parameters. It may not do arithmetic on a
// cricket quantity, and it may not hardcode a minimum or a date.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { type DuckDBConnection, DuckDBInstance, DuckDBTypeId } from "@duckdb/node-api";
import {
  type AttributeCoverage,
  type Cell,
  type Coverage,
  type CricinfoLink,
  type Definitions,
  ErrorDetail,
  type PhaseSource,
  type Qualification,
  type Row,
  ToolError,
  type ToolResponse,
} from "../contracts/index.js";
import {
  type BoundValue,
  type CompiledFilters,
  JOIN_SQL,
  MIN_BALLS_BOWLED,
  MIN_BALLS_FACED,
  MIN_INNINGS,
  metricDefinition,
} from "../core/index.js";
import { DB_ENV_VAR, dbPath, defaultDbPath } from "../core/warehouse.js";

/**
 * Where the warehouse is. Owned by `src/core/warehouse`, re-exported here.
 *
 * This file used to spell `"data/cricket.duckdb"` itself, and the ingest spelled it again.
 * Two copies of a *relative* path is what made the fixture conformance suite skip itself
 * under `vitest`, whose cwd is the package directory. It matters more in a published
 * package, where the cwd belongs to whichever MCP client spawned the process. The resolver
 * and the reasoning are in that module; `DEFAULT_DB` is the absolute answer rather than a
 * string to be resolved by whoever happens to hold it.
 */
export { DB_ENV_VAR, dbPath };
export const DEFAULT_DB = defaultDbPath();

/**
 * Server-side ceiling. The contract already caps `limit` at 200; this is the second
 * half of Trap D -- a model that omits `limit` gets 20, and a model that asks for 5000
 * gets a correctable error rather than a 5000-row context flood.
 */
export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 20;

export { ToolError };

// ---------------------------------------------------------------------------
// The warehouse handle
// ---------------------------------------------------------------------------

/** Column names plus rows, which is all any handler here wants from a query. */
export interface QueryResult {
  columns: string[];
  rows: Row[];
}

/**
 * A read-only warehouse connection.
 *
 * An interface rather than the DuckDB class so a test can hand a handler a stub, and
 * so nothing downstream of here can reach `run()` and write.
 */
export interface Db {
  query(sql: string, params?: readonly BoundValue[]): Promise<QueryResult>;
  close(): void;
}

/**
 * DuckDB numeric types that arrive from the JSON converter as strings.
 *
 * The converter renders BIGINT and DECIMAL as strings because they can exceed what a
 * JS number holds exactly. Our own columns are all `::INTEGER`, but `count(*)` widens
 * to BIGINT on its own, and a `row_count_total` of `"41"` fails the contract with a
 * type error three layers away from the query that produced it. So they are converted
 * here, once, with the safe-integer check that makes the conversion honest.
 */
const STRINGY_NUMERIC: ReadonlySet<DuckDBTypeId> = new Set([
  DuckDBTypeId.BIGINT,
  DuckDBTypeId.UBIGINT,
  DuckDBTypeId.HUGEINT,
  DuckDBTypeId.UHUGEINT,
  DuckDBTypeId.DECIMAL,
]);

function asNumber(value: unknown, column: string): Cell {
  if (typeof value !== "string") return value as Cell;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`column ${column} returned ${value}, which is not a number`);
  }
  if (Number.isInteger(parsed) && !Number.isSafeInteger(parsed)) {
    // Reachable only from a bug: no cricket quantity is anywhere near 2^53, so this
    // means the query is counting the wrong thing rather than that the sport got big.
    throw new Error(`column ${column} returned ${value}, which is too large to be exact`);
  }
  return parsed;
}

class DuckDb implements Db {
  constructor(private readonly connection: DuckDBConnection) {}

  async query(sql: string, params: readonly BoundValue[] = []): Promise<QueryResult> {
    const reader = await this.connection.runAndReadAll(sql, [...params]);
    const columns = reader.columnNames();
    const widened: string[] = [];
    for (let i = 0; i < reader.columnCount; i += 1) {
      if (STRINGY_NUMERIC.has(reader.columnTypeId(i))) widened.push(columns[i] as string);
    }
    // `getRowObjectsJson` is what gives DATE as `2024-06-29` and LIST as a real array,
    // which is exactly the JSON the contract wants. See STRINGY_NUMERIC for the one
    // thing it gets wrong for our purposes.
    const rows = reader.getRowObjectsJson() as unknown as Row[];
    for (const row of rows) {
      for (const column of widened) row[column] = asNumber(row[column], column);
    }
    return { columns, rows };
  }

  close(): void {
    this.connection.closeSync();
  }
}

/**
 * One DuckDB instance per warehouse file, reused.
 *
 * A fresh instance per tool call re-opens the file, and the agent loop makes several
 * calls per turn. Connections are still per call, which is what keeps concurrent
 * `/invocations` requests independent.
 */
const instances = new Map<string, Promise<DuckDBInstance>>();

/**
 * A fresh read-only connection.
 *
 * Read-only is not a nicety: a tool that can write to the warehouse can corrupt the
 * thing every answer is checked against. It also makes concurrent requests safe
 * without a lock.
 */
export async function connect(): Promise<Db> {
  const path = dbPath();
  const configured = process.env[DB_ENV_VAR] !== undefined && process.env[DB_ENV_VAR] !== "";
  if (!existsSync(path)) {
    throw new ToolError(
      ErrorDetail.parse({
        code: "INTERNAL_ERROR",
        tool: "",
        // The warehouse ships inside this package, so a missing file is not something the
        // reader forgot to do -- it is a broken install, or a `CRICKET_DB` pointing at a
        // path that is not there. Say which of those it is, because the remedies differ
        // and "the warehouse is missing" on its own sends people looking for a build step
        // that does not exist here.
        message: configured
          ? `the warehouse is missing at ${path}, which is where ${DB_ENV_VAR} points. ` +
            `Unset ${DB_ENV_VAR} to use the one bundled with this package.`
          : `the warehouse is missing at ${path}. It ships inside this package, so this ` +
            `means the install is incomplete -- reinstall, or set ${DB_ENV_VAR} to a ` +
            `warehouse you built yourself.`,
        retryable: false,
      }),
    );
  }
  let instance = instances.get(path);
  if (instance === undefined) {
    instance = DuckDBInstance.create(path, { access_mode: "READ_ONLY" });
    instances.set(path, instance);
  }
  return new DuckDb(await (await instance).connect());
}

/** Release the cached instances. For test teardown; the runtime holds them for life. */
export async function closeWarehouses(): Promise<void> {
  const pending = [...instances.values()];
  instances.clear();
  for (const instance of pending) (await instance).closeSync();
}

// ---------------------------------------------------------------------------
// Small query helpers
// ---------------------------------------------------------------------------

/** The first row, or `undefined`. Named for how it reads at the call site. */
export function firstRow(result: QueryResult): Row | undefined {
  return result.rows[0];
}

/** The named cell of the first row, or `null`. */
export function cell(result: QueryResult, column: string): Cell {
  return result.rows[0]?.[column] ?? null;
}

/** A cell that must be a number, with `null` folded to `0`. */
export function count(result: QueryResult, column: string): number {
  const value = cell(result, column);
  return typeof value === "number" ? value : 0;
}

/** `?, ?, ?` for a list of bound values. */
export function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

/**
 * A stable short handle for a query.
 *
 * The full SQL is 300-800 tokens and the model does not need it to write prose, so
 * only this travels in the tool result. The SQL itself goes to the UI on the
 * `tool_result` event, keyed by this id.
 */
export function sqlId(sql: string): string {
  return createHash("sha256").update(sql).digest("hex").slice(0, 12);
}

/**
 * Drop the private columns.
 *
 * A leading underscore marks a column the query needed but the model should not see --
 * scan counts, sort keys, coverage scratch. Dates are already ISO strings by the time
 * they get here, which is what `Db.query` is for.
 */
export function cleanRows(rows: readonly Row[]): Row[] {
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("_"))),
  );
}

/** `columns` with the private ones dropped, to match {@link cleanRows}. */
export function cleanColumns(columns: readonly string[]): string[] {
  return columns.filter((column) => !column.startsWith("_"));
}

// ---------------------------------------------------------------------------
// Tool descriptions
// ---------------------------------------------------------------------------

/**
 * Unwrap a source-wrapped tool description.
 *
 * Tool descriptions are long paragraphs and this file is limited to 100 columns, so
 * the source has to wrap them somewhere. Hand-splitting them into a list of fragments
 * is how a description ends up with two spaces in one place and none in another; this
 * does the joining once, in one place.
 *
 * The rule is indentation, so that the source reads like the output: an INDENTED line
 * is a continuation of the line above and is joined to it with a space, while a line
 * at the left margin starts a new line of its own. Blank lines survive as paragraph
 * breaks. That keeps the "DO NOT use this tool for" bullets and the "<field> values:
 * ..." lines on separate lines, which is the part of a description the model actually
 * navigates by.
 */
export function prose(text: string): string {
  const out: string[] = [];
  for (const block of text.replace(/^\n+/, "").replace(/\n+$/, "").split("\n\n")) {
    const joined: string[] = [];
    for (const line of block.split("\n")) {
      const continuation = joined.length > 0 && /^\s/.test(line);
      if (continuation)
        joined[joined.length - 1] = `${joined[joined.length - 1]} ${line.trim()}`.trim();
      else joined.push(line.trim());
    }
    out.push(joined.join("\n"));
  }
  return out.join("\n\n");
}

/**
 * The worked `input` examples, rendered from the same objects the tests use.
 *
 * Rendering them from real objects rather than typing them into the prose is what
 * stops an example drifting out of sync with the schema: `tools lint` validates these
 * against the tool's own input schema.
 */
export function examplesBlock(examples: readonly Record<string, unknown>[]): string {
  return examples
    .map((example, index) => `Example ${index + 1}:\n${JSON.stringify(example, null, 2)}`)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Coverage (Trap A)
// ---------------------------------------------------------------------------

/** `[first, last]` as ISO dates, or nulls. */
export type DatasetWindow = [string | null, string | null];

/**
 * The warehouse's own span, read from the `coverage` table and never hardcoded.
 *
 * Hardcoding it is how a UI badge ends up saying "2008-2024" a year after the data was
 * widened, which is a wrong answer about the answer.
 */
export async function datasetWindow(db: Db): Promise<DatasetWindow> {
  const result = await db.query(
    "SELECT min(first_date) AS first_date, max(last_date) AS last_date FROM coverage",
  );
  const row = firstRow(result);
  if (row === undefined) return [null, null];
  return [
    (row["first_date"] as string | null) ?? null,
    (row["last_date"] as string | null) ?? null,
  ];
}

export interface CoverageQuery {
  where: string;
  params: readonly BoundValue[];
  joins?: string;
  playerIds?: readonly string[];
}

/**
 * The scope this particular answer was computed over, plus the dataset's.
 *
 * `career_possibly_truncated` is the Trap A flag. It is set from
 * `player_debut_overrides`: if a queried player debuted before ball-by-ball data
 * existed then every career total here is a fragment, and an answer that does not say
 * so is confidently wrong.
 */
export async function buildCoverage(db: Db, query: CoverageQuery): Promise<Coverage> {
  const scope = await db.query(
    `
        SELECT count(DISTINCT d.match_id)::INTEGER AS matches,
               min(d.match_date) AS earliest,
               max(d.match_date) AS latest
        FROM deliveries d
        ${query.joins ?? ""}
        WHERE ${query.where}
    `,
    query.params,
  );
  const matches = count(scope, "matches");
  const earliest = cell(scope, "earliest") as string | null;
  const latest = cell(scope, "latest") as string | null;
  const [first, last] = await datasetWindow(db);

  let truncated = false;
  const playerIds = query.playerIds ?? [];
  if (playerIds.length > 0 && first !== null) {
    const debuts = await db.query(
      `SELECT count(*)::INTEGER AS n FROM player_debut_overrides ` +
        `WHERE player_id IN (${placeholders(playerIds)}) AND debut_date < ?`,
      [...playerIds, first],
    );
    truncated = count(debuts, "n") > 0;
  }

  return {
    matches_in_scope: matches,
    // Forced to null when nothing matched: `min()` over no rows is null anyway, but the
    // contract rejects a date on an empty scope and saying so here is cheaper to read.
    earliest_date: matches > 0 ? earliest : null,
    latest_date: matches > 0 ? latest : null,
    dataset_first_date: first,
    dataset_last_date: last,
    career_possibly_truncated: truncated,
  };
}

/**
 * Trap B: how much of the matched population actually carries the attribute.
 *
 * A "versus spin" answer over the fraction of deliveries whose bowler we have labelled
 * is not wrong; presenting it as complete is. The ratio ships with the answer so the
 * model can say "of the 38% of balls where we know the type".
 *
 * Measured with the attribute predicate itself REMOVED. Leaving it in would compare the
 * labelled deliveries against the labelled deliveries and report 100% coverage on every
 * query, which is a reassuring number that means nothing.
 */
export async function attributeCoverage(
  db: Db,
  attribute: string,
  compiled: CompiledFilters,
): Promise<AttributeCoverage> {
  const [where, params] = compiled.withoutAttributes();
  // Exactly once: the attribute join is required here, and the compiled filters may
  // already carry it. Emitting it twice is a duplicate-alias crash.
  const attrJoin = JOIN_SQL.bowler_attributes;
  const joins = [attrJoin, ...compiled.joins.filter((join) => join !== attrJoin)].join("\n");
  const result = await db.query(
    `
        SELECT count(*)::INTEGER AS total,
               sum(CASE WHEN coalesce(ba_bowl.${attribute}, 'unknown') <> 'unknown'
                        THEN 1 ELSE 0 END)::INTEGER AS known
        FROM deliveries d
        ${joins}
        WHERE ${where}
    `,
    params,
  );
  return {
    attribute,
    known_deliveries: count(result, "known"),
    total_deliveries: count(result, "total"),
  };
}

// ---------------------------------------------------------------------------
// Definitions echo (Trap C)
// ---------------------------------------------------------------------------

export interface DefinitionsInput {
  grain?: string;
  excluded?: readonly string[];
  notes?: readonly string[];
  phaseSource?: PhaseSource | null;
}

/**
 * Echo the one-sentence definition of every metric in the response.
 *
 * Read from `metricDefinition` rather than written here, so the prose a user is shown
 * and the SQL that produced the number cannot drift.
 *
 * `grain` is not optional in practice for a stats tool. Four metric names --
 * `average`, `strike_rate`, `dots`, `dot_pct` -- mean different things to a batter and
 * a bowler, and without the grain a bowling response echoed the batting sentence for
 * all four. Pass it wherever the grain is known; the keys the caller hands in stay
 * unqualified, because those are the response's own column names.
 */
export function definitionsFor(
  metrics: readonly string[],
  input: DefinitionsInput = {},
): Definitions {
  const resolved: Record<string, string> = {};
  for (const name of metrics) {
    const sentence = metricDefinition(name, input.grain);
    // Silently skipped rather than defaulted: a metric with no prose is a metric the
    // response simply does not define, and inventing a sentence here would be worse
    // than the omission. The suite that asserts every metric HAS prose is in core.
    if (sentence !== undefined) resolved[name] = sentence;
  }
  return {
    metrics: resolved,
    excluded: [...(input.excluded ?? [])],
    notes: [...(input.notes ?? [])],
    phase_source: input.phaseSource ?? null,
  };
}

export function superOverNote(includeSuperOver: boolean): string[] {
  return includeSuperOver ? [] : ["super-over innings"];
}

// ---------------------------------------------------------------------------
// Qualification (Trap D)
// ---------------------------------------------------------------------------

/**
 * The HAVING clause that stops a three-ball 600 strike rate topping a list.
 *
 * Applied by default, echoed in the response, and named in every tool description.
 * `entities_considered` vs `entities_qualified` is what lets an answer say "the best of
 * 38 bowlers who bowled 120 balls" instead of "the best".
 */
export class Qualifier {
  private constructor(
    readonly minBalls: number,
    readonly ballsColumn: "balls_faced" | "balls_bowled",
    readonly minInnings: number,
    readonly kind: "batting" | "bowling",
  ) {}

  static batting(minBallsFaced?: number | undefined, minInnings?: number | undefined): Qualifier {
    return new Qualifier(
      minBallsFaced ?? MIN_BALLS_FACED,
      "balls_faced",
      minInnings ?? MIN_INNINGS,
      "batting",
    );
  }

  static bowling(minBallsBowled?: number | undefined, minInnings?: number | undefined): Qualifier {
    return new Qualifier(
      minBallsBowled ?? MIN_BALLS_BOWLED,
      "balls_bowled",
      minInnings ?? MIN_INNINGS,
      "bowling",
    );
  }

  /**
   * Interpolated, not bound, and deliberately so: this lands in a HAVING inside a CTE
   * whose parameter positions are fixed by the filter compiler, and both values are
   * integers this class owns. `Math.trunc` is the guard that keeps that true.
   */
  get havingSql(): string {
    return `${this.ballsColumn} >= ${Math.trunc(this.minBalls)} AND innings >= ${Math.trunc(this.minInnings)}`;
  }

  toContract(considered: number, qualified: number): Qualification {
    const common = {
      min_innings: this.minInnings,
      entities_considered: considered,
      entities_qualified: qualified,
    };
    return this.kind === "batting"
      ? { ...common, min_balls_faced: this.minBalls, min_balls_bowled: null }
      : { ...common, min_balls_faced: null, min_balls_bowled: this.minBalls };
  }
}

// ---------------------------------------------------------------------------
// Relaxation hints -- an empty result is not an error
// ---------------------------------------------------------------------------

/**
 * Why the answer is empty, and which single filter to loosen.
 *
 * "No rows" with no explanation is the worst possible tool result: the model either
 * invents a reason or apologises vaguely. Each hint here names one filter and what
 * dropping it would do, computed by actually re-running the count without it.
 */
export async function relaxationHints(
  db: Db,
  compiled: CompiledFilters,
  qualifier?: Qualifier | undefined,
): Promise<string[]> {
  const hints: string[] = [];
  if (qualifier !== undefined) {
    hints.push(
      `the ${qualifier.kind} minimum of ${qualifier.minBalls} balls and ` +
        `${qualifier.minInnings} innings may have excluded everyone; pass a lower ` +
        `min_${qualifier.ballsColumn} if a small sample is acceptable, and say so ` +
        `in the answer`,
    );
  }

  for (const [index, clause] of compiled.where.entries()) {
    if (clause === "NOT d.is_super_over") {
      // Suggesting "include super overs" as a way to find more data would be advice to
      // make the answer wrong.
      continue;
    }
    const [where, params] = compiled.withoutClause(index);
    const result = await db.query(
      `SELECT count(*)::INTEGER AS n FROM deliveries d ${compiled.joinSql} WHERE ${where}`,
      params,
    );
    const matched = count(result, "n");
    if (matched > 0) {
      // The FIELD name, never the predicate: `d.match_date >= ?` is SQL, the model is
      // never shown SQL, and it cannot act on a clause it did not send. The locale is
      // pinned because a runtime default of `de-DE` would render 1234 as "1.234".
      hints.push(
        `dropping the filter \`${compiled.fieldFor(index)}\` would match ` +
          `${matched.toLocaleString("en-US")} deliveries`,
      );
    }
  }
  if (hints.length === 0) {
    hints.push(
      "no combination of these filters matches anything in the dataset; check " +
        "get_data_coverage before concluding the event did not happen",
    );
  }
  return hints.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Cricinfo links -- "verify the work"
// ---------------------------------------------------------------------------

/** Deep links for the players named in an answer, so a reader can check it. */
export async function cricinfoLinks(db: Db, playerIds: readonly string[]): Promise<CricinfoLink[]> {
  if (playerIds.length === 0) return [];
  const result = await db.query(
    `SELECT player_id, unique_name, key_cricinfo FROM players ` +
      `WHERE player_id IN (${placeholders(playerIds)}) AND key_cricinfo IS NOT NULL`,
    playerIds,
  );
  return result.rows.map((row) => ({
    player_id: String(row["player_id"]),
    name: String(row["unique_name"]),
    url: `https://www.espncricinfo.com/ci/content/player/${String(row["key_cricinfo"])}.html`,
  }));
}

// ---------------------------------------------------------------------------
// The tool spec
// ---------------------------------------------------------------------------

/** What a handler returns: the validated response plus what the UI needs. */
export interface ToolOutcome {
  response: ToolResponse;
  sql?: string;
  deliveriesScanned?: number;
}

/** A JSON Schema object, as Bedrock will receive it. */
export type JsonSchema = Record<string, unknown>;

export type ToolHandler = (db: Db, args: Record<string, unknown>) => Promise<ToolOutcome>;

/**
 * One tool, exactly as Bedrock will see it.
 *
 * `description` is not documentation, it is the prompt. It is the only place the model
 * is told when NOT to use this tool, what the enum values are, and that the
 * qualification minimums apply by default. `tools lint` enforces that contract,
 * because a description that drifts out of date is indistinguishable from a model that
 * has got worse.
 */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: ToolHandler;
  shape: "tiles" | "table" | "chart" | "unknown";
  /** Worked `input` examples. Two minimum; the linter asserts it. */
  examples: Record<string, unknown>[];
}

/** The exact `toolConfig.tools` element, `inputSchema.json` and all. */
export function bedrockSpec(spec: ToolSpec): JsonSchema {
  return {
    toolSpec: {
      name: spec.name,
      description: spec.description,
      inputSchema: { json: spec.inputSchema },
    },
  };
}
