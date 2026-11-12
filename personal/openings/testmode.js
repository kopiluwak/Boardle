// Openings TEST mode — pure logic (no DOM): variation ordering, unlocks,
// "next due" selection, result recording. Used by openings/ui.js + app.js.
import { Chess } from "../vendor/chess.js?v=3.3";
import { LESSONS, TEST_TREES, lessonById } from "./data.js?v=3.3";

export const TEST_MOVES = 5;   // the player's OWN moves per try (the computer plays the replies)
export const TEST_PLIES = 2 * TEST_MOVES - 1; // plies a line needs after `start` (5 yours + 4 replies)
export const TEST_TRIES = 5;   // rows / chances, same as the Boardle 5×5 tab
export const RUN_FORMAT = 2;  // v3.2: rows hold only the player's moves (older saved runs are discarded)
export const RESULTS_KEY = "boardle:openings:tests";
export const runKey = (variationId) => `boardle:openings:testrun:${variationId}`;
// Re-test intervals after the n-th solve (light spaced repetition).
export const RETEST_DAYS = [1, 3, 7, 14, 30, 60];

const splitMoves = (m) => (Array.isArray(m) ? m.slice() : m.trim().split(/\s+/));

/** Variations for one opening: main line pinned first, then by weight (most common first). */
export function orderedVariations(lessonId) {
  const lesson = lessonById(lessonId);
  const raw = TEST_TREES[lessonId] || [];
  const sorted = raw
    .map((v, i) => ({ v, i }))
    .sort((a, b) => (Number(!!b.v.main) - Number(!!a.v.main)) || (b.v.weight - a.v.weight) || (a.i - b.i))
    .map(({ v }) => v);
  return sorted.map((v, order) => materialize(v, lesson, order, sorted.length));
}

/** All variations of all openings in catalogue order. */
export function allVariations() {
  return LESSONS.flatMap((l) => orderedVariations(l.id));
}

export function variationById(id) {
  return allVariations().find((v) => v.id === id) || null;
}

/**
 * Build the playable test.
 *  fen       position where the player is to move (after the opponent's branching move)
 *  introFen  position before that branching move (null when the test starts at move one as White);
 *            the computer plays `introSan` from here at the start of every try
 *  solution  the player's 5 book moves; replies[k] = the computer's book answer to solution[k]
 *  plies     the whole line from `fen` on (shown/replayed when the test is over)
 */
function materialize(v, lesson, order, count) {
  const moves = splitMoves(v.moves);
  const g = new Chess();
  const prefix = [];
  let last = null, introFen = null;
  for (let i = 0; i < v.start; i++) {
    if (i === v.start - 1) introFen = g.fen();
    const m = g.move(moves[i]);
    if (!m) throw new Error(`${v.id}: illegal ${moves[i]} at ply ${i}`);
    prefix.push(m.san); last = m;
  }
  const fen = g.fen();
  const plies = [], fens = [];
  for (let i = v.start; i < moves.length; i++) {
    fens.push(g.fen());
    const m = g.move(moves[i]);
    if (!m) throw new Error(`${v.id}: illegal ${moves[i]} at ply ${i}`);
    plies.push(m.san);
  }
  if (plies.length < TEST_PLIES) throw new Error(`${v.id}: needs ${TEST_PLIES} plies after start`);
  const solution = [], replies = [], userFens = [];
  for (let k = 0; k < TEST_MOVES; k++) {
    solution.push(plies[2 * k]);
    userFens.push(fens[2 * k]);
    replies.push(plies[2 * k + 1] || null);
  }
  const side = lesson ? lesson.side : (fen.split(" ")[1] === "w" ? "white" : "black");
  return {
    id: v.id,
    lessonId: lesson ? lesson.id : null,
    lessonTitle: lesson ? lesson.title.replace(/ \(as (White|Black)\)$/, "") : "",
    side,
    name: v.name,
    branch: v.branch,
    note: v.note || "",
    weight: v.weight,
    main: !!v.main,
    order,             // 0 = main line, then decreasing popularity
    count,
    start: v.start,
    prefix,            // SAN moves already played (shown to the player)
    fen,
    introFen,
    introSan: last ? last.san : null,
    solution,          // the player's 5 book moves
    replies,           // computer's book reply after each of them (last may be null)
    userFens,          // position before each of the player's moves
    plies,             // full line from fen
    last: last ? last.from + last.to : "",
    lastSan: last ? last.san : "",
    title: `${lesson ? lesson.title.replace(/ \(as (White|Black)\)$/, "") : ""} — ${v.main ? "main line (most common)" : `${v.name} ${v.branch}`}`,
  };
}

