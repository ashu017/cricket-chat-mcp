// Input schemas for the tools, generated from the frozen contract models.
//
// The `filters` object on every stats tool is derived from the actual Zod schema
// rather than hand-written. That matters for one specific reason: the linter requires
// that no field be a bare string where an enum exists, and the only way to guarantee
// that permanently is to read the enum off the type that validates it. A hand-written
// copy of `Format` would be correct on the day it was written and wrong the first time
// a format is added.
//
// Bedrock's `inputSchema.json` takes a plain JSON Schema object. `z.toJSONSchema`
// already gives one -- it inlines its own defs, collapses the nullable branch of an
// optional field, and emits no titles -- so the ref-inlining and `anyOf: [T, null]`
// flattening the Python implementation needed against pydantic's output are simply
// gone. What remains is trimming three keys that are true but are prompt noise.

import { z } from "zod";

import { DEFAULT_LIMIT, type JsonSchema, MAX_LIMIT } from "./base.js";

/**
 * Keys that are correct JSON Schema and worth nothing to the model.
 *
 * `pattern` next to `format: "date"` is Zod's 200-character leap-year regex. It says
 * exactly what `format: "date"` says, and it says it four times per tool description
 * in a prompt that is charged by the token. `maximum: 9007199254740991` is
 * `Number.MAX_SAFE_INTEGER`, which Zod attaches to every `z.int()`; a model reading
 * "over_from must be at most nine quadrillion" has learned nothing about cricket.
 */
function tidy(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(tidy);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$schema") continue;
    if (key === "pattern" && (node as Record<string, unknown>)["format"] === "date") continue;
    if (key === "maximum" && value === Number.MAX_SAFE_INTEGER) continue;
    out[key] = tidy(value);
  }
  return out;
}

/** A self-contained JSON Schema for a filter model: no refs, enums intact. */
export function modelSchema(schema: z.ZodType): JsonSchema {
  // `io: "input"` is the one that matters. The output type of a filter model has
  // `include_super_over` required (the default has been applied), and a schema that
  // says "required" about a field the model never needs to send is a schema that
  // invites it to send one.
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  return tidy(json) as JsonSchema;
}

export interface AggregateSchemaInput {
  filters: z.ZodType;
  groupByValues: readonly string[];
  orderByValues: readonly string[];
  filtersDescription: string;
}

/**
 * The input schema shared by the two leaderboard tools.
 *
 * `order_by` is an enum of the real metric names and `group_by` an enum of the real
 * dimensions, both passed in from the aggregate registries. A model cannot invent
 * `order_by: "best"` and get a silent arbitrary ordering.
 */
export function aggregateSchema(input: AggregateSchemaInput): JsonSchema {
  const filters = modelSchema(input.filters);
  filters["description"] = input.filtersDescription;
  return {
    type: "object",
    properties: {
      filters,
      group_by: {
        type: "array",
        items: { type: "string", enum: [...input.groupByValues] },
        description:
          "Dimensions to break the numbers down by. Omit entirely for a " +
          "single total over everything the filters matched. REQUIRED for " +
          "any question phrased as 'who', 'which', 'best', 'most' or " +
          "'top' -- those need group_by=[\"player\"].",
      },
      order_by: {
        type: "string",
        enum: [...input.orderByValues],
        description:
          "Which metric to sort by. REQUIRED whenever group_by is set: an " +
          "unordered breakdown by player returns thousands of rows in " +
          "arbitrary order and the top of the list would be meaningless.",
      },
      order_dir: {
        type: "string",
        enum: ["asc", "desc"],
        default: "desc",
        description:
          "Use asc for metrics where lower is better (economy, bowling " +
          "average, dot_pct is higher-is-better for a bowler).",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_LIMIT,
        default: DEFAULT_LIMIT,
        description: "Rows to return. Defaults to 20; 200 is the hard maximum.",
      },
      offset: {
        type: "integer",
        minimum: 0,
        default: 0,
        description:
          "Rows to skip before the first one returned, for reaching past the " +
          "limit. row_count_total tells you how many qualified, so offset=20 " +
          "with limit=20 is ranks 21-40. Use it only when the user asked for a " +
          "position further down the list; the answer to 'who is best' is on " +
          "the first page.",
      },
    },
    required: [],
  };
}
