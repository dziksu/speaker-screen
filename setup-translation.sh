#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! command -v ollama >/dev/null 2>&1; then
  echo "Zainstaluj Ollama z https://ollama.com/download, a potem uruchom ponownie ./setup-translation.sh"
  exit 1
fi
ollama list >/dev/null
ollama pull "${TRANSLATION_MODEL:-translategemma:4b}"
echo "Tłumacz gotowy. Uruchom ponownie ./start.sh i wybierz język docelowy."
