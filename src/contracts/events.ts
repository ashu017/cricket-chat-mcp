import { z } from "zod";
import { ErrorDetail } from "./errors.js";
import { ToolResponse } from "./response.js";
import { ResultShape } from "./scalars.js";

// ---------------------------------------------------------------------------
// SSE events -- the agent/browser seam
// ---------------------------------------------------------------------------
// Six event types, fixed payloads, documented in docs/sse-events.md. The agent emits
// exactly these; the web app renders exactly these. Adding a seventh is an interface
// change and goes through the integrator.
//
// `type` is required on every event, where the Python models defaulted it. On the
// wire it is always present -- it is the discriminator -- and a default on a
// discriminated union's tag is a schema that cannot discriminate an absent key.
// The `*Event` helper constructors below keep producing one terse.

export const TokenEvent = z.strictObject({
  type: z.literal("token"),
  text: z.string(),
});
export type TokenEvent = z.infer<typeof TokenEvent>;

/**
 * Rendered as a status line, but only after 400 ms of dwell.
 *
 * `label` is verb + object in the user's language ("Scanning death overs, 2020-2026"),
 * never the tool name: "calling query_bowling_aggregate" tells a reader nothing and
 * reads as latency. `shape` lets the UI draw a skeleton of the right size so the
 * layout does not jump when rows arrive.
 */
export const ToolStartEvent = z.strictObject({
  type: z.literal("tool_start"),
  tool_use_id: z.string().min(1),
  tool: z.string().min(1),
  label: z.string().min(1),
  shape: ResultShape.default("unknown"),
});
export type ToolStartEvent = z.infer<typeof ToolStartEvent>;

const toolResultShape = {
  type: z.literal("tool_result"),
  tool_use_id: z.string().min(1),
  tool: z.string().min(1),
  ok: z.boolean(),
  ms: z.int().min(0),
  response: ToolResponse.nullish(),
  error: ErrorDetail.nullish(),
  sql: z.string().nullish(),
  sql_id: z.string().nullish(),
} as const;

