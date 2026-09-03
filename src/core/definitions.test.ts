// Trap C and Trap D, unit-tested. No warehouse, no network -- every case here is a
// definitional claim about cricket that a future refactor could silently reverse.
//
// Ported case-for-case from `tests/test_definitions.py`, which is the oracle.

import { describe, expect, it } from "vitest";
import * as contracts from "../contracts/index.js";

import * as definitions from "./definitions.js";
import {
  BATTING_BASE_SQL,
  BATTING_DERIVED_SQL,
  BOWLER_CREDITED_KINDS,
  BOWLING_BASE_SQL,
  BOWLING_DERIVED_SQL,
  battingAverage,
  battingStrikeRate,
  bowlingAverage,
  bowlingEconomy,
  bowlingStrikeRate,
  countsAsDismissalForBattingAverage,
  countsForOver,
  DERIVED_METRIC_EQUIVALENTS,
  declaredPowerplayOvers,
  isBallFaced,
  isBoundary,
  isBowlerCredited,
  isDotBall,
  isDotBatter,
  isFour,
  isSix,
  metricDefinition,
  NON_BOWLER_KINDS,
  type Phase,
  type PhaseSource,
  percentage,
  phaseForBall,
  runsConcededBowler,
  UnknownDismissalKind,
} from "./definitions.js";

// ---------------------------------------------------------------------------
// The four thresholds are re-exported, not restated
// ---------------------------------------------------------------------------

describe("threshold re-exports", () => {
  // The one test that keeps the inverted dependency honest. `contracts/thresholds.ts`
  // owns these four values because the contract layer needs them and may not depend
  // on core; `definitions.ts` re-exports them so "definitions is the one place you
  // look up a definition" still holds. If anybody ever pastes a second copy of a
  // number into core, this fails.
  it("is the same object as the contract's, value for value", () => {
    expect(definitions.MIN_BALLS_FACED).toBe(contracts.MIN_BALLS_FACED);
    expect(definitions.MIN_BALLS_BOWLED).toBe(contracts.MIN_BALLS_BOWLED);
    expect(definitions.MIN_INNINGS).toBe(contracts.MIN_INNINGS);
    expect(definitions.UNLIMITED_OVERS_FORMATS).toBe(contracts.UNLIMITED_OVERS_FORMATS);
  });

  it("keeps the Trap D minimums high enough to be worth having", () => {
    expect(definitions.MIN_BALLS_FACED).toBeGreaterThanOrEqual(60);
    expect(definitions.MIN_BALLS_BOWLED).toBeGreaterThanOrEqual(120);
  });
});

// ---------------------------------------------------------------------------
// Trap C: the two legal-ball denominators
// ---------------------------------------------------------------------------

describe("the two legal-ball denominators", () => {
  // wides, noballs, countsForOver, isBallFaced -- a no-ball is faced but is not in the
  // over, which is the whole reason these are two functions.
  const cases: ReadonlyArray<[number, number, boolean, boolean]> = [
    [0, 0, true, true],
    [1, 0, false, false],
    [0, 1, false, true],
    [1, 1, false, false],
    [2, 0, false, false],
  ];

  it.each(cases)(
    "wides=%i noballs=%i -> countsForOver=%s isBallFaced=%s",
    (wides, noballs, over, faced) => {
      expect(countsForOver(wides, noballs)).toBe(over);
      expect(isBallFaced(wides)).toBe(faced);
    },
  );
});

describe("runsConcededBowler", () => {
  it("charges the bowler for wides and no-balls", () => {
    expect(runsConcededBowler(2, 1, 1)).toBe(4);
  });

  it("does not charge the bowler for byes or leg-byes", () => {
    // The signature is the guard: byes never reach this function, so they cannot be
    // charged by accident.
    expect(runsConcededBowler(0, 0, 0)).toBe(0);
  });
});

describe("the two dot balls", () => {
  it("counts a leg-bye as a dot for the batter but not for the team", () => {
    // runs_batter=0, one leg-bye: the batter scored nothing, the team scored one.
    expect(isDotBatter(0, 0)).toBe(true);
    expect(isDotBall(1)).toBe(false);
  });

  it("counts a wide as a dot for neither", () => {
    expect(isDotBatter(0, 1)).toBe(false);
    expect(isDotBall(1)).toBe(false);
  });
});

