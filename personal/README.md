# Boardle (personal edition)

A self-contained, zero-build recreation of [Boardle](https://github.com/rorycochrane/Boardle)
(the original lives one folder up): a daily chess puzzle played Wordle-style.

* **Pure static site** — HTML + CSS + vanilla JavaScript (ES modules). No React, no npm, no database.
* **Python only for tooling** — a tiny `serve.py` for local play and `tools/build_puzzles.py` to regenerate puzzles.
* 4 puzzle modes like the original: **Mini** (3 moves × 3 tries), **Boardle** (5×5), **Mega** (7×7), **Maxi** (9×9).
* Fifth tab **Openings** (`#openings`): beginner White & Black lessons with move ideas, Learn (show → hint → recall) and spaced Recall practice. Progress uses separate `localStorage` keys from puzzle stats.
* 1,095 Lichess puzzles per mode (3 years of dailies), then it wraps around.

## How to play
Your opponent has just moved (yellow squares). Play the best continuation **for both sides** on the board;
each move fills a tile in SAN. When the row is full, **Submit** (Enter). 🟩 right move/right slot,
🟨 in the solution but elsewhere, ⬛ not in the solution. Undo = Backspace. After the game, use ◀ ▶ to replay the
solution, see stats, and copy an emoji share grid.

## Run locally
```bash
cd /Volumes/Internal_2T/Software/boardle/personal
python3 serve.py          # http://localhost:8000   (or: python3 serve.py 8080)
```
It must be served over http(s) (ES modules + `fetch` don't work from `file://`). Any static server works,
e.g. `npx serve .`.

## Deploy to your website
Upload the **contents of this folder** anywhere that serves static files — the root or a sub-path
(e.g. `https://example.com/boardle/`); all paths are relative. You only need:
`index.html style.css app.js logic.js config.js vendor/ pieces/ puzzles/`
(`serve.py`, `tools/`, `test.mjs`, `README.md` are optional).

* **Existing web server (nginx/Apache)**: `rsync -av --exclude tools --exclude test.mjs ./ user@host:/var/www/html/boardle/`
* **GitHub Pages**: push this folder to a repo → Settings → Pages → deploy from branch.
* **Netlify / Cloudflare Pages / Vercel**: drag-and-drop the folder or point at the repo; no build command, output dir = `.`.
* Make sure `.js` is served as `text/javascript` (all mainstream hosts do).

## Customise — `config.js`
* `startDate` — the date of puzzle #1 (default 2026-11-03). Day number = days since then + 1, using the
  player's local date (the original used America/Los_Angeles midnight).
* `modes` — rename/remove modes. `defaultMode` — which one `/` opens. Modes are selected by URL hash: `#mini`, `#classic`, `#mega`, `#maxi`.
* `allowDayOverride` — when true, `?day=N` plays any day's puzzle (archive/practice; doesn't affect stats).

## Regenerate / extend puzzles
```bash
python3 -m venv .venv && .venv/bin/pip install chess zstandard
curl -LO https://database.lichess.org/lichess_db_puzzle.csv.zst     # ~300 MB, CC0
.venv/bin/python tools/build_puzzles.py lichess_db_puzzle.csv.zst --per-size 1095
node test.mjs      # verifies scoring + that every bundled solution is legal in chess.js
node openings/test-openings.mjs   # lesson legality + spaced-review / trainer invariants
```
Filters (tunable flags): popularity ≥ 85, ≥ 300 plays, rating deviation ≤ 90; deterministic shuffle (`--seed`).
Puzzle format (`puzzles/<n>.json`): `{id, fen, last, moves[], rating, url}` where `fen` is the position *after*
the opponent's setup move `last` (UCI) and `moves` is the SAN solution to guess — same transformation the
original Flask API performed.

## Files
```
index.html        page shell + help/stats dialogs
style.css         layout, board, tiles (Wordle colours)
app.js            board UI (click or drag), promotion picker, rows/submit, stats, share
logic.js          pure logic: scoreGuess (same algorithm as original), day → puzzle index, emoji grid
config.js         settings
vendor/chess.js   chess.js 1.4.0 (BSD-2) – move legality + SAN
pieces/*.svg      cburnett piece set (from Lichess, GPLv2+)
puzzles/*.json    3/5/7/9-move puzzles from the Lichess puzzle DB (CC0)
serve.py          stdlib local server
tools/build_puzzles.py   puzzle generator
test.mjs          node sanity tests (puzzle scoring + legality)
openings/         openings trainer (data, schedule, trainer, ui) + tests
```

## Openings tab
Original beginner lines (Italian, London, Queen's Gambit as White; Open Game, Caro-Kann, QGD as Black) with short idea notes written for this build — **not** copied from Chessable/Chess.com courses.
Feature inspiration (methods only): active recall & spaced review ([Chessable MoveTrainer reviews](https://checkmatex.app/blog/chessable-review-i-tried-it-for-30-days), [ChessDir Chessable](https://chessdir.app/apps/chessable)); repertoire practice / coverage thinking ([Chessbook](https://chessbook.com/), [64 Squares review](https://64squares.substack.com/p/chessbook-review)); free exploration patterns ([Lichess features](https://lichess.org/features)); learn-by-playing passes ([Prologue comparison](https://prologuechess.com/en/blog/best-chess-opening-apps/)).
No fabricated popularity percentages — lessons teach ideas, not database stats.


## Differences from the original
* No Flask/Postgres/React/Heroku — puzzles ship as static JSON, selected client-side by date.
* Stats/streaks per mode in `localStorage` (like the original), plus a guess-distribution chart.
* If a guess ends the game early (e.g. a premature mate), you can submit the short row; empty slots count as ⬛.
* Highlights the opponent's last move and checks; lichess training link shown after finishing.
