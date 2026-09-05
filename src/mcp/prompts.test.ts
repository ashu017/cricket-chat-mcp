// The prompts, tested for the three ways a prompt goes quietly wrong.
//
//   1. **A declared argument nothing consumes.** The host collects it, the user types it, and
//      the rendered text ignores it -- so the prompt answers a different question than the one
//      asked and there is no error anywhere. Checked by rendering each argument two ways and
//      requiring the output to change.
//   2. **A required argument that renders anyway.** An empty `player` would produce a
//      grammatical instruction to split nobody's record, which a model will then attempt.
//   3. **Drift from the tool layer.** Every tool and filter field named in prompt text has to
//      exist. A prompt that says `group_by: ["home_away"]` when the dimension was renamed is
//      worse than no prompt: it teaches the model a call that fails.
//
// No database is touched here -- rendering is string substitution -- so this suite runs on a
// fresh clone.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { knownFields } from "../core/filters.js";
import * as aggregate from "../tools/aggregate.js";
import { specs } from "../tools/registry.js";
import { getPrompt, PROMPT_SPECS, promptDefinitions } from "./prompts.js";
import { createServer } from "./server.js";

/**
 * Two distinct plausible values per argument name, for the "is it consumed" check.
 *
 * Distinct *and* valid: swapping `role` between `batting` and `bowling` has to reach the
 * branch that picks the tool, which a pair of nonsense strings would not.
 */
const VALUES: Readonly<Record<string, readonly [string, string]>> = {
  player: ["Rohit Sharma", "MS Dhoni"],
  batter: ["Virat Kohli", "Joe Root"],
  bowler: ["Jasprit Bumrah", "Rashid Khan"],
  role: ["batting", "bowling"],
  phase: ["powerplay", "death"],
  metric: ["strike_rate", "boundary_pct"],
  since: ["2020-01-01", "2015-06-30"],
  format: ["Test", "ODI"],
  context: ["the Indian Premier League", "death overs since 2022"],
};

/** Every argument filled, so a template's optional branches are all taken. */
function everyArgument(spec: (typeof PROMPT_SPECS)[number]): Record<string, string> {
  const args: Record<string, string> = {};
  for (const one of spec.arguments) {
    const pair = VALUES[one.name];
    if (pair) args[one.name] = pair[0];
  }
  return args;
}

function textOf(name: string, args: Record<string, string>): string {
  const result = getPrompt(name, args);
  expect(result.messages).toHaveLength(1);
  const [message] = result.messages;
  expect(message?.role).toBe("user");
  expect(message?.content.type).toBe("text");
  return message?.content.type === "text" ? message.content.text : "";
}

