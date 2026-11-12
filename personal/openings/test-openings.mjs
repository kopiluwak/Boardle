// node openings/test-openings.mjs — legality, schedule, trainer, UI seams, start-race helper
import assert from "assert";
import { Chess } from "../vendor/chess.js?v=3.1";
import { LESSONS, lessonById } from "./data.js?v=3.1";
import {
  buildSteps, learnerCards, gradeAttempt, playSan, advancePastThem,
  nextLearnPhase, LEARN_PHASES, progressSummary, isAcceptable,
} from "./trainer.js?v=3.1";
import {
  makeCard, reviewCard, noteExposure, isDue, dueCount, pickSession, INTERVALS_MS,
} from "./schedule.js?v=3.1";
import { shouldApplyStart } from "../logic.js?v=3.1";
import { CONFIG } from "../config.js?v=3.1";

// --- every lesson line is legal ---
for (const lesson of LESSONS) {
  const steps = buildSteps(lesson);
  assert.ok(steps.length > 0, lesson.id);
  const g = new Chess();
  for (const node of lesson.line) {
    const m = g.move(node.san);
    assert.ok(m, `${lesson.id} illegal ${node.san}`);
    assert.strictEqual(m.san, node.san);
  }
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

// --- gradeAttempt ---
{
  const firstUs = buildSteps(lessonById("italian-white")).find((s) => s.by === "us");
  assert.strictEqual(gradeAttempt(firstUs, firstUs.san).ok, true);
  assert.strictEqual(gradeAttempt(firstUs, "a3").ok, false);
  assert.strictEqual(gradeAttempt(firstUs, "a3").reason, "wrong");
  assert.strictEqual(gradeAttempt(firstUs, "e5").reason, "illegal");
}

// --- advancePastThem / phases ---
{
  const steps = buildSteps(lessonById("e5-black"));
  const usIdx = steps.findIndex((s) => s.by === "us");
  const after = playSan(steps[usIdx].beforeFen, steps[usIdx].san);
  const adv = advancePastThem(steps, usIdx, after.fen);
  assert.ok(adv.nextIndex > usIdx);
  if (adv.nextIndex < steps.length) assert.strictEqual(steps[adv.nextIndex].by, "us");
}
assert.deepStrictEqual(LEARN_PHASES, ["show", "hint", "recall"]);
assert.strictEqual(nextLearnPhase("recall"), null);

// --- schedule + exposure does not inflate mastery ---
{
  const now = 1_000_000;
  let c = makeCard("x", now);
  c = reviewCard(c, true, now);
  assert.strictEqual(c.level, 1);
  const exposed = noteExposure(c, now + 1);
  assert.strictEqual(exposed.level, c.level, "exposure must not change level");
  assert.strictEqual(exposed.due, c.due, "exposure must not change due");
  assert.strictEqual(exposed.seen, c.seen, "exposure must not bump seen");
  assert.strictEqual(exposed.correct, c.correct);
  assert.ok(exposed.exposed >= 1);
  const fail = reviewCard(c, false, now + INTERVALS_MS[1]);
  assert.strictEqual(fail.level, 0);
  assert.strictEqual(fail.wrong, 1);
}

// --- shouldApplyStart (async tab race) ---
{
  const modes = CONFIG.modes;
  assert.strictEqual(shouldApplyStart(1, 1, "mega", "mega", modes, "classic"), true);
  assert.strictEqual(shouldApplyStart(1, 2, "mega", "maxi", modes, "classic"), false, "stale run id");
  assert.strictEqual(shouldApplyStart(2, 2, "mega", "maxi", modes, "classic"), false, "hash moved on");
  assert.strictEqual(shouldApplyStart(3, 3, "maxi", "maxi", modes, "classic"), true);
  assert.strictEqual(shouldApplyStart(4, 4, "classic", "openings", modes, "classic", "openings"), false);
  assert.strictEqual(shouldApplyStart(5, 5, "classic", "", modes, "classic"), true, "empty hash → default");
  console.log("shouldApplyStart race guards OK");
}

assert.ok(isAcceptable(buildSteps(lessonById("london-white")).find((s) => s.san === "Bg3"), "Bxd6"));

console.log("core openings tests passed — running UI smoke…");

// ---------- light DOM mock + UI seams ----------
function installDomMock() {
  const nodes = new Map();
  const makeEl = (tag = "div") => {
    const el = {
      tagName: tag.toUpperCase(),
      innerHTML: "",
      textContent: "",
      hidden: false,
      disabled: false,
      className: "",
      style: {},
      dataset: {},
      childNodes: [],
      onclick: null,
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
      },
      appendChild(c) { this.childNodes.push(c); return c; },
      remove() {},
      cloneNode() { return makeEl(tag); },
      getBoundingClientRect() { return { width: 40, height: 40, top: 0, left: 0 }; },
      insertAdjacentHTML() {},
      querySelector(sel) {
        if (sel.startsWith("#")) return nodes.get(sel.slice(1)) || null;
        return null;
      },
      querySelectorAll() { return []; },
      closest(sel) { return sel === ".sq" ? this : null; },
      addEventListener() {},
    };
    return el;
  };
  for (const id of ["board", "openingsPanel", "puzzleChrome", "controls", "replay", "solution", "grid", "promo", "info", "tabs"]) {
    nodes.set(id, makeEl());
  }
  const local = new Map();
  globalThis.localStorage = {
    getItem: (k) => (local.has(k) ? local.get(k) : null),
    setItem: (k, v) => { local.set(k, String(v)); },
    removeItem: (k) => { local.delete(k); },
  };
  globalThis.document = {
    createElement: (tag) => makeEl(tag),
    querySelector: (sel) => {
      if (sel.startsWith("#")) return nodes.get(sel.slice(1)) || null;
      if (sel === "dialog[open]") return null;
      return null;
    },
    querySelectorAll: () => [],
    elementFromPoint: () => null,
    body: makeEl("body"),
  };
  globalThis.window = globalThis;
  return { nodes, local };
}

