#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "Najpierw uruchom ./setup.sh"
  exit 1
fi
echo "Speaker Screen → http://localhost:${PORT:-8765}"
exec .venv/bin/python -m server
