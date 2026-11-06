// Pure game logic (no DOM) — shared by the app and the tests.

// Wordle-style scoring, identical to the original Boardle getResult():
//  "good" = right move in the right slot
//  "okay" = move appears elsewhere in the solution (multiplicity-aware)
//  "bad"  = not in the solution
export function scoreGuess(guess, solution) {
  const result = Array(guess.length).fill("bad");
  const guessFreq = {}, targetFreq = {};
  for (let i = 0; i < guess.length; i++) {
    if (guess[i] === solution[i]) result[i] = "good";
    else {
      guessFreq[guess[i]] = (guessFreq[guess[i]] || 0) + 1;
      targetFreq[solution[i]] = (targetFreq[solution[i]] || 0) + 1;
    }
  }
  for (let i = 0; i < guess.length; i++) {
    if (result[i] === "bad" && guessFreq[guess[i]] > 0 && targetFreq[guess[i]] > 0) {
      result[i] = "okay";
      guessFreq[guess[i]]--;
      targetFreq[guess[i]]--;
    }
  }
  return result;
}

// Puzzle number for a date. Day 1 = START_DATE. Uses the player's local calendar day.
export function dayNumber(date, startDate) {
  const [y, m, d] = startDate.split("-").map(Number);
  const start = Date.UTC(y, m - 1, d);
  const today = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor((today - start) / 86400000) + 1;
}

export function puzzleIndex(dayNum, count) {
  return (((dayNum - 1) % count) + count) % count;
}

export function emojiGrid(results, size) {
  const map = { good: "🟩", okay: "🟨", bad: "⬛" };
  const rows = [];
  for (let r = 0; r * size < results.length; r++) {
    const row = results.slice(r * size, (r + 1) * size);
    if (row.every((x) => x)) rows.push(row.map((x) => map[x]).join(""));
  }
  return rows.join("\n");
}
