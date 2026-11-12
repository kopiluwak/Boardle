"""SQLite storage (default). One file, safe for a single server process."""
import json
import os
import sqlite3
import threading

from .store_base import Conflict, Store

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  username   TEXT PRIMARY KEY,
  pw_hash    TEXT NOT NULL,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  username   TEXT NOT NULL REFERENCES users(username),
  expires_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(username);
CREATE TABLE IF NOT EXISTS history (
  username   TEXT PRIMARY KEY REFERENCES users(username),
  data       TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  updated_at REAL NOT NULL
);
"""


class SqliteStore(Store):
    def __init__(self, path: str):
        self.path = path
        if path != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA foreign_keys=ON")
        self._db.executescript(SCHEMA)

    def _q(self, sql, args=()):
        with self._lock:
            return self._db.execute(sql, args).fetchall()

    def create_user(self, username, pw_hash, now):
        try:
            self._q("INSERT INTO users(username, pw_hash, created_at) VALUES (?,?,?)", (username, pw_hash, now))
            return True
        except sqlite3.IntegrityError:
            return False

    def get_user(self, username):
        rows = self._q("SELECT username, pw_hash, created_at FROM users WHERE username=?", (username,))
        if not rows:
            return None
        u, h, c = rows[0]
        return {"username": u, "pw_hash": h, "created_at": c}

    def create_session(self, th, username, expires_at):
        self._q("INSERT INTO sessions(token_hash, username, expires_at) VALUES (?,?,?)", (th, username, expires_at))

    def get_session(self, th, now):
        rows = self._q("SELECT username, expires_at FROM sessions WHERE token_hash=?", (th,))
        if not rows:
            return None
        if rows[0][1] < now:
            self.delete_session(th)
            return None
        return rows[0][0]

    def delete_session(self, th):
        self._q("DELETE FROM sessions WHERE token_hash=?", (th,))

    def purge_expired(self, now):
        self._q("DELETE FROM sessions WHERE expires_at < ?", (now,))

    def get_history(self, username):
        rows = self._q("SELECT data, rev, updated_at FROM history WHERE username=?", (username,))
        if not rows:
            return {}, 0, None
        return json.loads(rows[0][0]), rows[0][1], rows[0][2]

    def put_history(self, username, data, base_rev, now):
        blob = json.dumps(data, separators=(",", ":"))
        with self._lock:
            cur = self._db.cursor()
            cur.execute("BEGIN IMMEDIATE")
            try:
                row = cur.execute("SELECT data, rev, updated_at FROM history WHERE username=?", (username,)).fetchone()
                current = row[1] if row else 0
                if int(base_rev) != current:
                    cur.execute("ROLLBACK")
                    raise Conflict(json.loads(row[0]) if row else {}, current, row[2] if row else None)
                new_rev = current + 1
                cur.execute(
                    "INSERT INTO history(username, data, rev, updated_at) VALUES (?,?,?,?) "
                    "ON CONFLICT(username) DO UPDATE SET data=excluded.data, rev=excluded.rev, updated_at=excluded.updated_at",
                    (username, blob, new_rev, now),
                )
                cur.execute("COMMIT")
                return new_rev
            except Conflict:
                raise
            except Exception:
                cur.execute("ROLLBACK")
                raise

    def close(self):
        with self._lock:
            self._db.close()
