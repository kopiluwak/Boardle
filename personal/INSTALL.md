# Install Boardle personal v3.2 (computer plays the opponent in Openings)

This archive was **not** installed on your Mac for you; run these steps yourself.
It contains everything from earlier versions (Openings tab, Carolina blue board, ⚙ colors) plus v3, v3.1 and v3.2.

## 1. Back up the current folder
```bash
mv /Volumes/Internal_2T/Software/boardle/personal \
   /Volumes/Internal_2T/Software/boardle/personal.bak-$(date +%Y%m%d)
```

## 2. Put this `personal/` folder in place
Unzip so you have a directory named `personal`, then:
```bash
mv ~/Downloads/personal /Volumes/Internal_2T/Software/boardle/personal
```

## 3. Run (same command as before)
```bash
cd /Volumes/Internal_2T/Software/boardle/personal
python3 serve.py
```
Open http://localhost:8000/ and hard-refresh (`Cmd+Shift+R`) so the new JavaScript modules load.
`serve.py` still needs only the Python standard library. It now also stores player profiles in
`~/.boardle/boardle.sqlite3` — outside the app folder, so future upgrades never touch it.

## 4. Sign in (optional, recommended)
Click **👤** (top right) → enter a username + password → **Create account**.
Your existing progress in that browser (puzzle stats/streaks, openings, board colors) is copied into the
first profile you sign into; nothing is deleted. Other people create their own accounts the same way.
Signed out, the app behaves exactly as before (history stays in the browser as "Guest").

## What's new in v3
- **Openings → Test**: Wordle-style tests on the same board/grid as Boardle — 5 moves (both sides), 5 tries.
  Main line (most common reply) first; solving one unlocks the next less-common reply. "Test: next due",
  "Random", or pick any unlocked variation. Results are recorded per variation (solved, tries, date).
- **👤 Profile & history**: per-player results, streaks, openings progress, test results, recent activity,
  Export / Import JSON.
- **AWS-ready backend**: see `DEPLOY_AWS.md` (Lightsail/EC2 + SQLite, or App Runner + DynamoDB, Dockerfile).

## v3.1: fix for a blank board after updating
v3 could show only the header and an empty black board if your browser still had files cached from an
earlier version (it mixed the old `openings/data.js` with the new `openings/testmode.js`, so none of the
app's code ran). v3.1 fixes this for good:
- every app file URL carries the release version (`app.js?v=3.1`, `./data.js?v=3.1`, …), so old and new
  files can never mix;
- `serve.py` now sends `Cache-Control: no-cache` for app files (the browser always checks for updates);
- if the app ever fails to start, the board shows **"Reload fresh copy"** instead of staying blank.

After swapping in this folder and restarting `python3 serve.py`, press **Cmd+Shift+R** once. Your
progress (localStorage and `~/.boardle/`) is untouched.

When changing the code yourself, bump the version so browsers pick up the change:
`python3 tools/stamp_version.py 3.3` (then `node test-version.mjs` checks every import is stamped).

## What's new in v3.2: the computer plays your opponent
- **Openings → Test**: you only move **your own side**. The computer plays the opponent's book move (short
  animation + yellow last-move highlight) and answers each of your correct moves instantly. A try is 5 of your
  moves; 5 tries. Moves are graded as you play them — 🟩 book move · 🟨 a book move from later in this line or
  another variation, but not here · ⬛ not in the book. A non-🟩 move ends the try (the rest of the row stays
  blank) and the board resets. No Submit/Undo needed in tests.
- Main lines now start from move one (as Black, the computer opens 1.e4 / 1.d4); sidelines start at the
  opponent's deviation. All 30 variations were extended so every test has 5 of your moves.
- **Learn / Recall**: the computer also plays the opponent there (e.g. it opens 1.e4 when you learn a Black
  repertoire); in Learn's "show" step your move is outlined on the board instead of being played for you.
- Test results/history (solved, tries) are recorded per player exactly as before. An unfinished v3.1 test run
  is simply restarted (its rows used the old both-sides format).

Install exactly like before (steps 1–3), restart `python3 serve.py`, and press **Cmd+Shift+R** once.
The page should report version 3.2 (view source: `<meta name="boardle-version" content="3.2">`).

## Applying only the v3 patch instead
If your folder already matches the previous version (board colors, commit f82c606):
```bash
cd /Volumes/Internal_2T/Software/boardle/personal
git apply --check ~/Downloads/boardle-v3.patch
git apply ~/Downloads/boardle-v3.patch
```
Then hard-refresh. (Don't apply it to the folder from this ZIP — it already contains the changes.)

## Tests (optional)
```bash
node test.mjs && node openings/test-openings.mjs && node openings/test-testmode.mjs && node test-storage.mjs && node test-version.mjs
python3 -m unittest discover -s tests
```
