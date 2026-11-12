import { Chess } from "./vendor/chess.js?v=3.3";
import { CONFIG } from "./config.js?v=3.3";
import { scoreGuess, dayNumber, puzzleIndex, emojiGrid, shouldApplyStart } from "./logic.js?v=3.3";
import { enterOpenings, leaveOpenings, openingsActive, openingsTabActive, wireOpeningsEvents } from "./openings/ui.js?v=3.3";
import { wireSettingsUI } from "./settings.js?v=3.3";
import { store, initStorage, logEvent } from "./storage.js?v=3.3";
import { runKey, movetext, TEST_TRIES, TEST_MOVES, RUN_FORMAT, newAttempt, attemptMove, attemptRow } from "./openings/testmode.js?v=3.3";
import { slidePiece, REPLY_DELAY_MS } from "./anim.js?v=3.3";
import { wireProfileUI } from "./history.js?v=3.3";

const $ = (s) => document.querySelector(s);
const FILES = "abcdefgh";

let modeKey, mode, size, puzzle, day, todayNum, isToday;
let st;            // per-puzzle state {guesses:[], results:[], done, won}
let current = [];  // SAN moves for the row being entered
let game;          // chess.js instance for the active row
let selected = null, pendingPromo = null, replayPly = 0, drag = null;
let testCtx = null; // { v, cb } while an Openings Test runs on this board
// Openings Test try state: the player enters only their own moves; the computer plays the book replies.
let att = null;          // current try (openings/testmode.js attemptMove reducer)
let tryPlies = [];       // SAN plies played on the board this try after v.fen (yours + computer's)
let cpuBusy = false;     // computer is about to move / board resetting → input locked
let cpuTimer = null, cpuGen = 0;
let tryMsg = "";         // short feedback line in the test bar
const cache = {};

// ---------- loading ----------
async function loadPuzzles(n) {
  if (!cache[n]) cache[n] = await (await fetch(`puzzles/${n}.json`)).json();
  return cache[n];
}

let startGen = 0; // increments on every start(); stale awaits must not mutate DOM

async function start() {
  const runId = ++startGen;
  const hash = location.hash.slice(1);
  renderTabs(); // highlight follows URL hash immediately (not last-applied modeKey)
  if (hash === CONFIG.openings.hash) {
    // Invalidate any in-flight puzzle fetch
    startGen++; // ensure older awaits fail shouldApplyStart
    enterOpenings();
    return;
  }
  if (openingsTabActive()) leaveOpenings();
  const requested = (hash in CONFIG.modes) ? hash : CONFIG.defaultMode;
  modeKey = requested;
  mode = CONFIG.modes[modeKey]; size = mode.size;
  todayNum = dayNumber(new Date(), CONFIG.startDate);
  const q = new URLSearchParams(location.search).get("day");
  day = (CONFIG.allowDayOverride && q && +q >= 1) ? +q : Math.max(1, todayNum);
  isToday = day === Math.max(1, todayNum);
  const list = await loadPuzzles(size);
  if (!shouldApplyStart(runId, startGen, requested, location.hash.slice(1), CONFIG.modes, CONFIG.defaultMode, CONFIG.openings.hash)) {
    return; // superseded by a newer tab / openings
  }
  modeKey = requested;
  mode = CONFIG.modes[modeKey]; size = mode.size;
  puzzle = list[puzzleIndex(day, list.length)];
  st = store.get(stateKey(), null);
  if (!st || typeof st !== "object" || st.id !== puzzle.id || !Array.isArray(st.guesses) || !Array.isArray(st.results)) st = { id: puzzle.id, guesses: [], results: [], done: false, won: false };
  resetRow();
  replayPly = puzzle.moves.length;
  const grid = $("#grid"); if (grid) grid.hidden = false;
  const chrome = $("#puzzleChrome"); if (chrome) chrome.classList.remove("hidden");
  const op = $("#openingsPanel"); if (op) op.classList.add("hidden");
  renderTabs();
  render();
}
const stateKey = () => (testCtx ? runKey(testCtx.v.id) : `boardle:${modeKey}:day${day}`);
const statsKey = () => `boardle:stats:${modeKey}`;

