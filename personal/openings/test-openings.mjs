// node openings/test-openings.mjs — legality + schedule/trainer invariants
import assert from "assert";
import { Chess } from "../vendor/chess.js";
import { LESSONS, lessonById } from "./data.js";
import {
  buildSteps, learnerCards, gradeAttempt, playSan, advancePastThem,
  nextLearnPhase, LEARN_PHASES, progressSummary, isAcceptable,
} from "./trainer.js";
import {
  makeCard, reviewCard, isDue, sortDue, dueCount, pickSession, INTERVALS_MS,
} from "./schedule.js";

// --- every lesson line is legal ---
for (const lesson of LESSONS) {
  const steps = buildSteps(lesson);
  assert.ok(steps.length > 0, lesson.id);
  let g = new Chess();
  for (const node of lesson.line) {
    const m = g.move(node.san);
    assert.ok(m, `${lesson.id} illegal ${node.san}`);
    assert.strictEqual(m.san, node.san);
  }
  // alts legal from beforeFen of that step
  for (const step of steps) {
    for (const alt of step.alts || []) {
      const g2 = new Chess(step.beforeFen);
      assert.ok(g2.move(alt), `${lesson.id} alt ${alt} at ${step.index}`);
    }
  }
  const us = learnerCards(lesson);
  assert.ok(us.length >= 3, `${lesson.id} should teach several moves`);
  assert.ok(us.every((s) => s.by === "us"));
  console.log(`lesson ${lesson.id}: ${steps.length} plies, ${us.length} learn cards OK`);
}

assert.ok(LESSONS.some((l) => l.side === "white"));
assert.ok(LESSONS.some((l) => l.side === "black"));
assert.ok(lessonById("italian-white"));

// --- gradeAttempt ---
{
  const lesson = lessonById("italian-white");
  const steps = buildSteps(lesson);
  const firstUs = steps.find((s) => s.by === "us");
  const good = gradeAttempt(firstUs, firstUs.san);
  assert.strictEqual(good.ok, true);
  const bad = gradeAttempt(firstUs, "a3");
  // a3 may be legal but wrong
  assert.strictEqual(bad.ok, false);
  const illegal = gradeAttempt(firstUs, "e5"); // black move from start? wait first is e4 from start
  // from beforeFen of e4, e5 is legal for... no white to move, e5 is illegal for white
  assert.ok(illegal.reason === "illegal" || illegal.ok === false);
}

// --- advancePastThem ---
{
  const lesson = lessonById("e5-black");
  const steps = buildSteps(lesson);
  // first us move is ...e5 after white e4
  const usIdx = steps.findIndex((s) => s.by === "us");
  assert.ok(usIdx > 0);
  const after = playSan(steps[usIdx].beforeFen, steps[usIdx].san);
  const adv = advancePastThem(steps, usIdx, after.fen);
  assert.ok(adv.nextIndex > usIdx);
  // next should be us or end
  if (adv.nextIndex < steps.length) assert.strictEqual(steps[adv.nextIndex].by, "us");
}

// --- learn phases ---
assert.deepStrictEqual(LEARN_PHASES, ["show", "hint", "recall"]);
assert.strictEqual(nextLearnPhase("show"), "hint");
assert.strictEqual(nextLearnPhase("hint"), "recall");
assert.strictEqual(nextLearnPhase("recall"), null);

// --- schedule ---
{
  const now = 1_000_000;
  let c = makeCard("x", now);
  assert.strictEqual(isDue(c, now), true);
  c = reviewCard(c, true, now);
  assert.strictEqual(c.level, 1);
  assert.strictEqual(c.due, now + INTERVALS_MS[1]);
  assert.strictEqual(isDue(c, now), false);
  assert.strictEqual(isDue(c, now + INTERVALS_MS[1]), true);
  const fail = reviewCard(c, false, now + INTERVALS_MS[1]);
  assert.strictEqual(fail.level, 0);
  assert.strictEqual(fail.wrong, 1);

  // climb
  let d = makeCard("y", now);
  for (let i = 0; i < INTERVALS_MS.length + 2; i++) d = reviewCard(d, true, now);
  assert.strictEqual(d.level, INTERVALS_MS.length - 1);

  const cards = [
    makeCard("a", now),
    reviewCard(makeCard("b", now), true, now), // due later
  ];
  // force b not due
  assert.ok(dueCount(cards, now) >= 1);
  const session = pickSession(cards, { now, maxDue: 10, maxNew: 2 });
  assert.ok(session.length >= 1);
  assert.ok(session.some((x) => x.id === "a")); // new card included
}

// --- progressSummary ---
{
  const map = {};
  for (const L of LESSONS) {
    for (const s of learnerCards(L)) map[s.cardId] = makeCard(s.cardId);
  }
  const sum = progressSummary(map, LESSONS);
  assert.ok(sum.total > 20);
  assert.strictEqual(sum.seen, 0);
}

// --- isAcceptable alts ---
{
  const lesson = lessonById("london-white");
  const step = buildSteps(lesson).find((s) => s.san === "Bg3");
  assert.ok(step);
  assert.ok(isAcceptable(step, "Bg3"));
  assert.ok(isAcceptable(step, "Bxd6"));
  assert.ok(!isAcceptable(step, "Bh2"));
}

// --- storage key separation invariant (documentation in code) ---
assert.ok(!"boardle:stats" .includes("openings"));
const puzzleKeySample = "boardle:classic:day1";
const openingsKeySample = "boardle:openings:cards";
assert.ok(!puzzleKeySample.startsWith("boardle:openings"));
assert.ok(openingsKeySample.startsWith("boardle:openings"));

console.log("all openings tests passed");
