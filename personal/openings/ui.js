// Openings tab UI — additive; puzzle mode DOM is hidden while this is active.
import { Chess } from "../vendor/chess.js?v=3.2";
import { LESSONS, lessonById } from "./data.js?v=3.2";
import {
  buildSteps, learnerCards, gradeAttempt,
  advancePastThem, progressSummary,
} from "./trainer.js?v=3.2";
import {
  makeCard, reviewCard, noteExposure, pickSession, dueCount,
} from "./schedule.js?v=3.2";
import {
  orderedVariations, statusOf, nextTest, randomTest, recordResult, followingVariation,
  testSummary, variationById, RESULTS_KEY, TEST_TRIES, movetext,
} from "./testmode.js?v=3.2";

const FILES = "abcdefgh";
const $ = (s, root = document) => root.querySelector(s);

// Per-player storage (localStorage when signed out / no server; synced profile when signed in)
import { store, logEvent } from "../storage.js?v=3.2";
import { slidePiece, REPLY_DELAY_MS } from "../anim.js?v=3.2";

const CARDS_KEY = "boardle:openings:cards";
const META_KEY = "boardle:openings:meta";

let active = false;
let lesson = null;
let steps = [];
let mode = "catalog"; // catalog | learn | practice | tests (variation list) | test (board run by app.js)
let testLessonId = null; // opening whose variation list is shown (null = all openings)
let currentTest = null;  // variation being tested
let hooks = { startTest: null, endTest: null }; // injected by app.js (shared Wordle-style board)
let learnIdx = 0;
let learnPhase = "show"; // show | hint | recall
let practiceQueue = [];
let practiceStep = null;
let practiceMixed = false;
let practiceReveal = false; // waiting for Next after grade/show-answer
let practiceRevealTimer = null;
let practiceSessionId = 0;
let fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
let game = new Chess();
let selected = null;
let pendingPromo = null;
let drag = null;
let feedback = "";
let banner = ""; // catalog completion / session messages
let orientationColor = "w";
let lastMove = null;     // {from,to} highlighted on the board (the move just played)
let replyBusy = false;   // computer is about to play the opponent's book move → input locked
let replyTimer = null;
let replyDelay = REPLY_DELAY_MS;

/** Run fn after a short beat (the computer "thinking"); dropped if the session changed meanwhile. */
function afterReply(fn) {
  if (replyTimer != null) clearTimeout(replyTimer);
  const sid = practiceSessionId;
  replyBusy = true;
  const run = () => {
    replyTimer = null;
    replyBusy = false;
    if (sid !== practiceSessionId) return;
    fn();
  };
  if (replyDelay <= 0) run(); else replyTimer = setTimeout(run, replyDelay);
}
/** The computer plays an opponent step on the panel board (highlight + slide). */
function playThem(step, note = true) {
  setFen(step.afterFen, { from: step.from, to: step.to });
  if (note) feedback = `${feedback ? feedback + " " : ""}Opponent played <b>${step.san}</b> — ${step.idea}`;
  render();
  slidePiece($("#board"), step.from, step.to);
}
const prevMoveOf = (step) => (step && step.prev ? { from: step.prev.from, to: step.prev.to } : null);

function clearPracticeTimer() {
  if (replyTimer != null) { clearTimeout(replyTimer); replyTimer = null; }
  replyBusy = false;
  if (practiceRevealTimer != null) {
    clearTimeout(practiceRevealTimer);
    practiceRevealTimer = null;
  }
}

function cardsMap() {
  return store.get(CARDS_KEY, {});
}
function saveCard(card) {
  const all = cardsMap();
  all[card.id] = card;
  store.set(CARDS_KEY, all);
}
function ensureCardsFor(lessonObj) {
  const all = cardsMap();
  let changed = false;
  for (const step of learnerCards(lessonObj)) {
    if (!all[step.cardId]) {
      all[step.cardId] = makeCard(step.cardId);
      changed = true;
    }
  }
  if (changed) store.set(CARDS_KEY, all);
  return all;
}

function setFen(f, last = null) {
  fen = f;
  game = new Chess(f);
  selected = null;
  lastMove = last;
}

function lessonTitleForStep(step) {
  if (!step) return "Mixed";
  const L = lessonById(step.lessonId);
  return L ? L.title : (lesson?.title || "Mixed");
}

function squaresInOrder() {
  const out = [];
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const rank = orientationColor === "w" ? 8 - r : r + 1;
    const file = orientationColor === "w" ? f : 7 - f;
    out.push(FILES[file] + rank);
  }
  return out;
}

