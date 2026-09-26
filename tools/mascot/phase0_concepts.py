"""Phase 0: one character sheet per mascot direction, for the user to pick from."""
from orclient import OUT, image, spent

STYLE = (
    "Character design turnaround sheet for a mascot named Lumi, for a photo-album app "
    "called Lumina. Soft 3D render like a matte vinyl designer toy: chunky simple "
    "shapes, no thin parts, smooth surfaces, gentle studio lighting, soft contact "
    "shadow. Palette drawn from the brand gradient: lavender #9d98c6, rose #e0a3ab, "
    "peach #f0b48c, with creamy white. Very cute, big friendly eyes, tiny smile. "
    "Plain off-white background. Layout: front view, three-quarter view, side view and "
    "back view standing in a row, same scale, then a small row of three expression "
    "heads (happy, surprised, sleepy). No text, no labels, no watermark."
)

CONCEPTS = {
    "a_light_sprite": (
        "Lumi is a small round glowing light sprite: a soft marshmallow-like body, a "
        "short antenna topped with a glowing orb of warm light, stubby arms and legs, "
        "a faint inner glow in its belly."
    ),
    "b_shutterbun": (
        "Lumi is a bao-bun shaped creature with a round camera lens on its tummy, two "
        "rounded ears shaped like a lens hood, stubby arms and legs, and a tiny "
        "flash-bulb bump on top of its head."
    ),
    "c_firefly": (
        "Lumi is a chubby round firefly with two small translucent wings, short "
        "rounded antennae, stubby arms and legs, and a glowing peach tail that "
        "works like a camera flash."
    ),
}

if __name__ == "__main__":
    for key, desc in CONCEPTS.items():
        image(f"concept {key}", f"{STYLE}\n\n{desc}", OUT / "concepts" / f"{key}.png",
              aspect="16:9")
    print(f"done, total spent ${spent():.4f}")
