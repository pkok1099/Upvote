#!/bin/bash
# proxy.sh — Kelola wireproxy (WARP) dengan mudah.
#
# Penggunaan:
#   ./proxy.sh start [dir]    # nyalakan semua proxy (default: wgcf-multi)
#   ./proxy.sh stop  [dir]    # matikan semua proxy
#   ./proxy.sh restart [dir]  # restart semua proxy
#   ./proxy.sh status [dir]   # lihat status proxy
#   ./proxy.sh list  [dir]    # tampilkan daftar proxy untuk upvote-core.js
#
# Contoh:
#   ./proxy.sh start            # pakai wgcf-multi (5 proxy)
#   ./proxy.sh start wgcf-30    # pakai wgcf-30 (30 proxy)
#   ./proxy.sh stop wgcf-30

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WIREPROXY="/data/data/com.termux/files/usr/bin/wireproxy"
KILL="/data/data/com.termux/files/usr/bin/kill"
CONF_DIR="$SCRIPT_DIR/${2:-wgcf-multi}"
PID_DIR="$SCRIPT_DIR/.proxy-pids"
LOG_DIR="$SCRIPT_DIR/.proxy-logs"

mkdir -p "$PID_DIR" "$LOG_DIR"

if [ ! -d "$CONF_DIR" ]; then
  echo "❌ Folder config tidak ditemukan: $CONF_DIR"
  echo "   Tersedia: $(find "$SCRIPT_DIR" -maxdepth 1 -type d -name 'wgcf-*' 2>/dev/null | xargs -n1 basename | tr '\n' ' ')"
  exit 1
fi

is_alive() {
  local pid="$1"
  [ -n "$pid" ] && $KILL -0 "$pid" 2>/dev/null
}

start_one() {
  local conf="$1"
  local name
  name=$(basename "$conf" .conf)
  local pidfile="$PID_DIR/$name.pid"

  if [ -f "$pidfile" ] && is_alive "$(cat "$pidfile")"; then
    echo "  ⏭  $name sudah jalan (PID $(cat "$pidfile"))"
    return 0
  fi

  nohup "$WIREPROXY" -c "$conf" > "$LOG_DIR/$name.log" 2>&1 &
  local pid=$!
  # Fallback: jika $! kosong/gagal, cari via pgrep
  if [ -z "$pid" ] || ! is_alive "$pid"; then
    sleep 0.3
    pid=$(pgrep -f "wireproxy -c $conf" | head -1)
  fi
  if [ -n "$pid" ]; then
    echo "$pid" > "$pidfile"
    echo "  ✅ $name jalan (PID $pid)"
  else
    echo "  ❌ $name GAGAL start (cek $LOG_DIR/$name.log)"
  fi
}

stop_one() {
  local conf="$1"
  local name
  name=$(basename "$conf" .conf)
  local pidfile="$PID_DIR/$name.pid"

  if [ -f "$pidfile" ]; then
    local pid
    pid=$(cat "$pidfile")
    if is_alive "$pid"; then
      $KILL "$pid" 2>/dev/null
      echo "  🛑 $name dimatikan (PID $pid)"
    else
      echo "  ⏭  $name tidak jalan"
    fi
    rm -f "$pidfile"
  else
    # Coba cari via pgrep jika tidak ada pidfile
    local pid
    pid=$(pgrep -f "wireproxy -c $conf" | head -1)
    if [ -n "$pid" ]; then
      $KILL "$pid" 2>/dev/null
      echo "  🛑 $name dimatikan (PID $pid, via pgrep)"
    else
      echo "  ⏭  $name tidak jalan"
    fi
  fi
}

status_one() {
  local conf="$1"
  local name
  name=$(basename "$conf" .conf)
  local pidfile="$PID_DIR/$name.pid"

  if [ -f "$pidfile" ] && is_alive "$(cat "$pidfile")"; then
    echo "  🟢 $name JALAN (PID $(cat "$pidfile"))"
  else
    # Cek juga via pgrep
    local pid
    pid=$(pgrep -f "wireproxy -c $conf" | head -1)
    if [ -n "$pid" ]; then
      echo "  🟢 $name JALAN (PID $pid, tanpa pidfile)"
    else
      echo "  🔴 $name MATI"
    fi
  fi
}

cmd="${1:-status}"

case "$cmd" in
  start)
    echo "Menyalakan proxy dari $(basename "$CONF_DIR")..."
    for conf in "$CONF_DIR"/wgcf-*.conf; do
      [ -f "$conf" ] || continue
      start_one "$conf"
    done
    echo "Selesai. Tunggu ~5 detik agar tunnel WG handshake selesai."
    ;;
  stop)
    echo "Mematikan proxy dari $(basename "$CONF_DIR")..."
    for conf in "$CONF_DIR"/wgcf-*.conf; do
      [ -f "$conf" ] || continue
      stop_one "$conf"
    done
    echo "Selesai."
    ;;
  restart)
    "$0" stop "${2:-wgcf-multi}"
    sleep 1
    "$0" start "${2:-wgcf-multi}"
    ;;
  status)
    echo "Status proxy ($(basename "$CONF_DIR")):"
    for conf in "$CONF_DIR"/wgcf-*.conf; do
      [ -f "$conf" ] || continue
      status_one "$conf"
    done
    ;;
  list)
    echo "Daftar proxy dari $(basename "$CONF_DIR") (untuk --proxy di upvote-core.js):"
    for conf in "$CONF_DIR"/wgcf-*.conf; do
      [ -f "$conf" ] || continue
      port=$(grep -i BindAddress "$conf" | awk -F: '{print $NF}')
      echo "  socks5://127.0.0.1:$port"
    done
    echo ""
    echo "Contoh pakai semua sekaligus (paralel):"
    echo "  node upvote-core.js --id <uuid> --max 10 --parallel --proxy $(for conf in "$CONF_DIR"/wgcf-*.conf; do port=$(grep -i BindAddress "$conf" | awk -F: '{print $NF}'); printf "socks5://127.0.0.1:%s," "$port"; done | sed 's/,$//')"
    ;;
  *)
    echo "Penggunaan: $0 {start|stop|restart|status|list} [folder-config]"
    echo ""
    echo "Folder config tersedia:"
    find "$SCRIPT_DIR" -maxdepth 1 -type d -name 'wgcf-*' 2>/dev/null | xargs -n1 basename | sed 's/^/  /'
    exit 1
    ;;
esac