function resetRow() { current = []; selected = null; game = new Chess(puzzle.fen); }

// ---------- board ----------
const orientation = () => puzzle.fen.split(" ")[1]; // player's colour = side to move
function squaresInOrder() {
  const out = [];
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const rank = orientation() === "w" ? 8 - r : r + 1;
    const file = orientation() === "w" ? f : 7 - f;
    out.push(FILES[file] + rank);
  }
  return out;
}

// ---------- Openings Test mode (same engine as the puzzle tabs) ----------
function clearCpuTimer() { if (cpuTimer != null) clearTimeout(cpuTimer); cpuTimer = null; cpuGen++; cpuBusy = false; }
/** Run fn after the reply delay unless the test was restarted/left meanwhile. */
function cpuLater(fn, ms = REPLY_DELAY_MS) {
  const gen = ++cpuGen;
  cpuBusy = true;
  cpuTimer = setTimeout(() => { cpuTimer = null; if (gen !== cpuGen || !testCtx) return; cpuBusy = false; fn(); }, ms);
}
/** The computer plays one book move on the test board, with slide animation + last-move highlight. */
function cpuPlay(san) {
  const m = game.move(san);
  if (!m) return null;
  tryPlies.push(m.san);
  render();
  slidePiece($("#board"), m.from, m.to);
  return m;
}

