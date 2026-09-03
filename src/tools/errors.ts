// Turning a validation failure into something the model can act on.
//
// A `ZodError` rendered as a string is a traceback: it names a path, an input and a
// rule, and the model's next attempt is a guess. Everything here exists to convert
// that into `allowed` + `did_you_mean` + `fix_example`, so the correction is a lookup.
//
// The single most valuable case is the one that looks least like an error:
// `batter_ids: ["Kohli"]`. The model does not know player ids exist, so left as a
// pattern-mismatch message it will retry with `["V Kohli"]` and fail again. It has to
// be told, by name, to call `resolve_entity` first.

import type { z } from "zod";
import { type ErrorCode, ErrorDetail, MAX_TOOL_ATTEMPTS, ToolError } from "../contracts/index.js";
import { knownFields } from "../core/index.js";

import { closeMatches } from "./similarity.js";

/**
 * Cap on corrective attempts per tool per turn. After this the model is told to
 * explain the limitation rather than keep trying -- three failed corrections mean the
 * question cannot be expressed, and a fourth attempt just burns tokens.
 *
 * Re-exported from `contracts` rather than spelled again: `ErrorDetail` has a
 * refinement that rejects a retryable error past the cap, so a local copy that drifted
 * would turn every fourth error into a validation failure inside the loop that exists
 * to handle failures.
 */
export const MAX_ATTEMPTS = MAX_TOOL_ATTEMPTS;

export { ToolError };

/** Closest matches by edit distance, for a field name or an enum value. */
export function didYouMean(value: unknown, candidates: readonly string[], n = 3): string[] {
  if (typeof value !== "string") return [];
  return closeMatches(value, candidates, n);
}

/**
 * Python's `repr()` for the handful of shapes that reach an error message.
 *
 * Not cosmetic: the messages are pinned by the committed payload fixtures, which were
 * written by the Python implementation. `card='scorecard' is not one of the accepted
 * values` is the fixture; `card=scorecard` would fail it, and would also read
 * ambiguously the one time a value contains a space.
 */
export function repr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    // Python prefers single quotes and switches to double only when the string
    // contains a single quote but no double quote.
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    const escaped = value.replace(/\\/g, "\\\\").replace(new RegExp(quote, "g"), `\\${quote}`);
    return `${quote}${escaped}${quote}`;
  }
  if (Array.isArray(value)) return `[${value.map(repr).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([key, item]) => `${repr(key)}: ${repr(item)}`).join(", ")}}`;
  }
  return String(value);
}

export interface ErrorOptions {
  field?: string | null;
  received?: unknown;
  allowed?: readonly string[];
  suggestions?: readonly string[];
  fixExample?: Record<string, unknown> | null;
  attempt?: number;
}

/** Build a {@link ToolError} whose payload the model can act on without guessing. */
export function error(
  code: ErrorCode,
  tool: string,
  message: string,
  options: ErrorOptions = {},
): ToolError {
  const attempt = options.attempt ?? 1;
  return new ToolError(
    ErrorDetail.parse({
      code,
      tool,
      message,
      field: options.field ?? null,
      received: options.received ?? null,
      allowed: [...(options.allowed ?? [])],
      did_you_mean: [...(options.suggestions ?? [])],
      fix_example: options.fixExample ?? null,
      attempt,
      // The contract forbids a retryable error past the cap, which is what makes the
      // cap real rather than advisory.
      retryable: attempt <= MAX_ATTEMPTS,
    }),
  );
}

/** The enum error, with the permitted values and the closest of them attached. */
export function badEnum(
  tool: string,
  field: string,
  received: unknown,
  allowed: readonly string[],
  attempt = 1,
): ToolError {
  return error(
    "BAD_ENUM_VALUE",
    tool,
    `${field}=${repr(received)} is not one of the accepted values.`,
    {
      field,
      received,
      allowed,
      suggestions: didYouMean(received, allowed),
      fixExample: allowed.length > 0 ? { [field]: allowed[0] } : null,
      attempt,
    },
  );
}

/**
 * The dotted path a model can map back onto the JSON it sent.
 *
 * Array indices are dropped: the model sent `batter_ids: ["Kohli"]` and the fix is to
 * the field, not to element 0.
 */
export function locName(path: readonly PropertyKey[]): string {
  const parts = path.filter((part) => typeof part !== "number").map(String);
  return parts.length > 0 ? parts.join(".") : "input";
}

/** The value at a Zod issue path, for the `received` field. */
function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let cursor: unknown = input;
  for (const part of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<PropertyKey, unknown>)[part];
  }
  return cursor;
}

