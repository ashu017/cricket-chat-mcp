// The resolver, tested for the property that matters: the answer does not depend on cwd.
//
// This file exists because the absence of it cost 32 silently-skipped tests upstream. The
// warehouse default was `"data/cricket.duckdb"`, a relative path, and `vitest` runs with
// cwd set to the package directory rather than the repo root, so `existsSync` asked about
// a path that had never existed and the fixture conformance suite -- the gate that catches
// a metric going wrong -- skipped itself on a machine with the warehouse present. Nothing
// failed. A skip count is not read.
//
// The stakes are higher in a published package than they were in a workspace, because the
// cwd of an `npx`-spawned MCP server is whatever directory the user's client happened to
// be in. So the assertions below are about the *anchor*: the root is derived from this
// module's own URL, it names this package and not the consumer's, and it is the same
// answer whatever cwd says.

import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DB_ENV_VAR,
  DEFAULT_DB_RELATIVE,
  dbPath,
  defaultDbPath,
  fromPackageRoot,
  packageRoot,
} from "./warehouse.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("packageRoot", () => {
  it("finds the package root, not the directory this module sits in", () => {
    const root = packageRoot();
    expect(isAbsolute(root)).toBe(true);
    expect(existsSync(join(root, "package.json"))).toBe(true);
    // `src/` under `vitest`, `dist/` once built -- either way the root is two levels up
    // from this module and therefore not `src/core` itself.
    const here = fileURLToPath(new URL(".", import.meta.url));
    expect(relative(root, here).split(/[\\/]/).filter(Boolean)).toHaveLength(2);
  });

  it("does not answer with the current working directory", () => {
    // The bug, stated as a test. Asserting `root !== cwd` would be wrong when the two
    // legitimately coincide (running `vitest` from the package root), so assert the
    // invariant instead: the root is derived from this module's URL, so it is a prefix of
    // this module's path no matter where the process was started.
    const self = fileURLToPath(import.meta.url);
    expect(self.startsWith(packageRoot())).toBe(true);
  });

  it("is stable across calls, since it is cached", () => {
    expect(packageRoot()).toBe(packageRoot());
  });
});

describe("fromPackageRoot", () => {
  it("makes a package-relative path absolute", () => {
    expect(fromPackageRoot(DEFAULT_DB_RELATIVE)).toBe(join(packageRoot(), DEFAULT_DB_RELATIVE));
  });

  it("leaves an absolute path alone", () => {
    expect(fromPackageRoot("/tmp/elsewhere.duckdb")).toBe("/tmp/elsewhere.duckdb");
  });
});

describe("dbPath", () => {
  it("returns an absolute path when nothing is configured", () => {
    vi.stubEnv(DB_ENV_VAR, "");
    const resolved = dbPath();
    expect(isAbsolute(resolved)).toBe(true);
    expect(resolved).toBe(defaultDbPath());
  });

  it("points at the bundled warehouse by default", () => {
    // The whole distribution promise: `npx` and it works, no configuration. If this ever
    // resolves outside the package the tarball is not self-contained.
    vi.stubEnv(DB_ENV_VAR, "");
    expect(dbPath().startsWith(packageRoot())).toBe(true);
    expect(dbPath()).toBe(join(packageRoot(), "data", "cricket.duckdb"));
  });

  it("honours an absolute CRICKET_DB verbatim", () => {
    // How someone runs these tools over their own wider warehouse.
    vi.stubEnv(DB_ENV_VAR, "/var/tmp/other.duckdb");
    expect(dbPath()).toBe("/var/tmp/other.duckdb");
  });

  it("resolves a relative CRICKET_DB against the package root", () => {
    // Honouring a relative value verbatim would reintroduce exactly the cwd dependence
    // this module exists to remove, and under `npx` there is no cwd worth honouring.
    vi.stubEnv(DB_ENV_VAR, "data/sample.duckdb");
    expect(dbPath()).toBe(join(packageRoot(), "data/sample.duckdb"));
  });

  it("treats an unset and an empty variable the same", () => {
    vi.stubEnv(DB_ENV_VAR, undefined);
    const unset = dbPath();
    vi.stubEnv(DB_ENV_VAR, "");
    expect(dbPath()).toBe(unset);
  });
});