describe("boundary gating on non_boundary", () => {
  it("excludes an all-run four", () => {
    expect(isFour(4, true)).toBe(false);
    expect(isSix(6, true)).toBe(false);
    expect(isBoundary(4, true)).toBe(false);
  });

  it("counts a four that reached the rope", () => {
    expect(isFour(4, false)).toBe(true);
    expect(isFour(4, null)).toBe(true);
  });

  it("is false for a run count that is not four or six", () => {
    expect(isFour(0, null)).toBe(false);
    for (const runs of [0, 1, 2, 3, 5, 7]) {
      expect(isBoundary(runs, null)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Dismissals
// ---------------------------------------------------------------------------

describe("dismissal-kind allowlists", () => {
  it("keeps the two allowlists disjoint", () => {
    const overlap = [...BOWLER_CREDITED_KINDS].filter((kind) => NON_BOWLER_KINDS.has(kind));
    expect(overlap).toEqual([]);
  });

  it("normalises case and surrounding whitespace", () => {
    expect(isBowlerCredited("  Caught And Bowled ")).toBe(true);
  });

  it("does not credit a run out to the bowler", () => {
    expect(isBowlerCredited("run out")).toBe(false);
  });

  it("throws rather than guessing on an unrecognised kind", () => {
    // Defaulting to "not the bowler's" would undercount wickets with no visible
    // symptom, which is the failure mode this allowlist exists to prevent.
    expect(() => isBowlerCredited("caught behind by the wind")).toThrow(UnknownDismissalKind);
    expect(() => isBowlerCredited("caught behind by the wind")).toThrow(/allowlist/);
  });
});

describe("countsAsDismissalForBattingAverage", () => {
  it("does not consume an average for a retirement that was not an out", () => {
    expect(countsAsDismissalForBattingAverage("retired hurt")).toBe(false);
    expect(countsAsDismissalForBattingAverage("retired not out")).toBe(false);
  });

  it("counts retired out, which is a dismissal", () => {
    expect(countsAsDismissalForBattingAverage("retired out")).toBe(true);
  });

  it("counts an ordinary dismissal however it is spelled", () => {
    expect(countsAsDismissalForBattingAverage(" Bowled ")).toBe(true);
    expect(countsAsDismissalForBattingAverage("run out")).toBe(true);
  });

  it("throws on an unclassified kind", () => {
    expect(() => countsAsDismissalForBattingAverage("vanished")).toThrow(UnknownDismissalKind);
    expect(() => countsAsDismissalForBattingAverage("vanished")).toThrow(/not classified/);
  });
});

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

/** T20 defaults unless a case says otherwise, matching the Python helper. */
function phase(
  overNumber: number,
  overrides: {
    fmt?: string;
    scheduledOvers?: number | null;
    ballsPerOver?: number;
    powerplays?: readonly definitions.PowerplayWindow[] | null;
  } = {},
): [Phase | null, PhaseSource] {
  return phaseForBall({
    fmt: overrides.fmt ?? "T20",
    overNumber,
    scheduledOvers: overrides.scheduledOvers === undefined ? 20 : overrides.scheduledOvers,
    ballsPerOver: overrides.ballsPerOver ?? 6,
    powerplays: overrides.powerplays ?? null,
  });
}

describe("phaseForBall defaults", () => {
  const t20: ReadonlyArray<[number, Phase]> = [
    [1, "powerplay"],
    [6, "powerplay"],
    [7, "middle"],
    [15, "middle"],
    [16, "death"],
    [20, "death"],
  ];

  it.each(t20)("T20 over %i is the %s", (over, expected) => {
    expect(phase(over)).toEqual([expected, "default"]);
  });

  const odi: ReadonlyArray<[number, Phase]> = [
    [1, "powerplay"],
    [10, "powerplay"],
    [11, "middle"],
    [40, "middle"],
    [41, "death"],
    [50, "death"],
  ];

  it.each(odi)("ODI over %i is the %s", (over, expected) => {
    expect(phase(over, { fmt: "ODI", scheduledOvers: 50 })).toEqual([expected, "default"]);
  });
});

describe("phaseForBall declines to guess", () => {
  it.each(["Test", "MDM"])("returns null for %s", (fmt) => {
    // A confident "powerplay" on a Test is the exact wrong answer to a question with
    // no answer.
    expect(phase(5, { fmt, scheduledOvers: null })).toEqual([null, "null"]);
  });

  it("returns null for a non-six-ball format", () => {
    expect(phase(5, { ballsPerOver: 5 })).toEqual([null, "null"]);
  });

  it("returns null for an innings length it has no default for", () => {
    expect(phase(5, { scheduledOvers: 33 })).toEqual([null, "null"]);
  });
});

describe("declared powerplays", () => {
  it("beats the default when the match declares one", () => {
    // Overs 0-2 zero-based, so 1-based overs 1..3 are the powerplay and over 4 is not.
    const declared = [{ from: 0.1, to: 2.6, type: "mandatory" }];
    expect(phase(1, { powerplays: declared })).toEqual(["powerplay", "declared"]);
    expect(phase(3, { powerplays: declared })).toEqual(["powerplay", "declared"]);
    expect(phase(4, { powerplays: declared })).toEqual(["middle", "declared"]);
  });

  it("covers whole overs, so a seven-ball over is entirely inside", () => {
    expect(declaredPowerplayOvers([{ from: 0.1, to: 5.6 }])).toEqual(new Set([0, 1, 2, 3, 4, 5]));
  });

  it("unions multiple windows", () => {
    expect(
      declaredPowerplayOvers([
        { from: 0.1, to: 1.6 },
        { from: 10.1, to: 11.6 },
      ]),
    ).toEqual(new Set([0, 1, 10, 11]));
  });

  it("returns null, not an empty set, when nothing was declared", () => {
    // Empty would mean "there is no powerplay"; null means "fall back to the default".
    expect(declaredPowerplayOvers(null)).toBeNull();
    expect(declaredPowerplayOvers([])).toBeNull();
    expect(declaredPowerplayOvers([{ type: "mandatory" }])).toBeNull();
  });

  it("splits what remains proportionally in a shortened innings", () => {
    // Ten overs: death is the last three (round(10/4) = 2 in Python's half-to-even?
    // No -- 2.5 rounds to 2, so death starts at over 9).
    const declared = [{ from: 0.1, to: 1.6 }];
    expect(phase(8, { scheduledOvers: 10, powerplays: declared })).toEqual(["middle", "declared"]);
    expect(phase(9, { scheduledOvers: 10, powerplays: declared })).toEqual(["death", "declared"]);
  });

  it("declines to place a ball when the innings length is unknown", () => {
    expect(phase(9, { scheduledOvers: null, powerplays: [{ from: 0.1, to: 1.6 }] })).toEqual([
      null,
      "declared",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Metrics: null, never zero, on an empty denominator
// ---------------------------------------------------------------------------

describe("metric arithmetic", () => {
  it("returns null for a batter who has never been dismissed", () => {
    // Zero would make him the worst in the list; his run total would make him the
    // best. Neither is true, so the honest answer is "undefined".
    expect(battingAverage(45, 0)).toBeNull();
  });

  it("rounds a batting average to two places", () => {
    expect(battingAverage(300, 7)).toBe(42.86);
  });

  it("returns null for a strike rate off no balls", () => {
    expect(battingStrikeRate(0, 0)).toBeNull();
  });

  it("scales economy by six because the denominator is overs", () => {
    expect(bowlingEconomy(24, 24)).toBe(6.0);
    expect(bowlingEconomy(8, 6)).toBe(8.0);
  });

  it("returns null for a bowler who has taken no wicket", () => {
    expect(bowlingAverage(50, 0)).toBeNull();
    expect(bowlingStrikeRate(120, 0)).toBeNull();
  });

  it("computes a percentage to two places, and null over nothing", () => {
    expect(percentage(53, 1284)).toBe(4.13);
    expect(percentage(0, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Trap C, the part that is prose rather than arithmetic
// ---------------------------------------------------------------------------

/** Every metric a caller may order by, matching `aggregate.metricsFor`. */
const METRICS: Readonly<Record<string, readonly string[]>> = {
  batting: [...Object.keys(BATTING_BASE_SQL), "dismissals", ...Object.keys(BATTING_DERIVED_SQL)],
  bowling: [...Object.keys(BOWLING_BASE_SQL), ...Object.keys(BOWLING_DERIVED_SQL)],
};

describe("metric prose", () => {
  it.each(Object.entries(METRICS))("covers every %s metric at its own grain", (grain, metrics) => {
    // "Forgot to write the sentence" has to fail the suite, because otherwise it fails
    // silently in front of a user: the response simply omits the definition for the
    // one metric the answer turned on.
    const missing = metrics.filter((metric) => metricDefinition(metric, grain) === undefined);
    expect(missing).toEqual([]);
  });

  it.each(["average", "strike_rate", "dots", "dot_pct"])(
    "gives %s a different sentence per grain",
    (metric) => {
      const batting = metricDefinition(metric, "batting");
      const bowling = metricDefinition(metric, "bowling");
      expect(batting).toBeDefined();
      expect(bowling).toBeDefined();
      expect(batting).not.toBe(bowling);
    },
  );

  it("refuses to guess a grain-qualified metric when no grain is given", () => {
    // Losing the sentence is recoverable; printing the batting definition next to a
    // bowling average is the Trap C failure this whole mechanism exists to prevent.
    expect(metricDefinition("average")).toBeUndefined();
    expect(metricDefinition("strike_rate")).toBeUndefined();
  });

  it("returns undefined for a metric that does not exist", () => {
    expect(metricDefinition("vibes", "batting")).toBeUndefined();
  });

  it("says out loud which denominator boundary_conceded_pct uses", () => {
    // The one thing a reader cannot infer and will get wrong: it is legal balls, not
    // balls faced, so it is not the same denominator as a batter's boundary %.
    expect(BOWLING_DERIVED_SQL).toHaveProperty("boundary_conceded_pct");
    expect(DERIVED_METRIC_EQUIVALENTS).toHaveProperty("bowling.boundary_conceded_pct");
    const prose = metricDefinition("boundary_conceded_pct", "bowling");
    expect(prose?.toLowerCase()).toContain("legal balls");
  });
});
