"""Package Lumi's 3D model for Mixamo's auto-rigger ($0, no API calls).

Mixamo takes FBX or a zipped OBJ (+ MTL + texture), not glTF. This reads the
uncompressed TRELLIS export (lumi_hq_tex.glb: one mesh, no node transforms,
Y-up, facing +Z as Mixamo expects), writes it out as OBJ with its base-colour
texture as PNG, and zips the three files for upload.

Output: out/mixamo/lumi_mixamo.zip
"""
import io
import json
import struct
import zipfile

import numpy as np
from PIL import Image

from orclient import OUT

SRC = OUT / "3d" / "lumi_hq_tex.glb"
DST = OUT / "mixamo" / "lumi_mixamo.zip"

COMPONENTS = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
WIDTHS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def read_glb(path):
    data = path.read_bytes()
    json_len = struct.unpack("<I", data[12:16])[0]
    gltf = json.loads(data[20:20 + json_len])
    bin_start = 20 + json_len + 8
    return gltf, data[bin_start:]


def accessor(gltf, blob, index):
    acc = gltf["accessors"][index]
    view = gltf["bufferViews"][acc["bufferView"]]
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    width = WIDTHS[acc["type"]]
    arr = np.frombuffer(blob, COMPONENTS[acc["componentType"]], acc["count"] * width, start)
    return arr.reshape(acc["count"], width) if width > 1 else arr


def image_bytes(gltf, blob, image_index):
    view = gltf["bufferViews"][gltf["images"][image_index]["bufferView"]]
    start = view.get("byteOffset", 0)
    return blob[start:start + view["byteLength"]]


def main():
    gltf, blob = read_glb(SRC)
    prim = gltf["meshes"][0]["primitives"][0]
    pos = accessor(gltf, blob, prim["attributes"]["POSITION"])
    nrm = accessor(gltf, blob, prim["attributes"]["NORMAL"])
    uv = accessor(gltf, blob, prim["attributes"]["TEXCOORD_0"])
    tris = accessor(gltf, blob, prim["indices"]).reshape(-1, 3) + 1  # OBJ is 1-based

    # Mixamo works best with the character ~1.7 m tall, feet on the ground.
    height = pos[:, 1].max() - pos[:, 1].min()
    pos = (pos - [0, pos[:, 1].min(), 0]) * (170.0 / height)

    base_tex = gltf["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"]
    tex = gltf["textures"][base_tex]
    source = tex.get("source", tex.get("extensions", {}).get("EXT_texture_webp", {}).get("source"))
    png = io.BytesIO()
    Image.open(io.BytesIO(image_bytes(gltf, blob, source))).convert("RGB").save(png, "PNG")

    obj = io.StringIO()
    obj.write("mtllib lumi.mtl\no Lumi\n")
    np.savetxt(obj, pos, "v %.5f %.5f %.5f")
    np.savetxt(obj, np.c_[uv[:, 0], 1.0 - uv[:, 1]], "vt %.6f %.6f")  # glTF UVs are top-down
    np.savetxt(obj, nrm, "vn %.5f %.5f %.5f")
    obj.write("usemtl lumi\ns 1\n")
    np.savetxt(obj, np.repeat(tris, 3, axis=1), "f %d/%d/%d %d/%d/%d %d/%d/%d")
    mtl = "newmtl lumi\nKa 1 1 1\nKd 1 1 1\nKs 0 0 0\nillum 1\nmap_Kd lumi.png\n"

    DST.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(DST, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("lumi.obj", obj.getvalue())
        z.writestr("lumi.mtl", mtl)
        z.writestr("lumi.png", png.getvalue())
    print(f"{len(pos)} vertices, {len(tris)} triangles -> {DST} ({DST.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
