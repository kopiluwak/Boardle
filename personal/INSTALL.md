# Install Boardle personal v3 (Openings Test mode + player profiles/history)

This archive was **not** installed on your Mac for you; run these steps yourself.
It contains everything from earlier versions (Openings tab, Carolina blue board, ⚙ colors) plus v3.

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
node test.mjs && node openings/test-openings.mjs && node openings/test-testmode.mjs && node test-storage.mjs
python3 -m unittest discover -s tests
```
