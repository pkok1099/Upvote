#!/bin/bash
# test-30.sh — Tes upvote-core.js dengan 30 proxy paralel (folder wgcf-30).
#
# Penggunaan:
#   ./test-30.sh [jumlah-vote] [delay-ms] [id-target]
#
# Contoh:
#   ./test-30.sh              # 30 vote (1 per proxy), delay 100ms, ID default
#   ./test-30.sh 60 200       # 60 vote (2 per proxy), delay 200ms
#   ./test-30.sh 30 100 <uuid>

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF_DIR="$SCRIPT_DIR/wgcf-30"
PROXY_SH="$SCRIPT_DIR/proxy.sh"
CORE="$SCRIPT_DIR/upvote-core.js"

MAX_VOTES="${1:-30}"
DELAY="${2:-100}"
TARGET_ID="${3:-a6d1020e-e71e-43ed-91a5-39c9c88de017}"

# --- Validasi ---
[ -d "$CONF_DIR" ] || { echo "❌ Folder $CONF_DIR tidak ada"; exit 1; }
[ -f "$CORE" ] || { echo "❌ $CORE tidak ada"; exit 1; }

# --- Kumpulkan daftar proxy dari config ---
PROXIES=""
COUNT=0
for conf in "$CONF_DIR"/wgcf-*.conf; do
  [ -f "$conf" ] || continue
  port=$(grep -i BindAddress "$conf" | awk -F: '{print $NF}')
  PROXIES="${PROXIES}socks5://127.0.0.1:${port},"
  COUNT=$((COUNT + 1))
done
PROXIES="${PROXIES%,}"

echo "=============================================="
echo " TES UPVOTE 30 PROXY PARALEL"
echo "=============================================="
echo "Proxy ditemukan : $COUNT"
echo "Total vote      : $MAX_VOTES"
echo "Delay           : ${DELAY} ms"
echo "Target          : $TARGET_ID"
echo "=============================================="

if [ "$COUNT" -eq 0 ]; then
  echo "❌ Tidak ada config proxy di $CONF_DIR"
  exit 1
fi

# --- 1. Nyalakan proxy ---
echo ""
echo "[1/4] Menyalakan $COUNT proxy..."
"$PROXY_SH" --skip start wgcf-30

# --- 2. Tunggu handshake WG ---
echo ""
echo "[2/4] Menunggu tunnel WG handshake (8 detik)..."
sleep 8

# Cek berapa proxy yang benar-benar hidup
ALIVE=0
for conf in "$CONF_DIR"/wgcf-*.conf; do
  [ -f "$conf" ] || continue
  if pgrep -f "wireproxy -c $conf" > /dev/null 2>&1; then
    ALIVE=$((ALIVE + 1))
  fi
done
echo "Proxy hidup: $ALIVE/$COUNT"

if [ "$ALIVE" -eq 0 ]; then
  echo "❌ Tidak ada proxy yang hidup. Membatalkan tes."
  "$PROXY_SH" stop wgcf-30
  exit 1
fi

# --- 3. Jalankan tes vote ---
echo ""
echo "[3/4] Menjalankan upvote-core.js ($MAX_VOTES vote, paralel)..."
echo "----------------------------------------------"
START_TIME=$(date +%s)

node "$CORE" \
  --id "$TARGET_ID" \
  --max "$MAX_VOTES" \
  --delay "$DELAY" \
  --parallel \
  --proxy "$PROXIES"

EXIT_CODE=$?
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo "----------------------------------------------"

# --- 4. Matikan proxy ---
echo ""
echo "[4/4] Mematikan proxy..."
"$PROXY_SH" stop wgcf-30

# --- Ringkasan ---
echo ""
echo "=============================================="
echo " HASIL TES"
echo "=============================================="
echo "Exit code  : $EXIT_CODE"
echo "Durasi     : ${DURATION} detik"
if [ "$EXIT_CODE" -eq 0 ]; then
  echo "Status     : ✅ SUKSES — semua vote terkirim"
else
  echo "Status     : ❌ GAGAL — cek log di atas"
fi
echo "=============================================="

exit $EXIT_CODE
