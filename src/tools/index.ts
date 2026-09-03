/**
 * `src/tools` -- the eight tools, over DuckDB.
 *
 * The runtime needs `specs()`/`toolConfig()` and `call()` from `registry.ts` and
 * nothing else; everything below that is re-exported for the tests and the CLI, which
 * want to reach a single query builder or one tool's description in isolation.
 */

export * as aggregate from "./aggregate.js";
export * from "./base.js";
export * as errors from "./errors.js";
export * as lint from "./lint.js";
export * from "./lookup.js";
export * from "./matchinfo.js";
export * from "./registry.js";
export * as schemas from "./schemas.js";
export { closeMatches, similarityRatio } from "./similarity.js";
export * from "./stats.js";