describe("the declared prompts", () => {
  it("names each prompt once and describes it", () => {
    const definitions = promptDefinitions();
    expect(definitions).toHaveLength(PROMPT_SPECS.length);
    expect(new Set(definitions.map((one) => one.name)).size).toBe(definitions.length);
    for (const definition of definitions) {
      // The description is the whole basis on which a user picks one out of a list.
      expect(definition.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(definition.title?.length ?? 0).toBeGreaterThan(8);
      expect(definition.description?.length ?? 0).toBeGreaterThan(40);
    }
  });

  it("has a test value for every argument it declares", () => {
    // Guards the guard: an argument added without a pair here would silently skip the
    // consumption check below rather than fail it.
    const missing = PROMPT_SPECS.flatMap((spec) =>
      spec.arguments.filter((one) => !VALUES[one.name]).map((one) => `${spec.name}.${one.name}`),
    );
    expect(missing).toEqual([]);
  });

  it("declares `required` only where the template enforces it", () => {
    for (const spec of PROMPT_SPECS) {
      for (const argument of spec.arguments) {
        const args = everyArgument(spec);
        delete args[argument.name];
        if (argument.required === true) {
          expect(() => getPrompt(spec.name, args), `${spec.name}.${argument.name}`).toThrow(
            argument.name,
          );
        } else {
          expect(() => getPrompt(spec.name, args), `${spec.name}.${argument.name}`).not.toThrow();
        }
      }
    }
  });

  it("treats blank and absent as the same missing argument", () => {
    // A host that sends every declared field with an empty string -- a form submission with
    // one box untouched -- must not render an instruction about nobody.
    for (const spec of PROMPT_SPECS) {
      for (const argument of spec.arguments.filter((one) => one.required === true)) {
        const args = { ...everyArgument(spec), [argument.name]: "   " };
        expect(() => getPrompt(spec.name, args)).toThrow(argument.name);
      }
    }
  });
});

describe("every argument reaches the text", () => {
  for (const spec of PROMPT_SPECS) {
    for (const argument of spec.arguments) {
      it(`${spec.name} consumes ${argument.name}`, () => {
        const pair = VALUES[argument.name] as readonly [string, string];
        const base = everyArgument(spec);
        const first = textOf(spec.name, { ...base, [argument.name]: pair[0] });
        const second = textOf(spec.name, { ...base, [argument.name]: pair[1] });
        // The property that catches a decorative argument: changing it must change the
        // instruction. Verbatim interpolation is one way to satisfy this, a branch is another
        // -- `role` picks the tool name rather than appearing as the word "bowling" alone.
        expect(first, `${spec.name}.${argument.name} is not consumed`).not.toBe(second);
      });
    }
  }

  it("renders without the optional arguments too", () => {
    for (const spec of PROMPT_SPECS) {
      const args: Record<string, string> = {};
      for (const one of spec.arguments.filter((two) => two.required === true)) {
        args[one.name] = (VALUES[one.name] as readonly [string, string])[0];
      }
      const text = textOf(spec.name, args);
      expect(text.length).toBeGreaterThan(200);
      // An unfilled optional must not leave the sentence it was in behind. `undefined` or a
      // dangling "Restrict it to: ." both read as a bug to the model.
      expect(text).not.toContain("undefined");
      expect(text).not.toMatch(/: \.$/m);
    }
  });
});

describe("the text agrees with the tool layer", () => {
  const rendered = PROMPT_SPECS.map((spec) => textOf(spec.name, everyArgument(spec))).join("\n");

  it("names only tools that exist", () => {
    const known = new Set(specs().map((spec) => spec.name));
    const named = new Set(rendered.match(/`(?:query|get|resolve)_[a-z_]+`/g) ?? []);
    expect(named.size).toBeGreaterThan(3);
    for (const backticked of named) {
      const name = backticked.replaceAll("`", "");
      expect(known, `prompt text names a tool that does not exist: ${name}`).toContain(name);
    }
  });

  it("names only filter fields that exist", () => {
    const known = new Set(knownFields());
    for (const match of rendered.matchAll(/`filters\.([a-z_]+)/g)) {
      expect(known, `prompt text names an unknown filter: ${match[1]}`).toContain(match[1]);
    }
    // Spelled out separately because these appear without the `filters.` prefix, and they are
    // the two the home/away prompt is entirely about.
    for (const field of ["batting_home_away", "bowling_home_away"]) {
      expect(known).toContain(field);
    }
  });

  it("groups and orders by dimensions and metrics that exist", () => {
    expect(rendered).toContain('group_by: ["home_away"]');
    expect(aggregate.BATTING_DIMS).toHaveProperty("home_away");
    expect(aggregate.BATTING_DIMS).toHaveProperty("player");

    // Every default `order_by` the leaderboard prompt can emit has to be a real metric on the
    // grain it emitted it for -- the failure would be a prompt that reliably produces a
    // BAD_ENUM_VALUE on its first call.
    expect(aggregate.metricsFor("batting")).toContain("strike_rate");
    expect(aggregate.metricsFor("bowling")).toContain("economy");
    for (const [role, grain] of [
      ["batting", "batting"],
      ["bowling", "bowling"],
    ] as const) {
      const text = textOf("phase_leaderboard", { phase: "death", role });
      const metric = /order_by: "([a-z_]+)"/.exec(text)?.[1];
      expect(aggregate.metricsFor(grain), `${role} default order_by`).toContain(metric);
    }
  });

  it("keeps the caveats the responses will actually carry", () => {
    // Each of these is a field name or value the model will see in a payload. A prompt that
    // taught a different vocabulary than the responses use is the failure mode `instructions`
    // warns about, restated at the prompt layer.
    expect(rendered).toContain("career_possibly_truncated");
    expect(rendered).toContain("matches_in_scope");
    expect(rendered).toContain("qualification");
    expect(rendered).toContain('provenance: "reference"');
    expect(rendered).toContain("neutral");
  });
});

describe("an unknown prompt", () => {
  it("fails naming the ones that exist", () => {
    expect(() => getPrompt("best_batsman")).toThrow(/Unknown prompt/);
    expect(() => getPrompt("best_batsman")).toThrow(/home_away_split/);
  });
});

describe("over the protocol", () => {
  /** A client and the real server, talking to each other in this process. */
  const connected = async (): Promise<Client> => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const { server } = createServer();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return client;
  };

  it("declares the capability, without which no host ever asks", async () => {
    // The failure this catches: handlers registered, `capabilities.prompts` forgotten. The
    // server works in every unit test and the prompts are invisible in every client, because
    // `prompts/list` is never sent.
    const client = await connected();
    try {
      expect(client.getServerCapabilities()?.prompts).toBeDefined();
      expect(client.getServerCapabilities()?.tools).toBeDefined();
      // `instructions` is the other thing only the low-level `Server` can carry, and it
      // arrives on the same handshake.
      expect(client.getInstructions()).toContain("Names are never IDs");
    } finally {
      await client.close();
    }
  });

  it("lists and expands a prompt end to end", async () => {
    const client = await connected();
    try {
      const listed = await client.listPrompts();
      expect(listed.prompts.map((one) => one.name).sort()).toEqual(
        PROMPT_SPECS.map((one) => one.name).sort(),
      );
      const got = await client.getPrompt({
        name: "home_away_split",
        arguments: { player: "Rohit Sharma" },
      });
      expect(got.messages[0]?.content).toMatchObject({ type: "text" });
      expect(JSON.stringify(got.messages[0]?.content)).toContain("Rohit Sharma");
    } finally {
      await client.close();
    }
  });

  it("reports a missing required argument as a protocol error", async () => {
    // Not `isError` -- there is nothing here for a model to correct, so it belongs in the
    // channel the host reads. `-32602` is InvalidParams.
    const client = await connected();
    try {
      await expect(client.getPrompt({ name: "home_away_split" })).rejects.toThrow(/player/);
      await expect(client.getPrompt({ name: "nonesuch" })).rejects.toThrow(/Unknown prompt/);
    } finally {
      await client.close();
    }
  });
});
