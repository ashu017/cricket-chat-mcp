// Writes curated bowling attributes for IPL bowlers straight into the warehouse.
//
// Why this exists, measured rather than assumed: `player_attributes` covers the ~200
// bowlers with the most deliveries *globally*, and the IPL's mid-volume bowlers are not in
// that set. Of the IPL's 295,732 deliveries, 105,684 were bowled by somebody with no
// attribute row at all -- and exactly 0 by somebody whose row says `unknown`. So the 64.3%
// bowling-type coverage on "Kohli against spin in the IPL" is a missing-row problem, not an
// unlabelled-row problem, and the fix is INSERTs.
//
// The 185 bowlers here are every IPL bowler with 200+ deliveries and no row, which is
// 86,854 of those 105,684 balls. The tail below 200 balls is long and individually
// worthless: 1,900 more bowlers for the remaining 6%.
//
// Labels are from memory of widely-documented bowling actions, not from a machine-readable
// source, and the `source` column says so. Where the player could not be identified with
// confidence the row is written `unknown` rather than guessed -- a wrong label is worse
// than a missing one here, because a wrong one is invisible: it lands silently in the
// denominator of a spin average with no indication that anything is off.
//
// Safety: every row carries the name as well as the id, and the script aborts before
// writing anything if any id's name disagrees with `players`. A transposed id would
// otherwise attribute a fast bowler's action to a spinner with no error at all.
//
// Idempotent: re-running replaces exactly these rows and nothing else.
//
//   PATH="$HOME/.local/node22/bin:$PATH" node scripts/label-bowlers.mjs [--dry-run]

import { DuckDBInstance } from "@duckdb/node-api";

const DB = "data/cricket.duckdb";
const IPL = "Indian Premier League";

/** How a label got here. The point of the column is that a hand-typed label can never be
 *  mistaken for a machine-verified one. */
const MANUAL = "manual: widely documented bowling action, not machine-verified";
const UNFILLED = "unfilled: nobody has attributed this bowler yet";

/**
 * [player_id, unique_name, bowling_type, bowling_arm].
 *
 * `unknown` here means "not identified with confidence", and every one of them is a
 * post-2024 debutant whose action is not yet widely documented. They are written rather
 * than skipped so the next person can see the row was considered and not simply missed.
 */
