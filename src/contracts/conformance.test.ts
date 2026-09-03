import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { ERROR_CODES, ErrorPayload } from "./errors.js";
import { Event, Transcript, totalInputTokens, totalTokens } from "./events.js";
import { ToolResponse } from "./response.js";

// ---------------------------------------------------------------------------
// The conformance gate
// ---------------------------------------------------------------------------
//
// The Python implementation is the oracle for this port. These fixtures were written
// BY it -- 24 tool payloads and 6 SSE transcripts, all committed -- so if the Zod
// schemas and the pydantic models have drifted by so much as a nullable field, that
// drift shows up here and not three packages downstream.
//
// This is why `.nullish()` is on every nullable field: pydantic writes an explicit
// `null` where TypeScript would omit the key. See the header of response.ts.
//
// Shape only. Never assert on a number in a fixture -- the transcripts get re-recorded
// from the real warehouse, and a test pinned to a strike rate breaks on that day.

const packageRootDir = fileURLToPath(new URL("../../", import.meta.url));
const payloadDir = join(packageRootDir, "tests/fixtures/tool_payloads");
const transcriptDir = join(packageRootDir, "tests/fixtures/transcripts");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function jsonFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

/** A readable failure. `error.message` on its own is a wall of unlabelled issues. */
function explain(name: string, error: z.ZodError): string {
  const issues = error.issues
    .map((issue) => `  ${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("\n");
  return `${name} does not conform:\n${issues}`;
}

const payloadFiles = jsonFiles(payloadDir);
const transcriptFiles = jsonFiles(transcriptDir);

describe("tool payload fixtures", () => {
  it("finds the committed fixtures", () => {
    // Guards against a path change silently turning this whole suite into a no-op.
    expect(payloadFiles.length).toBeGreaterThanOrEqual(24);
  });

  for (const name of payloadFiles) {
    it(`${name} parses`, () => {
      const raw = readJson(join(payloadDir, name)) as Record<string, unknown>;
      const schema = "error" in raw ? ErrorPayload : ToolResponse;
      const result = schema.safeParse(raw);
      if (!result.success) throw new Error(explain(name, result.error));
    });
  }

  it("covers both outcome shapes", () => {
    const shapes = payloadFiles.map((name) =>
      "error" in (readJson(join(payloadDir, name)) as object) ? "error" : "response",
    );
    expect(shapes).toContain("error");
    expect(shapes).toContain("response");
  });

  it("exercises every error code the fixtures claim to cover", () => {
    const seen = new Set<string>();
    for (const name of payloadFiles) {
      const raw = readJson(join(payloadDir, name)) as { error?: { code?: string } };
      if (raw.error?.code) seen.add(raw.error.code);
    }
    // Not every code needs a fixture, but every code a fixture uses must be a real one.
    for (const code of seen) expect(ERROR_CODES).toContain(code);
  });
});

describe("SSE transcripts", () => {
  it("finds the committed transcripts", () => {
    expect(transcriptFiles.length).toBeGreaterThanOrEqual(3);
  });

  for (const name of transcriptFiles) {
    it(`${name} parses`, () => {
      const result = Transcript.safeParse(readJson(join(transcriptDir, name)));
      if (!result.success) throw new Error(explain(name, result.error));
    });
  }

  it("every event in every transcript parses on its own", () => {
    // The Transcript schema parses events as part of a whole; the shim and the browser
    // parse them one line at a time. Both paths must accept the same bytes.
    for (const name of transcriptFiles) {
      const raw = readJson(join(transcriptDir, name)) as { events: unknown[] };
      for (const [i, event] of raw.events.entries()) {
        const result = Event.safeParse(event);
        if (!result.success) throw new Error(explain(`${name} event ${i}`, result.error));
      }
    }
  });

  it("the recorded flag is honest about which transcripts hold measured numbers", () => {
    // Not an assertion about which value is correct -- an assertion that the field is
    // populated, so a hand-written transcript cannot pass itself off as a recording by
    // omission.
    for (const name of transcriptFiles) {
      const parsed = Transcript.parse(readJson(join(transcriptDir, name)));
      expect(["hand-written", "from-stack"]).toContain(parsed.recorded);
    }
  });
});

describe("caching-aware token accounting", () => {
  // The rule the Python side has a test for, ported: with prompt caching on,
  // `input_tokens` counts only the NON-cached input. A measured turn gave
  // input=95, cache_read=4168 -- so the naive sum under-reports by 98%.
  const usage = {
    input_tokens: 95,
    output_tokens: 210,
    cache_read_input_tokens: 4168,
    cache_write_input_tokens: 0,
  };

  it("counts cache reads and writes as input", () => {
    expect(totalInputTokens(usage)).toBe(4263);
    expect(totalTokens(usage)).toBe(4473);
  });

  it("is not the naive input_tokens sum", () => {
    expect(totalTokens(usage)).not.toBe(usage.input_tokens + usage.output_tokens);
  });

  it("survives a JSON round-trip", () => {
    // These are functions, not getters, precisely because usage objects arrive from
    // JSON.parse across the SSE boundary.
    const revived = JSON.parse(JSON.stringify(usage)) as typeof usage;
    expect(totalInputTokens(revived)).toBe(4263);
  });
});
