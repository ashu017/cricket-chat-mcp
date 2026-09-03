/**
 * The shared flag reader.
 *
 * One test because there is one copy. Both CLIs bind their own `VALUE_FLAGS` to it, so the
 * cases below are written in terms of the two real bindings -- the tool CLI's positional
 * JSON blob and the ingest CLI's `--sample N` -- rather than abstractly.
 */

import { describe, expect, it } from "vitest";

import { intFlag, split, stringFlag, UsageError, unknownFlags } from "./argv.js";

const TOOL_FLAGS = new Set(["save-fixture", "name"]);
const INGEST_FLAGS = new Set(["formats", "db", "sample", "batch-size"]);

describe("split", () => {
  it("does not let a valueless flag swallow the token after it", () => {
    // The reason `valueFlags` is a parameter. `--compact` takes nothing, so a splitter that
    // always consumed the next token would eat the tool input and the failure would read as
    // malformed JSON rather than as a parser bug.
    const { positional, flags } = split(
      ["resolve_entity", "--compact", '{"query":"Kohli"}'],
      TOOL_FLAGS,
    );
    expect(positional).toEqual(["resolve_entity", '{"query":"Kohli"}']);
    expect(flags.get("compact")).toBe(true);
  });

  it("consumes the token after a value flag", () => {
    // And the mirror case: `--sample 400` must not leave `400` as a positional nothing
    // reads, which is what a splitter with no notion of value flags would do.
    const { positional, flags } = split(["--sample", "400"], INGEST_FLAGS);
    expect(positional).toEqual([]);
    expect(flags.get("sample")).toBe("400");
  });

  it("reads a value flag both ways round", () => {
    expect(split(["--save-fixture", "x"], TOOL_FLAGS).flags.get("save-fixture")).toBe("x");
    expect(split(["--save-fixture=x"], TOOL_FLAGS).flags.get("save-fixture")).toBe("x");
  });

  it("accepts --name=value even for a flag that takes no value", () => {
    // The spelling a reader reaches for when a value starts with a dash.
    expect(split(["--db=-"], INGEST_FLAGS).flags.get("db")).toBe("-");
    expect(split(["--compact=false"], TOOL_FLAGS).flags.get("compact")).toBe("false");
  });

  it("does not consume a following flag as a value", () => {
    const { flags } = split(["--name", "--json"], TOOL_FLAGS);
    expect(flags.get("name")).toBe(true);
    expect(flags.get("json")).toBe(true);
  });
});

describe("stringFlag", () => {
  it("is null when absent and a usage error when given without a value", () => {
    expect(stringFlag(split([], INGEST_FLAGS).flags, "db")).toBeNull();
    expect(stringFlag(split(["--db", "x"], INGEST_FLAGS).flags, "db")).toBe("x");
    expect(() => stringFlag(split(["--db", "--rebuild"], INGEST_FLAGS).flags, "db")).toThrow(
      UsageError,
    );
  });
});

describe("intFlag", () => {
  it("parses an integer and refuses anything else", () => {
    expect(intFlag(split([], INGEST_FLAGS).flags, "sample")).toBeNull();
    expect(intFlag(split(["--sample", "400"], INGEST_FLAGS).flags, "sample")).toBe(400);
    // `NaN` reaching `build()` would turn `--sample notanumber` into a full ingest, which
    // is a half-hour command that looks like it was asked for.
    for (const bad of ["notanumber", "4.5", "400x", ""]) {
      expect(() => intFlag(split([`--sample=${bad}`], INGEST_FLAGS).flags, "sample")).toThrow(
        /needs an integer/,
      );
    }
  });
});

describe("unknownFlags", () => {
  it("names what was not recognised, sorted, and nothing when all are", () => {
    const { flags } = split(["--sampl", "400", "--formats", "t20", "--dbb", "x"], INGEST_FLAGS);
    // `--sampl` did not consume `400`, so `400` is a positional -- which is why an
    // unrecognised flag has to be an error rather than something to ignore.
    expect(unknownFlags(flags, INGEST_FLAGS)).toEqual(["dbb", "sampl"]);
    expect(unknownFlags(split(["--formats", "t20"], INGEST_FLAGS).flags, INGEST_FLAGS)).toEqual([]);
  });
});