function startOpeningTest(v, cb) {
  startGen++; // drop any in-flight puzzle fetch
  clearCpuTimer();
  testCtx = { v, cb, finished: null };
  modeKey = "openings-test";
  mode = { label: "Openings Test", size: TEST_MOVES };
  size = TEST_MOVES; // grid: 5 of YOUR moves × 5 tries
  puzzle = { id: v.id, fen: v.fen, moves: v.plies, last: v.last, rating: null };
  st = store.get(stateKey(), null);
  if (!st || st.id !== v.id || st.done || st.fmt !== RUN_FORMAT || !Array.isArray(st.guesses)) {
    st = { id: v.id, fmt: RUN_FORMAT, guesses: [], results: [], done: false, won: false };
  }
  replayPly = puzzle.moves.length;
  $("#openingsPanel")?.classList.add("hidden");
  $("#puzzleChrome")?.classList.remove("hidden");
  const grid = $("#grid"); if (grid) grid.hidden = false;
  tryMsg = v.introFen ? `The computer plays ${v.side === "white" ? "Black" : "White"}. Watch its move, then answer.` :
    `You play ${v.side === "white" ? "White" : "Black"} — make your first move; the computer answers.`;
  beginTry();
}
/** Fresh try: back to the test position; the computer (re)plays its branching move first. */
function beginTry() {
  clearCpuTimer();
  att = newAttempt();
  tryPlies = [];
  selected = null; pendingPromo = null;
  current = [];
  const v = testCtx.v;
  if (v.introFen && !st.done) {
    game = new Chess(v.introFen);
    render();
    cpuLater(() => {
      const m = game.move(v.introSan);
      render();
      if (m) slidePiece($("#board"), m.from, m.to);
    });
  } else {
    game = new Chess(v.fen);
    render();
  }
}
/** A legal move by the player during a test. */
function onTestMove(mv) {
  if (!testCtx || cpuBusy || st.done || !att || att.over) return;
  const v = testCtx.v;
  const m = game.move(mv);
  if (!m) return;
  tryPlies.push(m.san);
  selected = null;
  const { att: nextAtt, reply } = attemptMove(v, att, m.san);
  att = nextAtt;
  current = att.moves.slice();
  const res = att.results[att.results.length - 1];
  if (!att.over) {
    tryMsg = `✓ ${m.san} — book move. The computer replies…`;
    render();
    cpuLater(() => {
      const r = cpuPlay(reply);
      tryMsg = r ? `Computer played ${r.san}. Your move (${att.k + 1}/${TEST_MOVES}).` : tryMsg;
      render();
    });
    return;
  }
  // try over: solved, or stopped at the first non-book move
  const row = attemptRow(att);
  st.guesses.push(...row.moves); st.results.push(...row.results);
  current = []; // the try is now a committed grid row
  const rows = st.guesses.length / size;
  const won = att.won;
  if (won || rows >= TEST_TRIES) {
    st.done = true; st.won = won; replayPly = v.plies.length; // show the whole line's final position
    testCtx.finished = testCtx.cb.onFinish(won, rows) || null;
    store.remove(stateKey()); // results recorded; next start is a fresh attempt
    tryMsg = won ? `✓ ${m.san} — solved! Full line below.` : `${m.san} isn't the book move. Out of tries — the line is shown below.`;
    current = [];
    render();
    setTimeout(() => openStats(), 600);
    return;
  }
  store.set(stateKey(), st);
  tryMsg = res === "okay"
    ? `🟨 ${m.san} is book elsewhere (later in this line or another variation), but not here. Back to the start — try ${rows + 1}/${TEST_TRIES}.`
    : `⬛ ${m.san} isn't in the book. Back to the start — try ${rows + 1}/${TEST_TRIES}.`;
  render();
  cpuLater(() => { beginTry(); }, 1100);
}
function endOpeningTest() {
  clearCpuTimer();
  testCtx = null;
  att = null; tryPlies = [];
  const tb = $("#testBar"); if (tb) { tb.hidden = true; tb.innerHTML = ""; }
}
/** "1.e4 e5 2.Nf3 …" with your moves bold and the computer's marked. */
function testMovesHtml(v) {
  const plies = st.done ? v.plies.slice(0, replayPly) : tryPlies;
  const all = [...v.prefix, ...plies];
  const userColor = v.side === "white" ? 0 : 1;
  let out = "";
  all.forEach((san, i) => {
    const num = i % 2 === 0 ? `<span class="mvnum">${i / 2 + 1}.</span>` : "";
    const cls = i < v.prefix.length ? "pre" : (i % 2 === userColor ? "you" : "cpu");
    out += `${num}<span class="mv ${cls}">${san}</span> `;
  });
  return out.trim();
}
function renderTestBar() {
  const tb = $("#testBar");
  if (!tb) return;
  if (!testCtx) { tb.hidden = true; return; }
  const { v } = testCtx;
  const rows = st.guesses.length / size;
  const fin = testCtx.finished;
  let status = `Try ${Math.min(rows + 1, TEST_TRIES)}/${TEST_TRIES} · your move ${Math.min((att ? att.k : 0) + 1, TEST_MOVES)}/${TEST_MOVES}`;
  if (st.done) status = st.won ? `Solved in ${rows}/${TEST_TRIES} 🎉` : `Out of tries — the full line is shown below`;
  else if (att && att.over) status = `Try ${rows}/${TEST_TRIES} ended · resetting the board…`;
  const next = st.done && testCtx.cb.nextAfter ? testCtx.cb.nextAfter() : null;
  tb.hidden = false;
  tb.innerHTML = `
    <div class="tb-row">
      <button type="button" id="tbBack">← Variations</button>
      <span class="tb-count">Variation ${v.order + 1}/${v.count}</span>
    </div>
    <div class="tb-title">${v.lessonTitle} — ${v.main ? "main line <small>(most common)</small>" : `${v.name} <small>${v.branch}</small>`}</div>
    <div class="tb-line"><span class="muted">You play ${v.side === "white" ? "White" : "Black"} · the computer plays ${v.side === "white" ? "Black" : "White"} · ~${v.weight}% of games</span></div>
    <div class="tb-moves" aria-label="Moves">${testMovesHtml(v) || '<span class="muted">Start position</span>'}</div>
    <div class="tb-status">${status}</div>
    ${tryMsg ? `<div class="tb-msg" role="status">${tryMsg}</div>` : ""}
    ${st.done ? `<div class="tb-note">${v.note}</div>
      ${fin && fin.unlocked ? `<div class="tb-unlock">🔓 Unlocked: ${fin.unlocked.name} <small>${fin.unlocked.branch}</small></div>` : ""}
      <div class="tb-row">
        <button type="button" id="tbRetry">Retry</button>
        ${next ? `<button type="button" class="primary" id="tbNext">Next: ${next.lessonId === v.lessonId ? (next.main ? "main line" : next.name) : next.lessonTitle} →</button>` : ""}
        <button type="button" id="tbShare">Share</button>
      </div>` : ""}`;
  $("#tbBack").onclick = () => { const cb = testCtx.cb; endOpeningTest(); cb.onExit(); };
  const r = $("#tbRetry"); if (r) r.onclick = () => { store.remove(runKey(v.id)); startOpeningTest(v, testCtx.cb); };
  const n = $("#tbNext"); if (n) n.onclick = () => startOpeningTest(next, testCtx.cb);
  const sh = $("#tbShare"); if (sh) sh.onclick = share;
}

