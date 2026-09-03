// The gate on the gate.
//
// `fixtures.test.ts` and the other warehouse suites are wrapped in
// `describe.skipIf(!warehouseAvailable())`. In this package the warehouse *ships* -- it is
// in `data/` and in the published tarball -- so the skip should never fire, and if it does,
// something is wrong with the resolver rather than with the checkout. The failure mode
// worth guarding is exactly that: the skip fires on a machine that has the warehouse, and
// then 32 tests report as skipped and nobody reads a skip count.
//
// That happened upstream. `dbPath()` fell back to the relative `"data/cricket.duckdb"`,
// and vitest runs with cwd set to the package directory, so `existsSync` asked about a
// path that had never existed. The 24-fixture Python-parity suite, the one gate that can
// catch a ported metric going wrong, switched itself off and reported success.
//
// These tests are deliberately NOT skipped when the warehouse is absent. They are about
// the resolver, not the data, and a guard that skips under the same condition as the
// thing it guards is not a guard.

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageRoot } from "../core/warehouse.js";

import { DEFAULT_DB, dbPath } from "./base.js";
import { warehouseAvailable, warehouseSuiteName } from "./testing.js";

describe("the warehouse gate", () => {
  it("resolves the default absolutely, so vitest's cwd cannot decide the answer", () => {
    expect(isAbsolute(DEFAULT_DB)).toBe(true);
    expect(isAbsolute(dbPath())).toBe(true);
  });

  it("looks under the package root, not under the source directory", () => {
    // The precise shape of the bug: `src/tools/data/...` instead of `data/...`.
    expect(DEFAULT_DB).toBe(join(packageRoot(), "data", "cricket.duckdb"));
    expect(DEFAULT_DB).not.toContain(join("src", "tools"));
  });

  it("says the warehouse is available exactly when the file it names is there", () => {
    // Tautological against the implementation, and that is the point: it pins the
    // *contract* that the two cannot disagree, so a future `warehouseAvailable` that
    // consults some other path fails here rather than skipping a suite in silence.
    expect(warehouseAvailable()).toBe(existsSync(dbPath()));
  });

  it("names the path it looked at when it skips", () => {
    const name = warehouseSuiteName("recorded Python payloads");
    if (warehouseAvailable()) {
      expect(name).toBe("recorded Python payloads");
    } else {
      // Without the path in the string, "skipped" is a dead end for whoever reads it.
      expect(name).toContain("skipped");
      expect(name).toContain(dbPath());
    }
  });
});