function renderBoard() {
  const el = $("#board");
  if (!el) return;
  el.innerHTML = "";
  const lastMv = lastMove;
  // Learn "show" phase: outline the recommended move instead of playing it for you
  const sug = (mode === "learn" && learnPhase === "show" && !replyBusy) ? currentUsStep() : null;
  const targets = (!practiceReveal && selected)
    ? game.moves({ square: selected, verbose: true }).map((m) => m.to) : [];
  squaresInOrder().forEach((sq, i) => {
    const d = document.createElement("div");
    const fileIdx = FILES.indexOf(sq[0]), rank = +sq[1];
    d.className = "sq " + ((fileIdx + rank) % 2 ? "light" : "dark");
    d.dataset.sq = sq;
    if (lastMv && (sq === lastMv.from || sq === lastMv.to)) d.classList.add("last");
    if (sq === selected) d.classList.add("sel");
    if (sug && (sq === sug.from || sq === sug.to)) d.classList.add("suggest");
    const p = game.get(sq);
    if (targets.includes(sq)) d.classList.add(p ? "capture" : "target");
    if (p) {
      const img = document.createElement("img");
      img.src = `pieces/${p.color}${p.type.toUpperCase()}.svg`;
      img.draggable = false; img.alt = "";
      d.appendChild(img);
    }
    if (p && p.type === "k" && game.inCheck() && p.color === game.turn()) d.classList.add("check");
    if (i % 8 === 0) d.insertAdjacentHTML("beforeend", `<span class="coord r">${rank}</span>`);
    if (i >= 56) d.insertAdjacentHTML("beforeend", `<span class="coord f">${sq[0]}</span>`);
    el.appendChild(d);
  });
}

function showPromo(from, to) {
  const box = $("#promo"); if (!box) return;
  box.innerHTML = ""; box.hidden = false;
  for (const t of ["q", "r", "b", "n"]) {
    const b = document.createElement("button");
    b.innerHTML = `<img src="pieces/${game.turn()}${t.toUpperCase()}.svg" alt="${t}">`;
    b.onclick = () => { box.hidden = true; pendingPromo = null; commitUserMove({ from, to, promotion: t }); };
    box.appendChild(b);
  }
  const c = document.createElement("button"); c.textContent = "✕";
  c.onclick = () => { box.hidden = true; pendingPromo = null; selected = null; renderBoard(); };
  box.appendChild(c);
}

function tryUserMove(from, to) {
  if (practiceReveal) return false;
  const legal = game.moves({ square: from, verbose: true }).filter((m) => m.to === to);
  if (!legal.length) return false;
  if (legal.some((m) => m.promotion)) { pendingPromo = { from, to }; showPromo(from, to); return true; }
  commitUserMove({ from, to });
  return true;
}

function commitUserMove(mv) {
  if (mode === "learn") return onLearnMove(mv);
  if (mode === "practice") return onPracticeMove(mv);
  return false;
}

function currentUsStep() {
  if (mode === "learn") {
    while (learnIdx < steps.length && steps[learnIdx].by === "them") learnIdx++;
    return steps[learnIdx] || null;
  }
  return practiceStep;
}

/**
 * Advance the learn line after a resolved "us" step. Your move stays on the board, then the computer
 * plays the opponent's book reply after a short beat; the next move is shown (outlined) on that position.
 */
function advanceLearnAfterUs(step) {
  const adv = advancePastThem(steps, step.index, step.afterFen);
  if (adv.nextIndex >= steps.length) {
    learnIdx = adv.nextIndex;
    learnPhase = "show";
    banner = `Finished ${lesson.title}. Use Recall to lock moves in (spaced reviews are separate from Learn walkthroughs).`;
    feedback = banner;
    mode = "catalog";
    store.set(META_KEY, { ...(store.get(META_KEY, {})), lastLesson: lesson.id, lastFinished: Date.now() });
    logEvent({ kind: "opening-learn", lesson: lesson.id, title: lesson.title });
    setFen(new Chess().fen());
    orientationColor = "w";
    return;
  }
  learnIdx = adv.nextIndex;
  learnPhase = "show";
  if (!adv.them.length) { setFen(steps[learnIdx].beforeFen, prevMoveOf(steps[learnIdx])); return; }
  setFen(step.afterFen, { from: step.from, to: step.to });
  afterReply(() => { for (const t of adv.them) playThem(t); });
}