function boardForView() {
  if (!st.done) return game;
  const g = new Chess(puzzle.fen);
  for (const m of puzzle.moves.slice(0, replayPly)) g.move(m);
  return g;
}

function renderBoard() {
  const g = boardForView();
  const el = $("#board"); el.innerHTML = "";
  const hist = g.history({ verbose: true });
  const lastMv = hist.length ? hist[hist.length - 1]
    : (puzzle.last && !(testCtx && g.fen() !== puzzle.fen)
      ? { from: puzzle.last.slice(0, 2), to: puzzle.last.slice(2, 4) } : { from: null, to: null });
  const targets = selected ? g.moves({ square: selected, verbose: true }).map((m) => m.to) : [];
  const order = squaresInOrder();
  order.forEach((sq, i) => {
    const d = document.createElement("div");
    const fileIdx = FILES.indexOf(sq[0]), rank = +sq[1];
    d.className = "sq " + ((fileIdx + rank) % 2 ? "light" : "dark");
    d.dataset.sq = sq;
    if (sq === lastMv.from || sq === lastMv.to) d.classList.add("last");
    if (sq === selected) d.classList.add("sel");
    const p = g.get(sq);
    if (targets.includes(sq)) d.classList.add(p ? "capture" : "target");
    if (p) {
      const img = document.createElement("img");
      img.src = `pieces/${p.color}${p.type.toUpperCase()}.svg`; img.draggable = false; img.alt = "";
      d.appendChild(img);
    }
    if (p && p.type === "k" && g.inCheck() && p.color === g.turn()) d.classList.add("check");
    if (i % 8 === 0) d.insertAdjacentHTML("beforeend", `<span class="coord r">${rank}</span>`);
    if (i >= 56) d.insertAdjacentHTML("beforeend", `<span class="coord f">${sq[0]}</span>`);
    el.appendChild(d);
  });
}

function rowFull() { return testCtx ? !!(att && att.over) : (current.length >= size || game.isGameOver()); }

function tryMove(from, to) {
  const legal = game.moves({ square: from, verbose: true }).filter((m) => m.to === to);
  if (!legal.length) return false;
  if (legal.some((m) => m.promotion)) { pendingPromo = { from, to }; showPromo(); return true; }
  commitMove({ from, to });
  return true;
}
function commitMove(mv) {
  if (testCtx) return onTestMove(mv);
  const m = game.move(mv);
  current.push(m.san);
  selected = null; render();
}

function showPromo() {
  const box = $("#promo"); box.innerHTML = "";
  for (const t of ["q", "r", "b", "n"]) {
    const b = document.createElement("button");
    b.innerHTML = `<img src="pieces/${game.turn()}${t.toUpperCase()}.svg" alt="${t}">`;
    b.onclick = () => { box.hidden = true; commitMove({ ...pendingPromo, promotion: t }); pendingPromo = null; };
    box.appendChild(b);
  }
  const c = document.createElement("button"); c.textContent = "✕";
  c.onclick = () => { box.hidden = true; pendingPromo = null; selected = null; render(); };
  box.appendChild(c);
  box.hidden = false;
}

function sqFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  return el && el.closest(".sq") ? el.closest(".sq").dataset.sq : null;
}

