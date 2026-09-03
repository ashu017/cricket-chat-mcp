// The seam. The agent runtime imports exactly two things from here.
//
// `specs()` gives the tool definitions to put in `toolConfig`; `call()` runs one and
// hands back a validated payload. Nothing else in this package is part of the contract,
// so the tool modules can be reorganised without touching the runtime.
//
// `call()` does not reject. A tool that fails resolves with `ok: false` and an
// `ErrorPayload`, because the agent loop needs to hand the model something it can
// correct from -- an exception escaping into the request handler becomes a 500, and a
// 500 is not a cricket answer.

import { z } from "zod";
import {
  type ErrorDetail,
  ErrorPayload,
  MAX_TOOL_ATTEMPTS,
  ToolResponse,
} from "../contracts/index.js";

import { bedrockSpec, connect, type JsonSchema, ToolError, type ToolSpec } from "./base.js";
import { didYouMean, repr } from "./errors.js";
import * as lookup from "./lookup.js";
import * as matchinfo from "./matchinfo.js";
import * as stats from "./stats.js";

/**
 * Registration order. It is also the order the model sees them in, and that is
 * deliberate: resolve_entity and get_data_coverage come first because almost every turn
 * should start with one of them.
 */
const TOOLS: readonly ToolSpec[] = Object.freeze([
  lookup.RESOLVE_TOOL,
  lookup.DATA_COVERAGE_TOOL,
  stats.BATTING_TOOL,
  stats.BOWLING_TOOL,
  stats.MATCHUP_TOOL,
  matchinfo.SCORECARD_TOOL,
  matchinfo.MATCHES_TOOL,
  lookup.CAREER_TOOL,
]);

const BY_NAME: ReadonlyMap<string, ToolSpec> = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function specs(): ToolSpec[] {
  return [...TOOLS];
}

export function spec(name: string): ToolSpec | undefined {
  return BY_NAME.get(name);
}

export function names(): string[] {
  return TOOLS.map((tool) => tool.name);
}

/** The exact `toolConfig` value the Bedrock Converse call takes. */
export function toolConfig(): { tools: JsonSchema[] } {
  return { tools: TOOLS.map(bedrockSpec) };
}

/**
 * One tool invocation, everything the runtime and the UI need.
 *
 * `payload` is JSON-ready and always validates: a `ToolResponse` when `ok`, an
 * `ErrorPayload` when not. `sql` travels here and stops here -- the model is given
 * `payload` only, so the 300-800 tokens of SQL never enter the context.
 */
export class ToolCallResult {
  constructor(
    readonly ok: boolean,
    readonly payload: Record<string, unknown>,
    readonly sql: string | null = null,
    readonly ms: number = 0,
    readonly deliveriesScanned: number | null = null,
  ) {}

  get sqlId(): string | null {
    const value = this.payload["sql_id"];
    return typeof value === "string" ? value : null;
  }

  get response(): ToolResponse | null {
    return this.ok ? ToolResponse.parse(this.payload) : null;
  }

  get error(): ErrorDetail | null {
    return this.ok ? null : ErrorPayload.parse(this.payload).error;
  }
}

/**
 * Run one tool. Never rejects.
 *
 * `attempt` is the corrective-retry counter the agent loop maintains. It is stamped onto
 * any error so that the fourth attempt comes back with `retryable: false`, which is the
 * model's signal to stop correcting and explain the limitation instead of looping until
 * the turn budget runs out.
 */
export async function call(
  name: string,
  args: Readonly<Record<string, unknown>> = {},
  attempt = 1,
): Promise<ToolCallResult> {
  const started = performance.now();
  const elapsed = (): number => Math.trunc(performance.now() - started);

  const failure = (detail: Record<string, unknown>): ToolCallResult => {
    // Re-stamp attempt/retryable centrally so no individual tool has to remember the
    // cap.
    const payload = ErrorPayload.parse({
      error: { ...detail, attempt, retryable: attempt <= MAX_TOOL_ATTEMPTS },
    });
    return new ToolCallResult(
      false,
      payload as unknown as Record<string, unknown>,
      null,
      elapsed(),
    );
  };

  const chosen = BY_NAME.get(name);
  if (chosen === undefined) {
    return failure({
      code: "INTERNAL_ERROR",
      tool: name,
      message: `there is no tool called ${repr(name)}.`,
      allowed: names(),
      did_you_mean: didYouMean(name, names()),
    });
  }

  let db: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    db = await connect();
    const outcome = await chosen.handler(db, { ...args });
    return new ToolCallResult(
      true,
      outcome.response as unknown as Record<string, unknown>,
      outcome.sql ?? null,
      elapsed(),
      outcome.deliveriesScanned ?? null,
    );
  } catch (thrown) {
    if (thrown instanceof ToolError) {
      const detail = thrown.detail;
      return failure({ ...detail, tool: detail.tool || name });
    }
    if (thrown instanceof z.ZodError) {
      // A response that fails its own contract is a bug in this package, not bad input,
      // and it must surface as one rather than as a plausible-looking partial answer.
      return failure({
        code: "INTERNAL_ERROR",
        tool: name,
        message: `the tool built a response that does not satisfy the contract: ${z.prettifyError(thrown)}`,
        retryable: false,
      });
    }
    // The runtime must not see a stack trace.
    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    return failure({
      code: "INTERNAL_ERROR",
      tool: name,
      message: `${error.name}: ${error.message}`,
      retryable: false,
    });
  } finally {
    db?.close();
  }
}

/**
 * The same two functions, under the names a host runtime duck-types for.
 *
 * The MCP server in `src/mcp/` calls `specs()` and `call()` directly and does not need
 * this. It exists for the other kind of consumer: an agent loop that reaches the tools
 * through a dynamic `import()` of a module *name* and then looks the result up by method,
 * which is how the upstream Bedrock loop loads them. That arrangement failed exactly once,
 * and instructively: the loop looked for `listTools`/`invokeTool`, this module exported
 * `specs`/`call`, nothing reconciled the two, and every live turn was refused with
 * "exports no tool registry" while every test stayed green -- because replay mode never
 * loads a tool at all. This object is that reconciliation, and it lives here because this
 * is the side that knows what it exports.
 *
 * `listTools` hands over the Bedrock-shaped specs rather than the `ToolSpec`s: the
 * runtime accepts either, and this is the form it would otherwise rebuild. `invokeTool`
 * only has to move `attempt` out of an options bag, because `ToolCallResult` already
 * carries `ok`/`payload`/`sql`/`ms`/`deliveriesScanned` -- which is the runtime's
 * `ToolOutcome` exactly.
 */
export const registry = {
  listTools: (): JsonSchema[] => toolConfig().tools,
  invokeTool: (
    name: string,
    input: Readonly<Record<string, unknown>> = {},
    options?: { attempt?: number },
  ): Promise<ToolCallResult> => call(name, input, options?.attempt ?? 1),
  toolConfig,
} as const;
