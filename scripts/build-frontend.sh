#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
DIST_DIR="$ROOT_DIR/backend/internal/frontend/dist"
PORT="${NEXT_EXPORT_PORT:-3900}"
HOST="${NEXT_EXPORT_HOST:-127.0.0.1}"
TOKEN_PLACEHOLDER="__ELPASTO_TOKEN__"
LOG_FILE="${TMPDIR:-/tmp}/elpasto-next-start.log"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

if [ ! -d "$ROOT_DIR/.next/static" ]; then
  echo "missing .next/static; run pnpm run build first" >&2
  exit 1
fi

mkdir -p "$DIST_DIR"
find "$DIST_DIR" -mindepth 1 -maxdepth 1 ! -name '.gitkeep' -exec rm -rf {} +

mkdir -p "$DIST_DIR/_next"
cp -R "$ROOT_DIR/.next/static" "$DIST_DIR/_next/static"

if [ -d "$ROOT_DIR/public" ]; then
  cp -R "$ROOT_DIR/public/." "$DIST_DIR/"
fi

: >"$LOG_FILE"
(cd "$ROOT_DIR" && pnpm next start -H "$HOST" -p "$PORT" >"$LOG_FILE" 2>&1) &
SERVER_PID=$!

attempt=0
while ! curl -fsS "http://$HOST:$PORT/" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 100 ]; then
    cat "$LOG_FILE" >&2
    echo "timed out waiting for next start" >&2
    exit 1
  fi
  sleep 0.1
done

TUNNEL_PEER_PLACEHOLDER="__ELPASTO_TUNNEL_PEER__"

curl -fsS "http://$HOST:$PORT/" >"$DIST_DIR/index.html"
curl -fsS "http://$HOST:$PORT/$TOKEN_PLACEHOLDER" >"$DIST_DIR/token.html"
curl -fsS "http://$HOST:$PORT/tunnel/$TUNNEL_PEER_PLACEHOLDER/" >"$DIST_DIR/tunnel.html"
curl -fsS "http://$HOST:$PORT/tunnel-view/$TUNNEL_PEER_PLACEHOLDER/" >"$DIST_DIR/tunnel-view.html"
curl -fsS "http://$HOST:$PORT/stats" >"$DIST_DIR/stats.html"
curl -fsS "http://$HOST:$PORT/icon.svg" >"$DIST_DIR/icon.svg"

: >"$DIST_DIR/.gitkeep"
