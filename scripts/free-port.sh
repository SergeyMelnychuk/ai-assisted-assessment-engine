#!/usr/bin/env bash
# Free a TCP port by killing whatever is listening on it.
#
# Usage: scripts/free-port.sh <port>
#
# Why: Next.js dev auto-increments to the next port when the default is
# busy (e.g. a stale `next-server` from an earlier session holding 3000).
# `NEXTAUTH_URL` in apps/web/.env is pinned to http://localhost:3000, so
# when dev lands on 3001 every auth redirect points at the ghost. This
# script is wired into `predev` to clear 3000 before `next dev` starts.
#
# Exits 0 if the port is free (either it was free, or we killed the
# listener). Exits 1 only if we found a listener but couldn't kill it.

set -euo pipefail

port="${1:-3000}"

if ! command -v lsof >/dev/null 2>&1; then
  echo "free-port: lsof not found — skipping port check for :${port}" >&2
  exit 0
fi

pids="$(lsof -ti :"${port}" -sTCP:LISTEN 2>/dev/null || true)"

if [[ -z "${pids}" ]]; then
  exit 0
fi

echo "free-port: killing listener(s) on :${port} — pid(s): ${pids}" >&2

# shellcheck disable=SC2086
kill ${pids} 2>/dev/null || true
sleep 1

# SIGKILL anything stubborn.
remaining="$(lsof -ti :"${port}" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "${remaining}" ]]; then
  echo "free-port: forcing SIGKILL on :${port} — pid(s): ${remaining}" >&2
  # shellcheck disable=SC2086
  kill -9 ${remaining} 2>/dev/null || true
  sleep 1
fi

still="$(lsof -ti :"${port}" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "${still}" ]]; then
  echo "free-port: could not free :${port} (pid(s) still listening: ${still})" >&2
  exit 1
fi

echo "free-port: :${port} is free" >&2
exit 0
