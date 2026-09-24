from __future__ import annotations

import io
import json

import pytest

pytest.importorskip("trafilatura")
from zenatlas_scenes.pagetext import main_text, serve  # noqa: E402

ARTICLE = " ".join(["The studio builds real-time 3D product scenes with custom shaders and scroll-driven camera paths."] * 4)
PAGE = f"""<html><head><title>Nova Studio</title><script>var secret = "never shown";</script></head><body>
<nav><a href="/">Home</a> <a href="/work">Work</a> <a href="/contact">Contact</a> <a href="/cookies">Cookie settings</a></nav>
<main><article><h1>How we build immersive sites</h1><p>{ARTICLE}</p><p>{ARTICLE}</p></article></main>
<footer>Copyright Nova Studio. All rights reserved. Privacy policy. Terms of use.</footer></body></html>"""


def test_main_text_keeps_the_article_and_drops_navigation_scripts_and_footer():
    text = main_text(PAGE)
    assert text is not None and "custom shaders" in text
    assert "Cookie settings" not in text and "never shown" not in text and "All rights reserved" not in text
    assert "\n" not in text


def test_main_text_is_empty_for_blank_or_oversized_pages():
    assert main_text("   ") is None
    assert main_text("<p>x</p>" * 600_000) is None


def test_serve_answers_each_request_by_id_and_skips_malformed_lines():
    source = io.StringIO("\n".join([json.dumps({"id": 1, "html": PAGE}), "not json", json.dumps({"id": "2", "html": PAGE}),
                                    json.dumps({"id": 3, "html": None}), json.dumps({"id": 4, "html": "<p></p>"})]) + "\n")
    sink = io.StringIO()
    serve(source, sink)
    answers = [json.loads(line) for line in sink.getvalue().splitlines()]
    assert [a["id"] for a in answers] == [1, 3, 4]
    assert "custom shaders" in answers[0]["text"]
    assert answers[1]["text"] is None and answers[2]["text"] is None


def _pdf(text: str, title: str) -> bytes:
    """A minimal one-page PDF with real text and document metadata, built with correct cross-reference offsets."""
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
               b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
               f"<< /Title ({title}) /Author (StoryShots) /CreationDate (D:20240802120000Z) >>".encode()]
    out, offsets = bytearray(b"%PDF-1.4\n"), []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R /Info 6 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


def test_pdf_requests_answer_page_count_metadata_and_first_page_text():
    pytest.importorskip("pypdf")
    import base64

    data = _pdf("Book summary and key takeaways", "The Art of Seduction - Summary")
    sink = io.StringIO()
    serve(io.StringIO(json.dumps({"id": 7, "pdf": base64.b64encode(data).decode()}) + "\n"
                      + json.dumps({"id": 8, "pdf": base64.b64encode(b"not a pdf").decode()}) + "\n"), sink)
    first, second = [json.loads(line) for line in sink.getvalue().splitlines()]
    assert first == {"id": 7, "pdf": {"pages": 1, "title": "The Art of Seduction - Summary", "author": "StoryShots",
                                      "created": "2024-08-02", "text": "Book summary and key takeaways"}}
    assert second == {"id": 8, "pdf": None}
