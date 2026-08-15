#!/usr/bin/env bash
set -euo pipefail

if docker compose version >/dev/null 2>&1; then
  compose=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  compose=(docker-compose)
else
  echo "Error: neither 'docker compose' nor 'docker-compose' is available." >&2
  exit 1
fi

if [[ -n "${WEBPO_IMAGE:-}" ]]; then
  echo "Pulling ${WEBPO_IMAGE}..."
  "${compose[@]}" pull
else
  echo "No WEBPO_IMAGE set; refreshing the local build from the Docker base image..."
  "${compose[@]}" build --pull
fi

"${compose[@]}" up -d --force-recreate
echo 'Done.'