function onLearnMove(mv) {
  const step = currentUsStep();
  // Only accept board input during hint/recall — never during show (or while the computer replies)
  if (!step || learnPhase === "show" || replyBusy) return false;
  const g = new Chess(step.beforeFen);
  let m = null;
  try { m = g.move(mv); } catch { m = null; }
  if (!m) { feedback = "Illegal move — try again."; render(); return false; }
  const grade = gradeAttempt(step, m.san);
  const all = ensureCardsFor(lesson);
  const prev = all[step.cardId] || makeCard(step.cardId);

  if (!grade.ok) {
    // Lapse always recorded (wrong attempt)
    saveCard(reviewCard(prev, false));
    feedback = `Not quite. ${hintText(step)}`;
    setFen(step.beforeFen, prevMoveOf(step));
    render();
    return false;
  }

  if (learnPhase === "recall") {
    // Graded unassisted recall — only this advances spaced mastery
    saveCard(reviewCard(prev, true));
    feedback = `Nice — ${m.san}. ${step.idea}`;
  } else {
    // hint (or other guided) success: exposure only, no level inflation
    saveCard(noteExposure(prev));
    feedback = `Got it with guidance — ${m.san}. Recall later for spaced credit. ${step.idea}`;
  }
  advanceLearnAfterUs(step);
  render();
  return true;
}

function onPracticeMove(mv) {
  if (practiceReveal || replyBusy) return false;
  const step = practiceStep;
  if (!step) return false;
  const g = new Chess(step.beforeFen);
  let m = null;
  try { m = g.move(mv); } catch { m = null; }
  if (!m) { feedback = "Illegal move."; render(); return false; }
  const grade = gradeAttempt(step, m.san);
  const all = cardsMap();
  const prev = all[step.cardId] || makeCard(step.cardId);
  saveCard(reviewCard(prev, grade.ok));
  practiceReveal = true;
  if (grade.ok) {
    feedback = `Correct: ${m.san}. ${step.idea}`;
    setFen(step.afterFen, { from: m.from, to: m.to });
  } else {
    feedback = `Expected ${step.san}. ${step.idea}`;
    setFen(step.afterFen, { from: step.from, to: step.to }); // show the correct result board
  }
  render();
  return true;
}

function practiceNext() {
  if (mode !== "practice" || !practiceReveal) return;
  clearPracticeTimer();
  practiceReveal = false;
  practiceQueue.shift();
  practiceStep = null;
  if (practiceQueue.length) {
    startPracticeCard(practiceQueue[0]);
    feedback = "";
  } else {
    banner = "Recall session finished.";
    feedback = banner;
    mode = "catalog";
    setFen(new Chess().fen());
    orientationColor = "w";
  }
  render();
}

function startPracticeCard(step) {
  practiceStep = step;
  practiceReveal = false;
  clearPracticeTimer();
  orientationColor = step.beforeFen.split(" ")[1];
  if (step.prev && step.prev.by === "them") {
    // The computer plays the opponent's move that leads into this position, then it's your turn
    setFen(step.prev.beforeFen, null);
    afterReply(() => { playThem({ ...step.prev, afterFen: step.beforeFen }, false); });
  } else setFen(step.beforeFen, prevMoveOf(step));
  selected = null;
  // Keep lesson pointer aligned with current card for labels
  if (step.lessonId) {
    const L = lessonById(step.lessonId);
    if (L) lesson = L;
  }
}

function sqFromPoint(x, y) {
  const el = document.elementFromPoint?.(x, y);
  return el && el.closest?.(".sq") ? el.closest(".sq").dataset.sq : null;
}

function onPointerDown(e) {
  if (!active || (mode !== "learn" && mode !== "practice")) return;
  if (mode === "learn" && learnPhase === "show") return;
  if (practiceReveal || pendingPromo || replyBusy) return;
  const sq = sqFromPoint(e.clientX, e.clientY); if (!sq) return;
  const p = game.get(sq);
  if (selected && selected !== sq && (!p || p.color !== game.turn())) {
    if (!tryUserMove(selected, sq)) { selected = null; renderBoard(); }
    return;
  }
  if (p && p.color === game.turn()) {
    selected = sq; renderBoard();
    const img = $(`#board [data-sq="${sq}"] img`);
    if (img) {
      const ghost = img.cloneNode(); ghost.className = "ghost";
      const w = img.getBoundingClientRect().width; ghost.style.width = ghost.style.height = w + "px";
      document.body.appendChild(ghost); img.style.opacity = 0.3;
      drag = { from: sq, ghost, w, moved: false };
      moveGhost(e);
      e.preventDefault();
    }
  } else { selected = null; renderBoard(); }
}
function moveGhost(e) {
  if (!drag) return;
  drag.ghost.style.left = e.clientX - drag.w / 2 + "px";
  drag.ghost.style.top = e.clientY - drag.w / 2 + "px";
}
function onPointerMove(e) { if (drag) { drag.moved = true; moveGhost(e); } }
function onPointerUp(e) {
  if (!drag) return;
  const { from, ghost } = drag; drag = null; ghost.remove();
  if (practiceReveal) { renderBoard(); return; }
  const sq = sqFromPoint(e.clientX, e.clientY);
  if (sq && sq !== from) { if (!tryUserMove(from, sq)) renderBoard(); } else renderBoard();
}

