#!/usr/bin/env node

// The executable. `npx cricket-chat-mcp`, or whatever an MCP client spawns.
//
// The one rule that shapes this whole file: **stdout belongs to the protocol.** A stdio MCP
// server speaks newline-delimited JSON-RPC over stdout, so a single stray `console.log` --
// a startup banner, a progress line, a debug dump -- corrupts the stream and the client
// reports a parse error with no obvious cause. Everything diagnostic goes to stderr, which
// hosts collect into their logs. `--help` and `--version` may use stdout because they print
// and exit without ever starting a transport.

import { existsSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { split, stringFlag, UsageError, unknownFlags } from "./core/argv.js";
import { DB_ENV_VAR, dbPath } from "./core/warehouse.js";
import { createServer, packageVersion, SERVER_NAME } from "./mcp/server.js";
import { closeWarehouses } from "./tools/base.js";

const VALUE_FLAGS = new Set(["db"]);
const KNOWN_FLAGS = new Set(["db", "help", "version"]);

const HELP = `${SERVER_NAME} -- cricket analytics over ball-by-ball data, as an MCP server

Usage:
  ${SERVER_NAME} [--db PATH]

Speaks the Model Context Protocol over stdin/stdout. It is meant to be spawned by an MCP
client rather than run by hand; started in a terminal it will sit and wait for JSON-RPC.

Options:
  --db PATH     Warehouse to query. Overrides ${DB_ENV_VAR}. Defaults to the DuckDB file
                bundled with this package, so the usual case needs no flag at all.
  --version     Print the version and exit.
  --help        Print this and exit.

Add it to an MCP client with:

  {
    "mcpServers": {
      "cricket": { "command": "npx", "args": ["-y", "${SERVER_NAME}"] }
    }
  }

Data from Cricsheet (https://cricsheet.org), licensed ODC-BY 1.0.
`;

async function main(argv: readonly string[]): Promise<number> {
  const { positional, flags } = split(argv, VALUE_FLAGS);

  const unknown = unknownFlags(flags, KNOWN_FLAGS);
  if (unknown.length > 0) {
    throw new UsageError(`unknown flag${unknown.length > 1 ? "s" : ""}: --${unknown.join(", --")}`);
  }
  if (positional.length > 0) {
    // There are no subcommands, so a positional is always a mistake -- and a silently
    // ignored one would make `cricket-chat-mcp data/other.duckdb` look like it worked.
    throw new UsageError(`unexpected argument ${JSON.stringify(positional[0])}; see --help`);
  }

  if (flags.has("help")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (flags.has("version")) {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }

  const db = stringFlag(flags, "db");
  if (db !== null) {
    // Set the env var rather than threading a path through every call site: `dbPath()` is
    // read lazily, on the first tool call, so this lands well before anything opens a file.
    process.env[DB_ENV_VAR] = db;
  }

  // A startup check, purely so the failure is legible. Without it the first symptom of a
  // missing warehouse is a tool error mid-conversation, several minutes after the client
  // was configured, in a log nobody is watching.
  if (!existsSync(dbPath())) {
    process.stderr.write(
      `${SERVER_NAME}: no warehouse at ${dbPath()}. Tool calls will fail until this exists.\n`,
    );
  }

  const { server, idle } = createServer();
  const transport = new StdioServerTransport();

  // Resolve when the client hangs up -- returning before that would exit the process while
  // the transport is still open, which the host sees as a server that crashed on startup.
  //
  // Two subtleties, both of which cost a debugging session to find:
  //
  //   1. This hooks `server.onclose`, not `transport.onclose`. `connect()` installs its own
  //      `transport.onclose` to drive protocol teardown (rejecting in-flight requests), so
  //      assigning that field afterwards replaces the SDK's handler rather than adding to
  //      it -- silently, since nothing complains and the happy path still works.
  //   2. `StdioServerTransport` subscribes to stdin's `data` and `error` only. Nothing
  //      watches for the pipe closing, so a client that hangs up leaves this promise
  //      pending forever and node exits 13 on an unsettled top-level await. Closing the
  //      transport on `end` is what turns a hangup into an ordinary shutdown -- but only
  //      *after* `idle()`, because stdin ending says the client sent everything, not that
  //      we have answered it. Closing immediately truncates in-flight replies.
  const closed = new Promise<void>((resolve) => {
    server.onclose = resolve;
  });
  const drainAndClose = (): void => {
    void idle().then(() => transport.close());
  };
  process.stdin.once("end", drainAndClose);
  process.stdin.once("close", drainAndClose);

  // The DuckDB instance is cached for the process lifetime, so it has to be released on the
  // way out or a client that restarts servers repeatedly leaks a file handle per restart.
  //
  // A signal is not a hangup: it means stop now, so this does not drain first.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      closeWarehouses();
      void server.close().finally(() => process.exit(0));
    });
  }

  await server.connect(transport);
  await closed;
  closeWarehouses();
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (thrown) {
  if (thrown instanceof UsageError) {
    process.stderr.write(`${SERVER_NAME}: ${thrown.message}\n`);
    process.exitCode = 2;
  } else {
    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    process.stderr.write(`${SERVER_NAME}: ${error.name}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
