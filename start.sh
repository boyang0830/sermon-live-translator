#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  echo "Creating Python virtual environment..."
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip
  .venv/bin/pip install -r requirements.txt
fi

if [ ! -f ".env" ]; then
  cp .env.example .env
  echo "Created .env from .env.example. You can edit .env or enter your API keys in the web UI."
fi

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8765}"
echo "Starting Sermon Live Translator at http://${HOST}:${PORT}"
exec .venv/bin/uvicorn server:app --host "${HOST}" --port "${PORT}"
