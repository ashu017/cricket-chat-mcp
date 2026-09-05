// MCP prompts: the multi-step shapes these tools make possible but a model will not find.
//
// ## What a prompt is for here, given `instructions` already exists
//
// `instructions.ts` is standing guidance -- it is paid on every request and it says how to
// behave whatever the question. A prompt is the opposite: the user picks it by name, it costs
// nothing until then, and it can therefore be a *procedure* rather than a rule. Everything in
// this file is a sequence of calls with a decision in the middle, which is precisely what a
// model does not reliably invent:
//
//   - `home_away_split` needs `group_by home_away` and then the caveat that the dimension is
//     IPL-only and that `neutral` is not `away`. Ask for "away average" without that and the
//     honest answer looks like a bug.
//   - `matchup_drilldown` needs three calls -- two resolves and a matchup -- and then a
//     decision about whether the sample is large enough to say anything at all. Left alone, a
//     model reports 12 balls as a head-to-head record.
//   - `phase_leaderboard` is the one shape no other cricket site can do, and it is also the
//     one most likely to be run unqualified. The qualifier belongs in the prompt.
//   - `career_with_boundary` is the coverage cliff. It is the question most likely to be asked
//     of a pre-2003 player and the one whose wrong answer is least visible.
//
// ## Why the text addresses the model, not the user
//
// A `prompts/get` result is a list of messages the host injects as the *conversation*, not a
// system note. So each renders as a `user` turn that states the task and the procedure --
// which is also why the arguments are interpolated as plain names, not IDs: `resolve_entity`
// is step one of every one of these, exactly as the instructions demand.
//
// ## Why a missing argument throws
//
// The opposite of the tool-layer rule, deliberately. A failed *tool* call is a result the
// model reads and corrects, because the model composed the arguments. A `prompts/get` with a
// missing required argument is the host's own bug -- the user chose a prompt from a list that
// declared the argument -- and there is nothing for a model to fix, so it belongs in the
// JSON-RPC error channel where the host will see it.

import {
  ErrorCode,
  type GetPromptResult,
  McpError,
  type Prompt,
  type PromptMessage,
} from "@modelcontextprotocol/sdk/types.js";

/** The arguments a host collected, as MCP delivers them: all strings, all optional. */
type PromptArgs = Readonly<Record<string, string | undefined>>;

interface PromptSpec {
  /** As it appears in a slash-command list, so short and lowercase with underscores. */
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly arguments: readonly { name: string; description: string; required?: boolean }[];
  /**
   * The user turn this prompt expands to.
   *
   * Takes its own spec so {@link required} can name the argument's description in the error
   * without every template reaching back into `SPECS` by index.
   */
  readonly render: (args: PromptArgs, self: PromptSpec) => string;
}

