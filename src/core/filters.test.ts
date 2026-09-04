// The filter compiler, tested for the two properties that matter: nothing a caller
// sent ever reaches the SQL text, and a filter the registry does not know about fails
// loudly instead of being ignored.

import { describe, expect, it } from "vitest";
import {
  BattingFilters,
  BowlingFilters,
  battingFilterShape,
  bowlingFilterShape,
  MatchFilters,
  matchFilterShape,
} from "../contracts/index.js";

import {
  compileFilters,
  FILTER_FIELD_ORDER,
  FILTER_SPECS,
  JOIN_SQL,
  knownFields,
  SPECIAL_FIELDS,
  UnknownFilterField,
} from "./filters.js";

describe("the registry covers the contract", () => {
  it("has a spec or a special case for every field on every filter model", () => {
    // The failure this prevents: somebody adds a field to the seam, no spec exists, and
    // every query using it silently ignores it and answers over a wider population.
    const fields = new Set([
      ...Object.keys(battingFilterShape),
      ...Object.keys(bowlingFilterShape),
      ...Object.keys(matchFilterShape),
    ]);
    const uncovered = [...fields].filter(
      (field) => !(field in FILTER_SPECS) && !SPECIAL_FIELDS.has(field),
    );
    expect(uncovered).toEqual([]);
  });

  it("advertises exactly the registry in `knownFields`", () => {
    // The `allowed` list on an error payload is read off the registry, so it cannot
    // advertise a filter that does not exist or omit one that does.
    expect(knownFields()).toEqual(
      [...new Set([...Object.keys(FILTER_SPECS), ...SPECIAL_FIELDS])].sort(),
    );
  });

  it("orders fields as the contract declares them", () => {
    // Clause order determines `sql_id`, which the payload fixtures pin, so the order
    // has to come from the shape rather than from this file.
    expect(FILTER_FIELD_ORDER.slice(0, 4)).toEqual(["format", "gender", "date_from", "date_to"]);
    expect(FILTER_FIELD_ORDER).toContain("include_super_over");
  });
});

describe("super overs", () => {
  it("excludes them by default, as a predicate like any other", () => {
    const compiled = compileFilters(BattingFilters.parse({}));
    expect(compiled.where).toEqual(["NOT d.is_super_over"]);
    expect(compiled.params).toEqual([]);
    expect(compiled.clauseFields).toEqual(["include_super_over"]);
  });

  it("drops the exclusion when asked, and adds no predicate in its place", () => {
    const compiled = compileFilters(BattingFilters.parse({ include_super_over: true }));
    expect(compiled.where).toEqual([]);
    expect(compiled.whereSql).toBe("TRUE");
  });
});

describe("every value is a bound parameter", () => {
  it("binds a list to one placeholder per element", () => {
    const compiled = compileFilters(
      BattingFilters.parse({ format: ["IT20", "T20"], batter_ids: ["99b75528"] }),
    );
    expect(compiled.whereSql).toBe(
      "NOT d.is_super_over AND d.format IN (?, ?) AND d.batter_id IN (?)",
    );
    expect(compiled.params).toEqual(["IT20", "T20", "99b75528"]);
  });

  it("puts nothing a caller sent into the SQL text", () => {
    // The adversarial case. If this string can reach the SQL at all, the compiler is
    // broken by construction rather than by review.
    const nasty = "'); DROP TABLE deliveries; --";
    const compiled = compileFilters(BattingFilters.parse({ venue_canonical: [nasty] }));
    expect(compiled.whereSql).not.toContain("DROP");
    expect(compiled.params).toContain(nasty);
  });

  it("compiles a date range to inclusive bounds", () => {
    const compiled = compileFilters(
      BattingFilters.parse({ date_from: "2020-01-01", date_to: "2024-12-31" }),
    );
    expect(compiled.whereSql).toBe(
      "NOT d.is_super_over AND d.match_date >= ? AND d.match_date <= ?",
    );
    expect(compiled.params).toEqual(["2020-01-01", "2024-12-31"]);
  });

  it("compiles an over range from either bound alone", () => {
    // Why there is no `between` op: a single one would have obliged the model to send
    // both bounds.
    expect(compileFilters(BowlingFilters.parse({ over_from: 16 })).whereSql).toBe(
      "NOT d.is_super_over AND d.over_number >= ?",
    );
    expect(compileFilters(BowlingFilters.parse({ over_to: 6 })).whereSql).toBe(
      "NOT d.is_super_over AND d.over_number <= ?",
    );
  });
});

