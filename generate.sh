#!/usr/bin/env bash

OUTPUT_DIR="./wireproxy_configs"
START_PORT=1100
TOTAL_COUNT=100

# Deteksi port SOCKS5 wireproxy yang sedang aktif di sistem
ACTIVE_PROXIES=($(pgrep -a wireproxy 2>/dev/null | grep -o '127.0.0.1:[0-9]*' | cut -d: -f2 | sort -u))

# Jika tidak ada wireproxy aktif yang terdeteksi, gunakan daftar port default
if [ ${#ACTIVE_PROXIES[@]} -eq 0 ]; then
    ACTIVE_PROXIES=(1100 1101 1102 1103 1104 1105)
fi

mkdir -p "$OUTPUT_DIR"

echo "Memulai registrasi massal (Rotasi: Proxy Active -> Direct -> Proxy Next)..."

try_register() {
    local proxy_port="$1"
    local temp_dir="$2"
    
    pushd "$temp_dir" > /dev/null 2>&1
    
    if [ -n "$proxy_port" ]; then
        # Routing registrasi wgcf melalui SOCKS5 wireproxy
        ALL_PROXY="socks5://127.0.0.1:${proxy_port}" \
        HTTPS_PROXY="socks5://127.0.0.1:${proxy_port}" \
        HTTP_PROXY="socks5://127.0.0.1:${proxy_port}" \
        wgcf register --accept-tos > /dev/null 2>&1
    else
        # Routing registrasi langsung (Direct IP lokal)
        wgcf register --accept-tos > /dev/null 2>&1
    fi
    
    local status=$?
    if [ $status -eq 0 ]; then
        wgcf generate > /dev/null 2>&1
        status=$?
    fi
    
    popd > /dev/null 2>&1
    return $status
}

for i in $(seq 0 $((TOTAL_COUNT - 1))); do
    port=$((START_PORT + i))
    file_name="wgcf-${port}.conf"
    success=false
    
    # Menyusun antrean alur percobaaan: [Proxy 1, Proxy 2, ..., Direct, Proxy Next...]
    ROUTES=()
    for p in "${ACTIVE_PROXIES[@]}"; do
        ROUTES+=("proxy:$p")
    done
    ROUTES+=("direct")
    
    for route in "${ROUTES[@]}"; do
        temp_dir=$(mktemp -d)
        
        if [[ "$route" == proxy:* ]]; then
            pxy_port="${route#proxy:}"
            echo -n "[$((i + 1))/$TOTAL_COUNT] Port $port: Coba via Proxy $pxy_port... "
            if try_register "$pxy_port" "$temp_dir"; then
                echo "OK"
                success=true
            else
                echo "GAGAL"
            fi
        else
            echo -n "[$((i + 1))/$TOTAL_COUNT] Port $port: Coba Direct (IP Asli)... "
            if try_register "" "$temp_dir"; then
                echo "OK"
                success=true
            else
                echo "GAGAL"
            fi
        fi
        
        if [ "$success" = true ]; then
            mv "$temp_dir/wgcf-profile.conf" "${OUTPUT_DIR}/${file_name}"
            cat <<EOF >> "${OUTPUT_DIR}/${file_name}"

[Socks5]
BindAddress = 127.0.0.1:${port}
EOF
            rm -rf "$temp_dir"
            break
        fi
        
        rm -rf "$temp_dir"
        sleep 1
    done
    
    if [ "$success" = false ]; then
        echo "[!] Gagal membuat config untuk port $port setelah mencoba seluruh rute."
    fi
done

echo "Proses selesai. File tersimpan di: $OUTPUT_DIR"