const LABELS = [
  // --- 900+ IPL deliveries ---------------------------------------------------------
  ["dcf81436", "S Kaul", "pace", "right"],
  ["bb18be76", "SK Warne", "spin", "right"],
  ["46a9bea1", "TU Deshpande", "pace", "right"],
  ["abfeb126", "M Kartik", "spin", "left"],
  ["efc04be7", "Noor Ahmad", "spin", "left"],
  ["c8179c68", "SB Jakati", "spin", "left"],
  ["0a3d54b9", "VR Aaron", "pace", "right"],
  ["7a8bd078", "S Gopal", "spin", "right"],
  ["0c2730df", "A Kumble", "spin", "right"],
  ["32198ae0", "MC Henriques", "pace", "right"],
  ["6b8eb6e5", "S Sreesanth", "pace", "right"],
  ["85aae393", "Iqbal Abdulla", "spin", "left"],
  // Rahul Sharma, not Rohit -- `RG Sharma` is a separate row below.
  ["5d9a1a73", "R Sharma", "spin", "right"],
  ["7c3b3b78", "VG Arora", "pace", "right"],
  ["1dc12ab9", "SK Raina", "spin", "right"],
  ["ae78bc32", "MS Gony", "pace", "right"],
  ["2a2e6343", "DT Christian", "pace", "right"],
  ["7210d461", "Yash Dayal", "pace", "left"],
  ["9fc0ef64", "PJ Sangwan", "pace", "left"],

  // --- 500-900 --------------------------------------------------------------------
  ["e2db2409", "M Ashwin", "spin", "right"],
  ["1c914163", "Yuvraj Singh", "spin", "left"],
  ["2cffab74", "Mukesh Kumar", "pace", "right"],
  ["c05edf8e", "Harpreet Brar", "spin", "left"],
  ["39a2dfa8", "R Tewatia", "spin", "right"],
  ["12eddf28", "RJ Harris", "pace", "right"],
  ["9440ef41", "Suyash Sharma", "spin", "right"],
  ["fa463154", "AB Agarkar", "pace", "right"],
  ["64839cb3", "M Pathirana", "pace", "right"],
  ["957532de", "S Aravind", "pace", "left"],
  ["5d2eea49", "Kartik Tyagi", "pace", "right"],
  ["1a0c3177", "P Awana", "pace", "right"],
  ["a9fd84fb", "M Markande", "spin", "right"],
  ["f62772e5", "P Negi", "spin", "left"],
  // Bats left, bowls right.
  ["e087956b", "BA Stokes", "pace", "right"],
  ["21d4e29b", "NA Saini", "pace", "right"],
  ["2e8994e7", "JP Duminy", "spin", "right"],
  ["26a85969", "R Dhawan", "pace", "right"],
  ["c404f58a", "DP Nannes", "pace", "left"],
  ["c38d3503", "Shivam Mavi", "pace", "right"],
  ["77b1aa15", "Harshit Rana", "pace", "right"],
  ["c33d8116", "Mohsin Khan (2)", "pace", "left"],
  ["f9e6e7ef", "Shahbaz Ahmed", "spin", "left"],
  ["6aed7e79", "PV Tambe", "spin", "right"],
  ["bd17b45f", "STR Binny", "pace", "right"],
  ["eaa76d3c", "C Green", "pace", "right"],
  ["45c2196c", "DE Bollinger", "pace", "left"],
  ["557153ca", "KK Cooper", "pace", "right"],
  ["90de905a", "K Gowtham", "spin", "right"],
  ["3d8feaf8", "MR Marsh", "pace", "right"],
  ["db584dad", "CH Gayle", "spin", "right"],
  ["db31895a", "AS Rajpoot", "pace", "right"],
  ["13fc5c6d", "DS Rathi", "spin", "right"],
  ["35205dfc", "DR Smith", "pace", "right"],
  ["9a158001", "Azhar Mahmood", "pace", "right"],
  ["54e52590", "Vijaykumar Vyshak", "pace", "right"],
  // Deccan Chargers / Kings XI 2009-2013, cricinfo 391128 -- not the Rajasthan Royals
  // left-arm spinner of the same name, and not confidently identified either way.
  ["2a72fd4f", "Harmeet Singh", "unknown", "unknown"],
  // Bowled both medium pace and off-breaks; the IPL spells were predominantly medium pace.
  ["bd77eb62", "A Symonds", "pace", "right"],
  ["871e9faf", "Basil Thampi", "pace", "right"],
  ["addfb70e", "SW Tait", "pace", "right"],
  ["81c08fa3", "Umran Malik", "pace", "right"],
  ["b8527c3d", "Rasikh Salam", "pace", "right"],
  ["d8b2f218", "BB Sran", "pace", "left"],
  // Eshan Malinga, SRH 2025 -- no relation to SL Malinga.
  ["5750bcb4", "E Malinga", "pace", "right"],
  ["fcc21ace", "A Kamboj", "pace", "right"],
  ["765a4731", "Mukesh Choudhary", "pace", "left"],
  ["4b31f3a3", "Yash Thakur", "pace", "right"],

  // --- 200-500 --------------------------------------------------------------------
  // Amit Singh, Rajasthan Royals 2009-2012, cricinfo 26789.
  ["5b040b81", "A Singh", "pace", "right"],
  ["2cdce1be", "C Sakariya", "pace", "left"],
  ["c7a995d3", "R Sai Kishore", "spin", "left"],
  ["80b2fb19", "Prince Yadav", "pace", "right"],
  ["e0407c01", "IC Pandey", "pace", "right"],
  // Left-arm wrist spin.
  ["f708a0bc", "GB Hogg", "spin", "left"],
  ["7d92277a", "Mujeeb Ur Rahman", "spin", "right"],
  ["4c5d73db", "CR Woakes", "pace", "right"],
  ["5d096f3d", "RR Powar", "spin", "right"],
  ["ab89348d", "MF Maharoof", "pace", "right"],
  ["c18496e1", "Bipul Sharma", "spin", "left"],
  ["4125d931", "J Suchith", "spin", "left"],
  ["69be866a", "Anureet Singh", "pace", "right"],
  ["62af8546", "Mohammad Nabi", "spin", "right"],
  ["64775749", "RP Meredith", "pace", "right"],
  ["12314277", "Arshad Khan (2)", "pace", "left"],
  ["c0c411cb", "Naveen-ul-Haq", "pace", "right"],
  ["81049310", "J Yadav", "spin", "right"],
  ["73ad96ed", "DJ Hooda", "spin", "right"],
  ["f3171936", "BW Hilfenhaus", "pace", "right"],
  ["9eb1455b", "NT Ellis", "pace", "right"],
  ["caf69bf7", "DR Sams", "pace", "left"],
  ["465aa633", "N Burger", "pace", "left"],
  ["4933f499", "JP Behrendorff", "pace", "left"],
  ["4bd09374", "Akash Madhwal", "pace", "right"],
  ["24d94623", "Ankit Sharma", "spin", "left"],
  ["f29185a1", "Abhishek Sharma", "spin", "left"],
  ["c654af19", "R McLaren", "pace", "right"],
  ["034b4b7d", "VRV Singh", "pace", "right"],
  ["8f6dd463", "Azmatullah Omarzai", "pace", "right"],
  ["2498e163", "JR Hopes", "pace", "right"],
  // Abu Nechim Ahmed.
  ["2af1b6d2", "AN Ahmed", "pace", "right"],
  ["93a17209", "VY Mahesh", "pace", "right"],
  // Anukul Roy, KKR/MI, cricinfo 1079839.
  ["e4cdf230", "AS Roy", "spin", "left"],
  // Rohit Sharma's part-time off-breaks.
  ["740742ef", "RG Sharma", "spin", "right"],
  ["aad0c365", "Nithish Kumar Reddy", "pace", "right"],
  ["dfc4d8b5", "KW Richardson", "pace", "right"],
  ["04a418e8", "R Parag", "spin", "right"],
  ["ee7d0c82", "GD McGrath", "pace", "right"],
  ["b552a935", "AC Thomas", "pace", "right"],
  ["b1451597", "LR Shukla", "pace", "right"],
  ["fd835ab3", "DJ Hussey", "spin", "right"],
  // Bowls both off-break and leg-break; either way it is spin, and `bowling_arm` is the
  // part this table can state without qualification.
  ["50c6bc2b", "LS Livingstone", "spin", "right"],
  ["68c56d09", "KA Jamieson", "pace", "right"],
  ["8abdf100", "CJ Anderson", "pace", "left"],
  ["66cf56a5", "A Mithun", "pace", "right"],
  ["e32d22f6", "Pankaj Singh", "pace", "right"],
  ["3edb58fc", "AD Mascarenhas", "pace", "right"],
  ["aa8d28ae", "D Wiese", "pace", "right"],
  ["2049f3a0", "SJ Srivastava", "pace", "right"],
  ["dc4686e6", "BA Bhatt", "spin", "left"],
  ["0a67aec0", "Akash Deep", "pace", "right"],
  // Vipraj Nigam, Delhi Capitals 2025.
  ["5ffc0565", "V Nigam", "spin", "right"],
  ["f233bbb4", "ST Jayasuriya", "spin", "left"],
  // Rajasthan Royals 2026 debutant, cricinfo 1515046.
  ["133bbd61", "Brijesh Sharma", "unknown", "unknown"],
  ["ad427b5c", "Lalit Yadav", "spin", "right"],
  ["3204c99f", "G Coetzee", "pace", "right"],
  ["f6d8a7ab", "K Kartikeya", "spin", "left"],
  ["2e11c706", "BCJ Cutting", "pace", "right"],
  ["bcce309e", "WPUJC Vaas", "pace", "left"],
  ["88fccd6c", "SM Pollock", "pace", "right"],
  ["725529bc", "SC Ganguly", "pace", "right"],
  ["d68e7f48", "R Rampaul", "pace", "right"],
  ["5bdcdb72", "TM Dilshan", "spin", "right"],
  // Sunrisers Hyderabad 2026 debutant, cricinfo 1340422.
  ["280fff14", "Sakib Hussain", "unknown", "unknown"],
  ["9f961c14", "Joginder Sharma", "pace", "right"],
  ["1c2a64cd", "A Ashish Reddy", "pace", "right"],
  // Ali Murtaza.
  ["ef5da05c", "AG Murtaza", "spin", "left"],
  ["3b53243a", "XC Bartlett", "pace", "right"],
  ["e9c7f0d0", "Fazalhaq Farooqi", "pace", "left"],
  ["e342e5fb", "CR Brathwaite", "pace", "right"],
  // Kohli's occasional medium pace, mostly from the early seasons.
  ["ba607b88", "V Kohli", "pace", "right"],
  ["76388dc8", "S Badree", "spin", "right"],
  ["0994d0ae", "V Shankar", "pace", "right"],
  ["b483905d", "Akash Singh", "pace", "left"],
  ["30df8c66", "Simarjeet Singh", "pace", "right"],
  // Kuldeep Sen.
  ["2e78f685", "KR Sen", "pace", "right"],
  ["29d72eb2", "AA Chavan", "spin", "left"],
  ["e86754b2", "TK Curran", "pace", "right"],
  // Dilhara Fernando.
  ["342d8ade", "CRD Fernando", "pace", "right"],
  // Ajantha Mendis.
  ["ea0cdc12", "BAW Mendis", "spin", "right"],
  ["c03c6200", "DJG Sammy", "pace", "right"],
  ["3eac9d95", "JDP Oram", "pace", "right"],
  // Spencer Johnson, cricinfo 1123718.
  ["83c3e8e3", "SH Johnson", "pace", "left"],
  ["91ffa6c6", "JD Ryder", "pace", "right"],
  // Sunrisers Hyderabad 2026 debutant, cricinfo 1512089.
  ["7b44eb3e", "Shivang Kumar", "unknown", "unknown"],
  ["a45a5e8d", "AM Nayar", "pace", "left"],
  ["b57f8a9a", "BJ Hodge", "spin", "right"],
  ["350bb1b1", "AF Milne", "pace", "right"],
  ["9ca68676", "AM Ghazanfar", "spin", "right"],
  ["dec8e038", "J Theron", "pace", "right"],
  ["99b202b3", "A Chandila", "spin", "right"],
  // Mayank Yadav, Lucknow Super Giants, cricinfo 1292563.
  ["b1ad996b", "MP Yadav", "pace", "right"],
  ["94d7f855", "C de Grandhomme", "pace", "right"],
  ["6a26221c", "AK Markram", "spin", "right"],
  ["edb3d4f8", "KC Cariappa", "spin", "right"],
  ["fb2d1dda", "N Rana", "spin", "left"],
  ["d92e42f5", "KP Appanna", "spin", "left"],
  ["fe763256", "Y Venugopal Rao", "spin", "right"],
  // Yusuf Abdulla.
  ["4353bba5", "YA Abdulla", "pace", "left"],
  ["57efa3be", "SB Styris", "pace", "right"],
  ["f752db61", "JL Pattinson", "pace", "right"],
  // Jimmy Neesham.
  ["9219eff0", "JDS Neesham", "pace", "right"],
  ["7f048519", "DJ Willey", "pace", "left"],
  ["c24a2c5d", "S Tyagi", "pace", "right"],
  ["f846de6a", "MN Samuels", "spin", "right"],
  ["245c97cb", "TS Mills", "pace", "left"],
  ["59559bc2", "J Overton", "pace", "right"],
  ["20a941bb", "M Ntini", "pace", "right"],
  ["7ca5e05d", "RS Bopara", "pace", "right"],
  ["0c9652b0", "HR Shokeen", "spin", "right"],
  ["1647bd37", "Karanveer Singh", "spin", "right"],
  // Vikramjeet Malik, cricinfo 31738.
  ["5f26df4f", "VS Malik", "pace", "left"],
  // Veer Pratap Singh, Deccan Chargers 2012, cricinfo 528967.
  ["d718440b", "V Pratap Singh", "pace", "right"],
  // Shivil Kaushik, Gujarat Lions 2016-17 -- left-arm wrist spin.
  ["1da489ff", "S Kaushik", "spin", "left"],
  ["36619795", "Zeeshan Ansari", "spin", "right"],
  ["9caf69a1", "WG Jacks", "spin", "right"],
  ["9170ff49", "Parvez Rasool", "spin", "right"],
  ["25228673", "Harsh Dubey", "spin", "left"],
];

