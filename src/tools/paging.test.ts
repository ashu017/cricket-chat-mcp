// Paging, and the one thing about it that fails silently.
//
// `limit` caps a page at 200 rows. Before `offset` existed, rank 201 was unreachable: the
// response said 1,400 batters qualified and gave no way to see any of them past the first
// 200. That part is a missing feature, and a missing feature announces itself.
//
// The part that does not announce itself is a page past the end. `row_count_total` comes
// from `count(*) OVER ()`, which SQL evaluates only on rows the query actually returns --
// so an over-shot page comes back with no rows AND a total of zero, which is
// indistinguishable from a filter that excluded everything. "No batter qualified" when
// 140 did, because the caller asked for rank 300, is the invisible-wrongness failure this
// project exists to avoid, so both paged tools re-ask for one row from the top to recover
// the real total, and say where the last reachable page starts.

import { describe, expect, it } from "vitest";

import { call } from "./registry.js";
import { warehouseAvailable, warehouseSuiteName } from "./testing.js";

/** Small enough that three pages are cheap, big enough that a page is not one row. */
const PAGE = 5;

const LEADERBOARD = {
  filters: { format: ["IT20"] },
  group_by: ["player"],
  order_by: "runs",
  limit: PAGE,
  min_balls_faced: 0,
  min_innings: 0,
} as const;

describe.skipIf(!warehouseAvailable())(warehouseSuiteName("paging"), () => {
  it("returns the next page, with nothing repeated", async () => {
    const first = await call("query_batting_aggregate", { ...LEADERBOARD, offset: 0 });
    const second = await call("query_batting_aggregate", { ...LEADERBOARD, offset: PAGE });

    const ids = (result: typeof first): string[] =>
      (result.response?.rows ?? []).map((row) => String(row["batter_id"]));
    const firstIds = ids(first);
    const secondIds = ids(second);
    expect(firstIds).toHaveLength(PAGE);
    expect(secondIds).toHaveLength(PAGE);
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);

    // The population did not change, so the total must not either. A total computed over
    // the page rather than the qualifying set would fall to PAGE on both.
    expect(second.response?.row_count_total).toBe(first.response?.row_count_total);
    expect(Number(first.response?.row_count_total)).toBeGreaterThan(2 * PAGE);

    // ...and the ordering is global, not per page: page two must be no better than the
    // worst row of page one.
    const worstOnFirst = Number(first.response?.rows.at(-1)?.["runs"]);
    const bestOnSecond = Number(second.response?.rows[0]?.["runs"]);
    expect(bestOnSecond).toBeLessThanOrEqual(worstOnFirst);
  });

  it("names the real total when the page is past the end", async () => {
    const sized = await call("query_batting_aggregate", { ...LEADERBOARD, offset: 0 });
    const qualified = Number(sized.response?.row_count_total);

    const past = await call("query_batting_aggregate", {
      ...LEADERBOARD,
      offset: qualified + PAGE,
    });
    expect(past.response?.rows).toEqual([]);
    // The assertion that matters: not zero.
    expect(past.response?.row_count_total).toBe(qualified);
    const hints = past.response?.relaxation_hints ?? [];
    expect(hints.join(" ")).toContain(String(qualified));
    // The hint has to be actionable, which means naming a page that exists.
    expect(hints.join(" ")).toContain(`offset=${qualified - PAGE}`);
  });

  it("does not mistake an over-shot page for an over-restrictive filter", async () => {
    // The same empty result reached the other way: a filter nothing satisfies. This one
    // should get relaxation hints about the filters, and must NOT claim rows qualified.
    const empty = await call("query_batting_aggregate", {
      filters: { format: ["IT20"], date_from: "2030-01-01" },
      group_by: ["player"],
      order_by: "runs",
      limit: PAGE,
    });
    expect(empty.response?.rows).toEqual([]);
    expect(empty.response?.row_count_total).toBe(0);
    expect((empty.response?.relaxation_hints ?? []).join(" ")).not.toContain("past the end");
  });

  it("pages the bowling leaderboard on the same terms", async () => {
    // Both aggregates share `aggregate.build`, so this is a seam check rather than a
    // separate property: an offset applied to one grain and not the other would be a
    // silently truncated bowling list.
    const shared = {
      filters: { format: ["IT20"] },
      group_by: ["player"],
      order_by: "wickets",
      limit: PAGE,
      min_balls_bowled: 0,
      min_innings: 0,
    } as const;
    const first = await call("query_bowling_aggregate", { ...shared, offset: 0 });
    const second = await call("query_bowling_aggregate", { ...shared, offset: PAGE });
    const ids = (rows: readonly Record<string, unknown>[]): string[] =>
      rows.map((row) => String(row["bowler_id"]));
    const firstIds = ids(first.response?.rows ?? []);
    const secondIds = ids(second.response?.rows ?? []);
    expect(firstIds).toHaveLength(PAGE);
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
    expect(second.response?.row_count_total).toBe(first.response?.row_count_total);
  });

  it("pages the match list too", async () => {
    // query_matches counts its total with the same window function and had the same
    // unreachable tail: 200 matches was the whole of history as far as a caller could see.
    const shared = { filters: { format: ["IT20"] }, limit: PAGE } as const;
    const first = await call("query_matches", { ...shared, offset: 0 });
    const second = await call("query_matches", { ...shared, offset: PAGE });

    const ids = (rows: readonly Record<string, unknown>[]): string[] =>
      rows.map((row) => String(row["match_id"]));
    const firstIds = ids(first.response?.rows ?? []);
    const secondIds = ids(second.response?.rows ?? []);
    expect(firstIds).toHaveLength(PAGE);
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
    expect(second.response?.row_count_total).toBe(first.response?.row_count_total);

    const total = Number(first.response?.row_count_total);
    const past = await call("query_matches", { ...shared, offset: total + PAGE });
    expect(past.response?.rows).toEqual([]);
    expect(past.response?.row_count_total).toBe(total);
    expect((past.response?.relaxation_hints ?? []).join(" ")).toContain(String(total));
  });

  it("rejects a negative offset rather than treating it as zero", async () => {
    for (const tool of ["query_batting_aggregate", "query_matches"]) {
      const result = await call(tool, { filters: { format: ["IT20"] }, offset: -1 });
      expect(result.payload, tool).toHaveProperty("error");
    }
  });
});
