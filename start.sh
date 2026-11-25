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

if [ -f ".env" ]; then
  set -a
  source .env
  set +a
fi

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8765}"
LAN_IP=$(.venv/bin/python -c '
import socket
ip = "127.0.0.1"
for target in (("10.255.255.255", 1), ("8.8.8.8", 80)):
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(target)
        ip = s.getsockname()[0]
        s.close()
        break
    except Exception:
        pass
print(ip)
' 2>/dev/null || echo "127.0.0.1")

echo "================================================================"
echo "  Sermon Live Translator (Mode 1 Soundbooth + Mode 2 Broadcast)"
echo "  音控台控制台 (本机):   http://127.0.0.1:${PORT}"
echo "  会众手机收听 (局域网): http://${LAN_IP}:${PORT}/listen"
echo "================================================================"
exec .venv/bin/uvicorn server:app --host "${HOST}" --port "${PORT}"
