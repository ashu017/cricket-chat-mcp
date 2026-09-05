// Builds `match_home_away`: for every IPL match, whether each side was home, away or neutral.
//
// Cricsheet has no such column and cannot have one -- it records a venue string, and
// nothing about who owns that ground in that season. So this is derived, and the whole
// derivation reduces to one map: `(season, venue) -> the team whose home ground that was`.
// Once that map exists, each side of each match resolves by lookup:
//
//   * the venue has an owner and this team IS it            -> home
//   * the venue has an owner and this team is not           -> away
//   * the venue has no owner (a relocation, or a neutral    -> neutral
//     leg played abroad)
//
// Two consequences of keying on the *venue* rather than on the fixture list, both
// deliberate and both the user's stated rule -- secondary home grounds count as home,
// neutral grounds count as neutral rather than away:
//
//   * A knockout takes the same venue rule as a league game, so a final at Chepauk is a
//     home final for CSK. That is how the result is actually discussed.
//   * A team playing its "home" games at somebody else's ground -- Punjab's three 2025
//     fixtures at Jaipur, which Rajasthan owns -- reads as AWAY. Under a venue rule it
//     cannot read otherwise, and calling it home would make Rajasthan's own home record
//     depend on who the schedule says is hosting.
//
// How the owner map is derived, and why a count works: matches-per-(season, venue, team)
// is sharply bimodal. Visiting teams appear once (896 such pairs); a team's own ground
// carries 7 in a normal season (71 pairs), with 2-6 for shortened or shared seasons. So
// "T owns (season, venue) if T played >= 2 league matches there and strictly more than any
// other team" separates them cleanly: 164 owned pairs, none with two claimants.
//
// The residue is what makes this honest. Seven (season, venue) pairs resolve to no owner,
// and they split into two kinds that a threshold cannot tell apart -- genuine one-off
// secondary home grounds (which `n >= 2` wrongly excludes) and genuine relocations shared
// by several teams. Those seven are curated below with a reason each, and the script
// REFUSES TO WRITE if any match outside a designated neutral leg is still unresolved. A
// silently-defaulted match would land in an away average with nothing to contradict it.
//
// Idempotent: the table is rebuilt from scratch inside a transaction.
//
//   PATH="$HOME/.local/node22/bin:$PATH" node scripts/build-home-away.mjs [--dry-run]

import { DuckDBInstance } from "@duckdb/node-api";

const DB = process.env["CRICKET_DB"] ?? "data/cricket.duckdb";
const IPL = "Indian Premier League";

/**
 * Seasons, or parts of seasons, played away from the league's home country.
 *
 * `country: null` means the whole season. These are not judgement calls: every match in
 * them is neutral for both sides, because nobody's home ground is in the host country.
 */
const NEUTRAL_LEGS = [
  { season: "2009", country: null, why: "whole season in South Africa (Indian general election)" },
  { season: "2014", country: "United Arab Emirates", why: "first 20 matches in the UAE (election)" },
  { season: "2020/21", country: null, why: "whole season in the UAE (pandemic)" },
  { season: "2021", country: null, why: "second half moved to the UAE (pandemic); the Indian leg was itself played in empty neutral bubbles" },
  { season: "2022", country: null, why: "whole season in a Mumbai/Pune bio-bubble, no team at its own ground" },
];

/**
 * Venue strings that name the same ground.
 *
 * `venue_canonical` treats a renamed ground as two venues, which splits a home season in
 * half and would split any `group_by venue` besides. Merged here rather than in the
 * warehouse because fixing it globally means updating `matches` AND the denormalised copy
 * on `deliveries`, which is a wider change than this table needs.
 */
const VENUE_ALIASES = [
  [
    "Subrata Roy Sahara Stadium, Pune",
    "Maharashtra Cricket Association Stadium, Pune",
    "renamed in 2015; one ground, two strings",
  ],
];

/**
 * The (season, venue) pairs the count rule cannot resolve, with the reading each needs.
 *
 * `team: null` means nobody owned the ground that season, so every match there is neutral
 * for both sides. A named team means that team's home ground, which makes its opponents
 * away. Every entry is a documented relocation or a documented secondary home ground --
 * nothing here is inferred from the counts, because the counts are exactly what failed.
 */
