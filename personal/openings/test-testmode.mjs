// node openings/test-testmode.mjs — Test-mode lines (legality), ordering, unlocks, next-due, results
import assert from "assert";
import { Chess } from "../vendor/chess.js?v=3.1";
import { LESSONS, TEST_TREES } from "./data.js?v=3.1";
import { scoreGuess } from "../logic.js?v=3.1";
import {
  orderedVariations, allVariations, variationById, buildVariationTree, recordResult, isUnlocked,
  statusOf, nextTest, randomTest, followingVariation, testSummary, movetext, TEST_PLIES, RETEST_DAYS,
} from "./testmode.js?v=3.1";

// ---- every opening has ≥4 variations; every line is legal SAN; tests start on the player's move ----
const seen = new Set();
for (const lesson of LESSONS) {
  const raw = TEST_TREES[lesson.id];
  assert.ok(Array.isArray(raw) && raw.length >= 4, `${lesson.id} needs ≥4 test variations`);
  assert.strictEqual(raw.filter((v) => v.main).length, 1, `${lesson.id} exactly one main line`);
  for (const v of raw) {
    assert.ok(!seen.has(v.id), `duplicate id ${v.id}`); seen.add(v.id);
    assert.ok(v.weight > 0 && v.weight <= 100, `${v.id} weight`);
    const moves = v.moves.trim().split(/\s+/);
    assert.ok(moves.length >= v.start + TEST_PLIES, `${v.id} needs ${TEST_PLIES} plies after start`);
    const g = new Chess();
    for (const san of moves) {
      const m = g.move(san);
      assert.ok(m, `${v.id}: illegal ${san}`);
      assert.strictEqual(m.san, san, `${v.id}: SAN must be canonical (${san} vs ${m.san})`);
    }
    // side to move at start is the player's side; opponent made the branching move
    const g2 = new Chess();
    for (let i = 0; i < v.start; i++) g2.move(moves[i]);
    assert.strictEqual(g2.turn(), lesson.side === "white" ? "w" : "b", `${v.id}: test must start on ${lesson.side}'s move`);
  }
  const ordered = orderedVariations(lesson.id);
  assert.ok(ordered[0].main, `${lesson.id}: main line first`);
  for (let i = 2; i < ordered.length; i++) assert.ok(ordered[i - 1].weight >= ordered[i].weight, `${lesson.id}: sidelines by popularity`);
  ordered.forEach((v, i) => {
    assert.strictEqual(v.order, i);
    assert.strictEqual(v.solution.length, TEST_PLIES);
    assert.strictEqual(scoreGuess(v.solution, v.solution).every((r) => r === "good"), true);
    // replaying prefix+solution from the start reproduces the FEN used by the board
    const g = new Chess(v.fen);
    for (const san of v.solution) assert.ok(g.move(san));
    assert.ok(v.last.length === 4, `${v.id} last move uci`);
  });
  // tree merges shared prefixes and orders children by weight
  const tree = buildVariationTree(lesson.id);
  assert.strictEqual(tree.children.length, new Set(raw.map((v) => v.moves.split(" ")[0])).size);
  const walk = (n) => { for (let i = 1; i < n.children.length; i++) assert.ok(n.children[i - 1].weight >= n.children[i].weight); n.children.forEach(walk); };
  walk(tree);
  console.log(`${lesson.id}: ${ordered.map((v) => v.id).join(" → ")}`);
}

// Italian specifics from the brief
const it = orderedVariations("italian-white");
assert.strictEqual(it[0].id, "it-main");
assert.ok(it[0].title.includes("main line (most common)"));
assert.strictEqual(it[1].id, "it-two-knights");
assert.ok(it[1].title.includes("vs 3…Nf6") && it[1].title.includes("Two Knights"));
assert.deepStrictEqual(it[0].solution, ["c3", "Nf6", "d3", "d6", "O-O"]);
assert.strictEqual(movetext(it[1].prefix), "1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6");
assert.strictEqual(it[1].lastSan, "Nf6");

// ---- unlock progression ----
let res = {};
assert.strictEqual(statusOf(res, it, 0), "new");
assert.strictEqual(statusOf(res, it, 1), "locked");
assert.strictEqual(isUnlocked(res, it, 1), false);
assert.strictEqual(nextTest(res, "italian-white").id, "it-main");
// a failed attempt keeps the next locked and makes main a retry
res = recordResult(res, "it-main", { solved: false, tries: 5, date: "2026-11-01T10:00:00Z" });
assert.strictEqual(statusOf(res, it, 0), "retry");
assert.strictEqual(statusOf(res, it, 1), "locked");
assert.strictEqual(nextTest(res, "italian-white").id, "it-main");
// solving unlocks the next less-common reply, which becomes next due
res = recordResult(res, "it-main", { solved: true, tries: 3, date: "2026-11-01T10:05:00Z" });
assert.strictEqual(res["it-main"].solved, 1);
assert.strictEqual(res["it-main"].failed, 1);
assert.strictEqual(res["it-main"].bestTries, 3);
assert.strictEqual(res["it-main"].attempts.length, 2);
assert.strictEqual(statusOf(res, it, 1, Date.parse("2026-11-01T11:00:00Z")), "new");
assert.strictEqual(statusOf(res, it, 2), "locked");
assert.strictEqual(nextTest(res, "italian-white", Date.parse("2026-11-01T11:00:00Z")).id, "it-two-knights");
assert.strictEqual(followingVariation("it-main").id, "it-two-knights");
assert.strictEqual(followingVariation(it[it.length - 1].id), null);

// solve all → oldest due re-test comes back (spaced)
let t = Date.parse("2026-11-01T12:00:00Z");
for (const v of it) { res = recordResult(res, v.id, { solved: true, tries: 2, date: new Date(t).toISOString() }); t += 60000; }
const sameDay = Date.parse("2026-11-01T13:00:00Z");
assert.ok(it.every((v, i) => statusOf(res, it, i, sameDay) === "solved"));
const later = Date.parse("2026-11-20T00:00:00Z");
assert.strictEqual(statusOf(res, it, 0, later), "due");
assert.strictEqual(nextTest(res, "italian-white", later).id, "it-main", "oldest solve re-tested first");
assert.ok(RETEST_DAYS[0] >= 1);

// ---- across all openings: every main line before any sideline ----
{
  const order = [];
  let r = {};
  for (let k = 0; k < LESSONS.length; k++) {
    const v = nextTest(r, null);
    order.push(v.id);
    r = recordResult(r, v.id, { solved: true, tries: 1 });
  }
  assert.deepStrictEqual(order, LESSONS.map((l) => orderedVariations(l.id)[0].id));
  const after = nextTest(r, null);
  assert.strictEqual(after.order, 1, "then the most common sideline of each opening");
}

// random respects locks
{
  const r = {};
  for (let i = 0; i < 30; i++) assert.strictEqual(randomTest(r, null, () => i / 30).order, 0);
  assert.strictEqual(randomTest({}, "caro-black", () => 0.99).id, "caro-classical");
}

// summary + lookup
assert.strictEqual(testSummary({}).total, allVariations().length);
assert.ok(allVariations().length >= 24);
assert.strictEqual(variationById("qgd-london").side, "black");
console.log(`test mode: ${allVariations().length} variations legal + ordering/unlock/next-due OK`);
