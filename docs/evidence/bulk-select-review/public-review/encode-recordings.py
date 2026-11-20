"""Encode actual browser captures with their original elapsed timing (Pillow)."""
from pathlib import Path
import hashlib
import json
import sys
from PIL import Image

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent
for name in (sys.argv[2:] or ("before-flow", "after-flow")):
    manifest = json.loads((root / f"{name}-recording.json").read_text())
    images, durations = [], []
    for i, frame in enumerate(manifest["frames"]):
        images.append(Image.open(root / "frames" / frame["file"]).convert("RGB"))
        end = manifest["frames"][i + 1]["at"] if i + 1 < len(manifest["frames"]) else manifest["duration_ms"]
        durations.append(max(20, round((end - frame["at"]) / 10) * 10))
    dest = root / f"{name}.gif"
    images[0].save(dest, save_all=True, append_images=images[1:], duration=durations, loop=0, optimize=True)
    manifest["gif_sha256"] = hashlib.sha256(dest.read_bytes()).hexdigest()
    manifest["viewport"] = list(images[0].size)
    manifest["encoded_duration_ms"] = sum(durations)
    (root / f"{name}-recording.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(name, len(images), "frames", sum(durations), "ms", dest.stat().st_size, "bytes")
