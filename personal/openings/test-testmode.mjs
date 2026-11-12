// node openings/test-testmode.mjs — Test-mode lines (legality), ordering, unlocks, next-due, results
import assert from "assert";
import { Chess } from "../vendor/chess.js?v=3.3";
import { LESSONS, TEST_TREES } from "./data.js?v=3.3";
import { emojiGrid } from "../logic.js?v=3.3";
import {
  orderedVariations, allVariations, variationById, buildVariationTree, recordResult, isUnlocked,
  statusOf, nextTest, randomTest, followingVariation, testSummary, movetext, TEST_PLIES, TEST_MOVES, RETEST_DAYS,
  gradeTestMove, bookAlternatives, newAttempt, attemptMove, attemptRow, TEST_TRIES,
} from "./testmode.js?v=3.3";

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
    assert.strictEqual(TEST_PLIES, 2 * TEST_MOVES - 1);
    assert.ok(moves.length >= v.start + TEST_PLIES, `${v.id} needs ${TEST_MOVES} of the player's moves (+ replies) after start`);
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
    assert.strictEqual(v.solution.length, TEST_MOVES);
    assert.strictEqual(v.replies.length, TEST_MOVES);
    // alternate: your move (your colour) → computer's book reply (opponent's colour), all legal from v.fen
    const me = lesson.side === "white" ? "w" : "b";
    const g = new Chess(v.fen);
    for (let k = 0; k < TEST_MOVES; k++) {
      assert.strictEqual(g.fen(), v.userFens[k]);
      const m = g.move(v.solution[k]); assert.ok(m); assert.strictEqual(m.color, me, `${v.id}: solution[${k}] is the player's move`);
      if (k < TEST_MOVES - 1) {
        const r = g.move(v.replies[k]); assert.ok(r, `${v.id}: reply ${k}`); assert.notStrictEqual(r.color, me, `${v.id}: reply is the computer's`);
      }
    }
    // the computer's intro (branching) move leads from introFen to fen
    if (v.start > 0) {
      const gi = new Chess(v.introFen); const im = gi.move(v.introSan);
      assert.ok(im && im.color !== me); assert.strictEqual(gi.fen(), v.fen);
      assert.ok(v.last.length === 4, `${v.id} last move uci`);
    } else {
      assert.strictEqual(v.introFen, null); assert.strictEqual(lesson.side, "white");
    }
    if (v.main) assert.strictEqual(v.start, lesson.side === "white" ? 0 : 1, `${v.id}: main lines start from move one`);
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
assert.deepStrictEqual(it[0].solution, ["e4", "Nf3", "Bc4", "c3", "d3"]);
assert.deepStrictEqual(it[0].replies, ["e5", "Nc6", "Bc5", "Nf6", "d6"]);
assert.deepStrictEqual(it[1].solution, ["d3", "c3", "O-O", "h3", "Re1"]);
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
// ---- v3.2 attempt logic: you enter only your moves; the computer replies; first miss ends the try ----
{
  const v = variationById("e5-italian"); // Black: the computer opens 1.e4
  assert.strictEqual(v.side, "black");
  assert.strictEqual(v.introSan, "e4");
  assert.strictEqual(new Chess(v.introFen).fen(), new Chess().fen());
  let a = newAttempt(), out;
  out = attemptMove(v, a, "e5"); a = out.att;
  assert.deepStrictEqual(a.results, ["good"]); assert.strictEqual(out.reply, "Nf3", "computer replies 2.Nf3");
  out = attemptMove(v, a, "Nc6"); a = out.att; assert.strictEqual(out.reply, "Bc4");
  out = attemptMove(v, a, "Nf6"); a = out.att; assert.strictEqual(out.reply, "d3");
  out = attemptMove(v, a, "Bc5"); a = out.att; assert.strictEqual(out.reply, "c3");
  out = attemptMove(v, a, "d6"); a = out.att;
  assert.strictEqual(a.over, true); assert.strictEqual(a.won, true); assert.strictEqual(out.reply, null);
  assert.deepStrictEqual(attemptRow(a).results, ["good", "good", "good", "good", "good"]);

  // wrong move mid-try: stops there, remaining cells blank
  a = newAttempt();
  a = attemptMove(v, a, "e5").att;
  out = attemptMove(v, a, "a6"); a = out.att;
  assert.strictEqual(a.over, true); assert.strictEqual(a.won, false); assert.strictEqual(out.reply, null);
  const row = attemptRow(a);
  assert.deepStrictEqual(row.moves, ["e5", "a6", "", "", ""]);
  assert.deepStrictEqual(row.results, ["good", "bad", "skip", "skip", "skip"]);
  assert.strictEqual(emojiGrid(row.results, 5), "🟩⬛⬜⬜⬜");
  // a finished try ignores further input
  assert.strictEqual(attemptMove(v, a, "Nc6").att, a);

  // yellow: one of your later moves in this line
  assert.strictEqual(gradeTestMove(v, 1, "Nf6"), "okay");
  assert.strictEqual(gradeTestMove(v, 1, "Nc6"), "good");
  assert.strictEqual(gradeTestMove(v, 1, "h6"), "bad");
  // yellow: another known book move at this position
  const it2 = variationById("it-two-knights");
  const lonMain = variationById("lon-main");
  assert.strictEqual(lonMain.solution[4], "Bg3");
  assert.ok(bookAlternatives(lonMain, 4).has("Bxd6"), "lesson alt Bxd6 counts as a known alternative");
  assert.strictEqual(gradeTestMove(lonMain, 4, "Bxd6"), "okay");
  assert.strictEqual(gradeTestMove(it2, 0, "d3"), "good");
  // opening as White at move one (no intro move): first move is yours
  const im = variationById("it-main");
  assert.strictEqual(im.introFen, null);
  assert.strictEqual(attemptMove(im, newAttempt(), "e4").reply, "e5");
  assert.strictEqual(attemptMove(im, newAttempt(), "d4").att.results[0], "bad");
  // Black tests: computer opens as White (main lines) / plays the deviation (sidelines)
  for (const id of ["caro-classical", "qgd-main"]) {
    const b = variationById(id); assert.strictEqual(b.prefix.length, 1); assert.ok(["e4", "d4"].includes(b.introSan));
  }
  assert.strictEqual(variationById("e5-vienna").introSan, "Nc3");
  assert.ok(TEST_TRIES === 5 && TEST_MOVES === 5);
  console.log("attempt logic (your moves only, computer replies, stop on first miss) OK");
}

console.log(`test mode: ${allVariations().length} variations legal + ordering/unlock/next-due OK`);