/** Required, or a protocol error naming the field. */
function required(args: PromptArgs, spec: PromptSpec, name: string): string {
  const value = args[name]?.trim();
  if (!value) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${spec.name} requires the '${name}' argument: ${
        spec.arguments.find((one) => one.name === name)?.description ?? ""
      }`,
    );
  }
  return value;
}

/** An optional argument, with the wording the template needs when it is absent. */
function optional(args: PromptArgs, name: string, fallback: string): string {
  return args[name]?.trim() || fallback;
}

const SPECS: readonly PromptSpec[] = [
  {
    name: "home_away_split",
    title: "IPL home / away / neutral split",
    description:
      "Split one player's IPL record by whose ground it was, keeping neutral venues " +
      "separate from away and stating the IPL-only limit of the dimension.",
    arguments: [
      { name: "player", description: "Player name, e.g. 'Rohit Sharma'", required: true },
      {
        name: "role",
        description: "'batting' or 'bowling'. Defaults to batting.",
      },
    ],
    render: (args, self) => {
      const player = required(args, self, "player");
      const role = optional(args, "role", "batting");
      const tool = role === "bowling" ? "query_bowling_aggregate" : "query_batting_aggregate";
      const side = role === "bowling" ? "bowling_home_away" : "batting_home_away";
      return `Split ${player}'s IPL ${role} record by whose ground it was.

1. \`resolve_entity\` for ${player}.
2. \`${tool}\` with \`filters.competition: ["Indian Premier League"]\`, the resolved id, and
   \`group_by: ["home_away"]\`. \`order_by\` is required with \`group_by\` -- pick the metric the
   question is actually about, not just \`runs\`.

Then read the three buckets as three answers, not as home versus away:

- \`home\` and \`away\` mean the ground was owned by one of the two teams that season.
- \`neutral\` is a ground **nobody** owned -- the 2009 South Africa and 2020/21 UAE seasons,
  relocated fixtures, a knockout at a third team's ground. Report it separately. Folding it
  into \`away\` is the single most common way this figure goes wrong.
- \`unknown\` here would mean the curated table missed a fixture. It should not appear for the
  IPL; if it does, say so rather than dropping the bucket.

The dimension is curated for the IPL and nothing else, so do not extend the claim to T20
cricket generally. If you want the mirror question -- how the player did against *touring*
opposition rather than while touring -- that is the other side of the pair, \`${side}\`'s twin.`;
    },
  },
  {
    name: "matchup_drilldown",
    title: "Batter versus bowler, with the sample stated",
    description:
      "One batter against one bowler ball-by-ball -- the cell no other cricket site has -- " +
      "with an explicit judgement about whether the sample supports a claim.",
    arguments: [
      { name: "batter", description: "Batter's name, e.g. 'Virat Kohli'", required: true },
      { name: "bowler", description: "Bowler's name, e.g. 'Jasprit Bumrah'", required: true },
      {
        name: "context",
        description:
          "Optional slice: a competition, a phase ('powerplay', 'middle', 'death'), or a date range.",
      },
    ],
    render: (args, self) => {
      const batter = required(args, self, "batter");
      const bowler = required(args, self, "bowler");
      const context = optional(args, "context", "");
      return `How does ${batter} fare against ${bowler}?${
        context ? `\n\nRestrict it to: ${context}.` : ""
      }

1. \`resolve_entity\` for each name separately. If either comes back with genuinely close
   candidates, ask -- do not pick.
2. \`query_matchup\` with \`batter_id\` and \`bowler_id\`.${
        context
          ? "\n3. Pass the slice above through `filters` rather than filtering the rows yourself."
          : ""
      }

Then decide, before writing anything, whether there is a record here at all. A head-to-head
is a small sample by construction: two players meet for a few overs a season. So lead with the
balls faced, and if it is under about 60, say plainly that the sample is too small to support
a claim and give the raw counts instead of an average or a strike rate. "3 dismissals in 42
balls" is honest; "averages 14.00 against him" from the same 42 balls is not.

If the whole-career cell is thin, do not slice it further -- a phase breakdown of 42 balls is
four numbers none of which mean anything. Widen instead: the same batter against that bowling
type, via \`query_batting_aggregate\` with \`faced_bowling_type\`, is a real population and
answers the question the reader was probably asking.`;
    },
  },
  {
    name: "phase_leaderboard",
    title: "Powerplay / middle / death leaderboard",
    description:
      "Rank batters or bowlers within one phase of the innings -- the ball-grain question " +
      "no form-driven site can ask -- with the qualifying minimum named in the answer.",
    arguments: [
      {
        name: "phase",
        description: "'powerplay', 'middle' or 'death'",
        required: true,
      },
      { name: "role", description: "'batting' or 'bowling'. Defaults to batting." },
      {
        name: "metric",
        description:
          "What to rank by: strike_rate, boundary_pct, dot_pct, economy, wickets, " +
          "boundary_conceded_pct, average. Defaults to strike_rate (batting) or economy (bowling).",
      },
      { name: "since", description: "Optional ISO date, e.g. '2020-01-01'" },
    ],
    render: (args, self) => {
      const phase = required(args, self, "phase");
      const role = optional(args, "role", "batting");
      const bowling = role === "bowling";
      const metric = optional(args, "metric", bowling ? "economy" : "strike_rate");
      const since = optional(args, "since", "");
      const tool = bowling ? "query_bowling_aggregate" : "query_batting_aggregate";
      const minimum = bowling ? "min_balls_bowled" : "min_balls_faced";
      return `Who are the best ${role === "bowling" ? "bowlers" : "batters"} in the ${phase} overs, by ${metric}?${
        since ? `\n\nOnly from ${since} onward.` : ""
      }

\`${tool}\` with \`filters.phase: "${phase}"\`${since ? `, \`filters.date_from: "${since}"\`` : ""},
\`group_by: ["player"]\`, \`order_by: "${metric}"\`. Set \`order_dir: "asc"\` if a *lower* number
is better -- economy, dot_pct conceded and bowling average all rank the wrong way round on the
default. Add \`filters.format\` if the question is about one format; \`phase\` does not apply to
Tests or first-class cricket, so those return nothing rather than everything.

Two things the answer has to carry:

- **The qualifier.** A minimum is applied by default and comes back in \`qualification\`. Write
  "lowest of the 38 bowlers with 500+ ${phase}-over balls", never a bare "lowest" -- a rank
  without its population cannot be checked. Raise \`${minimum}\` if the default list still looks
  thin, and say that you did.
- **The phase definition.** It comes from the match's declared powerplay overs where the data
  has them, and from format defaults otherwise -- not from a fixed over range you can assume.

The rows you get back are the whole leaderboard. Do not re-run the same query to re-sort it or
to look up one name in it; sort and read the rows you already have.`;
    },
  },
  {
    name: "career_with_boundary",
    title: "Career figures, with the coverage cliff stated",
    description:
      "The safe way to ask about a player who may predate ball-by-ball data: the cited " +
      "reference total and the computed portion, side by side and never mixed.",
    arguments: [
      { name: "player", description: "Player name, e.g. 'Sachin Tendulkar'", required: true },
      { name: "format", description: "Optional: Test, ODI, T20, IT20" },
    ],
    render: (args, self) => {
      const player = required(args, self, "player");
      const format = optional(args, "format", "");
      return `What is ${player}'s career record${format ? ` in ${format}` : ""}, and how much of it is
actually in this data?

1. \`get_career_reference\` with the name. If there is a row, that is a hand-transcribed,
   cited total -- \`provenance: "reference"\` -- and it is the career figure.
2. \`get_data_coverage\`${format ? ` for ${format}` : ""} for the window the warehouse actually holds.
3. \`resolve_entity\`, then \`query_batting_aggregate\` (and \`query_bowling_aggregate\` if the
   player bowled) over that window.

Then present them as two figures, labelled, never arithmetic on each other:

> Tendulkar averaged **53.78** across 200 Tests -- cited from ESPNcricinfo, not computed here.
> The ball-by-ball data starts in November 2003 and covers 92 of those Tests: over that
> portion he averaged 48.84.

Rules that decide whether this answer is honest:

- \`career_possibly_truncated: true\` means the computed number is **not** a career figure.
  State the window in the same sentence as the number, every time.
- \`matches_in_scope: 0\` means the player is entirely before the data. Say so in one line and
  point at Statsguru. Do not offer a number you do not have, and do not apologise for the
  boundary -- ball-by-ball coverage starting in 2003 is a published spec, not a failure.
- No reference row is not an error either. It means nobody transcribed one; the computed
  figure over the stated window is then the whole answer.

Where the computed portion is real, it is also where this data earns its place: the same
window split by phase, by bowling type, or by opposition is a breakdown no records site will
give you. Offer one.`;
    },
  },
];

const BY_NAME = new Map(SPECS.map((spec) => [spec.name, spec]));

/** Every prompt, as MCP describes prompts. */
export function promptDefinitions(): Prompt[] {
  return SPECS.map((spec) => ({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    arguments: spec.arguments.map((one) => ({
      name: one.name,
      description: one.description,
      ...(one.required === true ? { required: true } : {}),
    })),
  }));
}

/**
 * One prompt, expanded.
 *
 * A single `user` message rather than a system/user pair: MCP has no system role, and the
 * host is going to place this as a turn in the conversation either way.
 */
export function getPrompt(name: string, args: PromptArgs = {}): GetPromptResult {
  const spec = BY_NAME.get(name);
  if (!spec) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Unknown prompt '${name}'. Available: ${SPECS.map((one) => one.name).join(", ")}.`,
    );
  }
  const message: PromptMessage = {
    role: "user",
    content: { type: "text", text: spec.render(args, spec) },
  };
  return { description: spec.description, messages: [message] };
}

/** Exported for the test that checks every declared argument is actually consumed. */
export const PROMPT_SPECS = SPECS;