/**
 * The handful of keys a model actually gets the type wrong on. A worked example is
 * worth more than the rule, and there is no point inventing one for every field.
 */
const TYPE_EXAMPLES: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  group_by: { group_by: ["player"], order_by: "runs" },
  "filters.format": { filters: { format: ["T20"] } },
  limit: { limit: 20 },
});

/**
 * Map the first Zod issue to the most actionable {@link ErrorDetail} we can.
 *
 * First, not all: a model given three simultaneous corrections tends to fix one and
 * re-break another. One precise instruction per turn converges faster.
 *
 * `input` is the object that failed, passed separately because Zod issues do not carry
 * the offending value the way pydantic's do -- so `received` is recovered by walking
 * the issue path.
 */
export function fromValidationError(
  tool: string,
  exception: z.ZodError,
  input: unknown,
  attempt = 1,
): ToolError {
  const first = exception.issues[0];
  if (first === undefined) {
    return error("INTERNAL_ERROR", tool, "validation failed with no issues", { attempt });
  }
  const path = first.path;
  let field = locName(path);
  const received = valueAt(input, path);

  // A name where an id belongs. This is the important one.
  if (first.code === "invalid_format" && first.format === "regex" && field.endsWith("_ids")) {
    return error(
      "NEEDS_ENTITY_RESOLUTION",
      tool,
      `${field} takes Cricsheet player ids (8 hex characters), not names. ` +
        `You passed ${repr(received)}. Call resolve_entity with ` +
        `{"query": "${String(received)}"} first, then pass the player_id it returns.`,
      {
        field,
        received,
        // An id-shaped value that is deliberately not anyone's id. A real one here
        // would be copied, and an answer about the wrong player reads as confident; an
        // unknown id returns an empty result with a hint.
        fixExample: { filters: { [field]: ["aaaaaaaa"] } },
        attempt,
      },
    );
  }

  if (first.code === "unrecognized_keys") {
    // Zod reports the offending keys against the *parent* object, so unlike every
    // other issue the field name is in the payload rather than at the end of the path.
    const key = first.keys[0] ?? "";
    const allowed = knownFields();
    return error("UNKNOWN_FILTER_FIELD", tool, `${key} is not a filter this tool accepts.`, {
      field: key,
      received: valueAt(input, [...path, key]),
      allowed,
      suggestions: didYouMean(key, allowed),
      attempt,
    });
  }

  if (first.code === "invalid_value") {
    return badEnum(
      tool,
      field,
      received,
      first.values.map((value) => String(value)),
      attempt,
    );
  }

  // The cross-field checks on the filter models raise with prose that is already
  // written for the model; pass it through rather than paraphrase.
  if (first.code === "custom") {
    const message = first.message;
    let code: ErrorCode = "MUTUALLY_EXCLUSIVE_FILTERS";
    let example: Record<string, unknown> | null = null;
    if (message.includes("phase is not defined")) {
      code = "FILTER_NOT_APPLICABLE_TO_FORMAT";
    } else if (message.includes("requires subject_team")) {
      code = "MISSING_SUBJECT_TEAM";
    } else if (message.includes("order_by is required")) {
      // This is the most common malformed call there is, so it gets its own code and a
      // worked example rather than being filed under "your filters conflict".
      code = "ORDER_BY_REQUIRED";
      field = "order_by";
      example = { group_by: ["player"], order_by: "runs", order_dir: "desc" };
    }
    return error(code, tool, message, {
      field,
      // A cross-field rule is about the object, not about one key, so the whole object
      // is what the model has to look at -- even though `field` names the key to edit.
      received: input,
      fixExample: example,
      attempt,
    });
  }

  // A wrong JSON type, or a required key left out. The model sent something
  // well-formed and fixable, so it must not be told INTERNAL_ERROR -- that reads as
  // "the tool is broken, stop correcting" about a one-edit mistake. Found by calling a
  // tool with `"group_by": "player"` instead of `["player"]`.
  if (first.code === "invalid_type") {
    return error(
      "INVALID_ARGUMENT_TYPE",
      tool,
      `${field}: ${first.message} (received ${repr(received)})`,
      {
        field,
        received,
        fixExample: TYPE_EXAMPLES[field] ?? null,
        attempt,
      },
    );
  }

  return error("INTERNAL_ERROR", tool, `${field}: ${first.message} (received ${repr(received)})`, {
    field,
    received,
    attempt,
  });
}
