from __future__ import annotations

import json

import pytest
from support import scenes_reply

from zenatlas_scenes.subtitles import Cue
from zenatlas_scenes.validation import ModelOutputRejected, parse_timestamp, validate_scenes


def validate(text: str, *, duration: float = 60.0, offset: float = 0.0, content: float | None = None, cues=()):
    return validate_scenes(text, media_duration=duration, timeline_offset=offset, content_duration=content, cues=list(cues))


@pytest.mark.parametrize(("value", "expected"), [("00:00", 0.0), ("01:05", 65.0), ("75:30", 4530.0), ("1:02:03", 3723.0),
                                                 ("00:07.250", 7.25), (" 02:00 ", 120.0)])
def test_parses_model_timestamps(value, expected):
    assert parse_timestamp(value) == expected


@pytest.mark.parametrize("value", ["", "5", "1:60", "00:61", "1:75:00", "-00:01", "00:01,5", "1h02m"])
def test_rejects_malformed_timestamps(value):
    assert parse_timestamp(value) is None


def test_offsets_map_media_time_onto_the_content_timeline():
    result = validate(scenes_reply({"start": "00:00", "end": "00:10", "description": "Boats leave  the\nharbour.", "tags": ["Boats", "boats", " "]},
                                   {"start": "00:10", "end": "00:25", "description": "Gulls circle the pier."}),
                      duration=30, offset=12.5, content=60)
    first, second = result.scenes
    assert (first.media_start, first.media_end, first.start, first.end) == (0, 10, 12.5, 22.5)
    assert first.description == "Boats leave the harbour." and first.tags == ("boats",)
    assert (second.start, second.end) == (22.5, 37.5)
    assert not result.rejected and result.adjusted == 0


def test_negative_offset_excludes_media_before_the_content_starts():
    result = validate(scenes_reply({"start": "00:00", "end": "00:04", "description": "Distributor logo before the programme."},
                                   {"start": "00:05", "end": "00:20", "description": "Opening shot of a valley."},
                                   {"start": "00:20", "end": "00:30", "description": "A train crosses a bridge."}),
                      duration=30, offset=-5)
    assert [(s.media_start, s.start) for s in result.scenes] == [(5, 0.0), (20, 15.0)]
    assert result.rejected == {"outside_timeline": 1}


def test_timestamps_move_at_most_one_second_to_fit_the_media():
    result = validate(scenes_reply({"start": "00:00", "end": "00:31", "description": "Final shot fades out."},
                                   {"start": "00:30", "end": "00:40", "description": "Credits past the end."}), duration=30.4)
    [scene] = result.scenes
    assert scene.media_end == 30.4 and result.adjusted == 1 and result.rejected == {"outside_timeline": 1}


def test_overlaps_are_trimmed_within_tolerance_and_rejected_beyond_it():
    result = validate(scenes_reply({"start": "00:10", "end": "00:20", "description": "Second"},
                                   {"start": "00:00", "end": "00:11", "description": "First"},
                                   {"start": "00:20", "end": "00:40", "description": "Third"},
                                   {"start": "00:30", "end": "00:50", "description": "Overlapping fourth"}))
    assert [(s.media_start, s.media_end, s.description) for s in result.scenes] == [(0, 11, "First"), (11, 20, "Second"), (20, 40, "Third")]
    assert result.rejected == {"overlap": 1} and result.adjusted == 1


def test_scenes_must_fit_the_content_duration_and_have_length():
    result = validate(scenes_reply({"start": "00:00", "end": "00:20", "description": "Inside"},
                                   {"start": "00:20", "end": "00:45", "description": "Past the content end"},
                                   {"start": "00:20", "end": "00:20", "description": "Zero length"},
                                   {"start": "00:20", "end": "00:30", "description": "Tail"}), offset=10, content=40)
    assert [(s.start, s.end) for s in result.scenes] == [(10, 30), (30, 40)]
    assert result.rejected == {"outside_timeline": 1, "non_positive_duration": 1}


def test_subtitle_citations_must_overlap_and_dialogue_is_quoted_from_cues():
    cues = [Cue(1, 1.0, 3.0, "Where is the ferry?", "segment-1"), Cue(2, 9.0, 11.0, "Right behind you."), Cue(3, 14.5, 16.0, "Hold on!")]
    result = validate(scenes_reply({"start": "00:00", "end": "00:10", "description": "Two travellers talk on a dock.", "subtitle_cue_ids": [1]},
                                   {"start": "00:10", "end": "00:15", "description": "A ferry horn sounds.", "subtitle_cue_ids": [2]},
                                   {"start": "00:15", "end": "00:20", "description": "Cites a cue from another scene.", "subtitle_cue_ids": [1]},
                                   {"start": "00:20", "end": "00:25", "description": "Cites a cue that does not exist.", "subtitle_cue_ids": [9]},
                                   {"start": "00:25", "end": "00:30", "description": "Waves break."}), duration=30, cues=cues)
    assert [(s.dialogue, s.segment_ids) for s in result.scenes] == [("Where is the ferry?", ("segment-1",)), ("Right behind you.", ()), (None, ())]
    assert result.rejected == {"subtitle_reference_mismatch": 2}


def test_dialogue_is_capped_at_cue_boundaries():
    cues = [Cue(i + 1, float(i), i + 0.9, "x" * 1500) for i in range(5)]
    [scene] = validate(scenes_reply({"start": "00:00", "end": "00:06", "description": "Long monologue."}), duration=10, cues=cues).scenes
    assert scene.dialogue == " ".join(["x" * 1500] * 2)


@pytest.mark.parametrize(("text", "code", "options"), [
    ("not json", "invalid_model_output", {}),
    (json.dumps({"media_viewable": True, "scenes": [], "notes": "extra field"}), "invalid_model_output", {}),
    (json.dumps({"media_viewable": True, "scenes": [{"start": 0, "end": 5, "description": "x", "tags": [], "subtitle_cue_ids": []}]}),
     "invalid_model_output", {}),
    (scenes_reply({"start": "00:00", "end": "00:05", "description": "Claimed scene"}, viewable=False), "model_could_not_view_media", {}),
    (scenes_reply({"start": "00:00", "end": "00:05", "description": "Plausible"}, {"start": "02:00", "end": "02:10", "description": "Invented"},
                  {"start": "03:00", "end": "03:10", "description": "Invented"}), "model_timestamps_unreliable", {}),
    (scenes_reply(), "no_timeline_overlap", {"offset": -100}),
])
def test_untrustworthy_responses_are_rejected_whole(text, code, options):
    with pytest.raises(ModelOutputRejected) as raised:
        validate(text, **options)
    assert raised.value.code == code


def test_an_empty_scene_list_is_an_honest_result():
    result = validate(scenes_reply())
    assert result.scenes == [] and not result.rejected
