/**
 * `src/core` -- the definitions and the filter compiler.
 *
 * Pure by construction: no database handle, no filesystem, no network. Everything
 * here is a constant, a SQL *string*, or a function over numbers. That is what lets
 * the parity suites evaluate a metric both ways and compare, and what keeps a unit
 * test of `is_four` from needing a warehouse.
 *
 * `definitions` is exported as a namespace as well as flat, because the parity tests
 * want to iterate the registries and the reader wants `definitions.MIN_BALLS_FACED` to
 * be the obvious way to reach a threshold.
 *
 * `argv` is the one thing here that is not about cricket. It is here because this is the
 * only package both CLIs can import -- see its own header -- and it is pure, so it does
 * not weaken the promise above.
 */

export * from "./argv.js";
export * as definitions from "./definitions.js";
export * from "./definitions.js";
export * from "./filters.js";