const { local } = installDomMock();
const ui = await import("./ui.js?v=3.1");
const T = ui._test;

// Handler name seam: currentUsStep must exist; currentUserStep must not
assert.strictEqual(typeof T.currentUsStep, "function");
assert.strictEqual(typeof T.onLearnMove, "function");
assert.strictEqual("currentUserStep" in T, false);

// Fresh storage
local.clear();

T.startLearn("italian-white");
let st = T.getState();
assert.strictEqual(st.mode, "learn");
assert.strictEqual(st.learnPhase, "show");
assert.strictEqual(typeof T.currentUsStep, "function");
const step0 = T.currentUsStep();
assert.ok(step0);
assert.strictEqual(step0.san, "e4");

// show phase ignores moves (no throw on missing currentUserStep)
assert.strictEqual(T.onLearnMove({ from: "e2", to: "e4" }), false);

// hint: wrong move records lapse
T.learnContinue(); // → hint
st = T.getState();
assert.strictEqual(st.learnPhase, "hint");
const beforeWrong = T.cardsMap()[step0.cardId];
assert.ok(T.onLearnMove({ from: "a2", to: "a3" }) === false || T.onLearnMove({ from: "a2", to: "a4" }) === false);
// ensure a wrong legal try
{
  // reset to hint on same step
  T.setState({ learnPhase: "hint", learnIdx: step0.index, mode: "learn" });
  // rebuild lesson context
  T.startLearn("italian-white");
  T.learnContinue(); // hint
  const s = T.currentUsStep();
  const levelBefore = (T.cardsMap()[s.cardId] || makeCard(s.cardId)).level;
  const wrong = T.onLearnMove({ from: "b1", to: "a3" }); // Nb1-a3 illegal or wrong
  // try a3 pawn
  T.startLearn("italian-white");
  T.learnContinue();
  const s2 = T.currentUsStep();
  const cardBefore = { ...(T.cardsMap()[s2.cardId] || makeCard(s2.cardId)) };
  assert.strictEqual(T.onLearnMove({ from: "a2", to: "a3" }), false);
  const cardAfter = T.cardsMap()[s2.cardId];
  assert.ok(cardAfter.wrong > (cardBefore.wrong || 0), "wrong learn attempt must save lapse");
  assert.strictEqual(cardAfter.level, 0);
}

// guided hint success → exposure only
{
  local.clear();
  T.startLearn("italian-white");
  T.learnContinue(); // hint
  const s = T.currentUsStep();
  const before = { ...(T.cardsMap()[s.cardId] || makeCard(s.cardId)) };
  assert.strictEqual(T.onLearnMove({ from: "e2", to: "e4" }), true);
  const after = T.cardsMap()[s.cardId];
  assert.strictEqual(after.level, before.level || 0, "hint success must not raise level");
  assert.strictEqual(after.correct, before.correct || 0, "hint success must not count correct");
  assert.ok((after.exposed || 0) >= 1, "hint success notes exposure");
}

// unassisted recall success → review credit
{
  local.clear();
  T.startLearn("italian-white");
  T.learnContinue(); // hint
  T.learnContinue(); // recall
  assert.strictEqual(T.getState().learnPhase, "recall");
  const s = T.currentUsStep();
  assert.strictEqual(T.onLearnMove({ from: "e2", to: "e4" }), true);
  const after = T.cardsMap()[s.cardId];
  assert.ok(after.correct >= 1);
  assert.ok(after.level >= 1);
  assert.ok(after.seen >= 1);
}