describe("exclusions", () => {
  it("keeps rows whose column is unset", () => {
    // `col NOT IN (...)` is NULL, not TRUE, when `col` is NULL, and a WHERE keeps only
    // TRUE -- so the obvious spelling silently discards every unlabelled row. 66 IT20
    // matches carry no `competition` at all, and "not the World Cup" has to include them.
    const compiled = compileFilters(
      BattingFilters.parse({ competition_not: ["ICC Men's T20 World Cup"] }),
    );
    expect(compiled.whereSql).toBe(
      "NOT d.is_super_over AND (d.competition IS NULL OR d.competition NOT IN (?))",
    );
    expect(compiled.params).toEqual(["ICC Men's T20 World Cup"]);
  });

  it("binds one placeholder per excluded value", () => {
    const compiled = compileFilters(
      BowlingFilters.parse({ batting_team_not: ["India", "Australia"] }),
    );
    expect(compiled.whereSql).toBe(
      "NOT d.is_super_over AND (d.batting_team IS NULL OR d.batting_team NOT IN (?, ?))",
    );
    expect(compiled.params).toEqual(["India", "Australia"]);
  });

  it("re-binds correctly when a clause either side of it is dropped", () => {
    // The null-safe spelling is the only clause with a parenthesised predicate, so a
    // `withoutClause` that counted anything other than placeholders would go wrong here
    // first.
    const compiled = compileFilters(
      MatchFilters.parse({
        format: ["IT20"],
        seasons_not: ["2019", "2020"],
        host_country: ["India"],
      }),
    );
    expect(compiled.params).toEqual(["IT20", "India", "2019", "2020"]);
    const [, withoutExclusion] = compiled.withoutClause(
      compiled.clauseFields.indexOf("seasons_not"),
    );
    expect(withoutExclusion).toEqual(["IT20", "India"]);
    const [where, withoutFormat] = compiled.withoutClause(compiled.clauseFields.indexOf("format"));
    expect(where).toBe(
      "NOT d.is_super_over AND m.country IN (?) " +
        "AND (m.season IS NULL OR m.season NOT IN (?, ?))",
    );
    expect(withoutFormat).toEqual(["India", "2019", "2020"]);
  });

  it("joins matches for a match-grain exclusion", () => {
    // The positive and negative twins must agree about the join, or excluding by season
    // references an alias that is not in the FROM.
    expect(compileFilters(MatchFilters.parse({ seasons_not: ["2019"] })).joins).toEqual([
      JOIN_SQL.matches,
    ]);
  });
});

describe("tri-state booleans", () => {
  it("makes both directions explicit", () => {
    // Compiling `false` to no predicate would silently widen the question from "only
    // non-chases" to "any innings".
    const chases = compileFilters(BattingFilters.parse({ is_chase: true }));
    expect(chases.whereSql).toBe("NOT d.is_super_over AND i.is_chase");
    const notChases = compileFilters(BattingFilters.parse({ is_chase: false }));
    expect(notChases.whereSql).toBe("NOT d.is_super_over AND NOT i.is_chase");
    // ...and neither binds a parameter, which `paramsFor` has to agree about.
    expect(chases.params).toEqual([]);
  });
});

describe("joins", () => {
  it("adds a join only when a filter needs one", () => {
    expect(compileFilters(BattingFilters.parse({ format: ["T20"] })).joins).toEqual([]);
  });

  it("emits each join once, however many filters want it", () => {
    // Twice is a duplicate-alias crash.
    const compiled = compileFilters(
      BowlingFilters.parse({ own_bowling_type: "spin", own_bowling_arm: "right" }),
    );
    expect(compiled.joins).toEqual([JOIN_SQL.bowler_attributes]);
    expect(compiled.hasJoin("bowler_attributes")).toBe(true);
    expect(compiled.hasJoin("matches")).toBe(false);
  });

  it("joins matches for a match-grain column", () => {
    const compiled = compileFilters(MatchFilters.parse({ host_country: ["India"] }));
    expect(compiled.joins).toEqual([JOIN_SQL.matches]);
  });
});