function startLearn(id) {
  clearPracticeTimer();
  practiceReveal = false;
  practiceSessionId += 1;
  lesson = lessonById(id);
  if (!lesson) return;
  ensureCardsFor(lesson);
  steps = buildSteps(lesson);
  mode = "learn";
  learnIdx = 0;
  learnPhase = "show";
  feedback = "";
  banner = "";
  setFen(new Chess().fen());
  orientationColor = lesson.side === "black" ? "b" : "w";
  const opening = [];
  while (learnIdx < steps.length && steps[learnIdx].by === "them") opening.push(steps[learnIdx++]);
  if (opening.length) {
    // As Black the computer opens as White; watch its move, then study your answer
    feedback = "";
    afterReply(() => { for (const t of opening) playThem(t); });
  }
  render();
}

function startPractice(id) {
  clearPracticeTimer();
  practiceReveal = false;
  practiceSessionId += 1;
  const session = practiceSessionId;
  const L = id ? lessonById(id) : null;
  practiceMixed = !L;
  const poolLessons = L ? [L] : LESSONS;
  const stepsPool = [];
  for (const les of poolLessons) {
    ensureCardsFor(les);
    for (const st of learnerCards(les)) stepsPool.push(st);
  }
  const map = cardsMap();
  const cards = stepsPool.map((st) => map[st.cardId] || makeCard(st.cardId));
  for (const c of cards) if (!map[c.id]) map[c.id] = c;
  store.set(CARDS_KEY, map);

  const sessionCards = pickSession(cards, { maxDue: 15, maxNew: 5 });
  const byId = Object.fromEntries(stepsPool.map((s) => [s.cardId, s]));
  practiceQueue = sessionCards.map((c) => byId[c.id]).filter(Boolean);
  if (!practiceQueue.length) {
    practiceQueue = stepsPool.slice(0, Math.min(8, stepsPool.length));
  }
  if (session !== practiceSessionId) return; // superseded
  mode = "practice";
  lesson = L || (practiceQueue[0] ? lessonById(practiceQueue[0].lessonId) : poolLessons[0]);
  steps = lesson ? buildSteps(lesson) : [];
  feedback = `${practiceQueue.length} positions in this session.`;
  banner = "";
  if (practiceQueue[0]) startPracticeCard(practiceQueue[0]);
  render();
}

function learnContinue() {
  if (replyBusy) return;
  const step = currentUsStep();
  if (!step) return;
  if (learnPhase === "show") {
    learnPhase = "hint";
    feedback = `Your move. Hint: ${hintText(step)}`;
    setFen(step.beforeFen, prevMoveOf(step));
    render();
    return;
  }
  if (learnPhase === "hint") {
    learnPhase = "recall";
    feedback = "Play the move from memory (counts for spaced review).";
    setFen(step.beforeFen, prevMoveOf(step));
    render();
  }
}

function hintText(step) {
  const pieceHint = step.san.match(/^[NBRQK]/)?.[0] || "a piece";
  return `${step.idea} (starts with ${pieceHint === "a piece" ? step.san[0] : pieceHint}…)`;
}

function showAnswer() {
  const step = currentUsStep();
  if (!step) return;
  if (mode === "practice" && practiceReveal) return; // already revealing
  if (replyBusy) return;

  feedback = `Answer: ${step.san}. ${step.idea}`;
  setFen(step.afterFen, { from: step.from, to: step.to });

  if (mode === "practice") {
    const all = cardsMap();
    saveCard(reviewCard(all[step.cardId] || makeCard(step.cardId), false));
    practiceReveal = true;
    clearPracticeTimer();
    // No auto-advance — user taps Next (guards tab/lesson races)
    render();
    return;
  }

  if (mode === "learn") {
    // Revealing answer is guided, not graded success — record lapse so it stays due
    const all = ensureCardsFor(lesson);
    saveCard(reviewCard(all[step.cardId] || makeCard(step.cardId), false));
    advanceLearnAfterUs(step);
    if (mode === "learn" && steps[learnIdx]) {
      feedback = `Answer was ${step.san}. Next: study the shown move.`;
    }
    render();
  }
}

