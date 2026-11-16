#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "Ten prototyp wymaga Maca z Apple Silicon (MLX)."
  exit 1
fi
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python scripts/download_model.py
echo "Gotowe. Uruchom: ./start.sh"
