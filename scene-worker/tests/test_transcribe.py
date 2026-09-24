from __future__ import annotations

from zenatlas_scenes.transcribe import MAX_CUE_SECONDS, word_cues


def words(*spans: tuple[float, float, str]) -> list[tuple[float, float, str]]:
    return list(spans)


def test_short_segment_stays_one_cue_with_word_tight_times():
    assert word_cues(words((1.2, 1.5, " Where"), (1.5, 1.7, " is"), (1.7, 2.4, " the ferry?"))) == [(1.2, 2.4, "Where is the ferry?")]


def test_long_segment_splits_at_sentence_end_so_cues_start_near_their_words():
    spoken = [(float(i), i + 0.8, f" w{i}") for i in range(12)]
    spoken[5] = (5.0, 5.8, " end.")
    cues = word_cues(spoken)
    assert cues[0] == (0.0, 5.8, "w0 w1 w2 w3 w4 end.")
    assert cues[1][0] == 6.0 and all(end - start <= MAX_CUE_SECONDS for start, end, _ in cues)


def test_unbroken_speech_is_forced_into_bounded_cues():
    spoken = [(i * 0.5, i * 0.5 + 0.45, " word") for i in range(60)]
    cues = word_cues(spoken)
    assert len(cues) > 1 and all(end - start <= MAX_CUE_SECONDS for start, end, _ in cues)
    assert sum(len(text.split()) for _, _, text in cues) == 60, "every word is kept exactly once"


def test_pause_is_a_boundary_and_empty_or_zero_length_cues_are_dropped():
    spoken = [(0.0, 1.0, " one"), (1.0, 2.0, " two"), (2.0, 3.0, " three"), (3.0, 4.2, " four"), (5.5, 6.0, " five"), (6.0, 6.0, " ")]
    assert word_cues(spoken) == [(0.0, 4.2, "one two three four"), (5.5, 6.0, "five")]