const OVERRIDES = [
  // --- relocations: several teams' "home" games moved to one borrowed ground, so the
  // --- ground belonged to none of them and the counts correctly refuse to pick a winner.
  {
    season: "2014",
    venue: "Barabati Stadium, Cuttack",
    team: null,
    why: "the Indian leg after the UAE opening was re-scheduled around the general election; Cuttack took three matches involving four different teams (KXIP 2, KKR 2, CSK 1, MI 1) and was nobody's home ground",
  },
  {
    season: "2016",
    venue: "Dr. Y.S. Rajasekhara Reddy ACA-VDCA Cricket Stadium, Visakhapatnam",
    team: null,
    why: "the Maharashtra drought order moved matches out of Pune and Mumbai; Visakhapatnam took six involving five teams (MI 3, RPS 3, SRH 2, KXIP 2, DD 2) with no side playing there more than any other",
  },

  // --- knockouts allotted to a ground that was nobody's home that season. The venue rule
  // --- makes a final at a team's own ground a home final, which is the point of using it
  // --- -- but these three grounds hosted no league cricket at all for the teams involved.
  {
    season: "2014",
    venue: "Brabourne Stadium, Mumbai",
    team: null,
    why: "the Eliminator, MI v CSK. Mumbai's home ground is the Wankhede; Brabourne hosted no league match that season and is not MI's ground",
  },
  {
    season: "2015",
    venue: "JSCA International Stadium Complex, Ranchi",
    team: null,
    why: "Qualifier 2, CSK v RCB. Ranchi hosted no 2015 league cricket and has never been a CSK home ground -- its earlier IPL matches (2013, 2014) belonged to other teams",
  },
  {
    season: "2019",
    venue: "Dr. Y.S. Rajasekhara Reddy ACA-VDCA Cricket Stadium, Visakhapatnam",
    team: null,
    why: "the Eliminator and Qualifier 2 were moved there for security reasons; no 2019 league match was played at the ground",
  },

  // --- genuine home grounds the `n >= 2` threshold excludes, because the team played
  // --- exactly one match there. This is the case a count rule cannot get right, and
  // --- calling it neutral would understate two teams' home records.
  {
    season: "2018",
    venue: "MA Chidambaram Stadium, Chennai",
    team: "Chennai Super Kings",
    why: "CSK's own ground and their home opener; the Cauvery protests moved the remaining six home games to Pune, which is why the count rule awards Pune and leaves this one behind",
  },
  {
    season: "2024",
    venue: "Barsapara Cricket Stadium, Guwahati",
    team: "Rajasthan Royals",
    why: "Rajasthan's designated secondary home venue, which the count rule already awards them in 2023 (2 matches), 2025 (2) and 2026 (3); 2024 allotted them only one",
  },
];

const dryRun = process.argv.includes("--dry-run");

const instance = await DuckDBInstance.create(DB);
const db = await instance.connect();

const run = async (sql, params = []) => {
  const prepared = await db.prepare(sql);
  params.forEach((value, index) => prepared.bindVarchar(index + 1, value));
  return await prepared.run();
};
const rows = async (sql, params = []) => await (await run(sql, params)).getRowObjectsJson();

// --- the source rows ----------------------------------------------------------------
//
// One row per (match, team). `innings.batting_team` is the only place a match's teams are
// recorded, so a match with no innings bowled contributes nothing -- six abandoned matches
// carry a single team and are handled by the same code path as any other.
const source = await rows(
  `SELECT DISTINCT m.match_id            AS match_id,
          m.season                       AS season,
          m.venue_canonical              AS venue,
          m.country                      AS country,
          m.event_match_number           AS num,
          i.batting_team                 AS team
   FROM matches m JOIN innings i USING (match_id)
   WHERE m.competition = ?
   ORDER BY m.match_id, i.batting_team`,
  [IPL],
);

const aliases = new Map(VENUE_ALIASES.map(([from, to]) => [from, to]));
const canonical = (venue) => aliases.get(venue) ?? venue;

/** A designated neutral leg: no team is at its own ground, whatever the venue says. */
const neutralLeg = (season, country) =>
  NEUTRAL_LEGS.some(
    (leg) => leg.season === season && (leg.country === null || leg.country === country),
  );

/**
 * A league match, as opposed to a knockout.
 *
 * There is no stage column; `event_match_number` is a plain number for league games and a
 * name ("Final", "Qualifier 1", "Eliminator") otherwise. Knockouts are excluded from the
 * *counting* because a neutral final would otherwise vote on who owns the ground -- they
 * are still resolved by the finished map, which is the point.
 */
const isLeague = (num) => num !== null && num !== undefined && /^[0-9]+$/.test(String(num));

const pairs = source.map((row) => ({
  matchId: String(row["match_id"]),
  season: String(row["season"]),
  venue: canonical(String(row["venue"])),
  team: String(row["team"]),
  neutralLeg: neutralLeg(String(row["season"]), row["country"] === null ? null : String(row["country"])),
  league: isLeague(row["num"]),
}));

// --- the owner map ------------------------------------------------------------------
const counts = new Map(); // "season|venue" -> Map(team -> matches)
for (const pair of pairs) {
  if (pair.neutralLeg || !pair.league) continue;
  const key = `${pair.season}|${pair.venue}`;
  const byTeam = counts.get(key) ?? new Map();
  byTeam.set(pair.team, (byTeam.get(pair.team) ?? 0) + 1);
  counts.set(key, byTeam);
}

const owners = new Map(); // "season|venue" -> team
for (const [key, byTeam] of counts) {
  for (const [team, n] of byTeam) {
    if (n < 2) continue;
    const best = Math.max(...[...byTeam].filter(([other]) => other !== team).map(([, m]) => m), 0);
    if (n > best) owners.set(key, team);
  }
}

