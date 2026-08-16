#!/bin/bash
# proxy.sh — Kelola wireproxy (WARP) dengan pemeriksaan IPv6 unik.
#
# Penggunaan:
#   ./proxy.sh start [dir]          # nyalakan semua proxy & pastikan IPv6 unik
#   ./proxy.sh start [dir] --fast   # mode cepat: skip cek IP utk proxy yg sudah
#                                    # jalan, timeout lebih pendek, skip cek
#                                    # duplikat IP utk proxy baru
#   ./proxy.sh start [dir] --skip   # mode skip total: tidak cek IP sama sekali,
#                                    # baik utk proxy yg sudah jalan maupun yg
#                                    # baru dinyalakan (paling cepat, tanpa
#                                    # jaminan IPv6 unik/valid)
#   ./proxy.sh stop  [dir]    # matikan semua proxy
#   ./proxy.sh restart [dir]  # restart semua proxy
#   ./proxy.sh status [dir]   # lihat status proxy
#   ./proxy.sh list  [dir]    # tampilkan daftar proxy untuk upvote-core.js
#
# Flag --fast / --skip bisa diletakkan di mana saja, misal:
#   ./proxy.sh --fast start
#   ./proxy.sh start wgcf-multi --skip

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WIREPROXY="/data/data/com.termux/files/usr/bin/wireproxy"
KILL="/data/data/com.termux/files/usr/bin/kill"
PID_DIR="$SCRIPT_DIR/.proxy-pids"
LOG_DIR="$SCRIPT_DIR/.proxy-logs"
MAX_ATTEMPTS=10

# Parsing argumen: pisahkan flag --fast/--skip dari argumen posisional (cmd, folder)
FAST_MODE=0
SKIP_MODE=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --fast) FAST_MODE=1 ;;
    --skip) SKIP_MODE=1; FAST_MODE=1 ;;  # --skip otomatis ikut aturan cepat --fast juga
    *) ARGS+=("$arg") ;;
  esac
done
set -- "${ARGS[@]}"

CONF_DIR="$SCRIPT_DIR/${2:-wgcf-multi}"

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

# Fungsi untuk mengekstrak port SOCKS5 dari file konfigurasi
get_port() {
  local conf="$1"
  grep -i BindAddress "$conf" | awk -F: '{print $NF}' | tr -d '\r\n '
}

# Fungsi untuk mengecek IPv6 keluar dari proxy SOCKS5
get_ipv6() {
  local port="$1"
  # Mode fast pakai timeout lebih pendek (2 detik), mode normal 5 detik
  local timeout=5
  [ "$FAST_MODE" -eq 1 ] && timeout=2
  curl -6 -s --max-time "$timeout" --socks5-hostname "127.0.0.1:$port" https://api64.ipify.org 2>/dev/null
}

# Cek apakah proxy untuk config ini sudah jalan. Kalau ya, echo PID-nya
# dan pastikan pidfile konsisten. Kalau tidak, echo kosong.
get_running_pid() {
  local conf="$1"
  local name
  name=$(basename "$conf" .conf)
  local pidfile="$PID_DIR/$name.pid"

  if [ -f "$pidfile" ] && is_alive "$(cat "$pidfile")"; then
    cat "$pidfile"
    return 0
  fi

  local pid
  pid=$(pgrep -f "wireproxy -c $conf" | head -1)
  if [ -n "$pid" ]; then
    echo "$pid" > "$pidfile"
    echo "$pid"
    return 0
  fi

  echo ""
  return 1
}

start_one_raw() {
  local conf="$1"
  local name
  name=$(basename "$conf" .conf)
  local pidfile="$PID_DIR/$name.pid"

  local existing
  existing=$(get_running_pid "$conf")
  if [ -n "$existing" ]; then
    echo "$existing"
    return 0
  fi

  nohup "$WIREPROXY" -c "$conf" > "$LOG_DIR/$name.log" 2>&1 &
  local pid=$!
  sleep 0.5
  if [ -z "$pid" ] || ! is_alive "$pid"; then
    pid=$(pgrep -f "wireproxy -c $conf" | head -1)
  fi

  if [ -n "$pid" ]; then
    echo "$pid" > "$pidfile"
    echo "$pid"
  else
    echo ""
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
    fi
    rm -f "$pidfile"
  else
    local pid
    pid=$(pgrep -f "wireproxy -c $conf" | head -1)
    if [ -n "$pid" ]; then
      $KILL "$pid" 2>/dev/null
    fi
  fi
  echo "  🛑 $name dimatikan"
}

