"""Run once with internet access. Server inference uses only the local files."""
from pathlib import Path
import os

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HOME", str(ROOT / ".models" / "hub"))

from huggingface_hub import snapshot_download

if __name__ == "__main__":
    target = Path(os.environ.get("WHISPER_MODEL_PATH", ROOT / ".models" / "whisper-large-v3-turbo"))
    print("Pobieranie Whisper large-v3-turbo (~1,61 GB). Kolejne uruchomienia działają offline.", flush=True)
    snapshot_download("mlx-community/whisper-large-v3-turbo", local_dir=target, allow_patterns=["config.json", "weights.safetensors"])
    print(f"Model gotowy: {target}", flush=True)
