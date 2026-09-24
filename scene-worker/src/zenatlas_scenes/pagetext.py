"""Main-content text for the Node worker's page checks.

Reads one JSON object per line, {"id": 1, "html": "..."}, and answers {"id": 1, "text": "..." or null}.
A request {"id": 2, "pdf": "<base64>"} answers {"id": 2, "pdf": {"pages", "title", "author", "created", "text"} or null}.
It never fetches anything: the Node worker has already fetched the page through its public-address checks.
"""
from __future__ import annotations

import base64
import binascii
import io
import json
import sys
from typing import TextIO

import trafilatura

MAX_HTML_CHARS = 4_000_000
MAX_TEXT_CHARS = 5_000
MAX_PDF_BYTES = 50 * 1024 * 1024
PDF_PAGES_READ = 3


def main_text(html: str) -> str | None:
    if not html.strip() or len(html) > MAX_HTML_CHARS:
        return None
    text = trafilatura.extract(html, output_format="txt", include_comments=False, include_tables=False,
                               include_images=False, include_links=False, favor_precision=True, deduplicate=True)
    return " ".join((text or "").split())[:MAX_TEXT_CHARS] or None


def pdf_facts(data: bytes) -> dict | None:
    """Page count, document metadata and the first pages' text: enough to tell a full work from a summary or excerpt."""
    if not data.startswith(b"%PDF") or len(data) > MAX_PDF_BYTES:
        return None
    from pypdf import PdfReader  # Optional: without it, PDFs are simply not inspected.

    reader = PdfReader(io.BytesIO(data))
    info = reader.metadata
    created = getattr(info, "creation_date", None) if info else None
    text = " ".join(" ".join((page.extract_text() or "").split()) for page in reader.pages[:PDF_PAGES_READ])
    return {"pages": len(reader.pages), "title": (info.title if info else None) or None,
            "author": (info.author if info else None) or None,
            "created": created.date().isoformat() if created else None, "text": text[:MAX_TEXT_CHARS] or None}


def serve(source: TextIO, sink: TextIO) -> None:
    for line in source:
        try:
            request = json.loads(line)
        except ValueError:
            continue
        if not isinstance(request, dict) or type(request.get("id")) is not int:
            continue
        if isinstance(request.get("pdf"), str):
            try:
                facts = pdf_facts(base64.b64decode(request["pdf"], validate=True))
            except (binascii.Error, ImportError, Exception):  # An unreadable document is simply not inspected.
                facts = None
            sink.write(json.dumps({"id": request["id"], "pdf": facts}) + "\n")
            sink.flush()
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
