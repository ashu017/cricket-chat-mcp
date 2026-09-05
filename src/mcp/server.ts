// The MCP server: the eight tools, spoken over the Model Context Protocol.
//
// ## Why the low-level `Server` and not `McpServer`
//
// The SDK's ergonomic wrapper, `McpServer.registerTool`, types `inputSchema` as
// `ZodRawShapeCompat | AnySchema`, and `AnySchema` is `z3.ZodTypeAny | z4.$ZodType` -- Zod,
// only ever Zod. Anything else is rejected at runtime with "inputSchema must be a Zod schema
// or raw shape". Our `ToolSpec.inputSchema` is hand-written JSON Schema, deliberately: the
// schema *is* part of the prompt, `tools lint` asserts its shape, and every enum value in it
// was chosen for how the model reads it. Round-tripping that through Zod and back out through
// a JSON Schema generator would hand the model a different document than the one that was
// tuned, so the conversion layer is not a neutral adapter -- it is a rewrite of the prompt.
//
// So this uses `Server` from `server/index.js`, which takes JSON Schema as-is. It carries an
// `@deprecated Use McpServer instead` marker; that marker is about ergonomics, and `McpServer`
// is itself implemented on top of this class. It is also the only one of the two whose options
// accept `instructions`, which this server cannot do without (see `instructions.ts`).
//
// ## Why a failed tool is a *result*, not a thrown error
//
// `registry.call()` never rejects: a failure comes back as `ok: false` carrying an
// `ErrorPayload` built for one-shot self-correction -- the real field name, the allowed
// values, a worked `fix_example`. Throwing here would turn all of that into a JSON-RPC
// error, which most hosts surface to the *user* as a red box rather than to the model as
// something to read and fix. So failures return normally with `isError: true` and the payload
// as the content. The model gets the correction; the host gets a well-formed response.

import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { MAX_TOOL_ATTEMPTS } from "../contracts/index.js";
import { fromPackageRoot } from "../core/warehouse.js";
import type { ToolSpec } from "../tools/base.js";
import { call, specs } from "../tools/registry.js";
import { INSTRUCTIONS } from "./instructions.js";
import { getPrompt, promptDefinitions } from "./prompts.js";

export const SERVER_NAME = "cricket-chat-mcp";

/**
 * The published version, read from `package.json` rather than duplicated here.
 *
 * A hardcoded string is a string that goes stale on the release that forgets it, and a
 * server reporting the wrong version during `initialize` is a bug report nobody can
 * reproduce. `package.json` is always in the tarball, so this works installed as well as
 * from source.
 */
export function packageVersion(): string {
  const raw = readFileSync(fromPackageRoot("package.json"), "utf8");
  const parsed: unknown = JSON.parse(raw);
  const version =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)["version"]
      : undefined;
  return typeof version === "string" ? version : "0.0.0";
}

/**
 * One tool, as MCP describes tools.
 *
 * This is the whole reason `ToolSpec` was shaped the way it was: MCP wants a name, a
 * description and a JSON Schema, which is exactly what a spec already carries.
 *
 * The annotations are not decoration. `readOnlyHint` is true because the warehouse is opened
 * `READ_ONLY` and there is no code path that writes; `openWorldHint` is false because every
 * answer comes from one local file, so a host is right to treat these calls as repeatable and
 * safe to run without asking.
 */
