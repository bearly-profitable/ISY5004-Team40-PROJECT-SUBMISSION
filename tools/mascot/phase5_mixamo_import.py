"""Bring the Mixamo-rigged Lumi into the island ($0, no API calls).

Put Mixamo's downloads (FBX Binary, 30 fps, no keyframe reduction) in
out/mixamo/in/:

    lumi.fbx    the character, "With Skin" (any animation, or T-pose)
    idle.fbx    "Without Skin"
    walk.fbx    "Without Skin", "In Place" ticked
    run.fbx     "Without Skin", "In Place" ticked
    wave.fbx    "Without Skin"
    jump.fbx    "Without Skin", "In Place" ticked (optional; otherwise Lumi stretches and tucks in code)

Each FBX is converted with FBX2glTF, then compressed with gltf-transform
(meshopt geometry/animation, WebP textures) into frontend/public/world/:
lumi.glb and anim/<name>.glb. Both tools are installed on first run into
out/mixamo/.tools (gitignored).
"""
import platform
import shutil
import subprocess
import sys

from orclient import OUT, ROOT

IN = OUT / "mixamo" / "in"
TMP = OUT / "mixamo" / "tmp"
TOOLS = OUT / "mixamo" / ".tools"
WEB = ROOT.parent.parent / "frontend" / "public" / "world"
NPX = shutil.which("npx") or "npx"
NPM = shutil.which("npm") or "npm"


def run(*args):
    print(">", " ".join(str(a) for a in args), flush=True)
    subprocess.run([str(a) for a in args], check=True)


def ensure_tools():
    if not (TOOLS / "node_modules" / "fbx2gltf").exists():
        TOOLS.mkdir(parents=True, exist_ok=True)
        run(NPM, "install", "--prefix", TOOLS, "fbx2gltf@0.9.7-p1", "@gltf-transform/cli@4")
    folder = {"Windows": "Windows_NT", "Darwin": "Darwin"}.get(platform.system(), "Linux")
    exe = "FBX2glTF.exe" if folder == "Windows_NT" else "FBX2glTF"
    return TOOLS / "node_modules" / "fbx2gltf" / "bin" / folder / exe


def gltf_transform(*args):
    run(NPX, "--prefix", TOOLS, "gltf-transform", *args)


def main():
    fbx2gltf = ensure_tools()
    files = sorted(IN.glob("*.fbx"))
    if not any(f.stem == "lumi" for f in files):
        sys.exit(f"Put the rigged character in {IN / 'lumi.fbx'} first.")
    TMP.mkdir(parents=True, exist_ok=True)
    (WEB / "anim").mkdir(parents=True, exist_ok=True)

    for fbx in files:
        raw = TMP / f"{fbx.stem}.glb"
        run(fbx2gltf, "--binary", "--output", raw.with_suffix(""), fbx)
        if fbx.stem == "lumi":
            out = WEB / "lumi.glb"
            gltf_transform("optimize", raw, out, "--compress", "meshopt", "--texture-compress", "webp",
                           "--texture-size", "2048", "--simplify", "false")
        else:
            out = WEB / "anim" / f"{fbx.stem}.glb"
            # Only the skeleton and its motion: drop any stray meshes.
            gltf_transform("optimize", raw, out, "--compress", "meshopt", "--texture-compress", "false",
                           "--simplify", "false")
        print(f"  {out.relative_to(WEB.parent.parent.parent)}: {out.stat().st_size / 1e3:.0f} KB")

    anims = sorted(p.stem for p in (WEB / "anim").glob("*.glb"))
    print("\nSet LUMI_ANIMATION_URLS in frontend/world/LumiCharacter.tsx to:")
    print("  [" + ", ".join(f"'/world/anim/{a}.glb'" for a in anims) + "]")


if __name__ == "__main__":
    main()
