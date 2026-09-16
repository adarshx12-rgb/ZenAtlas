from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def make_video(path: Path, *, seconds: int = 6, fps: int = 5, audio: bool = False) -> Path:
    """Encode a small synthetic TEST FIXTURE clip (optionally with a tone track); it is never presented as analysed content."""
    import av
    import numpy as np

    with av.open(str(path), "w") as container:
        stream = container.add_stream("mpeg4", rate=fps)
        stream.width, stream.height, stream.pix_fmt = 64, 48, "yuv420p"
        tone = container.add_stream("aac", rate=16000, layout="mono") if audio else None
        for index in range(seconds * fps):
            image = np.full((48, 64, 3), (index * 9) % 255, dtype=np.uint8)
            for packet in stream.encode(av.VideoFrame.from_ndarray(image, format="rgb24")):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
        if tone is not None:
            samples = (0.2 * np.sin(2 * np.pi * 440 * np.arange(16000 * seconds) / 16000)).astype(np.float32).reshape(1, -1)
            frame = av.AudioFrame.from_ndarray(samples, format="flt", layout="mono")
            frame.sample_rate = 16000
            for packet in [*tone.encode(frame), *tone.encode()]:
                container.mux(packet)
    return path


class FakeModel:
    """Returns prepared replies in order; an unexpected call fails the test."""

    def __init__(self, *replies: str | Exception):
        self.replies = list(replies)
        self.requests: list[Any] = []

    def analyse(self, request: Any, heartbeat: Any) -> str:
        heartbeat()
        self.requests.append(request)
        if not self.replies:
            raise AssertionError("the model was called unexpectedly")
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


def scenes_reply(*scenes: dict[str, Any], viewable: bool = True) -> str:
    return json.dumps({"media_viewable": viewable, "scenes": [{"tags": [], "subtitle_cue_ids": [], **scene} for scene in scenes]})