function toolDefinition(spec: ToolSpec): Tool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema as Tool["inputSchema"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

export interface CricketServer {
  server: Server;
  /**
   * Resolves once no tool call is in flight.
   *
   * Needed because closing the transport is not the same thing as being finished: a client
   * that hangs up (or a piped file that simply runs out) can end stdin while several
   * `tools/call` requests are still awaiting DuckDB. Closing at that moment drops their
   * responses on the floor, which looks exactly like a server that answered some questions
   * and silently ignored the rest.
   */
  idle(): Promise<void>;
}

/**
 * An MCP server with the eight tools registered. Not yet connected to a transport.
 *
 * Separated from `bin.ts` so a test can drive it over an in-memory transport pair without
 * spawning a process.
 */
export function createServer(): CricketServer {
  const server = new Server(
    { name: SERVER_NAME, version: packageVersion() },
    // `prompts` is declared as well as `tools` because a capability that is not declared is
    // one the host will never ask about -- `prompts/list` is simply not sent, and the handler
    // below would be dead code.
    { capabilities: { tools: {}, prompts: {} }, instructions: INSTRUCTIONS },
  );

  // Consecutive failures per tool, so `attempt` and `retryable` mean something here.
  //
  // Upstream the agent loop owned this counter. Over MCP there is no loop of ours to own it:
  // the host model decides when to retry, and each call arrives with no memory of the last.
  // Without this map every failure would be stamped `attempt: 1, retryable: true` forever,
  // and the "stop after three corrections" rule in the instructions would be a claim the
  // server never actually honours.
  //
  // Keyed by tool name and cleared on that tool's next success, because the thing worth
  // counting is a model stuck correcting *one* call -- not the total number of mistakes in a
  // long session, which would eventually refuse a first attempt out of nowhere.
  const failures = new Map<string, number>();

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: specs().map(toolDefinition),
  }));

  // Prompts, unlike tools, are chosen by the *user* -- they arrive in Claude Code as
  // `/mcp__cricket__<name>` and in Claude Desktop's prompt picker. Neither handler touches the
  // warehouse, so neither is tracked by `idle()`: a `prompts/get` is a string substitution and
  // has returned long before a shutdown could race it.
  server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: promptDefinitions() }));

  server.setRequestHandler(GetPromptRequestSchema, (request) =>
    getPrompt(request.params.name, request.params.arguments ?? {}),
  );

  const inFlight = new Set<Promise<void>>();

  const handleCall = async (name: string, args: Record<string, unknown>) => {
    const attempt = (failures.get(name) ?? 0) + 1;

    const result = await call(name, args, attempt);

    if (result.ok) {
      failures.delete(name);
    } else {
      // Clamp so a model that keeps hammering one tool does not inflate `attempt` without
      // limit. Past the cap the number carries no more information -- `retryable: false` is
      // already the whole message.
      failures.set(name, Math.min(attempt, MAX_TOOL_ATTEMPTS + 1));
    }

    // Compact JSON, one text block. Not `structuredContent`: that is meant to be checked
    // against a declared `outputSchema`, these tools declare none, and the payload is already
    // a validated `ToolResponse`. And the full SQL stops here, as it does upstream -- it is
    // 300-800 tokens the model does not need to write prose, and `sql_id` is in the payload
    // for anyone who wants to correlate two calls.
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.payload) }],
      isError: !result.ok,
    };
  };

  server.setRequestHandler(CallToolRequestSchema, (request): Promise<CallToolResult> => {
    const work = handleCall(request.params.name, request.params.arguments ?? {});

    // What `idle()` tracks is deliberately not `work` itself. The protocol serialises and
    // sends the response in a callback on `work`, so a set keyed on `work` empties one
    // macrotask *before* anything is written -- and a shutdown in that gap drops the reply
    // of whichever tool happened to finish last. Waiting a turn past settlement is enough
    // for the send to be queued on stdout, and a queued write keeps the process alive until
    // it flushes. `.then(ok, err)` rather than `.finally` because a rejected handler must
    // not make `idle()` reject.
    const settled = work.then(
      () => new Promise<void>((resolve) => setImmediate(resolve)),
      () => new Promise<void>((resolve) => setImmediate(resolve)),
    );
    inFlight.add(settled);
    void settled.then(() => inFlight.delete(settled));

    return work;
  });

  return {
    server,
    idle: async (): Promise<void> => {
      // Looped, not a single `allSettled`: a handler could in principle enqueue more work,
      // and one pass would then return with the set non-empty.
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
  };
}