// showAnswer learn sets next show afterFen
{
  local.clear();
  T.startLearn("italian-white");
  T.learnContinue();
  const s = T.currentUsStep();
  T.showAnswer();
  const st2 = T.getState();
  assert.ok(st2.mode === "learn" || st2.mode === "catalog");
  if (st2.mode === "learn") {
    assert.strictEqual(st2.learnPhase, "show");
    const next = T.currentUsStep();
    assert.ok(next);
    assert.strictEqual(st2.fen, next.afterFen, "show phase should preview next move afterFen");
  }
}

// practice: correct waits for Next; session id guards
{
  local.clear();
  T.startPractice("italian-white");
  let st = T.getState();
  assert.strictEqual(st.mode, "practice");
  assert.strictEqual(st.practiceReveal, false);
  const step = st.practiceStep || T.currentUsStep();
  // Play correct via SAN path using onPracticeMove with chess move object from beforeFen
  const g = new Chess(step.beforeFen);
  const legal = g.moves({ verbose: true }).find((m) => m.san === step.san);
  assert.ok(legal, step.san);
  assert.strictEqual(T.onPracticeMove({ from: legal.from, to: legal.to, promotion: legal.promotion }), true);
  st = T.getState();
  assert.strictEqual(st.practiceReveal, true);
  assert.strictEqual(st.fen, step.afterFen);
  const qLen = st.practiceQueue.length;
  // Next advances
  T.practiceNext();
  st = T.getState();
  assert.strictEqual(st.practiceReveal, false);
  assert.ok(st.practiceQueue.length === qLen - 1 || st.mode === "catalog");
}

// practice showAnswer does not use dangling timer auto-advance; Next required
{
  local.clear();
  T.startPractice("italian-white");
  const sid = T.getState().practiceSessionId;
  T.showAnswer();
  assert.strictEqual(T.getState().practiceReveal, true);
  // switching lesson cancels reveal session
  T.startLearn("london-white");
  assert.notStrictEqual(T.getState().practiceSessionId, sid);
  assert.strictEqual(T.getState().practiceReveal, false);
  assert.strictEqual(T.getState().mode, "learn");
}

// mixed practice label follows current card lessonId
{
  local.clear();
  T.startPractice(null);
  const st = T.getState();
  assert.strictEqual(st.practiceMixed, true);
  assert.ok(st.practiceStep);
  assert.ok(st.lessonId === st.practiceStep.lessonId || lessonById(st.practiceStep.lessonId));
}

// catalog keeps banner/feedback
{
  T.setState({ banner: "Finished Italian Game (as White). Use Recall…", feedback: "Finished Italian Game (as White). Use Recall…", mode: "catalog" });
  T.render();
  const html = document.querySelector("#openingsPanel").innerHTML;
  assert.ok(html.includes("op-banner") || html.includes("Finished"), "catalog must show completion banner");
}

// store.set failure soft-handles
{
  const real = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => { throw new Error("quota"); };
  assert.strictEqual(T.store.set("x", { a: 1 }), false);
  globalThis.localStorage.setItem = real;
}

// Test mode wiring: catalog → variation list → shared board hook → result recorded → back
{
  local.clear();
  const started = [];
  let ended = 0;
  T.setHooks({ startTest: (v, cb) => started.push({ v, cb }), endTest: () => { ended++; } });
  T.showTests("italian-white");
  assert.strictEqual(T.getState().mode, "tests");
  let html = document.querySelector("#openingsPanel").innerHTML;
  assert.ok(html.includes("Main line") && html.includes("vs 3…Nf6") && html.includes("locked"), "variation list shows order + locks");
  T.startNextTest("italian-white");
  assert.strictEqual(T.getState().mode, "test");
  assert.strictEqual(started.at(-1).v.id, "it-main");
  const fin = started.at(-1).cb.onFinish(true, 2);
  assert.strictEqual(fin.unlocked.id, "it-two-knights");
  assert.strictEqual(T.testResults()["it-main"].bestTries, 2);
  assert.strictEqual(started.at(-1).cb.nextAfter().id, "it-two-knights", "advance to next less-common reply");
  const log = JSON.parse(local.get("boardle:history:log"));
  assert.strictEqual(log.at(-1).kind, "opening-test");
  started.at(-1).cb.onExit();
  assert.strictEqual(T.getState().mode, "tests");
  html = document.querySelector("#openingsPanel").innerHTML;
  assert.ok(/data-test-id="it-two-knights"/.test(html), "two knights now unlocked");
  T.startTestById("it-two-knights");
  T.leaveOpenings();
  assert.ok(ended >= 1, "leaving the tab ends a running test");
  assert.strictEqual(T.getState().mode, "catalog");
}

console.log("all openings tests passed");
