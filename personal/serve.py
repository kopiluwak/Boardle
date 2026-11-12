#!/usr/bin/env python3
"""Local server: python3 serve.py [port]  ->  http://localhost:8000

Serves the static Boardle app exactly as before, plus a small /api for player
profiles and history (SQLite at ~/.boardle/boardle.sqlite3 by default; see
boardle_backend/server.py and DEPLOY_AWS.md for env vars and DynamoDB).
Standard library only for local use.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from boardle_backend.server import main  # noqa: E402

if __name__ == "__main__":
    main()
