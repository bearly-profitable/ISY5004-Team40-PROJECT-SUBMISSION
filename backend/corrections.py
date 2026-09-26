"""Human-in-the-loop cluster corrections.

Pure functions over the analysis-result dict (as persisted in SQLite). Each
returns the mutated result so the server can save + return it. Raising
ValueError signals a bad request (unknown ids etc.).

Every correction is also an implicit statement that the ML got something
wrong, so the server logs them to the `corrections` table — that log doubles
as evaluation data for the report (what kinds of mistakes users had to fix).
"""
from __future__ import annotations

from typing import Dict, List, Optional


def _find_identity(result: Dict, person_id: str) -> Dict:
    for ident in result.get("identities", []):
        if ident["id"] == person_id:
            return ident
    raise ValueError(f"Unknown person id: {person_id}")


def _find_event(result: Dict, event_id: str) -> Dict:
    for evt in result.get("events", []):
        if evt["id"] == event_id:
            return evt
    raise ValueError(f"Unknown event id: {event_id}")


def _recompute_event_persons(result: Dict) -> None:
    """Rebuild each event's person list and each identity's event list from
    the (possibly just-edited) identity photo memberships."""
    for evt in result.get("events", []):
        photo_set = set(evt.get("photoIds", []))
        evt["persons"] = [
            ident["id"]
            for ident in result.get("identities", [])
            if photo_set & set(ident.get("photoIds", []))
        ]
    for ident in result.get("identities", []):
        photo_set = set(ident.get("photoIds", []))
        ident["eventIds"] = sorted(
            evt["id"]
            for evt in result.get("events", [])
            if photo_set & set(evt.get("photoIds", []))
        )


def rename_person(result: Dict, person_id: str, label: str) -> Dict:
    label = label.strip()
    if not label:
        raise ValueError("Label must not be empty.")
    ident = _find_identity(result, person_id)
    ident["label"] = label
    return result


def merge_persons(result: Dict, source_id: str, target_id: str) -> Dict:
    """Merge the source identity into the target (the target survives)."""
    if source_id == target_id:
        raise ValueError("Cannot merge a person into themselves.")
    source = _find_identity(result, source_id)
    target = _find_identity(result, target_id)

    target["photoIds"] = sorted(set(target.get("photoIds", [])) | set(source.get("photoIds", [])))
    if not target.get("faceThumb") and source.get("faceThumb"):
        target["faceThumb"] = source["faceThumb"]
    # Face-highlight boxes: keep the target's where both identities have one
    target["faceBoxes"] = {**(source.get("faceBoxes") or {}), **(target.get("faceBoxes") or {})}

    result["identities"] = [i for i in result["identities"] if i["id"] != source_id]

    # Per-person best picks: keep the target's pick where both exist,
    # otherwise adopt the source's.
    for evt in result.get("events", []):
        picks = evt.get("bestByPerson") or []
        target_has = any(p["personId"] == target_id for p in picks)
        rewritten: List[Dict] = []
        for pick in picks:
            if pick["personId"] == source_id:
                if target_has:
                    continue
                pick = {**pick, "personId": target_id}
            rewritten.append(pick)
        evt["bestByPerson"] = rewritten

    _recompute_event_persons(result)
    summary = result.get("summary") or {}
    summary["numIdentities"] = len(result.get("identities", []))
    result["summary"] = summary
    return result


def move_photo(result: Dict, photo_id: str, from_person_id: Optional[str], to_person_id: str) -> Dict:
    """Reassign a photo from one identity to another (fixes a mis-clustering)."""
    target = _find_identity(result, to_person_id)
    if from_person_id:
        source = _find_identity(result, from_person_id)
        if photo_id in source.get("photoIds", []):
            source["photoIds"] = [p for p in source["photoIds"] if p != photo_id]
    if photo_id not in target.get("photoIds", []):
        target["photoIds"] = sorted(set(target.get("photoIds", [])) | {photo_id})

    # Drop now-empty identities
    result["identities"] = [
        i for i in result["identities"] if i.get("photoIds")
    ]
    _recompute_event_persons(result)
    summary = result.get("summary") or {}
    summary["numIdentities"] = len(result.get("identities", []))
    result["summary"] = summary
    return result


def set_best_photo(result: Dict, event_id: str, photo_id: str) -> Dict:
    """Pin a user-chosen best shot for an event (records the previous pick)."""
    evt = _find_event(result, event_id)
    if photo_id not in evt.get("photoIds", []):
        raise ValueError("Photo does not belong to this event.")
    previous = evt.get("topPhotoId")
    evt["topPhotoId"] = photo_id
    evt["userPinned"] = True
    evt["previousTopPhotoId"] = previous
    return result


def rename_event(result: Dict, event_id: str, label: str) -> Dict:
    label = label.strip()
    if not label:
        raise ValueError("Label must not be empty.")
    evt = _find_event(result, event_id)
    evt["label"] = label
    evt["userRenamed"] = True
    return result


def delete_event(result: Dict, event_id: str) -> Dict:
    _find_event(result, event_id)  # raises if unknown
    result["events"] = [e for e in result["events"] if e["id"] != event_id]
    _recompute_event_persons(result)
    summary = result.get("summary") or {}
    summary["numEvents"] = len(result.get("events", []))
    result["summary"] = summary
    return result


def delete_photos(result: Dict, photo_ids: List[str]) -> Dict:
    """Remove photos from the session everywhere they appear. A moment left
    empty is dropped; a moment that loses its best shot falls back to its
    highest-scoring remaining photo."""
    gone = set(photo_ids)
    known = {pid for evt in result.get("events", []) for pid in evt.get("photoIds", [])}
    unknown = gone - known
    if not gone or unknown:
        raise ValueError(f"Unknown photo id: {sorted(unknown)[0]}" if unknown else "No photos given.")

    events: List[Dict] = []
    for evt in result.get("events", []):
        evt["photoIds"] = [p for p in evt.get("photoIds", []) if p not in gone]
        if not evt["photoIds"]:
            continue
        evt["members"] = [m for m in evt.get("members", []) if m["photoId"] not in gone]
        evt["bestByPerson"] = [b for b in evt.get("bestByPerson") or [] if b["photoId"] not in gone]
        if evt.get("mmrPicks"):
            evt["mmrPicks"] = {mode: [p for p in picks if p not in gone] for mode, picks in evt["mmrPicks"].items()}
        if evt.get("topPhotoId") in gone:
            ranked = sorted(evt["members"], key=lambda m: m.get("finalScore", 0), reverse=True)
            evt["topPhotoId"] = ranked[0]["photoId"] if ranked else evt["photoIds"][0]
            evt.pop("userPinned", None)
        if evt.get("previousTopPhotoId") in gone:
            evt.pop("previousTopPhotoId", None)
        events.append(evt)
    result["events"] = events

    for ident in result.get("identities", []):
        ident["photoIds"] = [p for p in ident.get("photoIds", []) if p not in gone]
        ident["faceBoxes"] = {p: box for p, box in (ident.get("faceBoxes") or {}).items() if p not in gone}
    result["identities"] = [i for i in result.get("identities", []) if i.get("photoIds")]

    _recompute_event_persons(result)
    summary = result.get("summary") or {}
    summary["numPhotos"] = max(0, int(summary.get("numPhotos") or 0) - len(gone))
    summary["numEvents"] = len(result["events"])
    summary["numIdentities"] = len(result["identities"])
    result["summary"] = summary
    return result
