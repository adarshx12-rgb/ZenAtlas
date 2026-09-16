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