start_with_unique_ip() {
  local conf="$1"
  local name
  name=$(basename "$conf" .conf)
  local port
  port=$(get_port "$conf")

  if [ -z "$port" ]; then
    echo "  ❌ $name GAGAL: Port BindAddress tidak ditemukan dalam file config."
    return 1
  fi

  # Jika proxy sudah jalan (dicek via pidfile ATAU proses nyata), jangan
  # dinyalakan ulang.
  local existing_pid
  existing_pid=$(get_running_pid "$conf")
  if [ -n "$existing_pid" ]; then
    if [ "$FAST_MODE" -eq 1 ]; then
      # Mode cepat/skip: skip total cek IP, langsung anggap OK
      local mode_label="fast mode"
      [ "$SKIP_MODE" -eq 1 ] && mode_label="skip mode"
      echo "  ⏭️  $name SUDAH JALAN (PID $existing_pid | Port $port) — dilewati ($mode_label, IP tidak dicek)"
      return 0
    fi
    # Mode normal: catat IP-nya supaya tidak dianggap bentrok dengan
    # proxy lain yang baru akan dinyalakan.
    local ip
    ip=$(get_ipv6 "$port")
    if [ -n "$ip" ]; then
      USED_IPS+=("$ip")
    fi
    echo "  ⏭️  $name SUDAH JALAN (PID $existing_pid | Port $port | IP: ${ip:-'Gagal Cek IP'}) — dilewati"
    return 0
  fi

  local attempt=1
  local pid=""
  local ip=""

  # Mode skip total: langsung start satu kali, tanpa cek IP/konektivitas
  # sama sekali dan tanpa retry loop. Paling cepat, tidak menjamin
  # IPv6 unik atau bahkan proxy benar-benar bisa konek.
  if [ "$SKIP_MODE" -eq 1 ]; then
    echo -n "  🚀 $name Memulai (Port $port, skip mode)... "
    pid=$(start_one_raw "$conf")
    if [ -n "$pid" ]; then
      echo "✅ DIJALANKAN (PID $pid, IP tidak dicek)"
      return 0
    else
      echo "GAGAL START (Cek log di $LOG_DIR/$name.log)"
      return 1
    fi
  fi

  while [ $attempt -le $MAX_ATTEMPTS ]; do
    echo -n "  🔄 [$attempt/$MAX_ATTEMPTS] Memulai $name (Port $port)... "
    pid=$(start_one_raw "$conf")

    if [ -z "$pid" ]; then
      echo "GAGAL START (Cek log di $LOG_DIR/$name.log)"
      ((attempt++))
      sleep 1
      continue
    fi

    # Berikan jeda sebentar agar handshake WireGuard selesai
    # (lebih singkat di mode fast)
    if [ "$FAST_MODE" -eq 1 ]; then
      sleep 1
    else
      sleep 3
    fi

    # Cek IPv6
    ip=$(get_ipv6 "$port")

    if [ -z "$ip" ]; then
      echo "GAGAL KONEKSI/TIDAK ADA IPV6. Merestart..."
      stop_one "$conf" > /dev/null
      ((attempt++))
      sleep 1
      continue
    fi

    # Cek apakah IP ini sudah dipakai oleh proxy lain yang sedang aktif
    # (dilewati di mode fast untuk mempercepat, risiko IP duplikat diterima)
    local is_duplicate=0
    if [ "$FAST_MODE" -ne 1 ]; then
      for used_ip in "${USED_IPS[@]}"; do
        if [ "$used_ip" == "$ip" ]; then
          is_duplicate=1
          break
        fi
      done
    fi

    if [ $is_duplicate -eq 1 ]; then
      echo "IP BENTROK ($ip). Mematikan dan mencoba ulang..."
      stop_one "$conf" > /dev/null
      ((attempt++))
      sleep 1
    else
      USED_IPS+=("$ip")
      echo "✅ BERHASIL (PID $pid | IPv6: $ip)"
      return 0
    fi
  done

  echo "  ❌ $name GAGAL mendapatkan IPv6 unik setelah $MAX_ATTEMPTS percobaan."
  stop_one "$conf" > /dev/null
  return 1
}

status_one() {
  local conf="$1"
  local name
  name=$(basename "$conf" .conf)
  local pidfile="$PID_DIR/$name.pid"
  local port
  port=$(get_port "$conf")

  if [ -f "$pidfile" ] && is_alive "$(cat "$pidfile")"; then
    local ip
    ip=$(get_ipv6 "$port")
    echo "  🟢 $name JALAN (PID $(cat "$pidfile") | Port $port | IP: ${ip:-'Gagal Cek IP'})"
  else
    local pid
    pid=$(pgrep -f "wireproxy -c $conf" | head -1)
    if [ -n "$pid" ]; then
      local ip
      ip=$(get_ipv6 "$port")
      echo "  🟢 $name JALAN (PID $pid | Port $port | IP: ${ip:-'Gagal Cek IP'})"
    else
      echo "  🔴 $name MATI (Port $port)"
    fi
  fi
}

cmd="${1:-status}"
USED_IPS=()

case "$cmd" in
  start)
    echo "Menyalakan proxy dari $(basename "$CONF_DIR") (Validasi IPv6 Unik)..."
    for conf in "$CONF_DIR"/wgcf-*.conf; do
      [ -f "$conf" ] || continue
      start_with_unique_ip "$conf"
    done
    echo "Selesai. Total proxy dengan IP unik aktif: ${#USED_IPS[@]}"
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
      port=$(get_port "$conf")
      echo "  socks5://127.0.0.1:$port"
    done
    echo ""
    echo "Contoh pakai semua sekaligus (paralel):"
    echo "  node upvote-core.js --id <uuid> --max 10 --parallel --proxy $(for conf in "$CONF_DIR"/wgcf-*.conf; do port=$(get_port "$conf"); printf "socks5://127.0.0.1:%s," "$port"; done | sed 's/,$//')"
    ;;
  *)
    echo "Penggunaan: $0 {start|stop|restart|status|list} [folder-config] [--fast|--skip]"
    echo ""
    echo "Folder config tersedia:"
    find "$SCRIPT_DIR" -maxdepth 1 -type d -name 'wgcf-*' 2>/dev/null | xargs -n1 basename | sed 's/^/  /'
    exit 1
    ;;
esac