function onPointerDown(e) {
  if (openingsActive()) return;
  if (!st || st.done || rowFull() || pendingPromo || cpuBusy) return;
  const sq = sqFromPoint(e.clientX, e.clientY); if (!sq) return;
  const p = game.get(sq);
  if (selected && selected !== sq && (!p || p.color !== game.turn())) {
    if (!tryMove(selected, sq)) { selected = null; render(); }
    return;
  }
  if (p && p.color === game.turn()) {
    selected = sq; render();
    const img = $(`#board [data-sq="${sq}"] img`);
    if (img) {
      const ghost = img.cloneNode(); ghost.className = "ghost";
      const w = img.getBoundingClientRect().width; ghost.style.width = ghost.style.height = w + "px";
      document.body.appendChild(ghost); img.style.opacity = 0.3;
      drag = { from: sq, ghost, w, moved: false };
      moveGhost(e);
      e.preventDefault();
    }
  } else { selected = null; render(); }
}
function moveGhost(e) {
  if (!drag) return;
  drag.ghost.style.left = e.clientX - drag.w / 2 + "px";
  drag.ghost.style.top = e.clientY - drag.w / 2 + "px";
}
function onPointerMove(e) { if (openingsActive()) return; if (drag) { drag.moved = true; moveGhost(e); } }
function onPointerUp(e) {
  if (openingsActive()) return;
  if (!drag) return;
  const { from, ghost } = drag; drag = null; ghost.remove();
  if (cpuBusy) { render(); return; }
  const sq = sqFromPoint(e.clientX, e.clientY);
  if (sq && sq !== from) { if (!tryMove(from, sq)) render(); } else render();
}

// ---------- grid ----------
function renderGrid() {
  const el = $("#grid"); el.innerHTML = ""; el.style.setProperty("--n", size);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const i = r * size + c;
      const t = document.createElement("div"); t.className = "tile";
      if (i < st.guesses.length) { t.textContent = st.guesses[i]; t.classList.add(st.results[i]); }
      else if (!st.done && r === st.guesses.length / size && c < current.length) {
        t.textContent = current[c];
        t.classList.add(testCtx && att && att.results[c] ? att.results[c] : "typed");
      }
      el.appendChild(t);
    }
  }
}

// ---------- actions ----------
function undo() {
  if (testCtx) return; // Openings test: moves are graded instantly, no undo
  if (openingsActive() || !st || st.done || !current.length) return;
  game.undo(); current.pop(); selected = null; render();
}

function submit() {
  if (testCtx) return; // Openings test: moves are graded as you play them
  if (openingsActive() || !st || st.done || !rowFull() || !current.length) return;
  const guess = current.slice();
  while (guess.length < size) guess.push("–"); // game ended early (e.g. premature mate)
  const res = scoreGuess(guess, puzzle.moves);
  st.guesses.push(...guess); st.results.push(...res);
  const won = res.every((r) => r === "good");
  const rows = st.guesses.length / size;
  if (won || rows >= size) {
    st.done = true; st.won = won; replayPly = 0;
    if (testCtx) {
      testCtx.finished = testCtx.cb.onFinish(won, rows) || null;
    } else {
      if (isToday) updateStats(won, rows);
      logEvent({ kind: "puzzle", mode: modeKey, day, id: puzzle.id, won, tries: rows, size, archive: !isToday });
    }
  }
  if (testCtx && st.done) store.remove(stateKey()); // results recorded; next start is a fresh attempt
  else store.set(stateKey(), st);
  resetRow(); render();
  if (st.done) setTimeout(() => openStats(), 400);
}

function updateStats(won, rows) {
  const s = store.get(statsKey(), { played: 0, wins: 0, streak: 0, maxStreak: 0, lastWonDay: null, dist: {} });
  s.played++;
  if (won) {
    s.wins++;
    s.streak = s.lastWonDay === day - 1 ? s.streak + 1 : 1;
    s.maxStreak = Math.max(s.maxStreak, s.streak);
    s.lastWonDay = day;
    s.dist[rows] = (s.dist[rows] || 0) + 1;
  } else s.streak = 0;
  store.set(statsKey(), s);
}

function shareText() {
  const rows = st.won ? st.guesses.length / size : "X";
  if (testCtx) {
    const v = testCtx.v;
    return `${CONFIG.title} Openings · ${v.lessonTitle} — ${v.main ? "main line" : `${v.name} ${v.branch}`} ${rows}/${size}\n` +
      emojiGrid(st.results, size) + `\n${location.origin}${location.pathname}#${CONFIG.openings.hash}`;
  }
  return `${CONFIG.title} ${mode.label === CONFIG.title ? "" : mode.label + " "}#${day} ${rows}/${size}\n` +
    emojiGrid(st.results, size) + `\n${location.origin}${location.pathname}#${modeKey}`;
}
async function share() {
  const text = shareText();
  if (navigator.share && /Mobi|Android|iPhone/i.test(navigator.userAgent)) { try { await navigator.share({ text }); return; } catch {} }
  await navigator.clipboard.writeText(text);
  toast("Copied to clipboard!");
}

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), 1800);
}

