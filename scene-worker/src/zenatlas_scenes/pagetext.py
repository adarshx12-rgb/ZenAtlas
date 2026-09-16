"""Main-content text for the Node worker's page checks.

Reads one JSON object per line, {"id": 1, "html": "..."}, and answers {"id": 1, "text": "..." or null}.
It never fetches anything: the Node worker has already fetched the page through its public-address checks.
"""
from __future__ import annotations

import json
import sys
from typing import TextIO

import trafilatura

MAX_HTML_CHARS = 4_000_000
MAX_TEXT_CHARS = 5_000


def main_text(html: str) -> str | None:
    if not html.strip() or len(html) > MAX_HTML_CHARS:
        return None
    text = trafilatura.extract(html, output_format="txt", include_comments=False, include_tables=False,
                               include_images=False, include_links=False, favor_precision=True, deduplicate=True)
    return " ".join((text or "").split())[:MAX_TEXT_CHARS] or None


def serve(source: TextIO, sink: TextIO) -> None:
    for line in source:
        try:
            request = json.loads(line)
        except ValueError:
            continue
        if not isinstance(request, dict) or type(request.get("id")) is not int:
            continue
        html = request.get("html")
        try:
            text = main_text(html) if isinstance(html, str) else None
        except Exception:  # A page trafilatura cannot parse simply has no main text; the worker falls back to visible text.
            text = None
        sink.write(json.dumps({"id": request["id"], "text": text}) + "\n")
        sink.flush()


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    serve(sys.stdin, sys.stdout)
