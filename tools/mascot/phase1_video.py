"""The landing page's scroll story: 5 keyframes, then 4 clips chained between them.

Each clip starts on one keyframe and ends on the next, so the clips join without
a cut. Lumi is kept in the middle of the frame so the same 16:9 video can be
cropped to a phone's portrait screen.

    python phase1_video.py keys [k0 ...]    # keyframe images (~$0.07 each)
    python phase1_video.py clips [c1 ...]   # video clips (~$0.18 each)
"""
import sys

from orclient import OUT, image, spent, video

REF = OUT / "ref" / "lumi_3q.png"
SHEET = OUT / "concepts" / "b_shutterbun.png"
KEYS = OUT / "video" / "keys"
CLIPS = OUT / "video" / "clips"

SCENE = (
    "Wide 16:9 cinematic still from a cute 3D animated short. The SAME character Lumi from "
    "the reference images (lavender bear-hood with round ears, cream face, pink-to-peach "
    "body, purple camera lens on its cream tummy, small peach bump on its head), exact "
    "design and colours. Setting, identical in every shot: a dreamy pastel studio with a "
    "smooth gradient backdrop from lavender to rose to peach, soft floating bokeh lights, a "
    "glossy pale cream floor. Camera: static, straight on, eye level with Lumi. Lumi is "
    "full body, horizontally centred, about half the frame height, and everything important "
    "stays inside the middle third of the frame width. Lumi's hands are soft rounded "
    "mitten paws with no separate fingers. Photos shown are polaroids with soft blurry "
    "pastel snapshots on them. Soft matte vinyl toy render. No text. Moment: "
)

KEYFRAMES = {
    "k0": "Lumi sits curled up asleep on the floor, eyes closed, peaceful, lights dim and "
          "soft, a single polaroid lying beside it.",
    "k1": "Lumi stands awake, waving happily at the viewer, a few polaroids beginning to "
          "float down from above.",
    "k2": "Many polaroids swirl in a gentle ring around Lumi, its tummy camera lens glowing "
          "softly, Lumi looking up in wonder with both arms open.",
    "k3": "The polaroids hang in the air in three neat stacks around Lumi: one to its left, "
          "one to its right, one floating above it. Lumi stands with both arms spread wide "
          "and low at its sides, open rounded mitten hands, delighted smile.",
    "k4": "Lumi proudly holds one single polaroid in front of its chest with both rounded "
          "mitten hands gripping the photo's side edges, the photo glowing golden with "
          "sparkles, an open photo album lying on the floor at its feet.",
}

CLIP_PROMPTS = {
    "c1": "The cute mascot wakes up, stretches, stands up and waves at the camera while a "
          "few polaroid photos start drifting down. Lights gently brighten. Static camera, "
          "smooth gentle motion.",
    "c2": "More and more polaroid photos drift in and swirl in a gentle ring around the "
          "mascot, its tummy camera lens starts to glow, it looks up in wonder and opens its "
          "arms. Static camera, smooth motion.",
    "c3": "The swirling polaroids fly into three neat floating stacks around the mascot, "
          "which happily spreads its arms wide. Static camera, smooth motion.",
    "c4": "One polaroid floats down from the stacks into the mascot's paws; it holds it "
          "proudly at its chest and the photo glows golden with sparkles, while the other photos settle into an "
          "open album on the floor. Static camera, smooth joyful motion.",
}


def keys(names: list[str]) -> None:
    order = list(KEYFRAMES)
    for name in names or order:
        i = order.index(name)
        # The previous keyframe is a reference too, so the set stays in one scene.
        refs = (REF, SHEET) if i == 0 else (REF, KEYS / f"{order[i - 1]}.png")
        image(f"keyframe {name}", SCENE + KEYFRAMES[name], KEYS / f"{name}.png",
              refs=refs, aspect="16:9")


def clips(names: list[str]) -> None:
    order = list(CLIP_PROMPTS)
    for name in names or order:
        i = order.index(name)
        video(f"clip {name}", CLIP_PROMPTS[name], CLIPS / f"{name}.mp4",
              first=KEYS / f"k{i}.png", last=KEYS / f"k{i + 1}.png")


if __name__ == "__main__":
    cmd, *names = sys.argv[1:]
    {"keys": keys, "clips": clips}[cmd](names)
    print(f"total spent ${spent():.4f}")
