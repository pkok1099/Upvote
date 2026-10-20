#!/usr/bin/env bash
# wpmulti.sh — Launcher: build+jalankan wpmulti (N sesi WG, 1 SOCKS5), lalu
# jalankan upvote-core.js dengan --proxy-replicas auto (deteksi jumlah sesi), stop.
#
# Pakai:
#   ./wpmulti.sh <conf-dir> [votes] [delay-ms] [target-id] [opsi upvote lain...]
# Contoh:
#   ./wpmulti.sh ./wp-conf 1200 0 "chapter/<uuid>" --no-keepalive
#
# Env opsional:
#   WPMULTI_DIR  (default /home/ubuntu/wpmulti-lib)
#   SOCKS_ADDR   (default 127.0.0.1:1080)
#   HTTP_ADDR    (default 127.0.0.1:2080)
#   DEBUG_ADDR   (default 127.0.0.1:2081)
set -euo pipefail

WPMULTI_DIR="${WPMULTI_DIR:-/home/ubuntu/wpmulti-lib}"
SOCKS_ADDR="${SOCKS_ADDR:-127.0.0.1:1080}"
HTTP_ADDR="${HTTP_ADDR:-127.0.0.1:2080}"
DEBUG_ADDR="${DEBUG_ADDR:-127.0.0.1:2081}"

CONF_DIR="${1:-}"; shift || true
VOTES="${1:-100}"; shift || true
DELAY="${1:-0}"; shift || true
TARGET="${1:-}"; shift || true
# sisa argumen diteruskan ke node (mis. --no-keepalive)

if [[ -z "$CONF_DIR" ]]; then
  echo "Pakai: $0 <conf-dir> [votes] [delay-ms] [target-id] [opsi upvote...]" >&2
  exit 2
fi
if [[ ! -d "$WPMULTI_DIR" ]]; then
  echo "WPMULTI_DIR tidak ada: $WPMULTI_DIR" >&2
  exit 2
fi

BIN="$WPMULTI_DIR/wpmulti"
if [[ ! -x "$BIN" ]]; then
  echo "[wpmulti] build..." >&2
  ( cd "$WPMULTI_DIR" && go build -o wpmulti ./cmd/wpmulti/ )
fi

echo "[wpmulti] start: conf=$CONF_DIR socks=$SOCKS_ADDR http=$HTTP_ADDR debug=$DEBUG_ADDR" >&2
"$BIN" --conf-dir "$CONF_DIR" --socks "$SOCKS_ADDR" --http "$HTTP_ADDR" --debug "$DEBUG_ADDR" &
WP_PID=$!

cleanup() { kill "$WP_PID" 2>/dev/null || true; wait "$WP_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Tunggu SOCKS5 siap (poll port).
HOST="${SOCKS_ADDR%:*}"; PORT="${SOCKS_ADDR##*:}"
for _ in $(seq 1 100); do
  if (exec 3<>"/dev/tcp/$HOST/$PORT") 2>/dev/null; then exec 3>&- 3<&-; break; fi
  sleep 0.3
done

ARGS=(--proxy "socks5://$SOCKS_ADDR" --proxy-replicas auto --wpmulti-debug "$DEBUG_ADDR" --max "$VOTES" --delay "$DELAY")
[[ -n "$TARGET" ]] && ARGS+=(--id "$TARGET")
ARGS+=("$@")

echo "[wpmulti] jalankan upvote: ${ARGS[*]}" >&2
node "$(dirname "$0")/upvote-core.js" "${ARGS[@]}"