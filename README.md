# Boardle (kopiluwak fork)

A fork of [rorycochrane/Boardle](https://github.com/rorycochrane/Boardle), the daily
chess puzzle played Wordle-style ([playboardle.com](https://playboardle.com)).

The original project is a Flask API plus a React client (`api/` and `client/` in
this repo, unchanged). This fork’s work lives in **[`personal/`](personal/)**: a
zero-build, vanilla JavaScript edition with an Openings trainer, per-player
accounts, and a serverless AWS deploy aimed at [ch35s.com](https://ch35s.com).

## Personal edition

- Static HTML, CSS, and vanilla JavaScript (ES modules, chess.js). No React, no
  npm build. Hash tabs: `#mini`, `#classic`, `#mega`, `#maxi`, `#openings`.
- Larger board, default **Carolina blue / white** squares, and a **⚙** settings
  dialog for custom colors (saved under `boardle:settings:boardColors`).
- **Openings** tab with Learn, Recall, and Test. Test is Wordle-style: 5 of
  your moves, 5 chances; the computer plays the opponent’s book replies
  (~0.5 s delay). Main line first, then sidelines by popularity, with spaced
  re-testing.
- Optional **👤** sign-in so each player has their own results, streaks,
  openings progress, and board colors, plus history export/import.

Full feature list and how to play: [`personal/README.md`](personal/README.md).

## Quick start

```bash
cd personal
python3 serve.py          # http://localhost:8000   (or: python3 serve.py 8080)
```

Python 3, standard library only — no packages to install. Open the URL in a
browser (ES modules and `fetch` do not work from `file://`). Sign-in and
history are stored in `~/.boardle/boardle.sqlite3`.

## Documentation

- [`personal/README.md`](personal/README.md) — features, how to play, static hosting, openings notes
- [`personal/RUNTIME.md`](personal/RUNTIME.md) — local runtime, environment variables, storage, tests, AWS operations
- [`personal/aws/README-DEPLOY.md`](personal/aws/README-DEPLOY.md) — serverless deploy to ch35s.com (CloudFront, S3, Lambda, DynamoDB, Route 53)
- [`personal/DEPLOY_AWS.md`](personal/DEPLOY_AWS.md) — alternative single-server / Docker / App Runner deploy
- [`personal/INSTALL.md`](personal/INSTALL.md) — installing a `personal/` ZIP on the Mac

## Tests

From `personal/`:

```bash
npm test
# or the same steps:
node test.mjs && node openings/test-openings.mjs && node openings/test-testmode.mjs \
  && node test-storage.mjs && node test-version.mjs \
  && python3 -m unittest discover -s tests
```

## Credit

Upstream project: [rorycochrane/Boardle](https://github.com/rorycochrane/Boardle).
This fork does not replace it; the Flask/React app remains in `api/` and `client/`.
