// Spaced-review helpers for the openings trainer (pure, no DOM).
// Intervals are intentionally simple — not claimed to match any commercial product.

export const INTERVALS_MS = [
  0,                 // due now (just introduced / failed)
  10 * 60 * 1000,    // 10 minutes
  60 * 60 * 1000,    // 1 hour
  24 * 60 * 60 * 1000,   // 1 day
  3 * 24 * 60 * 60 * 1000,  // 3 days
  7 * 24 * 60 * 60 * 1000,  // 7 days
  21 * 24 * 60 * 60 * 1000, // 21 days
];

export function makeCard(id, now = Date.now()) {
  return {
    id,
    level: 0,
    due: now,
    seen: 0,
    correct: 0,
    wrong: 0,
    last: null,
  };
}

/** Advance or reset a card after a review. Wrong answers drop to level 0. */
export function reviewCard(card, wasCorrect, now = Date.now()) {
  const next = { ...card, seen: (card.seen || 0) + 1, last: now };
  if (wasCorrect) {
    next.correct = (card.correct || 0) + 1;
    next.level = Math.min((card.level || 0) + 1, INTERVALS_MS.length - 1);
  } else {
    next.wrong = (card.wrong || 0) + 1;
    next.level = 0;
  }
  next.due = now + INTERVALS_MS[next.level];
  return next;
}

export function isDue(card, now = Date.now()) {
  return (card.due ?? 0) <= now;
}

/** Stable sort: due first (oldest due), then lower level, then id. */
export function sortDue(cards, now = Date.now()) {
  return [...cards].sort((a, b) => {
    const ad = isDue(a, now) ? 0 : 1;
    const bd = isDue(b, now) ? 0 : 1;
    if (ad !== bd) return ad - bd;
    if (a.due !== b.due) return (a.due || 0) - (b.due || 0);
    if ((a.level || 0) !== (b.level || 0)) return (a.level || 0) - (b.level || 0);
    return String(a.id).localeCompare(String(b.id));
  });
}

export function dueCount(cards, now = Date.now()) {
  return cards.filter((c) => isDue(c, now)).length;
}

/** Cap how many new (never-seen) cards join a session. */
export function pickSession(cards, { now = Date.now(), maxDue = 20, maxNew = 5 } = {}) {
  const sorted = sortDue(cards, now);
  const due = sorted.filter((c) => isDue(c, now) && (c.seen || 0) > 0);
  const fresh = sorted.filter((c) => (c.seen || 0) === 0);
  return [...due.slice(0, maxDue), ...fresh.slice(0, maxNew)];
}
