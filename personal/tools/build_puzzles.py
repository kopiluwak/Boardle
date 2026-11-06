#!/usr/bin/env python3
"""Build Boardle puzzle files from the Lichess puzzle database.

Mirrors what the original Flask API did per request (api/app.py):
  * take a Lichess puzzle (FEN + UCI move list)
  * play the first move (the opponent's "setup" move) on the board
  * the remaining moves, converted to SAN, are the solution the player guesses

Usage:
  pip install chess zstandard
  curl -LO https://database.lichess.org/lichess_db_puzzle.csv.zst
  python tools/build_puzzles.py lichess_db_puzzle.csv.zst --per-size 1095

Writes puzzles/3.json, 5.json, 7.json, 9.json (one entry per day).
"""
import argparse, csv, io, json, random, sys
from pathlib import Path

import chess

SIZES = (3, 5, 7, 9)


def open_csv(path):
    if path.endswith(".zst"):
        import zstandard
        fh = open(path, "rb")
        stream = zstandard.ZstdDecompressor().stream_reader(fh)
        return io.TextIOWrapper(stream, encoding="utf-8")
    return open(path, encoding="utf-8")


def convert(fen, uci_moves):
    board = chess.Board(fen)
    first = chess.Move.from_uci(uci_moves[0])
    board.push(first)
    start_fen = board.fen()
    san = []
    for u in uci_moves[1:]:
        m = chess.Move.from_uci(u)
        san.append(board.san(m))
        board.push(m)
    return start_fen, first.uci(), san


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", help="lichess_db_puzzle.csv(.zst)")
    ap.add_argument("--per-size", type=int, default=1095, help="puzzles per mode (1 per day)")
    ap.add_argument("--min-popularity", type=int, default=85)
    ap.add_argument("--min-plays", type=int, default=300)
    ap.add_argument("--max-rd", type=int, default=90)
    ap.add_argument("--seed", type=int, default=20220721)
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "puzzles"))
    a = ap.parse_args()

    # Reservoir-sample candidates per size so memory stays small.
    rng = random.Random(a.seed)
    cap = a.per_size * 3
    pools = {n: [] for n in SIZES}
    seen = {n: 0 for n in SIZES}
    reader = csv.DictReader(open_csv(a.csv))
    for i, row in enumerate(reader):
        moves = row["Moves"].split()
        n = len(moves) - 1
        if n not in pools:
            continue
        if (int(row["Popularity"]) < a.min_popularity or int(row["NbPlays"]) < a.min_plays
                or int(row["RatingDeviation"]) > a.max_rd):
            continue
        seen[n] += 1
        item = (row["PuzzleId"], row["FEN"], moves, int(row["Rating"]), row["GameUrl"], row["Themes"])
        if len(pools[n]) < cap:
            pools[n].append(item)
        else:
            j = rng.randrange(seen[n])
            if j < cap:
                pools[n][j] = item
        if i % 500000 == 0:
            print(f"  scanned {i:,} rows; candidates {seen}", file=sys.stderr)

    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    for n in SIZES:
        pool = pools[n]
        rng.shuffle(pool)
        result = []
        for pid, fen, moves, rating, url, themes in pool:
            try:
                start_fen, last, san = convert(fen, moves)
            except Exception:
                continue
            result.append({"id": pid, "fen": start_fen, "last": last, "moves": san,
                           "rating": rating, "url": url})
            if len(result) >= a.per_size:
                break
        (out / f"{n}.json").write_text(json.dumps(result, separators=(",", ":")))
        print(f"size {n}: {len(result)} puzzles (from {seen[n]:,} candidates)", file=sys.stderr)


if __name__ == "__main__":
    main()
