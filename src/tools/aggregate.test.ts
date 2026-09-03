// Dismissals are at their own grain, and this file is the reason that stays true.
//
// Three mistakes are available when counting a batter's dismissals, and each produces a
// plausible number rather than an error, which is why each gets an assertion here
// measured against the warehouse:
//
//   1. Counting dismissals in the tier-1 aggregate over `deliveries`. Every ball that
//      carried two wickets would double the runs on it.
//   2. Joining `wickets` to `deliveries` without `ball_in_over`. That is an over-grain
//      join: it matches every ball of the over, and in this warehouse it turns 85,792
//      dismissals into 534,066 -- a 6.2x inflation that lands on the *denominator* of
//      every batting average, so the leaderboard is not obviously wrong, just wrong.
//   3. Keying the dismissal on `d.batter_id` instead of `w.player_out_id`. 4,123 of the
//      85,792 dismissals here -- 4.8%, almost all run outs -- are of the player at the
//      non-striker's end, so this does not undercount, it credits the dismissal to the
//      wrong batter and takes it away from the right one.
//
// The first two are checked structurally, which needs no data. The third and the
// arithmetic need the warehouse and are skipped without it.

import { describe, expect, it } from "vitest";
import {
  BATTING_BASE_SQL,
  DISMISSAL_PREDICATE,
  DISMISSED_BATTER_KEY,
  WICKETS_BALL_JOIN,
} from "../core/index.js";

import * as aggregate from "./aggregate.js";
import { connect } from "./base.js";
import { call } from "./registry.js";
import { warehouseAvailable, warehouseSuiteName } from "./testing.js";

describe("the dismissal grain", () => {
  it("keeps dismissals out of the tier-1 batting registry", () => {
    expect(Object.keys(BATTING_BASE_SQL)).not.toContain("dismissals");
    // It is still orderable and still a column, just from the other aggregate.
    expect(aggregate.metricsFor("batting")).toContain("dismissals");
  });

  it("joins wickets on all four key parts", () => {
    for (const part of ["match_id", "innings_no", "over_number", "ball_in_over"]) {
      expect(WICKETS_BALL_JOIN, `the join drops ${part}`).toContain(`w.${part} = d.${part}`);
    }
  });

  it("keys the dismissal on the player who was out, not the striker", () => {
    expect(DISMISSED_BATTER_KEY).toBe("w.player_out_id");
    // A retirement ends an innings without costing a wicket; `counts_as_out` is the
    // column that knows, and without the predicate a retired-hurt consumes an average.
    expect(DISMISSAL_PREDICATE).toBe("w.counts_as_out");
  });

  it("groups a batting query by the dismissed player, not the striker", () => {
    const player = aggregate.BATTING_DIMS["player"];
    expect(player?.expr).toBe("d.batter_id");
    expect(aggregate.dismissalsExpr(player as aggregate.GroupDim)).toBe(DISMISSED_BATTER_KEY);
    // Every other dimension is a property of the ball, so it is the same expression in
    // both aggregates and must not carry an override.
    // Widened to `GroupDim` deliberately: the literal type of the `venue` entry has no
    // `outsExpr` at all, and "the property is absent from the type" is a weaker claim than
    // "the value is undefined at runtime", which is what this asserts.
    const venue: aggregate.GroupDim | undefined = aggregate.BATTING_DIMS["venue"];
    expect(venue?.outsExpr).toBeUndefined();
  });
});

describe.skipIf(!warehouseAvailable())(
  warehouseSuiteName("dismissals against the warehouse"),
  () => {
    it("agrees with a direct count over wickets", async () => {
      const result = await call("query_batting_aggregate", {
        filters: { format: ["T20"] },
        min_balls_faced: 0,
        min_innings: 0,
      });
      const row = result.response?.rows[0];
      expect(row).toBeDefined();

      const db = await connect();
      try {
        const direct = await db.query(
          `SELECT count(*)::INTEGER AS n
         FROM deliveries d
         ${WICKETS_BALL_JOIN}
         JOIN matches m ON m.match_id = d.match_id
         -- The tool excludes super overs unless asked; without this the direct count
         -- is 31 higher, which is exactly the point of the default.
         WHERE m.format = 'T20' AND NOT d.is_super_over AND ${DISMISSAL_PREDICATE}`,
        );
        expect(row?.["dismissals"]).toBe(direct.rows[0]?.["n"]);
      } finally {
        db.close();
      }
    });

    it("counts super-over dismissals only when asked", async () => {
      const totals = async (includeSuperOver: boolean): Promise<number> => {
        const result = await call("query_batting_aggregate", {
          filters: { format: ["T20"], ...(includeSuperOver ? { include_super_over: true } : {}) },
          min_balls_faced: 0,
          min_innings: 0,
        });
        return Number(result.response?.rows[0]?.["dismissals"]);
      };
      // A super over decides a tied match and counts toward no career statistic, so the
      // default must exclude it -- and opting in must actually change the answer, or the
      // flag is decoration.
      expect(await totals(true)).toBeGreaterThan(await totals(false));
    });

    it("the over-grain join really does inflate by about six", async () => {
      // Pinned so that if someone "simplifies" the join, the reason not to is measured
      // rather than asserted in a comment.
      const db = await connect();
      try {
        const exact = await db.query(
          `SELECT count(*)::INTEGER AS n FROM deliveries d ${WICKETS_BALL_JOIN}`,
        );
        const overGrain = await db.query(
          `SELECT count(*)::INTEGER AS n FROM deliveries d
         JOIN wickets w ON w.match_id = d.match_id AND w.innings_no = d.innings_no
              AND w.over_number = d.over_number`,
        );
        const ratio = Number(overGrain.rows[0]?.["n"]) / Number(exact.rows[0]?.["n"]);
        expect(ratio).toBeGreaterThan(5);
      } finally {
        db.close();
      }
    });

    it("a meaningful share of dismissals are of the non-striker", async () => {
      // If this ever reads zero, the `player_out_id` key has stopped being loaded and the
      // other two assertions above would pass while meaning nothing.
      const db = await connect();
      try {
        const result = await db.query(
          `SELECT count(*)::INTEGER AS n
         FROM deliveries d ${WICKETS_BALL_JOIN}
         WHERE w.player_out_id <> d.batter_id`,
        );
        expect(Number(result.rows[0]?.["n"])).toBeGreaterThan(1000);
      } finally {
        db.close();
      }
    });
  },
);
