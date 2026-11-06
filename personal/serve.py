#!/usr/bin/env python3
"""Zero-dependency local server: python3 serve.py [port]  ->  http://localhost:8000"""
import functools, http.server, os, sys

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
root = os.path.dirname(os.path.abspath(__file__))
http.server.SimpleHTTPRequestHandler.extensions_map[".js"] = "text/javascript"
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
print(f"Boardle running at http://localhost:{port}  (Ctrl+C to stop)")
http.server.ThreadingHTTPServer(("", port), handler).serve_forever()
