// Openings tab UI — additive; puzzle mode DOM is hidden while this is active.
import { Chess } from "../vendor/chess.js";
import { LESSONS, lessonById } from "./data.js";
import {
  buildSteps, learnerCards, gradeAttempt, LEARN_PHASES, nextLearnPhase,
  advancePastThem, progressSummary,
} from "./trainer.js";
import {
  makeCard, reviewCard, isDue, pickSession, dueCount,
} from "./schedule.js";

const FILES = "abcdefgh";
const $ = (s, root = document) => root.querySelector(s);

const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

const CARDS_KEY = "boardle:openings:cards";
const META_KEY = "boardle:openings:meta";

let active = false;
let lesson = null;
let steps = [];
let mode = "catalog"; // catalog | learn | practice
let learnIdx = 0;     // index into steps
let learnPhase = "show";
let practiceQueue = [];
let practiceStep = null;
let fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
let game = new Chess();
let selected = null;
let pendingPromo = null;
let drag = null;
let feedback = "";
let orientationColor = "w";

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

function setFen(f) {
  fen = f;
  game = new Chess(f);
  selected = null;
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
  const hist = game.history({ verbose: true });
  const lastMv = hist.length ? hist[hist.length - 1] : null;
  const targets = selected ? game.moves({ square: selected, verbose: true }).map((m) => m.to) : [];
  squaresInOrder().forEach((sq, i) => {
    const d = document.createElement("div");
    const fileIdx = FILES.indexOf(sq[0]), rank = +sq[1];
    d.className = "sq " + ((fileIdx + rank) % 2 ? "light" : "dark");
    d.dataset.sq = sq;
    if (lastMv && (sq === lastMv.from || sq === lastMv.to)) d.classList.add("last");
    if (sq === selected) d.classList.add("sel");
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
  const box = $("#promo"); box.innerHTML = ""; box.hidden = false;
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

function onLearnMove(mv) {
  const step = currentUserStep();
  if (!step || learnPhase === "show") return false;
  const g = new Chess(step.beforeFen);
  let m = null;
  try { m = g.move(mv); } catch { m = null; }
  if (!m) { feedback = "Illegal move — try again."; render(); return false; }
  const grade = gradeAttempt(step, m.san);
  if (!grade.ok) {
    feedback = `Not quite. ${hintText(step)}`;
    setFen(step.beforeFen);
    render();
    return false;
  }
  const all = ensureCardsFor(lesson);
  saveCard(reviewCard(all[step.cardId] || makeCard(step.cardId), true));
  const afterUs = new Chess(step.beforeFen);
  afterUs.move(m.san);
  const adv = advancePastThem(steps, step.index, afterUs.fen());
  setFen(adv.fen);
  learnIdx = adv.nextIndex;
  learnPhase = "show";
  feedback = `Nice — ${m.san}. ${step.idea}`;
  if (learnIdx >= steps.length) {
    feedback += " Lesson complete! Try Recall to lock it in.";
    mode = "catalog";
    store.set(META_KEY, { ...(store.get(META_KEY, {})), lastLesson: lesson.id, lastFinished: Date.now() });
  } else if (steps[learnIdx] && steps[learnIdx].by === "us") {
    setFen(steps[learnIdx].afterFen);
  }
  render();
  return true;
}

function onPracticeMove(mv) {
  const step = practiceStep;
  if (!step) return false;
  const g = new Chess(step.beforeFen);
  let m = null;
  try { m = g.move(mv); } catch { m = null; }
  if (!m) { feedback = "Illegal move."; render(); return false; }
  const grade = gradeAttempt(step, m.san);
  const all = cardsMap();
  const prev = all[step.cardId] || makeCard(step.cardId);
  const card = reviewCard(prev, grade.ok);
  saveCard(card);
  if (grade.ok) {
    feedback = `Correct: ${m.san}. ${step.idea}`;
    setFen(step.afterFen);
  } else {
    feedback = `Expected ${step.san}. ${step.idea}`;
    setFen(step.beforeFen);
  }
  // next card
  practiceQueue.shift();
  practiceStep = null;
  if (practiceQueue.length) {
    startPracticeCard(practiceQueue[0]);
  } else {
    feedback += " Session finished.";
    mode = "catalog";
  }
  render();
  return true;
}

function startPracticeCard(step) {
  practiceStep = step;
  setFen(step.beforeFen);
  orientationColor = step.beforeFen.split(" ")[1];
  selected = null;
}

function sqFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  return el && el.closest(".sq") ? el.closest(".sq").dataset.sq : null;
}

function onPointerDown(e) {
  if (!active || (mode !== "learn" && mode !== "practice")) return;
  if (mode === "learn" && learnPhase === "show") return;
  if (pendingPromo) return;
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
  const sq = sqFromPoint(e.clientX, e.clientY);
  if (sq && sq !== from) { if (!tryUserMove(from, sq)) renderBoard(); } else renderBoard();
}

function startLearn(id) {
  lesson = lessonById(id);
  if (!lesson) return;
  ensureCardsFor(lesson);
  steps = buildSteps(lesson);
  mode = "learn";
  learnIdx = 0;
  learnPhase = "show";
  feedback = "";
  // play out leading "them" moves if any (Black lessons)
  setFen(new Chess().fen());
  orientationColor = lesson.side === "black" ? "b" : "w";
  while (learnIdx < steps.length && steps[learnIdx].by === "them") {
    const s = steps[learnIdx];
    setFen(s.afterFen);
    learnIdx++;
  }
  if (learnIdx < steps.length) setFen(steps[learnIdx].afterFen);
  render();
}

function startPractice(id) {
  const L = id ? lessonById(id) : null;
  const poolLessons = L ? [L] : LESSONS;
  const allCards = cardsMap();
  const stepsPool = [];
  for (const les of poolLessons) {
    ensureCardsFor(les);
    for (const st of learnerCards(les)) stepsPool.push(st);
  }
  const cards = stepsPool.map((st) => allCards[st.cardId] || makeCard(st.cardId));
  // ensure saved
  const map = cardsMap();
  for (const c of cards) if (!map[c.id]) map[c.id] = c;
  store.set(CARDS_KEY, map);

  const sessionCards = pickSession(cards, { maxDue: 15, maxNew: 5 });
  const byId = Object.fromEntries(stepsPool.map((s) => [s.cardId, s]));
  practiceQueue = sessionCards.map((c) => byId[c.id]).filter(Boolean);
  if (!practiceQueue.length) {
    // bootstrap: take first few learner moves
    practiceQueue = stepsPool.slice(0, Math.min(8, stepsPool.length));
  }
  mode = "practice";
  lesson = L || poolLessons[0];
  steps = lesson ? buildSteps(lesson) : [];
  feedback = `${practiceQueue.length} positions in this session.`;
  startPracticeCard(practiceQueue[0]);
  render();
}

function learnContinue() {
  const step = currentUsStep();
  if (!step) return;
  if (learnPhase === "show") {
    // show the move on the board briefly by playing it, then undo for hint/recall
    learnPhase = "hint";
    feedback = `Your move. Hint: ${hintText(step)}`;
    setFen(step.beforeFen);
    render();
    return;
  }
  if (learnPhase === "hint") {
    learnPhase = "recall";
    feedback = "Play the move from memory.";
    setFen(step.beforeFen);
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
  feedback = `Answer: ${step.san}. ${step.idea}`;
  setFen(step.afterFen);
  if (mode === "practice") {
    const all = cardsMap();
    const card = reviewCard(all[step.cardId] || makeCard(step.cardId), false);
    saveCard(card);
    practiceQueue.shift();
    setTimeout(() => {
      if (practiceQueue.length) startPracticeCard(practiceQueue[0]);
      else { mode = "catalog"; feedback += " Session finished."; }
      render();
    }, 600);
  } else if (mode === "learn") {
    // treat as failed recall then advance with them moves
    const all = ensureCardsFor(lesson);
    saveCard(reviewCard(all[step.cardId] || makeCard(step.cardId), false));
    const afterUs = step.afterFen;
    const adv = advancePastThem(steps, step.index, afterUs);
    setFen(adv.fen);
    learnIdx = adv.nextIndex;
    learnPhase = "show";
    if (learnIdx >= steps.length) {
      mode = "catalog";
      feedback += " Lesson finished — review with Recall.";
    }
  }
  render();
}

function renderCatalog() {
  const prog = progressSummary(cardsMap(), LESSONS);
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
  return `
    <div class="op-progress">
      <div><b>${prog.seen}</b><span>Seen</span></div>
      <div><b>${prog.mastered}</b><span>Comfortable</span></div>
      <div><b>${due}</b><span>Due</span></div>
      <div><b>${prog.total}</b><span>Total</span></div>
    </div>
    <p class="op-lead">Beginner repertoires with ideas — Learn walks you through; Recall quizzes due moves (stored separately from puzzle stats).</p>
    <div class="op-actions">
      <button type="button" class="primary" id="opPracticeAll">Recall due (${due})</button>
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
    <p class="op-phase">Learn · step ${Math.min(doneUs + 1, totalUs)}/${totalUs} · <b>${learnPhase}</b></p>
    <div class="op-idea">${step ? (learnPhase === "show" ? `<b>${step.san}</b> — ${step.idea}` : step.idea) : "Done."}</div>
    <div class="op-actions">
      ${learnPhase === "show" ? `<button type="button" class="primary" id="opContinue">Got it — hide move</button>` : ""}
      ${learnPhase === "hint" ? `<button type="button" class="primary" id="opContinue">Ready to try</button>` : ""}
      ${learnPhase !== "show" ? `<button type="button" id="opShowAns">Show answer</button>` : ""}
    </div>
    <p class="op-feedback">${feedback}</p>
  `;
}

function renderPracticePanel() {
  const step = practiceStep;
  const left = practiceQueue.length;
  return `
    <div class="op-toolbar">
      <button type="button" id="opBack">← Lessons</button>
    </div>
    <h3 class="op-h">Recall practice</h3>
    <p class="muted">${lesson ? lesson.title : "Mixed"} · ${left} left in session</p>
    <div class="op-idea">${step ? "Find the repertoire move for the side to move." : ""}</div>
    <div class="op-actions">
      <button type="button" id="opShowAns">Show answer</button>
      <button type="button" id="opHint">Hint</button>
    </div>
    <p class="op-feedback">${feedback}</p>
  `;
}

function render() {
  const panel = $("#openingsPanel");
  if (!panel) return;
  if (mode === "catalog") panel.innerHTML = renderCatalog();
  else if (mode === "learn") panel.innerHTML = renderLearnPanel();
  else panel.innerHTML = renderPracticePanel();

  // wire buttons
  panel.querySelectorAll(".op-card").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      panel.querySelectorAll(".op-card").forEach((b) => b.classList.remove("pick"));
      btn.classList.add("pick");
      // dual action row
      const existing = panel.querySelector(".op-pick-actions");
      if (existing) existing.remove();
      const row = document.createElement("div");
      row.className = "op-actions op-pick-actions";
      row.innerHTML = `<button type="button" class="primary" id="opLearn">Learn</button>
        <button type="button" id="opRecallOne">Recall</button>`;
      btn.after(row);
      $("#opLearn").onclick = () => startLearn(id);
      $("#opRecallOne").onclick = () => startPractice(id);
    };
  });
  const pa = $("#opPracticeAll"); if (pa) pa.onclick = () => startPractice(null);
  const back = $("#opBack"); if (back) back.onclick = () => { mode = "catalog"; feedback = ""; setFen(new Chess().fen()); orientationColor = "w"; render(); };
  const cont = $("#opContinue"); if (cont) cont.onclick = learnContinue;
  const show = $("#opShowAns"); if (show) show.onclick = showAnswer;
  const hint = $("#opHint"); if (hint) hint.onclick = () => {
    const step = currentUsStep();
    if (step) { feedback = hintText(step); render(); }
  };
  const pr1 = $("#opPracticeOne"); if (pr1) pr1.onclick = () => startPractice(lesson.id);

  renderBoard();
  const info = $("#info");
  if (info) {
    if (mode === "catalog") info.textContent = "Openings · pick a lesson to Learn, or Recall due moves";
    else if (mode === "learn") info.textContent = `Openings · Learn · ${lesson?.title || ""} · phase ${learnPhase}`;
    else info.textContent = `Openings · Recall · ${practiceQueue.length} remaining`;
  }
}

