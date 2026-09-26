import copy

import pytest

from corrections import (
    delete_event,
    delete_photos,
    merge_persons,
    move_photo,
    rename_event,
    rename_person,
    set_best_photo,
)


@pytest.fixture()
def result():
    return {
        "summary": {"numPhotos": 4, "numEvents": 2, "numIdentities": 2},
        "events": [
            {
                "id": "event_0",
                "label": "Event 1",
                "photoIds": ["p1", "p2"],
                "topPhotoId": "p1",
                "persons": ["person_0", "person_1"],
                "members": [
                    {"photoId": "p1", "finalScore": 0.9},
                    {"photoId": "p2", "finalScore": 0.7},
                ],
                "bestByPerson": [
                    {"personId": "person_0", "photoId": "p1"},
                    {"personId": "person_1", "photoId": "p2"},
                ],
            },
            {
                "id": "event_1",
                "label": "Event 2",
                "photoIds": ["p3", "p4"],
                "topPhotoId": "p3",
                "persons": ["person_0"],
                "members": [
                    {"photoId": "p3", "finalScore": 0.8},
                    {"photoId": "p4", "finalScore": 0.6},
                ],
                "bestByPerson": [{"personId": "person_0", "photoId": "p3"}],
            },
        ],
        "identities": [
            {"id": "person_0", "label": "Person 1", "faceThumb": "thumb0",
             "photoIds": ["p1", "p3", "p4"], "eventIds": ["event_0", "event_1"]},
            {"id": "person_1", "label": "Person 2", "faceThumb": None,
             "photoIds": ["p2"], "eventIds": ["event_0"]},
        ],
    }


def _identity(result, pid):
    return next(i for i in result["identities"] if i["id"] == pid)


def test_rename_person(result):
    out = rename_person(result, "person_0", "  Alice ")
    assert _identity(out, "person_0")["label"] == "Alice"
    with pytest.raises(ValueError):
        rename_person(out, "person_0", "   ")
    with pytest.raises(ValueError):
        rename_person(out, "nobody", "Bob")


def test_merge_persons_unions_photos_and_rewrites_picks(result):
    out = merge_persons(result, "person_1", "person_0")
    assert [i["id"] for i in out["identities"]] == ["person_0"]
    assert set(_identity(out, "person_0")["photoIds"]) == {"p1", "p2", "p3", "p4"}
    # person_0 already had a pick in event_0, so person_1's pick is dropped
    picks = out["events"][0]["bestByPerson"]
    assert picks == [{"personId": "person_0", "photoId": "p1"}]
    # Event person lists rebuilt
    assert out["events"][0]["persons"] == ["person_0"]
    assert out["summary"]["numIdentities"] == 1


def test_merge_person_into_self_rejected(result):
    with pytest.raises(ValueError):
        merge_persons(result, "person_0", "person_0")


def test_move_photo_reassigns_membership(result):
    out = move_photo(result, "p2", "person_1", "person_0")
    assert "p2" in _identity(out, "person_0")["photoIds"]
    # person_1 is now empty and gets dropped
    assert all(i["id"] != "person_1" for i in out["identities"])
    assert out["events"][0]["persons"] == ["person_0"]


def test_set_best_photo_pins_choice(result):
    out = set_best_photo(result, "event_0", "p2")
    evt = out["events"][0]
    assert evt["topPhotoId"] == "p2"
    assert evt["userPinned"] is True
    assert evt["previousTopPhotoId"] == "p1"
    with pytest.raises(ValueError):
        set_best_photo(out, "event_0", "p999")


def test_rename_and_delete_event(result):
    out = rename_event(result, "event_0", "Beach Day")
    assert out["events"][0]["label"] == "Beach Day"
    assert out["events"][0]["userRenamed"] is True

    out = delete_event(out, "event_0")
    assert [e["id"] for e in out["events"]] == ["event_1"]
    assert out["summary"]["numEvents"] == 1
    # person_1 only appeared in event_0; their event list is now empty
    assert _identity(out, "person_1")["eventIds"] == []


def test_operations_do_not_corrupt_unrelated_fields(result):
    snapshot = copy.deepcopy(result["events"][1]["members"])
    out = merge_persons(result, "person_1", "person_0")
    assert out["events"][1]["members"] == snapshot


def test_delete_photos_removes_them_everywhere(result):
    out = delete_photos(result, ["p2", "p4"])
    assert out["events"][0]["photoIds"] == ["p1"]
    assert [m["photoId"] for m in out["events"][0]["members"]] == ["p1"]
    assert out["events"][0]["bestByPerson"] == [{"personId": "person_0", "photoId": "p1"}]
    # person_1 only appeared in p2, so they are gone
    assert [i["id"] for i in out["identities"]] == ["person_0"]
    assert _identity(out, "person_0")["photoIds"] == ["p1", "p3"]
    assert out["events"][0]["persons"] == ["person_0"]
    assert out["summary"] == {"numPhotos": 2, "numEvents": 2, "numIdentities": 1}


def test_delete_photos_repicks_best_and_drops_empty_moments(result):
    result["events"][0]["userPinned"] = True
    out = delete_photos(result, ["p1", "p3", "p4"])
    assert [e["id"] for e in out["events"]] == ["event_0"]
    assert out["events"][0]["topPhotoId"] == "p2"
    assert "userPinned" not in out["events"][0]
    assert out["summary"]["numEvents"] == 1


def test_delete_photos_rejects_unknown_ids(result):
    with pytest.raises(ValueError):
        delete_photos(result, ["p1", "nope"])
    with pytest.raises(ValueError):
        delete_photos(result, [])
