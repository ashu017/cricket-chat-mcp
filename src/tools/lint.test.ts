// The description contract, enforced on every tool, and the linter enforced on itself.
//
// `lint.ts` is only worth having if it is run, and the only way to guarantee it is run
// is to make a violation a failing test rather than a command someone remembers. The
// second half of this file checks the linter still detects the things it claims to --
// a linter that has quietly stopped finding anything passes just as green as one that
// has nothing to find.
//
// Needs no warehouse: descriptions and schemas are static.

import { describe, expect, it } from "vitest";

import type { ToolSpec } from "./base.js";
import { check, checkAll, formatFinding, MIN_DESCRIPTION_CHARS, MIN_EXAMPLES } from "./lint.js";
import { names, spec, specs } from "./registry.js";

describe("tool descriptions", () => {
  it("all eight satisfy every rule", () => {
    expect(checkAll().map(formatFinding)).toEqual([]);
  });

  it("registers the eight tools, in the order the model sees them", () => {
    expect(names()).toEqual([
      "resolve_entity",
      "get_data_coverage",
      "query_batting_aggregate",
      "query_bowling_aggregate",
      "query_matchup",
      "get_scorecard",
      "query_matches",
      "get_career_reference",
    ]);
  });

  it("each carries its worked examples and the negative half of the contract", () => {
    for (const one of specs()) {
      expect(one.examples.length, one.name).toBeGreaterThanOrEqual(MIN_EXAMPLES);
      expect(one.description.length, one.name).toBeGreaterThanOrEqual(MIN_DESCRIPTION_CHARS);
      expect(one.description, one.name).toContain("DO NOT use this tool for:");
    }
  });

  it("names the qualification minimums wherever they are applied by default", () => {
    // Trap D: an unqualified leaderboard reads as a fact. The model can only warn about
    // the minimum if the description told it there is one.
    for (const name of ["query_batting_aggregate", "query_matchup"]) {
      expect(spec(name)?.description, name).toContain("min_balls_faced");
    }
    expect(spec("query_bowling_aggregate")?.description).toContain("min_balls_bowled");
  });
});

/** A spec that passes, to be broken one rule at a time. */
function healthy(): ToolSpec {
  const original = spec("get_scorecard");
  if (original === undefined) throw new Error("get_scorecard is not registered");
  return { ...original };
}

function rules(spec: ToolSpec): string[] {
  return check(spec, names()).map((finding) => finding.rule);
}

describe("the linter itself", () => {
  it("passes the spec it was handed unmodified", () => {
    expect(rules(healthy())).toEqual([]);
  });

  it("catches a description that has stopped saying when not to call the tool", () => {
    const broken = { ...healthy(), description: "One match, in scorecard form." };
    expect(rules(broken)).toContain("description too short");
    expect(rules(broken)).toContain("no negative guidance");
  });

  it("catches negative guidance that names no alternative tool", () => {
    const description = `${"x".repeat(MIN_DESCRIPTION_CHARS)}\n\nDO NOT use this tool for: anything else.`;
    expect(rules({ ...healthy(), description })).toContain(
      "negative guidance names no alternative",
    );
  });

  it("catches an example that has drifted from the schema", () => {
    const stale = { ...healthy(), examples: [{ match_id: "1415755", card: "fielding" }, {}] };
    const found = check(stale, names());
    expect(found.map((one) => one.rule)).toContain("example 1 does not match the schema");
    expect(found.map((one) => one.detail)).toContain(
      'card="fielding" is not in [innings, batting, bowling]',
    );
    // The empty second example is missing the required field, which is the other way an
    // example rots -- a field was made required after the example was written.
    expect(found.map((one) => one.detail)).toContain("missing required field match_id");
  });

  it("catches an enum whose values are not spelled out", () => {
    // The field is named, so every value must be listed: naming `phase` and listing
    // two of its three values is what produces phase="slog overs".
    const base = healthy();
    const broken = {
      ...base,
      description: `${base.description}\n\nphase values: powerplay, middle.`,
      inputSchema: {
        type: "object",
        properties: {
          match_id: { type: "string" },
          phase: { type: "string", enum: ["powerplay", "middle", "death"] },
        },
        required: ["match_id"],
      },
      examples: [{ match_id: "1415755" }, { match_id: "1415755", phase: "powerplay" }],
    };
    const found = check(broken, names());
    expect(found.map((one) => one.rule)).toContain(
      "enum values missing from the description (phase)",
    );
    expect(found.map((one) => one.detail).join(" ")).toContain("death");
  });

  it("catches a bare string field that is not on the free-text allowlist", () => {
    const inputSchema = {
      type: "object",
      properties: { fielder: { type: "string" } },
      required: [],
    };
    const broken = { ...healthy(), inputSchema, examples: [{}, {}] };
    expect(rules(broken)).toContain("bare string field");
  });
});