/**
 * Rows that already exist and are only missing an arm. Kept separate from `LABELS`
 * because these are UPDATEs to somebody else's row, and overwriting a `bowling_type`
 * that a previous reviewer set is not this script's business.
 */
const ARM_FIXES = [["c3d35165", "JA Morkel", "right"]];

const dryRun = process.argv.includes("--dry-run");

const instance = await DuckDBInstance.create(DB);
const db = await instance.connect();

/** Run `sql`, binding every element of `params` as a VARCHAR. */
const run = async (sql, params = []) => {
  const prepared = await db.prepare(sql);
  params.forEach((value, index) => prepared.bindVarchar(index + 1, value));
  return await prepared.run();
};
const rows = async (sql, params = []) => await (await run(sql, params)).getRowObjectsJson();

/** IPL bowling-type coverage: the share of deliveries whose bowler carries a real label. */
const coverage = async () => {
  const [row] = await rows(
    `SELECT count(*)::INTEGER AS balls,
            count(*) FILTER (WHERE pa.bowling_type IN ('pace', 'spin'))::INTEGER AS labelled
     FROM deliveries d LEFT JOIN player_attributes pa ON pa.player_id = d.bowler_id
     WHERE d.competition = ?`,
    [IPL],
  );
  const balls = Number(row["balls"]);
  const labelled = Number(row["labelled"]);
  return { balls, labelled, pct: ((100 * labelled) / balls).toFixed(1) };
};

