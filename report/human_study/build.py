"""Copy the study photos into public/ and the answer key into the API bundle.

The answer key is removed from the public copy so the website does not serve it.
"""

from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PUBLIC_FORM = ROOT / "public" / "form"
DATA = ROOT / "api" / "data"


def main() -> None:
    if PUBLIC_FORM.exists():
        shutil.rmtree(PUBLIC_FORM)
    shutil.copytree(ROOT / "form", PUBLIC_FORM)
    for name in ("key.csv", "events_people.csv"):
        leaked = PUBLIC_FORM / name
        if leaked.exists():
            leaked.unlink()
    DATA.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "form" / "key.csv", DATA / "key.csv")
    shutil.copy2(ROOT / "form" / "events_people.csv", DATA / "events_people.csv")
    print(f"Copied photos to {PUBLIC_FORM}")


if __name__ == "__main__":
    main()
