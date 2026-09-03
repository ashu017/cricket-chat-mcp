// Whether the suites that need real data can run.
//
// The warehouse is a 74 MB DuckDB file built from Cricsheet, and in *this* package it
// ships: it lives in `data/` and travels inside the published tarball, which is what makes
// `npx` work with no infrastructure. So these suites should run, not skip, and a skip here
// means the resolver is pointing somewhere wrong.
//
// The mechanism survives anyway, for two cases that are real: a clone that has not yet
// copied the warehouse in, and a `CRICKET_DB` pointed at a warehouse the reader built
// themselves and then moved. Skipped rather than failed, because the failure that means
// "you have no data" must stay distinguishable from the failure that means "you have
// broken a metric" -- and `warehouseSuiteName` prints the path so a skip is never a dead
// end.
//
// Not exported from `index.ts`: this is for the suites in this package, not for the
// runtime.

import { existsSync } from "node:fs";

import { dbPath } from "./base.js";

export function warehouseAvailable(): boolean {
  return existsSync(dbPath());
}

/**
 * Suite name that says why it was skipped, since `skipIf` carries no reason and a
 * silently skipped correctness suite is worse than no suite.
 */
export function warehouseSuiteName(name: string): string {
  return warehouseAvailable() ? name : `${name} (skipped: no warehouse at ${dbPath()})`;
}
