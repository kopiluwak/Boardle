// node test.mjs — sanity checks for scoring + every bundled puzzle's solution is legal
import { readFileSync } from "fs";
import { Chess } from "./vendor/chess.js";
import { scoreGuess, dayNumber, puzzleIndex, emojiGrid } from "./logic.js";
import assert from "assert";

assert.deepStrictEqual(scoreGuess(["a","b","c"],["a","b","c"]), ["good","good","good"]);
assert.deepStrictEqual(scoreGuess(["b","a","x"],["a","b","c"]), ["okay","okay","bad"]);
assert.deepStrictEqual(scoreGuess(["a","a","a"],["a","b","b"]), ["good","bad","bad"]);
assert.deepStrictEqual(scoreGuess(["b","a","a"],["a","b","a"]), ["okay","okay","good"]);
assert.strictEqual(dayNumber(new Date(2026,10,3), "2026-11-03"), 1);
assert.strictEqual(dayNumber(new Date(2027,10,3), "2026-11-03"), 366);
assert.strictEqual(puzzleIndex(1096, 1095), 0);
assert.strictEqual(emojiGrid(["good","okay","bad"],3), "🟩🟨⬛");
for (const n of [3,5,7,9]) {
  const list = JSON.parse(readFileSync(`puzzles/${n}.json`));
  for (const p of list) {
    assert.strictEqual(p.moves.length, n, p.id);
    const g = new Chess(p.fen);
    for (const m of p.moves) assert.strictEqual(g.move(m).san, m, p.id);
  }
  console.log(`size ${n}: ${list.length} puzzles OK`);
}
console.log("all tests passed");