function openStats() {
  if (testCtx && st) {
    const v = testCtx.v;
    const rec = (store.get("boardle:openings:tests", {})[v.id]) || null;
    $("#statsBody").innerHTML = `
      <p class="result">${st.done ? (st.won ? `Solved in ${st.guesses.length / size}/${size}! 🎉` : "Out of tries.") : "Test in progress."}
        ${st.done ? `Line: <b>${puzzle.moves.join(" ")}</b>` : ""}</p>
      <p>${v.title}</p>
      ${rec ? `<div class="nums"><div><b>${rec.attempts.length}</b>Attempts</div><div><b>${rec.solved}</b>Solved</div>
        <div><b>${rec.bestTries ?? "–"}</b>Best</div></div>` : ""}
      <button type="button" id="statsHistory">Full history</button>
      ${st.done ? `<button id="shareBtn" class="primary">Share</button>` : ""}`;
    const sb = $("#shareBtn"); if (sb) sb.onclick = share;
    $("#statsHistory").onclick = () => { $("#stats").close(); $("#profileBtn").click(); };
    $("#stats").showModal();
    return;
  }
  if (openingsActive()) {
    $("#statsBody").innerHTML = `<p class="muted">Puzzle statistics stay on Mini / Boardle / Mega / Maxi.
      Openings progress is tracked inside the Openings tab (separate from these stats).</p>
      <button type="button" id="statsHistory">Full history</button>`;
    $("#statsHistory").onclick = () => { $("#stats").close(); $("#profileBtn").click(); };
    $("#stats").showModal();
    return;
  }
  const s = store.get(statsKey(), { played: 0, wins: 0, streak: 0, maxStreak: 0, lastWonDay: null, dist: {} });
  const streak = s.lastWonDay !== null && s.lastWonDay >= Math.max(1, todayNum) - 1 ? s.streak : 0;
  const max = Math.max(1, ...Object.values(s.dist));
  let bars = "";
  for (let r = 1; r <= size; r++) {
    const v = s.dist[r] || 0;
    bars += `<div class="bar"><span>${r}</span><div style="width:${Math.max(6, (v / max) * 100)}%">${v}</div></div>`;
  }
  $("#statsBody").innerHTML = `
    ${st.done ? `<p class="result">${st.won ? "Solved! 🎉" : "Out of attempts."} Solution: <b>${puzzle.moves.join(" ")}</b></p>
      <p><a href="https://lichess.org/training/${puzzle.id}" target="_blank" rel="noopener">Puzzle ${puzzle.id} on Lichess</a> · rating ${puzzle.rating}</p>` : ""}
    <div class="nums"><div><b>${s.played}</b>Played</div><div><b>${s.played ? Math.round((100 * s.wins) / s.played) : 0}</b>Win %</div>
    <div><b>${streak}</b>Streak</div><div><b>${s.maxStreak}</b>Max</div></div>
    <h4>Guess distribution (${mode.label})</h4>${bars}
    <button type="button" id="statsHistory">Full history</button>
    ${st.done ? `<button id="shareBtn" class="primary">Share</button>` : ""}`;
  const sb = $("#shareBtn"); if (sb) sb.onclick = share;
  $("#statsHistory").onclick = () => { $("#stats").close(); $("#profileBtn").click(); };
  $("#stats").showModal();
}

// ---------- render ----------
function renderTabs() {
  const hash = location.hash.slice(1);
  const onOpenings = hash === CONFIG.openings.hash;
  // Highlight from the URL so rapid switches never show a mismatched "on" tab
  const activeMode = onOpenings ? null : ((hash in CONFIG.modes) ? hash : CONFIG.defaultMode);
  const modeLinks = Object.entries(CONFIG.modes).map(([k, m]) =>
    `<a href="#${k}" class="${k === activeMode ? "on" : ""}">${m.label}<small>${m.size}×${m.size}</small></a>`).join("");
  const op = CONFIG.openings;
  const opLink = `<a href="#${op.hash}" class="${onOpenings ? "on" : ""}">${op.label}<small>learn · test</small></a>`;
  $("#tabs").innerHTML = modeLinks + opLink;
}

