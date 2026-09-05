# cricket-chat-mcp

[![npm](https://img.shields.io/npm/v/cricket-chat-mcp)](https://www.npmjs.com/package/cricket-chat-mcp)
[![license](https://img.shields.io/npm/l/cricket-chat-mcp)](./LICENSE)
[![node](https://img.shields.io/node/v/cricket-chat-mcp)](https://nodejs.org)

An MCP server for **ball-by-ball cricket analytics**. Eight typed tools over a DuckDB
warehouse built from [Cricsheet](https://cricsheet.org) data — and the warehouse ships
inside the package, so there is nothing to download, ingest, host or configure.

## Install

Requires **Node 22 or newer**. Nothing else — no API key, no database to set up, no service to
run. The first launch downloads ~18 MB and caches it; after that startup is instant.

### Claude Code

```bash
claude mcp add cricket -- npx -y cricket-chat-mcp
```

That registers it for the current project only. Add `--scope user` to make it available in every
project, or `--scope project` to write a `.mcp.json` your teammates get when they clone the repo.

Check it came up with `claude mcp list`, then ask something — *"which bowlers concede fewest
boundaries in T20 death overs since 2020?"*

### Claude Desktop

Open **Settings → Developer → Edit Config**, which opens `claude_desktop_config.json`, and add:

```json
{
  "mcpServers": {
    "cricket": { "command": "npx", "args": ["-y", "cricket-chat-mcp"] }
  }
}
```

If you'd rather edit the file directly, it lives at
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows, and
`~/.config/Claude/claude_desktop_config.json` on Linux. Merge the `cricket` entry into any
`mcpServers` block already there rather than replacing it.

**Restart Claude Desktop** — it only reads that file at startup. The tools then appear under the
connector icon in the message box.

### Any other MCP client

It's a standard stdio server, so the same command works anywhere: run
`npx -y cricket-chat-mcp` and speak JSON-RPC over stdin/stdout. `npx cricket-chat-mcp --help`
prints the options.

### If it doesn't start

Almost always the Node version. Claude Desktop launches servers with its own environment, which
may not be the shell `PATH` where your Node 22 lives — so `node --version` in a terminal can say
22 while the server still fails. Point the config at an absolute path to prove it:

```json
{
  "mcpServers": {
    "cricket": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/npx", "-y", "cricket-chat-mcp"]
    }
  }
}
```

Claude Desktop's MCP logs are in `~/Library/Logs/Claude/` (macOS) or `%APPDATA%\Claude\logs\`
(Windows); Claude Code shows them with `claude mcp list` and `/mcp`. Anything this server wants
to tell you goes to stderr and lands in those logs — stdout carries only protocol traffic.

## Why this exists

Statsguru is comprehensive and does far more than people give it credit for: opposition,
ground, year, batting position, result, toss, innings. What it cannot do is **structural**,
because its grain is the innings and its interface is a form:

| Question | Why the existing sites can't |
|---|---|
| "Boundary % conceded in T20 death overs since 2020" | Needs the **ball** as the unit, not the innings |
| "Every ball Rashid Khan has bowled to Buttler" | No batter × bowler cell exists |
| "Now only in Asia" → "now just the 20th over" | No form UI can hold a conversation |

That is the gap these tools fill. The model composes filters; the server compiles them to
SQL against a local file; you get the number, the population it was drawn from, and the
window it covers.

## What's in the warehouse

Queried from the shipped file, not hardcoded:

| Format | Gender | Range | Matches | Deliveries |
|---|---|---|---|---|
| IT20 | female | 2009-06-18 → 2026-08-23 | 2,118 | 481,616 |
| IT20 | male | 2005-02-17 → 2026-08-21 | 3,528 | 795,382 |
| T20 (franchise) | male | 2008-04-18 → 2026-05-31 | 1,243 | 295,732 |

**T20 only, and that is the honest headline.** No ODIs, no Tests. Ask
`get_data_coverage` and the server will tell you exactly this rather than guess.

Two consequences worth knowing before you trust a number:

- **Ball-by-ball coverage has a floor.** Nothing here predates 2005. A career average
  computed from this data for a player who debuted earlier is not a career average, and
  every response carries a `career_possibly_truncated` flag plus the actual window so the
  model states the boundary instead of quoting a bare figure.
- **Leaderboards are qualified by default** — minimum 60 balls faced, 120 balls bowled.
  Without that, `order_by strike_rate` hands you someone who faced three balls and hit two
  sixes. The applied minimums come back in every response.

## The eight tools

| Tool | What it does |
|---|---|
| `resolve_entity` | Name → 8-hex id. **Call first** for anything naming a player; every other tool takes ids, never names, and asks rather than guessing when a name is ambiguous. |
| `get_data_coverage` | The table above, live. |
| `query_batting_aggregate` | Runs, strike rate, average, boundary %, dot %, dismissals, for any slice. |
| `query_bowling_aggregate` | Wickets, economy, bowling average and strike rate, dot %, boundary-conceded %. |
| `query_matchup` | One batter against one bowler — the genuine blind spot in every existing site. |
| `get_scorecard` | One match, three views: innings totals, every batter's line, every bowler's line. |
| `query_matches` | Results, margins, venues, toss. |
| `get_career_reference` | Full-career totals for ~100 retired greats, transcribed by hand from ESPNcricinfo with a `source_url` on every row. Flagged `provenance: "reference"` and never to be mixed arithmetically with computed figures. |

A failed call is **not** a protocol error. It returns the real field name, the allowed
values, a `did_you_mean` list and a worked `fix_example`, so the model corrects itself in
one turn instead of surfacing a red box to you. After three consecutive failures on the
same tool the payload flips to `retryable: false` and the model is told to explain the
limitation rather than keep guessing.

## What it will not do

- **No live scores, no fixtures.** Cricbuzz owns live; this is historical analysis, and the
  server says so rather than improvising.
- **No pace/spin or handedness beyond a curated set.** Cricsheet has no such column, so
  bowling type is hand-reviewed: 385 bowlers, seeded from the highest-volume names globally
  and then extended down the IPL's own volume ranking, which is where the gaps actually
  were. That reaches 93% of IPL deliveries and rather less elsewhere. Any attribute-filtered
  answer reports its `attribute_coverage`, so a 90%-unknown result cannot pass as complete.
- **No home/away outside the IPL.** Cricsheet records a venue, never whose ground it was,
  so `batting_home_away` / `bowling_home_away` and `group_by home_away` read off a curated
  team × season × venue table that covers the IPL and nothing else; every other delivery is
  `unknown` rather than quietly excluded. `neutral` — a ground nobody owned that season, so
  the 2009 South Africa and 2020/21 UAE seasons, relocated fixtures, a knockout at a third
  team's ground — is its own bucket and is not folded into `away`.
- **No raw SQL.** Tools are typed and parameterised; `sql_id` in the response is a digest
  for correlating two calls, not a query you can edit.

## CLI

```
npx cricket-chat-mcp --help        # usage
npx cricket-chat-mcp --version
npx cricket-chat-mcp --db path/to/other.duckdb
```

Started in a terminal it waits for JSON-RPC on stdin — it is meant to be spawned by a
client. `--db` (or `CRICKET_DB`) points it at a different warehouse; the default is the
bundled one.

## Local development

Requires Node 22+.

```bash
npm install
npm run build      # tsc -> dist/
npm test           # vitest; warehouse-dependent suites skip without data/cricket.duckdb
npm run lint       # biome
npm run typecheck
```

**The warehouse is not in this repo.** It's 74 MB, and git cannot forget a blob once it's in
history, so every clone would pay for it forever. It travels in the published npm tarball
instead. To get one for local work, either take `data/cricket.duckdb` out of that tarball:

```bash
npm pack cricket-chat-mcp && tar xzf cricket-chat-mcp-*.tgz package/data/cricket.duckdb
mkdir -p data && mv package/data/cricket.duckdb data/
```

or build it with the ingest pipeline it came from. Without it, the warehouse-dependent test
suites skip and the rest still run.

## Attribution

Data from **[Cricsheet](https://cricsheet.org)**, licensed
[ODC-BY 1.0](https://opendatacommons.org/licenses/by/1-0/) — free reuse, including
commercial, with attribution. If you build on this, attribute Cricsheet too: the ball-by-ball
data is a decade of volunteer work and none of this exists without it.

Source code MIT. See [LICENSE](./LICENSE).