function goCatalog(opts = {}) {
  clearPracticeTimer();
  practiceReveal = false;
  practiceSessionId += 1;
  mode = "catalog";
  if (opts.clearFeedback) feedback = "";
  setFen(new Chess().fen());
  orientationColor = "w";
  render();
}

function renderCatalog() {
  const prog = progressSummary(cardsMap(), LESSONS);
  const tsum = testSummary(testResults());
  const due = dueCount(Object.values(cardsMap()));
  const white = LESSONS.filter((l) => l.side === "white");
  const black = LESSONS.filter((l) => l.side === "black");
  const card = (l) => {
    const n = learnerCards(l).length;
    return `<button type="button" class="op-card" data-id="${l.id}">
      <strong>${l.title}</strong>
      <span class="muted">${l.subtitle}</span>
      <span class="op-meta">${n} key moves · ${l.side}</span>
    </button>`;
  };
  const note = banner || feedback;
  return `
    ${note ? `<div class="op-banner" role="status">${note}</div>` : ""}
    <div class="op-progress">
      <div><b>${prog.seen}</b><span>Seen</span></div>
      <div><b>${prog.mastered}</b><span>Comfortable</span></div>
      <div><b>${due}</b><span>Due</span></div>
      <div><b>${prog.total}</b><span>Total</span></div>
    </div>
    <p class="op-lead">Beginner repertoires with ideas — Learn walks you through (no mastery inflate); Recall quizzes due moves for spaced credit. Stored separately from puzzle stats.</p>
    <div class="op-actions">
      <button type="button" class="primary" id="opPracticeAll">Recall due (${due})</button>
    </div>
    <div class="op-test-box">
      <div class="op-test-head"><b>Test mode</b> <span class="muted">5 of your moves · 5 tries · the computer plays the opponent · ${tsum.solved}/${tsum.total} variations solved</span></div>
      <div class="op-actions">
        <button type="button" class="primary" id="opTestNext">Test: next due</button>
        <button type="button" id="opTestRandom">Test: random</button>
        <button type="button" id="opTestAll">All variations</button>
      </div>
    </div>
    <h3 class="op-h">As White</h3>
    <div class="op-grid">${white.map(card).join("")}</div>
    <h3 class="op-h">As Black</h3>
    <div class="op-grid">${black.map(card).join("")}</div>
  `;
}

function renderLearnPanel() {
  const step = currentUsStep();
  const totalUs = steps.filter((s) => s.by === "us").length;
  const doneUs = steps.filter((s, i) => s.by === "us" && i < learnIdx).length;
  return `
    <div class="op-toolbar">
      <button type="button" id="opBack">← Lessons</button>
      <button type="button" id="opPracticeOne">Recall this</button>
    </div>
    <h3 class="op-h">${lesson.title}</h3>
    <p class="muted">${lesson.goal}</p>
    <p class="op-phase">Learn · step ${Math.min(doneUs + 1, totalUs)}/${totalUs} · <b>${learnPhase}</b>
      ${learnPhase === "recall" ? "· graded" : "· guided (no mastery credit)"}</p>
    <div class="op-idea">${step ? (learnPhase === "show" ? `Your move: <b>${step.san}</b> <span class="muted">(outlined on the board)</span> — ${step.idea}` : step.idea) : "Done."}</div>
    <p class="muted op-cpu-note">You play ${lesson.side === "white" ? "White" : "Black"}; the computer plays the opponent's book replies.</p>
    <div class="op-actions">
      ${learnPhase === "show" ? `<button type="button" class="primary" id="opContinue">Got it — hide move</button>` : ""}
      ${learnPhase === "hint" ? `<button type="button" class="primary" id="opContinue">Ready to try (ungraded)</button>` : ""}
      ${learnPhase === "recall" ? `<span class="muted">Play from memory on the board</span>` : ""}
      ${learnPhase !== "show" ? `<button type="button" id="opShowAns">Show answer</button>` : ""}
    </div>
    <p class="op-feedback">${feedback}</p>
  `;
}