const overrides = new Map(OVERRIDES.map((o) => [`${o.season}|${canonical(o.venue)}`, o]));
for (const [key, override] of overrides) {
  if (owners.has(key)) {
    console.error(
      `stale override: ${key} is owned by ${owners.get(key)} by the count rule, so the ` +
        `override (${override.team ?? "neutral"}) is dead code. Remove it.`,
    );
    process.exit(1);
  }
}

// --- resolve ------------------------------------------------------------------------
const resolved = [];
const unresolved = new Map(); // "season|venue" -> match ids

for (const pair of pairs) {
  const key = `${pair.season}|${pair.venue}`;
  if (pair.neutralLeg) {
    resolved.push({ ...pair, homeAway: "neutral" });
    continue;
  }
  const owner = owners.get(key);
  if (owner !== undefined) {
    resolved.push({ ...pair, homeAway: pair.team === owner ? "home" : "away" });
    continue;
  }
  const override = overrides.get(key);
  if (override !== undefined) {
    const homeAway =
      override.team === null ? "neutral" : pair.team === override.team ? "home" : "away";
    resolved.push({ ...pair, homeAway });
    continue;
  }
  unresolved.set(key, [...(unresolved.get(key) ?? []), pair.matchId]);
}

if (unresolved.size > 0) {
  console.error(`refusing to write: ${unresolved.size} (season, venue) pair(s) unresolved.`);
  console.error("Each needs an OVERRIDES entry with a stated reason.\n");
  for (const [key, matchIds] of [...unresolved].sort()) {
    const [season, venue] = key.split("|");
    const byTeam = counts.get(key) ?? new Map();
    const tally = [...byTeam]
      .sort((a, b) => b[1] - a[1])
      .map(([team, n]) => `${team}=${n}`)
      .join(", ");
    console.error(`  ${season}  ${venue}`);
    console.error(`      ${new Set(matchIds).size} match(es): ${[...new Set(matchIds)].join(", ")}`);
    console.error(`      league counts: ${tally || "none"}`);
  }
  process.exit(1);
}

// --- report -------------------------------------------------------------------------
const tally = (key) => resolved.filter((r) => r.homeAway === key).length;
console.log(
  `${resolved.length} (match, team) rows across ${new Set(resolved.map((r) => r.matchId)).size} matches`,
);
console.log(`  home ${tally("home")}  away ${tally("away")}  neutral ${tally("neutral")}`);
console.log(`  ${owners.size} owned (season, venue) pairs, ${OVERRIDES.length} curated`);

// The shapes a match may legitimately take. Most are one home and one away; a designated
// neutral leg gives two neutrals; the six abandoned matches carry a single team.
//
// `away+away` is the fourth, and it is the venue rule rather than a bug: a knockout allotted
// to a ground that a THIRD team owns leaves both participants at somebody else's home --
// 2017's Eliminator was KKR v SRH at Bengaluru, and a relocated league fixture does the same
// (2025 match 62, CSK v RR at Delhi). Neither side is home, and neither ground is neutral,
// because the ground is somebody's. Calling it away for both is what the rule says, and it
// is the reading the user asked for: a ground that is not yours is away, and only a ground
// that is nobody's is neutral.
const SHAPES = ["away+home", "away+away", "neutral+neutral", "away", "home", "neutral"];

const odd = [];
for (const matchId of new Set(resolved.map((r) => r.matchId))) {
  const sides = resolved.filter((r) => r.matchId === matchId).map((r) => r.homeAway).sort();
  const shape = sides.join("+");
  if (!SHAPES.includes(shape)) odd.push(`${matchId}: ${shape}`);
}
if (odd.length > 0) {
  console.log(`  ${odd.length} match(es) with an unexpected shape:`);
  for (const line of odd.slice(0, 20)) console.log(`      ${line}`);
}

if (dryRun) {
  console.log("--dry-run: nothing written");
  db.closeSync();
  process.exit(0);
}

// --- the write ----------------------------------------------------------------------
await run("BEGIN TRANSACTION");
try {
  await run("DROP TABLE IF EXISTS match_home_away");
  await run(
    `CREATE TABLE match_home_away (
       match_id  VARCHAR NOT NULL,
       team      VARCHAR NOT NULL,
       home_away VARCHAR NOT NULL
     )`,
  );
  for (const row of resolved) {
    await run(`INSERT INTO match_home_away (match_id, team, home_away) VALUES (?, ?, ?)`, [
      row.matchId,
      row.team,
      row.homeAway,
    ]);
  }
  await run("COMMIT");
} catch (error) {
  await run("ROLLBACK");
  throw error;
}

const [check] = await rows(
  `SELECT count(*)::INTEGER AS rows,
          count(DISTINCT match_id)::INTEGER AS matches,
          count(*) FILTER (WHERE home_away = 'home')::INTEGER AS home,
          count(*) FILTER (WHERE home_away = 'away')::INTEGER AS away,
          count(*) FILTER (WHERE home_away = 'neutral')::INTEGER AS neutral
   FROM match_home_away`,
);
console.log(
  `match_home_away: ${check["rows"]} rows, ${check["matches"]} matches, ` +
    `${check["home"]} home / ${check["away"]} away / ${check["neutral"]} neutral`,
);
db.closeSync();
