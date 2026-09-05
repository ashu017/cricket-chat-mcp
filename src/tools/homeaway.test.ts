// The curated home/away dimension, measured against the warehouse.
//
// `src/core/filters.test.ts` proves the clauses and joins compile as intended. That is a
// claim about SQL text; the claims that can only be settled with data are the two that
// would make an answer wrong rather than absent:
//
//   1. **The join must not duplicate.** `match_home_away` is one row per (match, team) and
//      the join predicate uses both columns, so it can match at most once per delivery. If
//      that grain ever slips, every run and wicket in a home/away split doubles -- and the
//      numbers stay plausible, which is exactly why it needs a measurement rather than a
//      comment. The check: the three buckets must sum to the ungrouped total.
//   2. **`unknown` must be a value, not an exclusion.** The join is LEFT and the expression
//      is a `coalesce`, so a delivery from a competition the table does not cover is
//      explicitly unknown. An inner join would silently drop every non-IPL ball the moment
//      anything asked about home/away, and the result would look like a complete answer.
//
// And one definitional claim, which is the user's stated rule: a ground nobody owned that
// season is `neutral`, not `away`. If the neutral bucket is ever empty, that distinction has
// collapsed and every away figure here has quietly absorbed the UAE and South Africa seasons.

import { describe, expect, it } from "vitest";

import * as aggregate from "./aggregate.js";
import { connect } from "./base.js";
import { call } from "./registry.js";
import { warehouseAvailable, warehouseSuiteName } from "./testing.js";

const IPL = "Indian Premier League";

describe("the home_away dimension", () => {
  it("resolves to the grain's own side under one shared name", () => {
    // Same name in both maps, each pointing at its own alias -- the arrangement `team` and
    // `opposition` already use. A single shared expression would answer the batting
    // question on a bowling query.
    const batting = aggregate.BATTING_DIMS["home_away"];
    const bowling = aggregate.BOWLING_DIMS["home_away"];
    expect(batting?.alias).toBe("home_away");
    expect(bowling?.alias).toBe("home_away");
    expect(batting?.expr).toContain("ha_bat.");
    expect(bowling?.expr).toContain("ha_bowl.");
    expect(batting?.requiresJoin).toBe("batting_home_away");
    expect(bowling?.requiresJoin).toBe("bowling_home_away");
  });

  it("carries the IPL-only caveat where the response will surface it", () => {
    // `notesFor()` reads `note` for every dimension used, and that is the only channel
    // this caveat has. Without it a model can group by home_away over all T20 cricket and
    // report an `unknown` bucket as if it were a finding.
    for (const dim of [aggregate.BATTING_DIMS["home_away"], aggregate.BOWLING_DIMS["home_away"]]) {
      expect(dim?.note).toContain("IPL only");
      expect(dim?.note).toContain("neutral");
    }
  });
});

describe.skipIf(!warehouseAvailable())(
  warehouseSuiteName("home/away against the warehouse"),
  () => {
    /** Every IPL delivery, split by whose ground it was. */
    const split = async (): Promise<Record<string, number>> => {
      const result = await call("query_batting_aggregate", {
        filters: { competition: [IPL] },
        group_by: ["home_away"],
        order_by: "runs",
        min_balls_faced: 0,
        min_innings: 0,
        limit: 10,
      });
      const out: Record<string, number> = {};
      for (const row of result.response?.rows ?? []) {
        out[String(row["home_away"])] = Number(row["runs"]);
      }
      return out;
    };

    it("splits the IPL without inventing or losing a single run", async () => {
      const buckets = await split();
      const total = await call("query_batting_aggregate", {
        filters: { competition: [IPL] },
        min_balls_faced: 0,
        min_innings: 0,
      });
      const summed = Object.values(buckets).reduce((a, b) => a + b, 0);
      // The non-duplication check. A join matching twice would make this exactly double.
      expect(summed).toBe(Number(total.response?.rows[0]?.["runs"]));
    });

    it("keeps neutral as its own answer, distinct from away", async () => {
      const buckets = await split();
      expect(Object.keys(buckets).sort()).toEqual(["away", "home", "neutral"]);
      for (const [bucket, runs] of Object.entries(buckets)) {
        expect(runs, `${bucket} is empty`).toBeGreaterThan(0);
      }
      // Curated for every IPL delivery, so nothing here may fall through to 'unknown'. The
      // build script refuses to write with any (season, venue) pair unresolved, and this is
      // that guarantee restated at the other end of the pipeline.
      expect(buckets["unknown"]).toBeUndefined();
    });

    it("reads every non-IPL delivery as unknown rather than dropping it", async () => {
      const filters = { format: ["IT20" as const] };
      const shared = { min_balls_faced: 0, min_innings: 0 } as const;
      const all = await call("query_batting_aggregate", { filters, ...shared });
      const unknown = await call("query_batting_aggregate", {
        filters: { ...filters, batting_home_away: "unknown" },
        ...shared,
      });
      // No international T20 is in the curated table, so filtering for `unknown` must be a
      // no-op there -- and asking for `away` must return nothing at all rather than a
      // partial figure that reads as complete.
      expect(Number(unknown.response?.rows[0]?.["runs"])).toBe(
        Number(all.response?.rows[0]?.["runs"]),
      );
      const away = await call("query_batting_aggregate", {
        filters: { ...filters, batting_home_away: "away" },
        ...shared,
      });
      expect(Number(away.response?.rows[0]?.["balls_faced"] ?? 0)).toBe(0);
    });

    it("agrees with a direct join to the curated table", async () => {
      const buckets = await split();
      const db = await connect();
      try {
        const direct = await db.query(
          `SELECT ha.home_away AS home_away, sum(d.runs_batter)::INTEGER AS runs
         FROM deliveries d
         JOIN match_home_away ha
           ON ha.match_id = d.match_id AND ha.team = d.batting_team
         WHERE d.competition = ? AND NOT d.is_super_over
         GROUP BY ha.home_away`,
          [IPL],
        );
        for (const row of direct.rows) {
          expect(buckets[String(row["home_away"])]).toBe(Number(row["runs"]));
        }
      } finally {
        db.close();
      }
    });

    it("asks the question of the fielding side too", async () => {
      // The pair exists so a batting query can ask about the *other* side: "at home against
      // a touring team" needs bowling_home_away on a batting grain. If the two fields
      // compiled to the same join alias this would equal the batting split instead.
      const result = await call("query_batting_aggregate", {
        filters: { competition: [IPL], bowling_home_away: "away" },
        min_balls_faced: 0,
        min_innings: 0,
      });
      const batterAway = await call("query_batting_aggregate", {
        filters: { competition: [IPL], batting_home_away: "away" },
        min_balls_faced: 0,
        min_innings: 0,
      });
      const bowlingAwayRuns = Number(result.response?.rows[0]?.["runs"]);
      expect(bowlingAwayRuns).toBeGreaterThan(0);
      expect(bowlingAwayRuns).not.toBe(Number(batterAway.response?.rows[0]?.["runs"]));
    });
  },
);