function onKey(e) {
  if (!active) return;
  if (document.querySelector("dialog[open]")) return;
  if (e.key === "Enter" && mode === "learn" && learnPhase === "show") learnContinue();
}

export function openingsActive() { return active; }

export function enterOpenings() {
  active = true;
  mode = "catalog";
  feedback = "";
  lesson = null;
  setFen(new Chess().fen());
  orientationColor = "w";
  $("#puzzleChrome")?.classList.add("hidden");
  $("#openingsPanel")?.classList.remove("hidden");
  $("#controls").hidden = true;
  $("#replay").hidden = true;
  $("#solution").hidden = true;
  $("#grid").hidden = true;
  render();
}

export function leaveOpenings() {
  active = false;
  $("#puzzleChrome")?.classList.remove("hidden");
  $("#openingsPanel")?.classList.add("hidden");
  $("#grid").hidden = false;
}

export function wireOpeningsEvents() {
  $("#board").addEventListener("pointerdown", (e) => { if (active) onPointerDown(e); });
  window.addEventListener("pointermove", (e) => { if (active) onPointerMove(e); });
  window.addEventListener("pointerup", (e) => { if (active) onPointerUp(e); });
  window.addEventListener("keydown", onKey);
}

// test seams
export const _test = {
  CARDS_KEY, META_KEY, startLearn, startPractice, cardsMap, ensureCardsFor,
};
