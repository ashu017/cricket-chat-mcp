// `cchat tools lint` -- the description contract, enforced.
//
// The tool description is the prompt. Everything the model knows about when NOT to call
// a tool, what the enum values are, and that the qualification minimums apply by
// default, it knows from here. Which means a description that drifts out of date is
// indistinguishable, from the outside, from a model that has got worse: the answers
// degrade and nothing in the code changed.
//
// So the shape of a description is checked mechanically. Every rule below exists because
// its absence produces a specific, observed failure mode, named in the rule.
//
// No JSON Schema validator dependency: the example checker walks the schema itself. It
// is a partial validator on purpose -- it checks the things a hand-written example gets
// wrong (a stray key, a stale enum value, a name where an id belongs) and ignores the
// rest.

import type { JsonSchema, ToolSpec } from "./base.js";
import { names, specs } from "./registry.js";

/**
 * A description shorter than this cannot carry purpose + when-not-to-use + enums +
 * defaults + two examples. The number is a floor, not a target.
 */
export const MIN_DESCRIPTION_CHARS = 700;

/**
 * Two, because one example teaches the model a template and two teach it which parts
 * vary. The single most common tool-call failure is copying the one example verbatim and
 * changing only the name.
 */
export const MIN_EXAMPLES = 2;

/**
 * The phrase that carries the negative half of the contract. A tool description that
 * only says what the tool does gets called for everything adjacent to it.
 */
export const NOT_FOR_MARKER = "DO NOT use this tool for:";

/**
 * String fields that are legitimately free text: names the user typed, which cannot be
 * enumerated because the warehouse decides what exists. Every one of them is resolvable
 * through `resolve_entity`, and that is the point -- the allowlist is short and each
 * entry is a name, not a category.
 */
export const FREE_TEXT_FIELDS: ReadonlySet<string> = new Set([
  "query",
  "player_name",
  "match_id",
  "batting_team",
  "bowling_team",
  "subject_team",
  "venue_canonical",
  "host_country",
  "competition",
  "seasons",
  // The exclusion twins, free text for exactly the reason their positive counterparts
  // above are: they take the same warehouse-decided strings. Listed individually rather
  // than matched with a `_not` suffix rule, because a suffix rule would also wave through
  // a future `bowling_type_not`, which does have an enum and should be held to it.
  "batting_team_not",
  "bowling_team_not",
  "venue_canonical_not",
  "host_country_not",
  "competition_not",
  "seasons_not",
]);

/**
 * One rule violation, in a form a developer can act on without reading this file: which
 * tool, which rule, what to do.
 */
export interface Finding {
  tool: string;
  rule: string;
  detail: string;
}

export function formatFinding(finding: Finding): string {
  return `${finding.tool}: ${finding.rule}: ${finding.detail}`;
}

// ---------------------------------------------------------------------------
// Schema walking
// ---------------------------------------------------------------------------

function asSchema(value: unknown): JsonSchema {
  return value !== null && typeof value === "object" ? (value as JsonSchema) : {};
}

function properties(schema: JsonSchema): Record<string, JsonSchema> {
  const props = schema["properties"];
  if (props === null || typeof props !== "object") return {};
  return props as Record<string, JsonSchema>;
}

function enumValues(schema: JsonSchema): string[] | undefined {
  const values = schema["enum"];
  return Array.isArray(values) && values.length > 0 ? values.map(String) : undefined;
}

/**
 * Every string-typed leaf in a schema, with its dotted path.
 *
 * Arrays are unwrapped to their item schema, because `format: ["Test"]` is the shape the
 * model actually sends and the enum that matters lives on the item.
 */
function leafStringFields(schema: JsonSchema, path = ""): [string, JsonSchema][] {
  const found: [string, JsonSchema][] = [];
  for (const [name, prop] of Object.entries(properties(schema))) {
    const here = `${path}${name}`;
    const kind = prop["type"];
    if (kind === "object" || "properties" in prop) {
      found.push(...leafStringFields(prop, `${here}.`));
    } else if (kind === "array") {
      const items = asSchema(prop["items"]);
      if (items["type"] === "object" || "properties" in items) {
        found.push(...leafStringFields(items, `${here}.`));
      } else if (items["type"] === "string") {
        found.push([here, items]);
      }
    } else if (kind === "string") {
      found.push([here, prop]);
    }
  }
  return found;
}

/** Every enumerated field, by dotted path, with its permitted values. */
function enumFields(schema: JsonSchema, path = ""): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [name, prop] of leafStringFields(schema, path)) {
    const values = enumValues(prop);
    if (values !== undefined) out.set(name, values);
  }
  return out;
}

/**
 * Structural check of one worked example against the schema it illustrates.
 *
 * Not a full JSON Schema validator -- deliberately. It catches the three ways a
 * hand-written example rots: a key the schema no longer has, an enum value that was
 * renamed, and a name in a field that takes an id.
 */
function checkExample(schema: JsonSchema, example: unknown, path = ""): string[] {
  const problems: string[] = [];
  if (example === null || typeof example !== "object" || Array.isArray(example)) {
    return [`${path || "input"} should be an object, got ${describeType(example)}`];
  }

  const props = properties(schema);
  const required = schema["required"];
  for (const name of Array.isArray(required) ? required.map(String) : []) {
    if (!Object.hasOwn(example, name)) problems.push(`missing required field ${path}${name}`);
  }

  for (const [key, value] of Object.entries(example as Record<string, unknown>)) {
    const prop = props[key];
    if (prop === undefined) {
      problems.push(`unknown field ${path}${key}`);
      continue;
    }
    problems.push(...checkValue(prop, value, `${path}${key}`));
  }
  return problems;
}

