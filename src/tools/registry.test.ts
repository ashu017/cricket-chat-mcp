// The registry is the single source of the metric list, in all three places it appears.
//
// `order_by` has to be enumerated for the model in the JSON Schema, restated in the
// tool description, and echoed in the `allowed` list of the error a wrong value
// produces. Hand-written, those three drift, and the failure is silent: the model is
// told `runs_per_dismissal` is a legal ordering, asks for it, and gets an error whose
// `allowed` list disagrees with the schema it was reading. So all three are derived
// from `aggregate.metricsFor(grain)`, and that is what this file pins.
//
// Also here: the two things the agent runtime depends on and nothing else does --
// `toolConfig()`'s exact shape, and `call()`'s promise never to reject.

import { describe, expect, it } from "vitest";
import { MAX_TOOL_ATTEMPTS } from "../contracts/index.js";
import {
  BATTING_BASE_SQL,
  BATTING_DERIVED_SQL,
  BOWLING_BASE_SQL,
  BOWLING_DERIVED_SQL,
  metricDefinition,
} from "../core/index.js";

import * as aggregate from "./aggregate.js";
import { call, names, spec, toolConfig } from "./registry.js";
import { warehouseAvailable, warehouseSuiteName } from "./testing.js";

function orderByEnum(tool: string): string[] {
  const properties = spec(tool)?.inputSchema["properties"] as Record<
    string,
    Record<string, unknown>
  >;
  return (properties["order_by"]?.["enum"] ?? []) as string[];
}

describe("the metric list, derived once", () => {
  it("batting: base metrics, then dismissals, then the derived ones", () => {
    // `dismissals` sits between the two because it is a base metric that cannot live in
    // BATTING_BASE_SQL: it aggregates `wickets`, not `deliveries`.
    expect(aggregate.metricsFor("batting")).toEqual([
      ...Object.keys(BATTING_BASE_SQL),
      "dismissals",
      ...Object.keys(BATTING_DERIVED_SQL),
    ]);
    expect(aggregate.metricsFor("batting")).toContain("dismissals");
  });

  it("bowling: base metrics, then the derived ones", () => {
    expect(aggregate.metricsFor("bowling")).toEqual([
      ...Object.keys(BOWLING_BASE_SQL),
      ...Object.keys(BOWLING_DERIVED_SQL),
    ]);
  });

  it("the order_by enum in each schema is that list", () => {
    expect(orderByEnum("query_batting_aggregate")).toEqual(aggregate.metricsFor("batting"));
    expect(orderByEnum("query_bowling_aggregate")).toEqual(aggregate.metricsFor("bowling"));
  });

  it("every orderable metric is named in the tool description", () => {
    // Otherwise the model picks from the ones it can see and never orders by the rest.
    for (const [tool, grain] of [
      ["query_batting_aggregate", "batting"],
      ["query_bowling_aggregate", "bowling"],
    ] as const) {
      const description = spec(tool)?.description ?? "";
      for (const metric of aggregate.metricsFor(grain)) {
        expect(description, `${tool} does not mention ${metric}`).toContain(metric);
      }
    }
  });

  it("every orderable metric has a definition sentence at its own grain", () => {
    // The payload echoes a definition for every column it returns. A metric with no
    // sentence is one the model has to guess the meaning of, which is Trap C.
    for (const grain of ["batting", "bowling"] as const) {
      for (const metric of aggregate.metricsFor(grain)) {
        const sentence = metricDefinition(metric, grain);
        expect(sentence, `${grain}.${metric} has no definition`).toBeTruthy();
        expect((sentence ?? "").length, `${grain}.${metric}`).toBeGreaterThan(10);
      }
    }
  });

  it("group_by enumerates exactly the dimensions the builder knows", () => {
    for (const [tool, grain] of [
      ["query_batting_aggregate", "batting"],
      ["query_bowling_aggregate", "bowling"],
    ] as const) {
      const properties = spec(tool)?.inputSchema["properties"] as Record<
        string,
        Record<string, unknown>
      >;
      const items = properties["group_by"]?.["items"] as Record<string, unknown>;
      // Alphabetical in the schema, the description and the error's `allowed` list --
      // the model reads a list, and a list it can scan beats one in an internal
      // registry order that means nothing to it. Registry order is the projection
      // order, which is a different job and stays in `dimsFor`.
      const expected = Object.keys(aggregate.dimsFor(grain)).sort();
      expect(items["enum"]).toEqual(expected);
      expect(spec(tool)?.description).toContain(`group_by values: ${expected.join(", ")}`);
    }
  });
});

describe("the runtime seam", () => {
  it("toolConfig is the exact shape Bedrock Converse takes", () => {
    const config = toolConfig();
    expect(config.tools).toHaveLength(names().length);
    for (const entry of config.tools) {
      const toolSpec = entry["toolSpec"] as Record<string, unknown>;
      expect(Object.keys(entry)).toEqual(["toolSpec"]);
      expect(Object.keys(toolSpec).sort()).toEqual(["description", "inputSchema", "name"]);
      expect(Object.keys(toolSpec["inputSchema"] as object)).toEqual(["json"]);
    }
  });

  it("an unknown tool name resolves, with the near misses", async () => {
    const result = await call("query_batting_agregate");
    expect(result.ok).toBe(false);
    const error = result.error;
    expect(error?.code).toBe("INTERNAL_ERROR");
    expect(error?.allowed).toEqual(names());
    expect(error?.did_you_mean).toContain("query_batting_aggregate");
  });

  it("stops being retryable past the attempt cap", async () => {
    const inside = await call("nope", {}, MAX_TOOL_ATTEMPTS);
    expect(inside.error?.retryable).toBe(true);
    const past = await call("nope", {}, MAX_TOOL_ATTEMPTS + 1);
    expect(past.error?.retryable).toBe(false);
    expect(past.error?.attempt).toBe(MAX_TOOL_ATTEMPTS + 1);
  });
});

describe.skipIf(!warehouseAvailable())(warehouseSuiteName("order_by errors"), () => {
  it("offers the whole registry-derived list when the value is wrong", async () => {
    const result = await call("query_batting_aggregate", {
      group_by: ["player"],
      order_by: "runs_per_dismissal",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("BAD_ENUM_VALUE");
    expect(result.error?.field).toBe("order_by");
    // The same list the schema advertised, from the same call.
    expect(result.error?.allowed).toEqual(aggregate.metricsFor("batting"));
    expect(result.error?.did_you_mean).toContain("dismissals");
  });

  it("offers the dimension list when group_by names something that is not one", async () => {
    const result = await call("query_batting_aggregate", {
      group_by: ["fielder"],
      order_by: "runs",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.field).toBe("group_by");
    expect(result.error?.allowed).toEqual(Object.keys(aggregate.dimsFor("batting")).sort());
  });

  it("reports the missing order_by before the unknown dimension", async () => {
    // Contract-level checks run first, and that ordering is the useful one: told both
    // at once the model tends to fix only the last thing it read.
    const result = await call("query_batting_aggregate", { group_by: ["fielder"] });
    expect(result.error?.code).toBe("ORDER_BY_REQUIRED");
  });
});