// ---------------- grading one try ----------------
const posKey = (fen) => fen.split(" ").slice(0, 3).join(" ");
const altIndex = {};
/** position → book moves for the player's side, from every line of this opening + the lesson (incl. alts). */
function bookMovesIndex(lessonId) {
  if (altIndex[lessonId]) return altIndex[lessonId];
  const idx = new Map();
  const add = (fen, san) => { const k = posKey(fen); if (!idx.has(k)) idx.set(k, new Set()); idx.get(k).add(san); };
  for (const v of TEST_TREES[lessonId] || []) {
    const g = new Chess();
    for (const san of splitMoves(v.moves)) { const f = g.fen(); const m = g.move(san); if (!m) break; add(f, m.san); }
  }
  const lesson = lessonById(lessonId);
  if (lesson) {
    const g = new Chess();
    for (const node of lesson.line) {
      const f = g.fen();
      for (const alt of node.alts || []) { try { const t = new Chess(f); const m = t.move(alt); if (m) add(f, m.san); } catch { /* ignore */ } }
      const m = g.move(node.san); if (!m) break; add(f, m.san);
    }
  }
  altIndex[lessonId] = idx;
  return idx;
}

/** Other book moves (not the expected one) for the player's k-th move in this variation. */
export function bookAlternatives(v, k) {
  const set = new Set(bookMovesIndex(v.lessonId).get(posKey(v.userFens[k])) || []);
  set.delete(v.solution[k]);
  return set;
}

/**
 * Grade the player's k-th move:
 *  "good" = the book move
 *  "okay" = not now, but it is one of your later moves in this line, or another known book move here
 *  "bad"  = not in the book
 */
export function gradeTestMove(v, k, san) {
  if (san === v.solution[k]) return "good";
  if (v.solution.slice(k + 1).includes(san)) return "okay";
  if (bookAlternatives(v, k).has(san)) return "okay";
  return "bad";
}

export function newAttempt() {
  return { k: 0, moves: [], results: [], over: false, won: false };
}

/**
 * Pure reducer for one try. Returns { att, reply }:
 *  - correct move → the computer's book reply to play next (null after your 5th move: solved)
 *  - any other move → the try ends there (att.over, not won); the board resets for the next try
 */
export function attemptMove(v, att, san) {
  if (att.over) return { att, reply: null };
  const res = gradeTestMove(v, att.k, san);
  const k = att.k + 1;
  const next = { k, moves: [...att.moves, san], results: [...att.results, res], over: false, won: false };
  if (res !== "good") return { att: { ...next, over: true }, reply: null };
  if (k >= TEST_MOVES) return { att: { ...next, over: true, won: true }, reply: null };
  return { att: next, reply: v.replies[att.k] };
}

/** Grid row for a finished try: unplayed cells are blank ("skip"). */
export function attemptRow(att) {
  const moves = att.moves.slice(0, TEST_MOVES), results = att.results.slice(0, TEST_MOVES);
  while (moves.length < TEST_MOVES) { moves.push(""); results.push("skip"); }
  return { moves, results };
}

/** "1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6" */
export function movetext(prefix) {
  let out = "";
  prefix.forEach((san, i) => {
    if (i % 2 === 0) out += `${i / 2 + 1}.${san} `;
    else out += `${san} `;
  });
  return out.trim();
}

/** Merge every variation line of an opening into a move tree (weights summed per node). */
export function buildVariationTree(lessonId) {
  const root = { san: null, weight: 0, children: [], variations: [] };
  for (const v of TEST_TREES[lessonId] || []) {
    let node = root;
    root.weight += v.weight;
    for (const san of splitMoves(v.moves)) {
      let child = node.children.find((c) => c.san === san);
      if (!child) { child = { san, weight: 0, children: [], variations: [] }; node.children.push(child); }
      child.weight += v.weight;
      node = child;
    }
    node.variations.push(v.id);
  }
  const sortRec = (n) => { n.children.sort((a, b) => b.weight - a.weight); n.children.forEach(sortRec); };
  sortRec(root);
  return root;
}

