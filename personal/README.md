# Boardle (personal edition)

A self-contained, zero-build recreation of [Boardle](https://github.com/rorycochrane/Boardle)
(the original lives one folder up): a daily chess puzzle played Wordle-style.

* **Static front end** — HTML + CSS + vanilla JavaScript (ES modules). No React, no npm build.
* **Optional tiny backend** — `serve.py` (stdlib Python) serves the app plus a JSON API for player profiles and
  per-player history (SQLite locally, DynamoDB on AWS — see `DEPLOY_AWS.md`). Hosted as plain static files the
  app still works; history then stays in the browser.
* 4 puzzle modes like the original: **Mini** (3 moves × 3 tries), **Boardle** (5×5), **Mega** (7×7), **Maxi** (9×9).
* Fifth tab **Openings** (`#openings`): beginner White & Black lessons with move ideas, Learn (show → hint → recall) and spaced Recall practice. Progress uses separate `localStorage` keys from puzzle stats.
* Larger board (up to `min(90vw, calc(100vh - 220px), 680px)`), default **Carolina blue / white** squares, and a **⚙ Board settings** dialog (custom colors + presets) stored under `boardle:settings:boardColors`.
* **Openings → Test** mode: Wordle-style, same board/grid as Boardle — you play only **your own side** and the
  computer plays the opponent's book replies (short animation + last-move highlight). Find 5 of your moves in
  5 tries; each move is graded as you play it (🟩 book · 🟨 book elsewhere · ⬛ not book) and any non-🟩 move ends
  the try and resets the board. Main line (most common reply) first, then rarer replies unlock as you solve them.
* **The computer always plays the opponent** in Learn and Recall too: as Black it opens 1.e4 / 1.d4 for you,
  then answers each of your moves with the book reply.
* **👤 Profiles & history**: sign in (username + password) so each player has their own results, streaks,
  openings progress, test results and board colors; history view + JSON export/import.
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

Ports, environment variables, storage, accounts, tests, and AWS operations are in
[RUNTIME.md](RUNTIME.md).

## Deploy to your website
For sign-in + per-player history on AWS: serverless (CloudFront + S3 + Lambda + DynamoDB) with **`aws/README-DEPLOY.md`** / `aws/deploy.sh`, or a single server / App Runner with **`DEPLOY_AWS.md`**.
Runtime details (architecture, env vars, logs, backups, teardown) are in [RUNTIME.md](RUNTIME.md).
Plain static hosting below still works, with history kept in each browser.

Upload the **contents of this folder** anywhere that serves static files — the root or a sub-path
(e.g. `https://example.com/boardle/`); all paths are relative. You only need:
`index.html style.css app.js logic.js config.js settings.js openings/ vendor/ pieces/ puzzles/`
(`serve.py`, `tools/`, `test.mjs`, `README.md`, `INSTALL.md` are optional).

* **Existing web server (nginx/Apache)**: `rsync -av --exclude tools --exclude test.mjs ./ user@host:/var/www/html/boardle/`
* **GitHub Pages**: push this folder to a repo → Settings → Pages → deploy from branch.
* **Netlify / Cloudflare Pages / Vercel**: drag-and-drop the folder or point at the repo; no build command, output dir = `.`.
* Make sure `.js` is served as `text/javascript` (all mainstream hosts do).

## Updating / cache busting
All local module URLs carry `?v=<version>` (see `<meta name="boardle-version">` in `index.html`). After
editing any `.js`/`.css`, run `python3 tools/stamp_version.py <new-version>`; `node test-version.mjs` verifies
it. `serve.py` sends `Cache-Control: no-cache` for static files, and a boot guard in `index.html` shows a
"Reload fresh copy" button if the app fails to start.

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
node openings/test-testmode.mjs   # test-mode lines legal, ordering / unlocks / next-due
node test-storage.mjs             # storage modes, migration, merge, export/import
python3 -m unittest discover -s tests   # API: register/login/history isolation (SQLite; DynamoDB via moto)
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
anim.js           piece slide animation + computer reply delay (Openings)
logic.js          pure logic: scoreGuess (same algorithm as original), day → puzzle index, emoji grid
config.js         settings
vendor/chess.js   chess.js 1.4.0 (BSD-2) – move legality + SAN
pieces/*.svg      cburnett piece set (from Lichess, GPLv2+)
puzzles/*.json    3/5/7/9-move puzzles from the Lichess puzzle DB (CC0)
serve.py          local server (static app + /api), stdlib only
RUNTIME.md        runtime and operations (env vars, storage, tests, AWS)
boardle_backend/  API server, password hashing, SQLite + DynamoDB storage
storage.js        front-end storage: localStorage (Guest/static) or synced profile
history.js        👤 profile / sign-in / history dialog
Dockerfile, DEPLOY_AWS.md, requirements.txt   AWS deployment (server / App Runner)
aws/                                         serverless AWS deploy: deploy.sh, destroy.sh, lambda_handler.py
tools/build_puzzles.py   puzzle generator
test.mjs          node sanity tests (puzzle scoring + legality)
openings/         openings trainer (data, schedule, trainer, testmode, ui) + tests
tests/            Python API tests
```

## Openings tab
Original beginner lines (Italian, London, Queen's Gambit as White; Open Game, Caro-Kann, QGD as Black) with short idea notes written for this build — **not** copied from Chessable/Chess.com courses.
Feature inspiration (methods only): active recall & spaced review ([Chessable MoveTrainer reviews](https://checkmatex.app/blog/chessable-review-i-tried-it-for-30-days), [ChessDir Chessable](https://chessdir.app/apps/chessable)); repertoire practice / coverage thinking ([Chessbook](https://chessbook.com/), [64 Squares review](https://64squares.substack.com/p/chessbook-review)); free exploration patterns ([Lichess features](https://lichess.org/features)); learn-by-playing passes ([Prologue comparison](https://prologuechess.com/en/blog/best-chess-opening-apps/)).
Learn / Recall / Test never ask you to move the opponent's pieces: the computer plays them (≈0.5 s delay,
slide animation, last-move highlight). In Learn's *show* phase your recommended move is outlined on the board
instead of being played for you.

Test design (v3.2): main lines start from move one (as Black the computer opens), sidelines start at the
opponent's deviation, which the computer replays at the start of every try. A try is 5 of **your** moves; after
each correct move the computer replies instantly with the book move. A wrong move can't be "continued" (the
book has no reply to it), so the try stops there — remaining cells stay blank (⬜ in the share grid) — and the
board resets for the next try. 🟨 means the move is one of your later moves in this line, or another book move
from this opening at this position (other variations / Learn alternatives), but not the move for this line.

Test-mode variation weights (`TEST_TREES` in `openings/data.js`) are **approximate**, rounded from Lichess
opening-explorer frequencies, and are only used to order tests from most to least common.


## Differences from the original
* No Flask/Postgres/React/Heroku — puzzles ship as static JSON, selected client-side by date.
* Stats/streaks per mode in `localStorage` (like the original), plus a guess-distribution chart.
* Board colors default to Carolina blue / white; change them anytime via ⚙ (does not affect puzzle or openings progress keys).
* If a guess ends the game early (e.g. a premature mate), you can submit the short row; empty slots count as ⬛.
* Highlights the opponent's last move and checks; lichess training link shown after finishing.