function renderPracticePanel() {
  const step = practiceStep;
  const left = practiceQueue.length;
  const title = practiceMixed
    ? (step ? lessonTitleForStep(step) : "Mixed due moves")
    : (lesson ? lesson.title : "Recall");
  const mixNote = practiceMixed ? "Mixed" : title;
  return `
    <div class="op-toolbar">
      <button type="button" id="opBack" ${practiceReveal ? "" : ""}>← Lessons</button>
    </div>
    <h3 class="op-h">Recall practice</h3>
    <p class="muted">${practiceMixed ? `Mixed · now: ${title}` : title} · ${left} left in session
      ${practiceReveal ? " · revealing" : ""}</p>
    <div class="op-idea">${step && !practiceReveal ? (replyBusy ? "The computer is playing the opponent's move…" : "The opponent just moved (highlighted). Find your repertoire reply.") : (step ? `<b>${step.san}</b> — ${step.idea}` : "")}</div>
    <div class="op-actions">
      ${practiceReveal
        ? `<button type="button" class="primary" id="opPracticeNext">Next</button>`
        : `<button type="button" id="opShowAns">Show answer</button>
           <button type="button" id="opHint">Hint</button>`}
    </div>
    <p class="op-feedback">${feedback}</p>
  `;
}

// ---------------- Test mode (Wordle-style, shared board in app.js) ----------------
function testResults() { return store.get(RESULTS_KEY, {}); }

const STATUS_LABEL = { new: "new", retry: "retry", due: "re-test due", solved: "solved", locked: "locked" };
const STATUS_ICON = { new: "●", retry: "↻", due: "⏰", solved: "✓", locked: "🔒" };

function renderTestsPanel() {
  const results = testResults();
  const lessons = testLessonId ? [lessonById(testLessonId)] : LESSONS;
  const opts = [`<option value="">All openings</option>`, ...LESSONS.map((l) =>
    `<option value="${l.id}" ${l.id === testLessonId ? "selected" : ""}>${l.title}</option>`)].join("");
  const next = nextTest(results, testLessonId);
  const sections = lessons.map((l) => {
    const ordered = orderedVariations(l.id);
    const rows = ordered.map((v, i) => {
      const st = statusOf(results, ordered, i);
      const r = results[v.id];
      const meta = r && r.attempts.length
        ? `${r.solved}/${r.attempts.length} solved${r.bestTries ? ` · best ${r.bestTries}/${TEST_TRIES}` : ""}`
        : (st === "locked" ? `solve “${ordered[i - 1].main ? "main line" : ordered[i - 1].name}” to unlock` : "not tried");
      const label = v.main ? `Main line <small>(most common)</small>` : `${v.name} <small>${v.branch}</small>`;
      return `<button type="button" class="op-var ${st} ${next && next.id === v.id ? "next" : ""}" ${st === "locked" ? "disabled" : `data-test-id="${v.id}"`}>
        <span class="op-var-ico" aria-hidden="true">${STATUS_ICON[st]}</span>
        <span class="op-var-main"><span>${i + 1}. ${label}</span>
          <span class="op-meta">~${v.weight}% of games · ${STATUS_LABEL[st]} · ${meta}</span></span>
      </button>`;
    }).join("");
    return `<h3 class="op-h">${l.title} <span class="muted">${l.side === "white" ? "you play White" : "you play Black"}</span></h3>
      <div class="op-vars">${rows}</div>`;
  }).join("");
  return `
    <div class="op-toolbar">
      <button type="button" id="opBack">← Lessons</button>
      <select id="opTestLesson" aria-label="Opening">${opts}</select>
    </div>
    ${banner ? `<div class="op-banner" role="status">${banner}</div>` : ""}
    <p class="op-lead">You play only <b>your own side</b>: the computer plays the opponent's book move, you answer, and it
      replies instantly with the next book move — <b>5 of your moves</b> per try, 5 tries. Each move is graded as you play it:
      🟩 book move · 🟨 a book move from later in this line or another variation, but not here · ⬛ not in the book.
      Any non-🟩 move ends the try and the board resets. Main lines start from move one; sidelines start at the opponent's deviation.
      Variations go from the most common reply to rarer ones; solving one unlocks the next.</p>
    <div class="op-actions">
      <button type="button" class="primary" id="opTestNext">${next ? `Next due: ${next.lessonTitle} · ${next.main ? "main line" : next.name}` : "Next due"}</button>
      <button type="button" id="opTestRandom">Random</button>
    </div>
    ${sections}
  `;
}

function showTests(lessonId = null) {
  clearPracticeTimer();
  practiceReveal = false;
  practiceSessionId += 1;
  if (mode === "test" && hooks.endTest) hooks.endTest();
  mode = "tests";
  testLessonId = lessonId;
  currentTest = null;
  setFen(new Chess().fen());
  orientationColor = lessonId && lessonById(lessonId)?.side === "black" ? "b" : "w";
  showPanelChrome();
  render();
}