// ---------------- results ----------------
export function emptyResult() {
  return { attempts: [], solved: 0, failed: 0, bestTries: null, lastSolved: null, lastAttempt: null };
}

/** Pure: returns a new results map with one attempt appended. */
export function recordResult(results, variationId, { solved, tries, date = new Date().toISOString() }) {
  const prev = results[variationId] || emptyResult();
  const r = { ...prev, attempts: [...prev.attempts, { date, solved: !!solved, tries }].slice(-50) };
  if (solved) {
    r.solved += 1;
    r.lastSolved = date;
    r.bestTries = r.bestTries == null ? tries : Math.min(r.bestTries, tries);
  } else r.failed += 1;
  r.lastAttempt = date;
  return { ...results, [variationId]: r };
}

/** Variation k of an opening is unlocked once variation k-1 has been solved (main line always open). */
export function isUnlocked(results, ordered, index) {
  if (index <= 0) return true;
  const prev = ordered[index - 1];
  return !!(results[prev.id] && results[prev.id].solved > 0);
}

export function statusOf(results, ordered, index, now = Date.now()) {
  const v = ordered[index];
  const r = results[v.id];
  if (!isUnlocked(results, ordered, index)) return "locked";
  if (!r || !r.attempts.length) return "new";
  const lastAtt = r.attempts[r.attempts.length - 1];
  if (!lastAtt.solved) return "retry";
  return isDueForRetest(r, now) ? "due" : "solved";
}

export function isDueForRetest(r, now = Date.now()) {
  if (!r || !r.lastSolved) return true;
  const days = RETEST_DAYS[Math.min(r.solved - 1, RETEST_DAYS.length - 1)] || 1;
  return now - Date.parse(r.lastSolved) >= days * 86400000;
}

/**
 * Pick the next test.
 *  1. a variation whose last attempt failed (retry)
 *  2. the first unlocked, never-attempted variation, in popularity order
 *  3. a solved variation that is due for re-test (oldest first)
 *  4. otherwise the least-recently attempted unlocked one
 * lessonId = null → across all openings (catalogue order).
 */
export function nextTest(results, lessonId = null, now = Date.now()) {
  const groups = lessonId ? [orderedVariations(lessonId)] : LESSONS.map((l) => orderedVariations(l.id));
  const flat = [];
  for (const ordered of groups) ordered.forEach((v, i) => flat.push({ v, s: statusOf(results, ordered, i, now) }));
  const pick = (s) => flat.filter((x) => x.s === s).map((x) => x.v);
  const retry = pick("retry"); if (retry.length) return retry[0];
  // Interleave openings for "new": lowest order first (all main lines before sidelines)
  const fresh = pick("new").sort((a, b) => a.order - b.order);
  if (fresh.length) return fresh[0];
  const lastSolved = (v) => Date.parse(results[v.id]?.lastSolved || 0);
  const due = pick("due").sort((a, b) => lastSolved(a) - lastSolved(b));
  if (due.length) return due[0];
  const unlocked = flat.filter((x) => x.s !== "locked").map((x) => x.v)
    .sort((a, b) => Date.parse(results[a.id]?.lastAttempt || 0) - Date.parse(results[b.id]?.lastAttempt || 0));
  return unlocked[0] || null;
}

/** Random unlocked variation (optionally within one opening). rng injectable for tests. */
export function randomTest(results, lessonId = null, rng = Math.random) {
  const groups = lessonId ? [orderedVariations(lessonId)] : LESSONS.map((l) => orderedVariations(l.id));
  const pool = [];
  for (const ordered of groups) ordered.forEach((v, i) => { if (isUnlocked(results, ordered, i)) pool.push(v); });
  if (!pool.length) return null;
  return pool[Math.floor(rng() * pool.length) % pool.length];
}

/** The next less-common response after `variationId` within its opening (or null). */
export function followingVariation(variationId) {
  const v = variationById(variationId);
  if (!v) return null;
  const ordered = orderedVariations(v.lessonId);
  return ordered[v.order + 1] || null;
}

export function testSummary(results) {
  const all = allVariations();
  const solved = all.filter((v) => results[v.id]?.solved > 0).length;
  const attempts = all.reduce((n, v) => n + (results[v.id]?.attempts.length || 0), 0);
  return { total: all.length, solved, attempts };
}
