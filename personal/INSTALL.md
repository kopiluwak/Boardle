# Install Boardle personal (Openings + board settings) — local copy

Safe steps for Pete’s machine. This archive was **not** installed for you; run these yourself.

## 1. Backup the current folder
```bash
mv /Volumes/Internal_2T/Software/boardle/personal \
   /Volumes/Internal_2T/Software/boardle/personal.bak-$(date +%Y%m%d)
```

## 2. Put this `personal/` folder in place
Unzip so you have a directory named `personal`, then:
```bash
mv /path/to/extracted/personal /Volumes/Internal_2T/Software/boardle/personal
```
(Or copy the contents of the extracted `personal/` into that path.)

## 3. Run
```bash
cd /Volumes/Internal_2T/Software/boardle/personal
python3 serve.py
```
Open http://localhost:8000/ — puzzle tabs Mini / Boardle / Mega / Maxi; Openings at http://localhost:8000/#openings

## 4. Hard-refresh the browser
After updating files, hard-refresh (or clear cache) so ES modules reload (`app.js`, `settings.js`, `openings/*.js`).

## Board look
- Default squares: **white** (`#FFFFFF`) and **Carolina blue** (`#4B9CD3`).
- Board is larger on desktop (`min(90vw, calc(100vh - 220px), 680px)`).
- Header **⚙** opens Board settings: color pickers, presets (Carolina, classic green/beige, walnut/cream, slate/ice), and Reset.
- Colors persist in `localStorage` under `boardle:settings:boardColors` (separate from puzzle and openings keys).

## Applying only the board-colors patch
If you already installed the openings ZIP and only want the board/settings change:
```bash
cd /Volumes/Internal_2T/Software/boardle/personal
git apply --check /path/to/boardle-board-colors.patch   # or: patch -p1 --dry-run < …
git apply /path/to/boardle-board-colors.patch            # or: patch -p1 < …
```
Then hard-refresh.

## Tests (optional)
```bash
node test.mjs
node openings/test-openings.mjs
```

## Notes
- Keeps existing puzzle modes, stats keys, and puzzle/piece assets.
- Openings progress is separate (`localStorage` keys under `boardle:openings:`).
- No npm build required.
