// Where the warehouse is, resolved once for every module that needs it.
//
// ## Why this file exists at all
//
// `data/cricket.duckdb` used to be spelled twice -- in `tools/base.ts` and in the
// ingest -- and both spellings were *relative*. That is fine for a CLI run from the
// repo root, and wrong for everything else, because a relative path is resolved
// against the current working directory and nothing guarantees what that is. The
// concrete damage upstream: `vitest` runs with `cwd` set to the package directory, so
// `existsSync("data/cricket.duckdb")` asked about a path that had never existed, and
// the fixture conformance suite -- the one gate that catches a metric going wrong --
// silently skipped itself on a machine with the warehouse sitting right there.
//
// It matters more here than it did there. This package is installed by `npx` into a
// content-addressed cache directory, and the process that spawns it is an MCP client
// whose cwd is the user's project, their home directory, or `/`. There is no cwd worth
// resolving against. So the anchor is this module's own location, which travels with
// the warehouse because both are inside the published tarball.
//
// ## Why the anchor is exactly two levels up
//
// Built output is `dist/core/warehouse.js` and source is `src/core/warehouse.ts`.
// Both are two levels below the package root, so one expression is correct under
// `vitest`, under `tsc`-built `dist/`, and after `npm pack`. A `package.json`-walk
// would also work, but it can find the *consumer's* manifest when this package is
// nested oddly, and being wrong there means opening someone else's file.

import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The one variable that names the warehouse.
 *
 * Spelled once: an earlier implementation had the tool layer inventing its own name
 * for it while everything else used `CRICKET_DB`, so in a deployed runtime the
 * download landed on one path and every tool then looked at another and answered "the
 * warehouse is missing" -- after paying for the transfer.
 */
export const DB_ENV_VAR = "CRICKET_DB";

/** Package-relative, and never used as-is. Resolve it with {@link defaultDbPath}. */
export const DEFAULT_DB_RELATIVE = join("data", "cricket.duckdb");

/**
 * The root of this package, found from this module rather than from `process.cwd()`.
 *
 * Cached because it runs on every `dbPath()` call and cannot change inside a process.
 * Named `packageRoot` rather than `repoRoot` because that is what it is: the installed
 * package, which under `npx` is not a repository at all.
 */
let cachedRoot: string | undefined;

export function packageRoot(): string {
  if (cachedRoot === undefined) {
    cachedRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  }
  return cachedRoot;
}

/** A package-relative path made absolute. An already-absolute path is returned as-is. */
export function fromPackageRoot(relative: string): string {
  return isAbsolute(relative) ? relative : resolve(packageRoot(), relative);
}

/** Absolute path to the bundled warehouse, when nothing is configured. */
export function defaultDbPath(): string {
  return fromPackageRoot(DEFAULT_DB_RELATIVE);
}

/**
 * The warehouse this process should open.
 *
 * A configured `CRICKET_DB` wins. It is honoured verbatim when absolute; a *relative*
 * value is resolved against the package root, which is the only anchor an installed
 * copy has. Point it at a warehouse you built yourself to run these tools over a
 * wider dataset than the T20 one that ships here.
 */
export function dbPath(): string {
  const configured = process.env[DB_ENV_VAR];
  if (configured !== undefined && configured !== "") return fromPackageRoot(configured);
  return defaultDbPath();
}
