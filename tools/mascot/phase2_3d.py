"""Lumi's 3D model at TRELLIS.2's highest quality settings.

phase1_3d.py used the Space's defaults (1024 grid, 12 sampling steps, 1024
texture). This asks for the 1536 grid, more sampling steps for shape and
texture, and a 2048 texture; the web copy is then compressed in
`gltf-transform` with only light simplification.
"""
import os
import shutil

from gradio_client import Client, handle_file

from orclient import OUT

SRC = OUT / "ref" / "lumi_3q.png"
DST = OUT / "3d" / "lumi_hq_raw.glb"

client = Client("microsoft/TRELLIS.2", hf_token=os.environ.get("HF_TOKEN"))
client.predict(api_name="/start_session")
prepped = client.predict(handle_file(str(SRC)), api_name="/preprocess_image")
print("preprocessed", flush=True)
client.predict(
    handle_file(prepped), 7, "1536",
    7.5, 0.7, 20, 5.0,      # sparse structure: guidance, rescale, steps, rescale_t
    7.5, 0.5, 20, 3.0,      # shape
    1.0, 0.0, 20, 3.0,      # texture
    api_name="/image_to_3d",
)
print("generated", flush=True)
glb, _ = client.predict(300000, 2048, api_name="/extract_glb")
DST.parent.mkdir(parents=True, exist_ok=True)
shutil.copy(glb, DST)
print("saved", DST, DST.stat().st_size, "bytes")