function startTestById(id) {
  const v = variationById(id);
  if (v) startTest(v);
}
function startNextTest(lessonId = null) {
  const v = nextTest(testResults(), lessonId);
  if (v) startTest(v); else { banner = "No test available."; render(); }
}
function startRandomTest(lessonId = null) {
  const v = randomTest(testResults(), lessonId);
  if (v) startTest(v);
}

/** Hand the board to app.js' Wordle-style engine for this variation. */
function startTest(v) {
  clearPracticeTimer();
  practiceReveal = false;
  practiceSessionId += 1;
  banner = "";
  currentTest = v;
  if (!hooks.startTest) { mode = "tests"; render(); return false; }
  mode = "test";
  $("#openingsPanel")?.classList.add("hidden");
  hooks.startTest(v, {
    onFinish: (won, tries) => finishTest(v, won, tries),
    onExit: () => showTests(testLessonId),
    nextAfter: () => nextAfter(v),
    pickNext: (kind) => (kind === "random" ? randomTest(testResults(), testLessonId) : nextTest(testResults(), testLessonId)),
  });
  return true;
}

/** After a result: the next less-common reply in the same opening if unlocked, else the next due test. */
function nextAfter(v) {
  const results = testResults();
  const follow = followingVariation(v.id);
  if (follow) {
    const ordered = orderedVariations(v.lessonId);
    if (statusOf(results, ordered, follow.order) !== "locked" && !(results[follow.id]?.solved)) return follow;
  }
  return nextTest(results, testLessonId);
}

/** Record a finished test: per-variation results + history log. Returns the updated record. */
function finishTest(v, won, tries) {
  const date = new Date().toISOString();
  const results = recordResult(testResults(), v.id, { solved: won, tries, date });
  store.set(RESULTS_KEY, results);
  logEvent({ kind: "opening-test", lesson: v.lessonId, variation: v.id, title: v.title, won: !!won, tries });
  const follow = followingVariation(v.id);
  const unlocked = won && follow && !(testResults()[follow.id]?.attempts?.length);
  return { record: results[v.id], unlocked: unlocked ? follow : null };
}

function showPanelChrome() {
  $("#puzzleChrome")?.classList.add("hidden");
  $("#openingsPanel")?.classList.remove("hidden");
  const controls = $("#controls"); if (controls) controls.hidden = true;
  const replay = $("#replay"); if (replay) replay.hidden = true;
  const solution = $("#solution"); if (solution) solution.hidden = true;
  const grid = $("#grid"); if (grid) grid.hidden = true;
  const tb = $("#testBar"); if (tb) tb.hidden = true;
}

function render() {
  const panel = $("#openingsPanel");
  if (!panel) return;
  if (mode === "test") return; // the shared puzzle board/grid is showing (app.js)
  if (mode === "catalog") panel.innerHTML = renderCatalog();
  else if (mode === "learn") panel.innerHTML = renderLearnPanel();
  else if (mode === "tests") panel.innerHTML = renderTestsPanel();
  else panel.innerHTML = renderPracticePanel();

  panel.querySelectorAll(".op-card").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      panel.querySelectorAll(".op-card").forEach((b) => b.classList.remove("pick"));
      btn.classList.add("pick");
      const existing = panel.querySelector(".op-pick-actions");
      if (existing) existing.remove();
      const row = document.createElement("div");
      row.className = "op-actions op-pick-actions";
      row.innerHTML = `<button type="button" class="primary" id="opLearn">Learn</button>
        <button type="button" id="opRecallOne">Recall</button>
        <button type="button" id="opTestOne">Test</button>`;
      btn.after(row);
      $("#opLearn").onclick = () => startLearn(id);
      $("#opRecallOne").onclick = () => startPractice(id);
      $("#opTestOne").onclick = () => showTests(id);
    };
  });
  const pa = $("#opPracticeAll"); if (pa) pa.onclick = () => startPractice(null);
  const tn = $("#opTestNext"); if (tn) tn.onclick = () => startNextTest(mode === "tests" ? testLessonId : null);
  const tr = $("#opTestRandom"); if (tr) tr.onclick = () => startRandomTest(mode === "tests" ? testLessonId : null);
  const ta = $("#opTestAll"); if (ta) ta.onclick = () => showTests(null);
  panel.querySelectorAll("[data-test-id]").forEach((b) => { b.onclick = () => startTestById(b.dataset.testId); });
  const tl = $("#opTestLesson");
  if (tl) tl.onchange = () => showTests(tl.value || null);
  const back = $("#opBack"); if (back) back.onclick = () => goCatalog({ clearFeedback: !banner });
  const cont = $("#opContinue"); if (cont) cont.onclick = learnContinue;
  const show = $("#opShowAns");
  if (show) {
    show.disabled = !!practiceReveal;
    show.onclick = showAnswer;
  }
  const next = $("#opPracticeNext"); if (next) next.onclick = practiceNext;
  const hint = $("#opHint");
  if (hint) {
    hint.disabled = !!practiceReveal;
    hint.onclick = () => {
      if (practiceReveal) return;
      const step = currentUsStep();
      if (step) { feedback = hintText(step); render(); }
    };
  }
  const pr1 = $("#opPracticeOne"); if (pr1) pr1.onclick = () => startPractice(lesson.id);

  renderBoard();
  const info = $("#info");
  if (info) {
    if (mode === "catalog") info.textContent = "Openings · pick a lesson to Learn, or Recall due moves";
    else if (mode === "learn") info.textContent = `Openings · Learn · ${lesson?.title || ""} · phase ${learnPhase}`;
    else if (mode === "tests") info.textContent = "Openings · Test · most common replies first, then sidelines (solve one to unlock the next)";
    else info.textContent = `Openings · Recall · ${lessonTitleForStep(practiceStep)} · ${practiceQueue.length} remaining`;
  }
}

