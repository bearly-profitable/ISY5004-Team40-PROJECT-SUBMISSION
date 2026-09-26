"""Unit tests for Lumi's sprite library.

Pure Pillow and numpy — no network, no models — so these run in the lightweight
CI job. They guard what the album relies on: every pose exists and fits the box
it is given, outfits recolour without touching transparency, and pose choice
follows the photos' scenes.
"""
import pytest

pytest.importorskip("PIL")

import mascot  # noqa: E402
from clip_search import EVENT_PROMPT_BANK  # noqa: E402


def test_every_pose_has_a_sprite():
    for pose in mascot.POSES:
        assert (mascot.ASSETS / f"{pose}.webp").is_file(), pose


def test_every_pose_renders_inside_its_box():
    for pose in mascot.POSES:
        img = mascot.render(pose, 120, 90)
        assert img.mode == "RGBA"
        assert img.size == (120, 90)
        box = img.getchannel("A").getbbox()
        assert box is not None, f"{pose} drew nothing"
        # Standing on the bottom edge: the feet reach the last rows.
        assert box[3] >= 88, pose


def test_unknown_pose_and_outfit_fall_back():
    assert mascot.render("moonwalk", 64, 64).getchannel("A").getbbox()
    assert mascot.render("wave", 64, 64, outfit="tuxedo").getchannel("A").getbbox()


def test_outfits_recolour_but_keep_the_silhouette():
    base = mascot.render("idle", 80, 80, "classic")
    for outfit in mascot.OUTFITS:
        dressed = mascot.render("idle", 80, 80, outfit)
        assert dressed.getchannel("A").tobytes() == base.getchannel("A").tobytes()
        if outfit != "classic":
            assert dressed.tobytes() != base.tobytes(), outfit


def test_facing_mirrors():
    right = mascot.render("point", 80, 80, facing=1)
    left = mascot.render("point", 80, 80, facing=-1)
    assert right.tobytes() != left.tobytes()


def test_every_clip_scene_maps_to_a_real_pose():
    for label, _ in EVENT_PROMPT_BANK:
        pose = mascot.pose_for_scene(label)
        assert pose in mascot.POSES, label


def test_renamed_events_still_find_their_scene():
    assert mascot.pose_for_scene("Beach day at Sentosa") == "beach"
    assert mascot.pose_for_scene("Event 3") is None
    assert mascot.pose_for_scene("") is None


def test_page_pose_follows_the_majority_scene():
    assert mascot.pose_for_page(["Beach", "Beach", "Dinner"], 0) == "beach"


def test_page_pose_uses_the_chapter_only_as_a_fallback():
    assert mascot.pose_for_page(["", ""], 0, fallback="Wedding") == "wedding"
    assert mascot.pose_for_page(["Dinner"], 0, fallback="Wedding") == "dinner"


def test_page_pose_avoids_repeating_the_previous_page():
    assert mascot.pose_for_page(["Beach", "Beach", "Dinner"], 0, avoid="beach") == "dinner"
    pose = mascot.pose_for_page(["Beach"], 0, avoid="beach")
    assert pose != "beach" and pose in mascot.WORK_POSES


def test_pages_without_scenes_cycle_work_poses():
    poses = {mascot.pose_for_page([], i) for i in range(len(mascot.WORK_POSES))}
    assert poses == set(mascot.WORK_POSES)


def test_every_frame_has_a_window_inside_its_sprite():
    assert set(mascot.frame_poses()) >= {"bighug", "peek", "sidehug", "tallhug"}
    for pose, meta in mascot.frame_meta().items():
        sprite = mascot.frame_sprite(pose)
        assert list(sprite.size) == meta["size"], pose
        x0, y0, x1, y1 = meta["window"]
        assert 0 <= x0 < x1 <= sprite.width and 0 <= y0 < y1 <= sprite.height, pose
        # The window is a real opening, not a sliver.
        assert (x1 - x0) * (y1 - y0) > 0.2 * sprite.width * sprite.height, pose
        assert len(meta["polygon"]) >= 4, pose


def test_frames_are_picked_to_suit_the_slot():
    wide, tall = mascot.pick_frame(700, 300), mascot.pick_frame(300, 600)
    assert wide != tall
    # The previous page's frame is avoided when another fits nearly as well.
    assert mascot.pick_frame(700, 300, avoid=wide) != wide
