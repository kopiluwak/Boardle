// Pure openings trainer logic (no DOM). Builds positions from lesson lines.

import { Chess } from "../vendor/chess.js?v=3.1";

/**
 * Apply a SAN move; throws if illegal.
 * @returns {{ san: string, fen: string, beforeFen: string }}
 */
export function playSan(fen, san) {
  const g = new Chess(fen);
  const beforeFen = g.fen();
  const m = g.move(san);
  if (!m) throw new Error(`Illegal move ${san} in ${fen}`);
  return { san: m.san, fen: g.fen(), beforeFen, color: m.color };
}

/** Walk a full lesson line from the standard start; return step snapshots. */
export function buildSteps(lesson) {
  const g = new Chess();
  const steps = [];
  for (let i = 0; i < lesson.line.length; i++) {
    const node = lesson.line[i];
    const beforeFen = g.fen();
    const m = g.move(node.san);
    if (!m) throw new Error(`Lesson ${lesson.id}: illegal ${node.san} at ply ${i}`);
    steps.push({
      index: i,
      san: m.san,
      alts: (node.alts || []).map(String),
      by: node.by, // "us" | "them"
      idea: node.idea || "",
      beforeFen,
      afterFen: g.fen(),
      cardId: `${lesson.id}:${i}`,
      lessonId: lesson.id,
    });
  }
  return steps;
}

/** Cards the learner should answer (only "us" moves). */
export function learnerCards(lesson) {
  return buildSteps(lesson).filter((s) => s.by === "us");
}

export function isAcceptable(step, san) {
  if (!san) return false;
  if (san === step.san) return true;
  return (step.alts || []).includes(san);
}

/**
 * Grade a attempt from beforeFen. Returns { ok, played, expected }.
 * Soft-accepts alts that are legal from the position.
 */
export function gradeAttempt(step, san) {
  const g = new Chess(step.beforeFen);
  let m = null;
  try {
    m = g.move(san);
  } catch {
    m = null;
  }
  if (!m) return { ok: false, played: null, expected: step.san, reason: "illegal" };
  const ok = isAcceptable(step, m.san) || isAcceptable(step, san);
  return { ok, played: m.san, expected: step.san, reason: ok ? "ok" : "wrong" };
}

/** Learn-mode phases for one "us" move: show → hint → recall */
export const LEARN_PHASES = ["show", "hint", "recall"];

export function nextLearnPhase(phase) {
  const i = LEARN_PHASES.indexOf(phase);
  if (i < 0 || i >= LEARN_PHASES.length - 1) return null;
  return LEARN_PHASES[i + 1];
}

/**
 * Auto-play "them" moves after an accepted "us" move, returning updated fen
 * and the them-steps consumed (for UI messaging).
 */
export function advancePastThem(steps, fromIndex, fen) {
  let i = fromIndex + 1;
  let cur = fen;
  const played = [];
  while (i < steps.length && steps[i].by === "them") {
    const r = playSan(cur, steps[i].san);
    cur = r.fen;
    played.push(steps[i]);
    i++;
  }
  return { fen: cur, nextIndex: i, them: played };
}

export function progressSummary(cardsById, lessons) {
  const all = [];
  for (const lesson of lessons) {
    for (const step of learnerCards(lesson)) {
      all.push(cardsById[step.cardId] || null);
    }
  }
  const total = all.length;
  const seen = all.filter((c) => c && c.seen > 0).length;
  const mastered = all.filter((c) => c && (c.level || 0) >= 4).length;
  const due = all.filter((c) => c && c.due <= Date.now()).length;
  return { total, seen, mastered, due };
}