function onKey(e) {
  if (!active) return;
  if (document.querySelector("dialog[open]")) return;
  if (e.key === "Enter" && mode === "learn" && learnPhase === "show") learnContinue();
  if (e.key === "Enter" && mode === "practice" && practiceReveal) practiceNext();
}

/** True while the Openings panel owns the board (false during a Test run, which uses the puzzle engine). */
export function openingsActive() { return active && mode !== "test"; }
/** True whenever the Openings tab is selected (including Test runs). */
export function openingsTabActive() { return active; }

export function enterOpenings() {
  clearPracticeTimer();
  practiceReveal = false;
  if (mode === "test" && hooks.endTest) hooks.endTest();
  active = true;
  mode = "catalog";
  // Keep banner if returning mid-session message; clear transient feedback only when empty banner
  if (!banner) feedback = "";
  lesson = null;
  setFen(new Chess().fen());
  orientationColor = "w";
  showPanelChrome();
  render();
}

export function leaveOpenings() {
  if (mode === "test" && hooks.endTest) hooks.endTest();
  mode = "catalog";
  currentTest = null;
  clearPracticeTimer();
  practiceReveal = false;
  practiceSessionId += 1;
  active = false;
  $("#puzzleChrome")?.classList.remove("hidden");
  $("#openingsPanel")?.classList.add("hidden");
  const grid = $("#grid"); if (grid) grid.hidden = false;
}

export function wireOpeningsEvents(h = {}) {
  hooks = { ...hooks, ...h };
  const board = $("#board");
  if (board) board.addEventListener("pointerdown", (e) => { if (openingsActive()) onPointerDown(e); });
  window.addEventListener("pointermove", (e) => { if (openingsActive()) onPointerMove(e); });
  window.addEventListener("pointerup", (e) => { if (openingsActive()) onPointerUp(e); });
  window.addEventListener("keydown", onKey);
}

// test seams (DOM-mock / unit)
export const _test = {
  CARDS_KEY, META_KEY, store,
  getState: () => ({
    active, mode, learnIdx, learnPhase, practiceReveal, practiceSessionId,
    practiceQueue: [...practiceQueue], practiceStep, practiceMixed, feedback, banner,
    lessonId: lesson?.id || null, fen, orientationColor,
    testLessonId, currentTestId: currentTest?.id || null,
    lastMove, replyBusy,
  }),
  setReplyDelay: (ms) => { replyDelay = ms; },
  setState: ( partial ) => {
    if ("mode" in partial) mode = partial.mode;
    if ("learnPhase" in partial) learnPhase = partial.learnPhase;
    if ("learnIdx" in partial) learnIdx = partial.learnIdx;
    if ("feedback" in partial) feedback = partial.feedback;
    if ("banner" in partial) banner = partial.banner;
    if ("practiceReveal" in partial) practiceReveal = partial.practiceReveal;
    if ("active" in partial) active = partial.active;
  },
  startLearn, startPractice, showAnswer, practiceNext, learnContinue,
  onLearnMove, onPracticeMove, currentUsStep, goCatalog,
  cardsMap, ensureCardsFor, clearPracticeTimer, advanceLearnAfterUs,
  commitUserMove, render, enterOpenings, leaveOpenings,
  showTests, startTest, startTestById, startNextTest, finishTest, nextAfter, testResults,
  setHooks: (h) => { hooks = { ...hooks, ...h }; },
};
