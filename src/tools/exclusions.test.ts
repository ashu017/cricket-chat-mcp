// Exclusion filters, measured against the warehouse.
//
// `src/core/filters.test.ts` proves the `not_in` ops compile to the null-safe spelling.
// That is a claim about SQL text, and the reason the spelling matters is a claim about
// data: how many rows a plain `NOT IN` would silently drop. Only the warehouse can
// answer that, and `connect()` lives here rather than in `core/`, so the measurement
// does too.
//
// The failure being pinned is not an error. `WHERE col NOT IN (...)` with a NULL `col`
// evaluates to NULL, a WHERE keeps only TRUE, and the query succeeds with fewer rows and
// no indication that anything was discarded. "T20 internationals outside the World Cup"
// would quietly exclude every bilateral the source never labelled -- the exact matches the
// question was asking for.

import { describe, expect, it } from "vitest";

import { connect } from "./base.js";
import { call } from "./registry.js";
import { warehouseAvailable, warehouseSuiteName } from "./testing.js";

/** The one competition excluded throughout, so the naive and null-safe counts differ by
 *  the unlabelled rows alone. */
const WORLD_CUP = "ICC Men's T20 World Cup";

describe.skipIf(!warehouseAvailable())(warehouseSuiteName("exclusion filters"), () => {
  it("keeps the matches the source never labelled", async () => {
    const result = await call("query_matches", {
      filters: { format: ["IT20"], competition_not: [WORLD_CUP] },
      limit: 1,
    });
    const reported = result.response?.row_count_total;

    const db = await connect();
    try {
      // The same population three ways: unfiltered, excluded null-safely, and excluded
      // the way that looks right and is not.
      const counts = await db.query(
        `SELECT
           count(DISTINCT d.match_id) FILTER (
             WHERE d.competition IS NULL OR d.competition NOT IN (?)
           )::INTEGER AS null_safe,
           count(DISTINCT d.match_id) FILTER (WHERE d.competition NOT IN (?))::INTEGER AS naive,
           count(DISTINCT d.match_id) FILTER (WHERE d.competition IS NULL)::INTEGER AS unlabelled
         FROM deliveries d
         WHERE d.format = 'IT20' AND NOT d.is_super_over`,
        [WORLD_CUP, WORLD_CUP],
      );
      const row = counts.rows[0];
      const nullSafe = Number(row?.["null_safe"]);
      const naive = Number(row?.["naive"]);
      const unlabelled = Number(row?.["unlabelled"]);

      // The measurement that makes the test worth having: if this is ever zero, the two
      // spellings agree and the assertion below proves nothing.
      expect(unlabelled).toBeGreaterThan(0);
      expect(nullSafe - naive).toBe(unlabelled);
      expect(reported).toBe(nullSafe);
    } finally {
      db.close();
    }
  });

  it("excludes what it says it excludes", async () => {
    // The other half: null-safety must not have widened the filter into a no-op.
    const result = await call("query_matches", {
      filters: { format: ["IT20"], competition_not: [WORLD_CUP] },
      limit: 200,
    });
    const competitions = (result.response?.rows ?? []).map((row) => row["competition"]);
    expect(competitions).not.toContain(WORLD_CUP);

    const withIt = await call("query_matches", {
      filters: { format: ["IT20"] },
      limit: 1,
    });
    // And it must actually remove something, or the excluded value was never present.
    expect(result.response?.row_count_total).toBeLessThan(Number(withIt.response?.row_count_total));
  });

  it("refuses a filter that contradicts its own exclusion", async () => {
    // `competition: [X]` with `competition_not: [X]` matches nothing by construction, and
    // zero rows with no explanation is the worst answer available. The contract catches it
    // before any SQL runs.
    const result = await call("query_matches", {
      filters: { format: ["IT20"], competition: [WORLD_CUP], competition_not: [WORLD_CUP] },
    });
    expect(result.payload).toHaveProperty("error");
    const error = (result.payload as { error: Record<string, unknown> }).error;
    expect(String(error["message"])).toContain(WORLD_CUP);
  });
});