function checkValue(prop: JsonSchema, value: unknown, where: string): string[] {
  const problems: string[] = [];
  if (prop["type"] === "array" || "items" in prop) {
    if (!Array.isArray(value)) return [`${where} should be an array`];
    for (const [index, item] of value.entries()) {
      problems.push(...checkValue(asSchema(prop["items"]), item, `${where}[${index}]`));
    }
    return problems;
  }

  if (prop["type"] === "object" || "properties" in prop) {
    return checkExample(prop, value, `${where}.`);
  }

  const allowed = enumValues(prop);
  if (allowed !== undefined && !allowed.includes(String(value))) {
    problems.push(`${where}=${JSON.stringify(value)} is not in [${allowed.join(", ")}]`);
  }
  const pattern = prop["pattern"];
  if (typeof pattern === "string" && typeof value === "string") {
    if (!new RegExp(`^(?:${pattern})$`).test(value)) {
      problems.push(`${where}=${JSON.stringify(value)} does not match ${pattern}`);
    }
  }
  if (prop["type"] === "integer" && typeof value === "number" && Number.isInteger(value)) {
    const maximum = prop["maximum"];
    const minimum = prop["minimum"];
    if (typeof maximum === "number" && value > maximum) {
      problems.push(`${where}=${value} exceeds maximum ${maximum}`);
    }
    if (typeof minimum === "number" && value < minimum) {
      problems.push(`${where}=${value} is below minimum ${minimum}`);
    }
  }
  return problems;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  return typeof value;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Every rule, applied to one tool. */
export function check(spec: ToolSpec, toolNames?: readonly string[]): Finding[] {
  const others = (toolNames ?? names()).filter((name) => name !== spec.name);
  const findings: Finding[] = [];
  const description = spec.description;

  const fail = (rule: string, detail: string): void => {
    findings.push({ tool: spec.name, rule, detail });
  };

  if (description.length < MIN_DESCRIPTION_CHARS) {
    fail(
      "description too short",
      `${description.length} chars, minimum ${MIN_DESCRIPTION_CHARS}. A short ` +
        `description is one that has stopped saying when NOT to call the tool.`,
    );
  }

  if (!description.includes(NOT_FOR_MARKER)) {
    fail(
      "no negative guidance",
      `the description must contain '${NOT_FOR_MARKER}' followed by the tool to ` +
        `use instead; without it the model calls this tool for everything nearby.`,
    );
  } else if (!others.some((name) => description.includes(name))) {
    fail(
      "negative guidance names no alternative",
      "'do not use this for X' is only actionable if it says which tool to use " +
        "instead. Name at least one other tool.",
    );
  }

  if (spec.examples.length < MIN_EXAMPLES) {
    fail(
      "too few examples",
      `${spec.examples.length} given, ${MIN_EXAMPLES} required. One example is a ` +
        `template to copy; two show which parts vary.`,
    );
  }
  for (const [index, example] of spec.examples.entries()) {
    for (const problem of checkExample(spec.inputSchema, example)) {
      fail(`example ${index + 1} does not match the schema`, problem);
    }
  }

  for (const [name, values] of enumFields(spec.inputSchema)) {
    const leaf = name.split(".").at(-1) ?? name;
    // Only demanded when the field is mentioned: naming a field without its values is
    // what produces format="Twenty20" and phase="slog overs".
    if (new RegExp(`\\b${escapeRegExp(leaf)}\\b`).test(description)) {
      const missing = values.filter((value) => !description.includes(value));
      if (missing.length > 0) {
        fail(
          `enum values missing from the description (${leaf})`,
          `${missing.join(", ")} -- the description mentions ${leaf} but does ` +
            `not spell out every accepted value.`,
        );
      }
    }
  }

  for (const [name, prop] of leafStringFields(spec.inputSchema)) {
    const leaf = name.split(".").at(-1) ?? name;
    if (enumValues(prop) !== undefined || "pattern" in prop || "format" in prop) continue;
    if (FREE_TEXT_FIELDS.has(leaf)) continue;
    fail(
      "bare string field",
      `${name} is a plain string with no enum, pattern or format. Either give it ` +
        `an enum, or add it to FREE_TEXT_FIELDS with a reason it cannot have one.`,
    );
  }

  const props = properties(spec.inputSchema);
  const limitProp = props["limit"];
  if (limitProp !== undefined && description.includes("limit")) {
    const ceiling = limitProp["maximum"];
    if (ceiling !== undefined && !description.includes(String(ceiling))) {
      fail(
        "limit ceiling not stated",
        `the schema caps limit at ${String(ceiling)}; say so, or the model asks for ` +
          `5000 rows and spends a retry finding out.`,
      );
    }
  }
  for (const field of ["min_balls_faced", "min_balls_bowled"]) {
    if (Object.hasOwn(props, field) && !description.includes(field)) {
      fail(
        "qualification default not stated",
        `${field} is applied by default and the description does not name it. ` +
          `An unqualified leaderboard reads as a fact.`,
      );
    }
  }

  return findings;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function checkAll(chosen: readonly ToolSpec[] = specs()): Finding[] {
  const toolNames = chosen.map((spec) => spec.name);
  return chosen.flatMap((spec) => check(spec, toolNames));
}