// --- the guard, before any write ---------------------------------------------------
//
// Every id is checked against `players` and every value against the enum the contract
// accepts. A transposed id or a typo'd "spinn" must fail here, loudly, rather than land in
// the warehouse where nothing will ever contradict it.
const TYPES = new Set(["pace", "spin", "unknown"]);
const ARMS = new Set(["right", "left", "unknown"]);
const problems = [];
const seen = new Set();

for (const [id, name, type, arm] of [...LABELS, ...ARM_FIXES.map((r) => [...r.slice(0, 2), null, r[2]])]) {
  if (seen.has(id)) problems.push(`${id} (${name}): listed twice`);
  seen.add(id);
  if (type !== null && !TYPES.has(type)) problems.push(`${id} (${name}): bad bowling_type ${type}`);
  if (!ARMS.has(arm)) problems.push(`${id} (${name}): bad bowling_arm ${arm}`);
  const found = await rows(`SELECT unique_name FROM players WHERE player_id = ?`, [id]);
  const actual = found[0]?.["unique_name"];
  if (actual === undefined) problems.push(`${id} (${name}): no such player`);
  else if (actual !== name) problems.push(`${id}: expected ${name}, warehouse says ${actual}`);
}

if (problems.length > 0) {
  console.error(`refusing to write, ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

const before = await coverage();
console.log(`IPL bowling-type coverage before: ${before.labelled}/${before.balls} = ${before.pct}%`);
console.log(`${LABELS.length} rows to insert, ${ARM_FIXES.length} arm(s) to fix`);

if (dryRun) {
  console.log("--dry-run: nothing written");
  process.exit(0);
}

// --- the write ----------------------------------------------------------------------
//
// Delete-then-insert rather than UPDATE, so a second run is a no-op rather than a
// duplicate. Scoped to exactly the ids above; no other row is touched.
await run("BEGIN TRANSACTION");
try {
  for (const [id, name, type, arm] of LABELS) {
    await run(`DELETE FROM player_attributes WHERE player_id = ?`, [id]);
    await run(
      `INSERT INTO player_attributes (player_id, player_name, bowling_type, bowling_arm, source)
       VALUES (?, ?, ?, ?, ?)`,
      [id, name, type, arm, type === "unknown" ? UNFILLED : MANUAL],
    );
  }
  for (const [id, , arm] of ARM_FIXES) {
    await run(`UPDATE player_attributes SET bowling_arm = ? WHERE player_id = ?`, [arm, id]);
  }
  await run("COMMIT");
} catch (error) {
  await run("ROLLBACK");
  throw error;
}

const after = await coverage();
console.log(`IPL bowling-type coverage after:  ${after.labelled}/${after.balls} = ${after.pct}%`);

const [totals] = await rows(
  `SELECT count(*)::INTEGER AS rows,
          count(*) FILTER (WHERE bowling_type = 'unknown')::INTEGER AS unknown_type,
          count(*) FILTER (WHERE bowling_arm = 'unknown')::INTEGER AS unknown_arm
   FROM player_attributes`,
);
console.log(
  `player_attributes: ${totals["rows"]} rows, ` +
    `${totals["unknown_type"]} unknown bowling_type, ${totals["unknown_arm"]} unknown bowling_arm`,
);
db.closeSync();