function toolResultChecks(
  value: { ok: boolean; response?: unknown; error?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (value.ok && value.response == null) {
    ctx.addIssue({ code: "custom", path: ["response"], message: "ok=true requires a response" });
  }
  if (!value.ok && value.error == null) {
    ctx.addIssue({ code: "custom", path: ["error"], message: "ok=false requires an error" });
  }
  if (value.response != null && value.error != null) {
    ctx.addIssue({
      code: "custom",
      path: ["error"],
      message: "a tool result is either a response or an error, not both",
    });
  }
}

/**
 * Collapses the status line upward into a permanent receipt.
 *
 * Exactly one of `response` / `error` is set. `sql` travels here and only here -- the
 * model never sees it.
 */
export const ToolResultEvent = z.strictObject(toolResultShape).superRefine(toolResultChecks);
export type ToolResultEvent = z.infer<typeof ToolResultEvent>;

/**
 * The one line that persists under the answer. Persistence is the point: a status
 * message that disappears reads as latency, a receipt reads as work.
 */
export const ReceiptEvent = z.strictObject({
  type: z.literal("receipt"),
  queries: z.int().min(0),
  ms: z.int().min(0),
  deliveries_scanned: z.int().min(0).nullish(),
});
export type ReceiptEvent = z.infer<typeof ReceiptEvent>;

/**
 * Bedrock's own field names, snake_cased once and then kept verbatim so they cannot
 * be mistranslated.
 *
 * `totalInput` is the sum of all three input counters. With prompt caching on,
 * `input_tokens` counts only the NON-cached input, so summing it with output alone
 * under-reports by most of the prompt on every cache hit.
 */
export const TokenUsage = z.strictObject({
  input_tokens: z.int().min(0),
  output_tokens: z.int().min(0),
  cache_read_input_tokens: z.int().min(0).default(0),
  cache_write_input_tokens: z.int().min(0).default(0),
  est_usd: z.number().nullish(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

/**
 * The real input total. Functions rather than getters because these objects arrive
 * from `JSON.parse` across the SSE boundary, where a class property would not survive.
 */
export function totalInputTokens(usage: TokenUsage): number {
  return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_write_input_tokens;
}

export function totalTokens(usage: TokenUsage): number {
  return totalInputTokens(usage) + usage.output_tokens;
}

/**
 * A mid-stream failure. The UI keeps everything already streamed and appends an
 * inline retry -- never wipes the turn, never shows a toast.
 */
export const ErrorEvent = z.strictObject({
  type: z.literal("error"),
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean().default(true),
});
export type ErrorEvent = z.infer<typeof ErrorEvent>;

/**
 * Terminal. `followups` are model-generated from *this* answer, which is what
 * demonstrates the multi-turn wedge instead of a fixed chip strip.
 */
export const DoneEvent = z.strictObject({
  type: z.literal("done"),
  stop_reason: z.string().min(1),
  usage: TokenUsage.nullish(),
  followups: z.array(z.string()).default([]),
});
export type DoneEvent = z.infer<typeof DoneEvent>;

/**
 * The wire union.
 *
 * The discriminated union is built from the *unrefined* `tool_result` object and the
 * cross-field rule is reapplied here, because a union can only discriminate on a
 * plain object's literal tag. `ToolResultEvent` above carries the same rule for
 * anyone validating one on its own.
 */
export const Event = z
  .discriminatedUnion("type", [
    TokenEvent,
    ToolStartEvent,
    z.strictObject(toolResultShape),
    ReceiptEvent,
    ErrorEvent,
    DoneEvent,
  ])
  .superRefine((value, ctx) => {
    if (value.type === "tool_result") toolResultChecks(value, ctx);
  });
export type Event = z.infer<typeof Event>;

export const EVENT_TYPES = [
  "token",
  "tool_start",
  "tool_result",
  "receipt",
  "error",
  "done",
] as const;

/**
 * A recorded turn. This is what `evals/transcripts/*.json` holds, what
 * `CRICKET_CHAT_REPLAY` serves, and what the web app is built against.
 *
 * The web app may assert on event *shape*. It may not assert on the numbers: these
 * files are re-recorded from the real stack, so a test pinned to a strike rate breaks
 * on the day the two halves next meet.
 */
export const Transcript = z
  .strictObject({
    id: z.string().min(1),
    prompt: z.string().min(1),
    /**
     * Never edit a recorded transcript by hand to make a UI test pass. `from-stack`
     * means the numbers in it were computed; `hand-written` means they were not and
     * must not be quoted anywhere a reader could mistake them for measurements.
     */
    recorded: z.enum(["hand-written", "from-stack"]).default("hand-written"),
    events: z.array(Event),
  })
  .superRefine((value, ctx) => {
    if (value.events.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["events"],
        message: "a transcript with no events cannot exercise anything",
      });
      return;
    }
    const terminal = value.events.filter((event) => event.type === "done");
    if (terminal.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["events"],
        message: `expected exactly one done event, found ${terminal.length}`,
      });
    }
    if (value.events.at(-1)?.type !== "done") {
      ctx.addIssue({
        code: "custom",
        path: ["events"],
        message: "the done event must be last",
      });
    }
    const starts = new Set(
      value.events.filter((e) => e.type === "tool_start").map((e) => e.tool_use_id),
    );
    const results = new Set(
      value.events.filter((e) => e.type === "tool_result").map((e) => e.tool_use_id),
    );
    const unmatched = [
      ...[...starts].filter((id) => !results.has(id)),
      ...[...results].filter((id) => !starts.has(id)),
    ].sort();
    if (unmatched.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["events"],
        message: `every tool_start needs its tool_result: unmatched ${unmatched.join(", ")}`,
      });
    }
  });
export type Transcript = z.infer<typeof Transcript>;