function render() {
  if (openingsActive() || !puzzle) return;
  renderBoard(); renderGrid();
  const turn = puzzle.fen.split(" ")[1] === "w" ? "White" : "Black";
  if (testCtx) {
    const you = testCtx.v.side === "white" ? "White" : "Black";
    $("#info").innerHTML = `Openings · Test · you play ${you}, the computer plays the book replies · find your next ${TEST_MOVES} moves · ${TEST_TRIES} tries`;
  } else {
    $("#info").innerHTML = `#${day}${isToday ? "" : " (archive)"} · ${turn} to move · find the next ${size} moves (both sides) · rating ${puzzle.rating}`;
  }
  renderTestBar();
  $("#controls").hidden = st.done || !!testCtx; // tests grade each move instantly (no Submit/Undo)
  $("#replay").hidden = !st.done;
  $("#submitBtn").disabled = !(rowFull() && current.length);
  $("#undoBtn").disabled = !current.length;
  $("#solution").hidden = !st.done;
  if (st.done) {
    const userPar = testCtx ? 0 : -1; // in a test, even plies from v.fen are yours, odd ones the computer's
    $("#solution").innerHTML = puzzle.moves.map((m, i) => `<span class="${i < replayPly ? "played" : ""}${userPar === 0 && i % 2 ? " cpu" : ""}">${m}</span>`).join("");
  }
}

// ---------- wiring ----------
$("#board").addEventListener("pointerdown", onPointerDown);
window.addEventListener("pointermove", onPointerMove);
window.addEventListener("pointerup", onPointerUp);
$("#undoBtn").onclick = undo;
$("#submitBtn").onclick = submit;
$("#prevBtn").onclick = () => { replayPly = Math.max(0, replayPly - 1); render(); };
$("#nextBtn").onclick = () => { replayPly = Math.min(puzzle.moves.length, replayPly + 1); render(); };
$("#helpBtn").onclick = () => $("#help").showModal();
$("#statsBtn").onclick = openStats;
// Load the signed-in player's history (or Guest localStorage) before anything reads state.
// Each init step is isolated so a failure in one (bad old localStorage, server hiccup,
// settings/profile UI) can never leave the board blank.
function safely(label, fn) {
  try { return fn(); } catch (err) { console.error(`[boardle] ${label} failed:`, err); return undefined; }
}
try { await initStorage(); } catch (err) { console.error("[boardle] storage init failed:", err); }
safely("settings", () => wireSettingsUI({ $, toast }));
safely("profile", () => wireProfileUI({ $, toast }));
document.querySelectorAll("dialog .close").forEach((b) => (b.onclick = () => b.closest("dialog").close()));
window.addEventListener("keydown", (e) => {
  if (document.querySelector("dialog[open]")) return;
  if (openingsActive()) return;
  if (e.key === "Backspace") undo();
  if (e.key === "Enter") submit();
  if (st && st.done && e.key === "ArrowLeft") $("#prevBtn").click();
  if (st && st.done && e.key === "ArrowRight") $("#nextBtn").click();
});
window.addEventListener("hashchange", start);
safely("openings", () => wireOpeningsEvents({ startTest: startOpeningTest, endTest: endOpeningTest }));
const initialHash = location.hash.slice(1);
safely("help", () => {
  if (!localStorage.getItem("boardle:seenHelp")) {
    localStorage.setItem("boardle:seenHelp", "1");
    // Don't block a deep-link straight into Openings with the puzzle help dialog
    if (initialHash !== CONFIG.openings.hash) $("#help").showModal();
  }
});
window.__boardleBooted = true;
Promise.resolve().then(start).catch((err) => {
  console.error("[boardle] start failed:", err);
  if (window.__boardleBootFailed) { window.__boardleBooted = false; window.__boardleBootFailed(String(err && err.message || err)); }
});
