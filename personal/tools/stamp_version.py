#!/usr/bin/env python3
"""Stamp a cache-busting version onto every local module URL.

    python3 tools/stamp_version.py 3.2

Browsers may reuse an old cached copy of a module (python's http.server only sends
Last-Modified, so browsers apply heuristic caching). If even one old module mixes with
new ones, the import graph fails to link and the page never starts. Giving every
release its own URLs (./data.js?v=3.2) makes old and new copies impossible to mix.
Rewrites: relative import/export specifiers in *.js/*.mjs (not vendor/), plus the
app.js / style.css references and the boardle-version meta tag in index.html.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SPEC = re.compile(r"""((?:\bfrom|\bimport)\s*\(?\s*)(["'])(\.\.?/[^"'?]+?\.m?js)(?:\?v=[^"']*)?\2""")


def stamp(version):
    changed = []
    for p in sorted(ROOT.rglob("*")):
        if p.suffix not in (".js", ".mjs") or "vendor" in p.parts or "node_modules" in p.parts:
            continue
        s = p.read_text(encoding="utf-8")
        t = SPEC.sub(lambda m: f"{m.group(1)}{m.group(2)}{m.group(3)}?v={version}{m.group(2)}", s)
        if t != s:
            p.write_text(t, encoding="utf-8")
            changed.append(p)
    idx = ROOT / "index.html"
    s = idx.read_text(encoding="utf-8")
    t = re.sub(r'href="style\.css(?:\?v=[^"]*)?"', f'href="style.css?v={version}"', s)
    t = re.sub(r'src="app\.js(?:\?v=[^"]*)?"', f'src="app.js?v={version}"', t)
    t = re.sub(r'<meta name="boardle-version" content="[^"]*">', f'<meta name="boardle-version" content="{version}">', t)
    if t != s:
        idx.write_text(t, encoding="utf-8")
        changed.append(idx)
    return changed


if __name__ == "__main__":
    if len(sys.argv) != 2 or not re.fullmatch(r"[0-9A-Za-z._-]+", sys.argv[1]):
        sys.exit("usage: python3 tools/stamp_version.py <version>")
    for p in stamp(sys.argv[1]):
        print("stamped", p.relative_to(ROOT))
