import { z } from "zod";

// ---------------------------------------------------------------------------
// Errors -- shaped for one-shot self-correction, never a traceback
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  "UNKNOWN_FILTER_FIELD",
  "BAD_ENUM_VALUE",
  "NEEDS_ENTITY_RESOLUTION",
  "FILTER_NOT_APPLICABLE_TO_FORMAT",
  "MUTUALLY_EXCLUSIVE_FILTERS",
  // Its own code rather than MUTUALLY_EXCLUSIVE_FILTERS, which is where it was
  // squeezed while the Python contract was frozen. Trap D's other half is the most
  // common malformed call there is -- `group_by` with no `order_by` -- and telling
  // the model its filters conflict when they do not sends the correction the wrong way.
  "ORDER_BY_REQUIRED",
  "MISSING_SUBJECT_TEAM",
  "LIMIT_EXCEEDED",
  // A well-formed argument of the wrong JSON type: `"group_by": "player"` where a
  // list belongs. Previously this fell through to INTERNAL_ERROR, which says "the
  // tool is broken, stop trying" about input the model can fix in one edit.
  "INVALID_ARGUMENT_TYPE",
  "INTERNAL_ERROR",
] as const;

export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

/**
 * How many corrective attempts one tool gets within one turn before it is told to
 * stop correcting and explain the limitation instead.
 *
 * Named here because four places need it and three of them had written `3` inline:
 * the refinement below, the error builder, the tool registry and the agent loop's
 * last-resort handler for a tool that throws. A cap that disagrees with itself by one
 * is a loop that either gives up early or does not stop, and neither shows up as a
 * test failure -- it shows up as a bill.
 */
export const MAX_TOOL_ATTEMPTS = 3;

/**
 * Everything the model needs to fix the call on its next attempt.
 *
 * `allowed` + `did_you_mean` + `fix_example` exist so the correction is a lookup, not
 * a guess. `attempt`/`retryable` cap the loop: after {@link MAX_TOOL_ATTEMPTS}
 * corrective attempts the model is told to explain the limitation instead.
 */
export const ErrorDetail = z
  .strictObject({
    code: ErrorCode,
    // Empty string permitted: `connect()` raises before it knows which tool asked.
    tool: z.string(),
    message: z.string().min(1),
    field: z.string().nullish(),
    received: z.unknown().nullish(),
    allowed: z.array(z.string()).default([]),
    did_you_mean: z.array(z.string()).default([]),
    fix_example: z.record(z.string(), z.unknown()).nullish(),
    attempt: z.int().min(1).default(1),
    retryable: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.attempt > MAX_TOOL_ATTEMPTS && value.retryable) {
      ctx.addIssue({
        code: "custom",
        path: ["retryable"],
        message:
          `attempt > ${MAX_TOOL_ATTEMPTS} must set retryable=false so the model stops ` +
          `correcting and explains the limitation instead`,
      });
    }
  });
export type ErrorDetail = z.infer<typeof ErrorDetail>;

/** The wrapper actually returned as a `toolResult` with an error status. */
export const ErrorPayload = z.strictObject({ error: ErrorDetail });
export type ErrorPayload = z.infer<typeof ErrorPayload>;

/**
 * A handler throws this to return a correctable {@link ErrorDetail}.
 *
 * Carries the whole payload rather than a message, because the payload is the point:
 * `allowed` plus `did_you_mean` plus `fix_example` turns the model's next attempt
 * into a lookup instead of a guess.
 */
export class ToolError extends Error {
  readonly detail: ErrorDetail;

  constructor(detail: ErrorDetail) {
    super(detail.message);
    this.name = "ToolError";
    this.detail = detail;
  }
}
