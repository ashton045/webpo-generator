#!/usr/bin/env bash
set -euo pipefail

IMAGE="ghcr.io/your-user/webpo-generator:latest"

if docker compose version >/dev/null 2>&1; then
    compose=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
    compose=(docker-compose)
else
    echo "Error: neither 'docker compose' nor 'docker-compose' is available." >&2
    exit 1
fi

echo "Pulling ${IMAGE}..."
"${compose[@]}" pull

"${compose[@]}" up -d --force-recreate

echo "Done."