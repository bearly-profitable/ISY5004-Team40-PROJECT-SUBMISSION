"""Lumi's 3D model, via Microsoft's free TRELLIS.2 Hugging Face Space.

The Space keeps per-session state, so all four calls must share one client.
Output is decimated for the web: the model only spins on the landing page.
"""
import os
import shutil
import sys

from gradio_client import Client, handle_file

from orclient import OUT

SRC = OUT / "ref" / "lumi_3q.png"
DST = OUT / "3d" / "lumi_raw.glb"

client = Client("microsoft/TRELLIS.2", hf_token=os.environ.get("HF_TOKEN"))
client.predict(api_name="/start_session")
prepped = client.predict(handle_file(str(SRC)), api_name="/preprocess_image")
print("preprocessed", prepped, flush=True)
client.predict(handle_file(prepped), 7, "1024", api_name="/image_to_3d")
print("generated", flush=True)
glb, _ = client.predict(100000, 1024, api_name="/extract_glb")
DST.parent.mkdir(parents=True, exist_ok=True)
shutil.copy(glb, DST)
print("saved", DST, DST.stat().st_size, "bytes")
sys.exit(0)
