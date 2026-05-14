"""Unit tests for diarize.merge — the max-overlap algorithm that assigns
speaker labels to whisper segments based on pyannote turn boundaries."""
import diarize


def seg(start, end, text="x"):
    return {"start": start, "end": end, "text": text}


def turn(start, end, speaker):
    return {"start": start, "end": end, "speaker": speaker}


def test_empty_turns_returns_unlabeled():
    result = diarize.merge([seg(0, 1)], [])
    assert result == [{"start": 0, "end": 1, "text": "x", "speaker": "SPEAKER_??"}]


def test_exact_overlap_assigns_speaker():
    result = diarize.merge([seg(0, 5)], [turn(0, 5, "SPEAKER_00")])
    assert result[0]["speaker"] == "SPEAKER_00"


def test_no_overlap_falls_through_to_placeholder():
    result = diarize.merge([seg(10, 12)], [turn(0, 5, "SPEAKER_00")])
    assert result[0]["speaker"] == "SPEAKER_??"


def test_picks_max_overlap_when_segment_spans_two_turns():
    # segment 0-10; turn A overlaps 0-3 (3s), turn B overlaps 3-10 (7s) → B wins
    turns = [turn(0, 3, "A"), turn(3, 10, "B")]
    result = diarize.merge([seg(0, 10)], turns)
    assert result[0]["speaker"] == "B"


def test_partial_overlap_outside_turn_picks_inside():
    # segment 2-8; turn A is 0-5 (overlap 3s) vs turn B at 6-12 (overlap 2s) → A wins
    turns = [turn(0, 5, "A"), turn(6, 12, "B")]
    result = diarize.merge([seg(2, 8)], turns)
    assert result[0]["speaker"] == "A"


def test_multiple_segments_independently_labeled():
    segments = [seg(0, 2), seg(2, 4), seg(4, 6)]
    turns = [turn(0, 3, "A"), turn(3, 6, "B")]
    result = diarize.merge(segments, turns)
    # 0-2 fully in A (2s); 2-4 split — A gets 1s, B gets 1s, first match wins on tie → A;
    # 4-6 fully in B
    speakers = [r["speaker"] for r in result]
    assert speakers[0] == "A"
    assert speakers[2] == "B"


def test_zero_duration_segment_does_not_crash():
    result = diarize.merge([seg(5, 5)], [turn(0, 10, "X")])
    # No positive overlap — placeholder, but should not error
    assert result[0]["speaker"] == "SPEAKER_??"


def test_preserves_segment_text():
    result = diarize.merge([seg(0, 1, "hello world")], [turn(0, 1, "A")])
    assert result[0]["text"] == "hello world"


def test_preserves_start_end_as_floats():
    result = diarize.merge([seg(1.25, 3.75)], [turn(0, 5, "A")])
    assert result[0]["start"] == 1.25
    assert result[0]["end"] == 3.75
