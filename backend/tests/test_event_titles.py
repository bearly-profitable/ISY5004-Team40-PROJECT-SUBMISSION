"""Event naming: vision titles when OpenRouter is set up, readable fallbacks
when it is not — never "Event 1"."""
import datetime as dt

import numpy as np
import pytest

pytest.importorskip("torch")

import openrouter  # noqa: E402
from lumina_pipeline import LuminaPipeline  # noqa: E402

SAT_EVENING = dt.datetime(2026, 6, 13, 19, 30).timestamp()
SAT_MORNING = dt.datetime(2026, 6, 13, 9, 0).timestamp()


def _event(eid, start=None, auto=None):
    return {"id": eid, "label": auto["label"] if auto else None, "autoLabel": auto,
            "caption": None, "startTime": start, "photoIds": ["a", "b"]}


def _samples(*eids):
    return {eid: [np.zeros((8, 8, 3), dtype=np.uint8)] for eid in eids}


def test_vision_titles_replace_generic_names(monkeypatch):
    monkeypatch.setattr(openrouter, "is_configured", lambda: True)
    sent = {}

    def fake_name_events(requests, scenes, model=None):
        sent["requests"] = requests
        return [{"title": "Sunset on the Beach", "scene": "Beach"},
                {"title": "Hotpot Night", "scene": None}]

    monkeypatch.setattr(openrouter, "name_events", fake_name_events)
    events = [_event("e0", SAT_MORNING), _event("e1", SAT_EVENING, {"label": "Dinner", "confidence": 0.3})]
    LuminaPipeline._title_events(events, _samples("e0", "e1"))

    assert [e["label"] for e in events] == ["Sunset on the Beach", "Hotpot Night"]
    # Scene words survive for Lumi's outfit: the model's pick, else CLIP's
    assert events[0]["autoLabel"]["label"] == "Beach"
    assert events[1]["autoLabel"]["label"] == "Dinner"
    assert events[1]["autoLabel"]["source"] == "vision"
    assert len(sent["requests"][0]["images"]) == 1
    assert "Dinner" in sent["requests"][1]["hint"]


def test_fallback_uses_time_not_event_numbers(monkeypatch):
    monkeypatch.setattr(openrouter, "is_configured", lambda: False)
    events = [_event("e0", SAT_MORNING), _event("e1"), _event("e2", SAT_EVENING, {"label": "Beach", "confidence": 0.3})]
    LuminaPipeline._title_events(events, {})

    assert events[0]["label"] == "Sat 13 Jun · Morning"
    assert events[1]["label"] == "Moment 1"
    assert events[2]["label"] == "Beach"


def test_duplicate_names_are_told_apart(monkeypatch):
    monkeypatch.setattr(openrouter, "is_configured", lambda: False)
    beach = {"label": "Beach", "confidence": 0.3}
    events = [_event("e0", SAT_MORNING, dict(beach)), _event("e1", SAT_EVENING, dict(beach))]
    LuminaPipeline._title_events(events, {})

    assert events[0]["label"] == "Beach"
    assert events[1]["label"] == "Beach · Sat 13 Jun · Evening"


def test_failed_call_keeps_fallbacks(monkeypatch):
    monkeypatch.setattr(openrouter, "is_configured", lambda: True)
    monkeypatch.setattr(openrouter, "name_events", lambda *a, **k: [])
    events = [_event("e0", SAT_EVENING)]
    LuminaPipeline._title_events(events, _samples("e0"))
    assert events[0]["label"] == "Sat 13 Jun · Evening"