describe("curated attributes", () => {
  it("records which attribute was filtered on so coverage can be reported", () => {
    const compiled = compileFilters(BattingFilters.parse({ faced_bowling_type: "spin" }));
    expect(compiled.attributesUsed).toEqual(["bowling_type"]);
    expect(compiled.attributeClauses).toEqual([1]);
  });

  it("removes the attribute predicate when measuring coverage", () => {
    // With `bowling_type = 'spin'` still in the WHERE, coverage is 100% by
    // construction and answers nothing.
    const compiled = compileFilters(
      BattingFilters.parse({ format: ["IT20"], faced_bowling_type: "spin" }),
    );
    const [where, params] = compiled.withoutAttributes();
    expect(where).toBe("NOT d.is_super_over AND d.format IN (?)");
    expect(params).toEqual(["IT20"]);
  });

  it("reports no attributes for the overwhelming majority of queries", () => {
    expect(compileFilters(BattingFilters.parse({ format: ["T20"] })).attributesUsed).toEqual([]);
  });
});

describe("dropping a clause after the fact", () => {
  it("re-binds the surviving parameters by counting placeholders", () => {
    // Slicing the parameter list by clause *position* would mis-bind every later
    // filter, which is the bug this method exists to avoid.
    const compiled = compileFilters(
      BattingFilters.parse({
        format: ["IT20", "T20"],
        gender: "male",
        date_from: "2021-01-01",
        is_chase: true,
      }),
    );
    expect(compiled.params).toEqual(["IT20", "T20", "male", "2021-01-01"]);

    // Drop `format` (two placeholders): the rest must still line up.
    const formatIndex = compiled.clauseFields.indexOf("format");
    const [where, params] = compiled.withoutClause(formatIndex);
    expect(where).toBe("NOT d.is_super_over AND d.gender = ? AND d.match_date >= ? AND i.is_chase");
    expect(params).toEqual(["male", "2021-01-01"]);

    // Drop `gender` (one placeholder, sitting between two bound clauses).
    const [, afterGender] = compiled.withoutClause(compiled.clauseFields.indexOf("gender"));
    expect(afterGender).toEqual(["IT20", "T20", "2021-01-01"]);
  });

  it("names the filter field behind a predicate, not the SQL", () => {
    // A relaxation hint has to say "drop `date_from`". The model sent field names, can
    // only act on field names, and is never shown SQL.
    const compiled = compileFilters(BattingFilters.parse({ date_from: "2021-01-01" }));
    expect(compiled.fieldFor(0)).toBe("include_super_over");
    expect(compiled.fieldFor(1)).toBe("date_from");
  });

  it("falls back to TRUE when the last predicate is dropped", () => {
    const compiled = compileFilters(
      BattingFilters.parse({ include_super_over: true, gender: "female" }),
    );
    expect(compiled.withoutClause(0)[0]).toBe("TRUE");
  });
});

describe("absent and empty", () => {
  it("treats an omitted filter as absent", () => {
    const compiled = compileFilters(BattingFilters.parse({ gender: "male" }));
    expect(compiled.where).toEqual(["NOT d.is_super_over", "d.gender = ?"]);
  });

  it("treats an empty list as absent, not as 'match nothing'", () => {
    // The contract rejects an empty array, but a hand-built filter object can still
    // carry one and zero rows with no explanation is the worst possible answer.
    const compiled = compileFilters({ format: [] });
    expect(compiled.where).toEqual(["NOT d.is_super_over"]);
  });
});

describe("an unregistered field", () => {
  it("throws rather than being silently ignored", () => {
    // Unreachable through a tool -- the contract's strictObject rejects unknown fields
    // first, with the real field names attached. It is here because the day somebody
    // adds a field to the seam and forgets the registry, this is the error that tells
    // them, instead of every query using it quietly answering a wider question.
    expect(() => compileFilters({ bowling_style: "spin" })).toThrow(UnknownFilterField);
    expect(() => compileFilters({ bowling_style: "spin" })).toThrow(/FILTER_SPECS/);
  });

  it("ignores an unregistered field that was not actually set", () => {
    expect(() => compileFilters({ bowling_style: undefined })).not.toThrow();
  });
});
