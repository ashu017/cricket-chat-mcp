// Vitest, deliberately close to the default.
//
// The one thing worth configuring is the root: `include` is anchored at the package root so
// the fixture suites resolve `tests/fixtures/` the same way whether vitest was started from
// here or from an editor's own working directory. Everything else -- environment, globals,
// pool -- is the default on purpose, because a test runner is not the interesting part of
// this package and every setting here is a setting a reader has to check later.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
