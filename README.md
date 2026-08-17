# Upvote — Simulasi Vote & Uji Rate Limiter

Tool CLI berbasis Node.js untuk mensimulasikan vote massal pada sistem voting web komik Anda sendiri. Dirancang untuk pengujian pre-launch: memverifikasi akurasi rate limiter berbasis IP, mendeteksi tumpang tindih vote, dan mengukur throughput server di bawah beban.

## Fitur

- **Independent Worker Loop** — Setiap proxy berjalan di loop asinkronnya sendiri. Begitu 1 request selesai, proxy langsung jeda sebesar `--delay` lalu menembak lagi tanpa menunggu proxy lain.
- **Keep-Alive Connection Pool** — Reuse tunnel TLS & SOCKS5 untuk meminimalkan latency antar-request.
- **Checkpoint Asinkron** — Progres disimpan tanpa membekukan event loop. Bisa di-resume kapan saja.
- **Circuit Breaker** — Proxy yang gagal beruntun otomatis ditandai mati dan di-skip.
- **Backoff 429** — Menghormati header `Retry-After` dari server saat rate limit aktif.
- **Dashboard Real-Time** — Statistik terminal: vote sukses, gagal, kecepatan (vote/s), ETA, dan jumlah proxy mati.
- **Dukungan IPv6** — Paksa jalur IPv6 dengan `--ipv6` untuk simulasi multi-user via banyak alamat IPv6.

## Persyaratan

- Node.js >= 18 (untuk `fetch` native)
- Server vote berjalan di `http://127.0.0.1:8000` (default)
- Opsional: proxy SOCKS5/HTTP atau file config WireGuard/WGCF (`.conf`)

## Instalasi

```bash
cd upvote
# Tidak perlu npm install — hanya menggunakan modul bawaan Node.js
```

## Manajemen Proxy (upctl)

Proxy WireGuard/WGCF dikelola oleh binary C `upctl` (pengganti shell script
lama). Build sekali pakai `make` (perlu `clang` + `libcurl` Termux):

```bash
make            # clang -O2 upctl.c -lcurl -o upctl
./upctl status wgcf-30        # cek status proxy (JALAN/MATI + IPv6)
./upctl list wgcf-30          # daftar proxy untuk --proxy-dir
./upctl start wgcf-30 --skip  # nyalakan semua proxy (tanpa cek IPv6)
./upctl stop wgcf-30          # matikan semua proxy
./upctl restart wgcf-30       # restart semua proxy
./upctl test wgcf-30 30 100   # start → tunggu handshake → jalankan node → stop
```

Flag: `--skip` (start tanpa cek IPv6/unik, paling cepat), `--fast` (cek lebih
ringan, lewati deteksi IP duplikat untuk proxy yang sudah jalan). Urutan bebas.

`upctl` (dan seluruh path `wireproxy`) hanya berjalan di lingkungan Termux/Android
sebagai-ada — tidak ada override path via env/config.

## Penggunaan

```bash
node upvote-core.js [opsi]
```

### Opsi Dasar

| Opsi | Deskripsi | Default |
|------|-----------|---------|
| `--id, --url <val>` | ID target: UUID polos, `chapter/<uuid>`, atau URL lengkap | UUID di CONFIG |
| `--max <n>` | Target jumlah vote sukses | `5` |
| `--delay <ms>` | Jeda per proxy setelah request selesai (min 0) | `1` |

### Pengaturan Proxy

| Opsi | Deskripsi | Default |
|------|-----------|---------|
| `--proxy <list>` | Daftar proxy dipisah koma (`socks5://`, `http://`, `host:port`) | env `HTTPS_PROXY` |
| `--proxy-dir <dir>` | Folder berisi file config WireGuard/WGCF (`.conf`) | — |
| `--parallel` | Jalankan worker paralel untuk setiap proxy | off |
| `--concurrency <n>` | Jumlah worker simultan per proxy | `1` |
| `--global-concurrency <n>` | Batas total request serentak lintas semua proxy; `0` = tanpa batas/independen | `0` |
| `--jitter <ms>` | Variasi acak tambahan delay tiap proxy agar ritme setiap proxy unik | `0` |

### Keandalan & Performa

| Opsi | Deskripsi | Default |
|------|-----------|---------|
| `--timeout <ms>` | Timeout tiap request HTTP | `3000` |
| `--max-retry <n>` | Maksimal retry saat koneksi bermasalah | `1` |
| `--checkpoint <file>` | File penyimpanan progres | `.upvote-checkpoint.json` |
| `--resume` | Lanjutkan dari checkpoint terakhir | off |
| `--stats-interval <ms>` | Frekuensi pembaruan statistik terminal | `1000` |
| `--ipv6` | Paksa jalur jaringan IPv6 | off |
| `-h, --help` | Tampilkan bantuan | — |

## Contoh Penggunaan

### Simulasi 30 user unik via IPv6

```bash
node upvote-core.js \
  --id "chapter/a6d1020e-e71e-43ed-91a5-39c9c88de017" \
  --max 30 \
  --ipv6 \
  --delay 100
```

### Simulasi dengan 30 proxy SOCKS5 (multi-IP)

```bash
node upvote-core.js \
  --id "chapter/a6d1020e-e71e-43ed-91a5-39c9c88de017" \
  --max 30 \
  --proxy "socks5://127.0.0.1:1081,socks5://127.0.0.1:1082,socks5://127.0.0.1:1083" \
  --parallel \
  --concurrency 1 \
  --delay 50
```

### Load test dari folder config WireGuard

```bash
node upvote-core.js \
  --id "chapter/a6d1020e-e71e-43ed-91a5-39c9c88de017" \
  --max 100 \
  --proxy-dir ./wgcf-30 \
  --parallel \
  --concurrency 2 \
  --timeout 5000
```

### Resume setelah terputus

```bash
node upvote-core.js \
  --id "chapter/a6d1020e-e71e-43ed-91a5-39c9c88de017" \
  --max 100 \
  --resume
```

## Format Target

Tool menerima tiga format input untuk `--id`:

```
# UUID polos
a6d1020e-e71e-43ed-91a5-39c9c88de017

# Prefixed
chapter/a6d1020e-e71e-43ed-91a5-39c9c88de017

# URL lengkap
https://example.com/read/chapter/a6d1020e-e71e-43ed-91a5-39c9c88de017
```

Semua format di atas akan dinormalisasi menjadi `chapter/<uuid>`.

## Arsitektur

```
┌─────────────────────────────────────────────────┐
│                  Main Runner                     │
│  - Parse CLI args                                │
│  - Load proxies (list / dir / env)               │
│  - Build lanes (1 lane = 1 proxy + agent)        │
│  - Spawn workers                                 │
└────────────────────┬────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐
   │ Worker 1│ │ Worker 2│ │ Worker N│  (independent loop)
   │ Lane A  │ │ Lane B  │ │ Lane C  │
   └────┬────┘ └────┬────┘ └────┬────┘
        │            │            │
        ▼            ▼            ▼
   ┌─────────────────────────────────┐
   │     ProxyAgent (Keep-Alive)     │
   │  SOCKS5 tunnel / HTTP CONNECT   │
   │  + TLS wrap                     │
   └────────────────┬────────────────┘
                    ▼
   ┌─────────────────────────────────┐
   │   POST /api/article?lang=en     │
   │   { path, type: "reaction0" }   │
   └─────────────────────────────────┘
```

### Alur per Worker

1. Kirim request vote via proxy lane (atau direct jika tanpa proxy)
2. Jika sukses → increment counter, simpan checkpoint async
3. Jika 429 → baca `Retry-After`, backoff eksponensial (cap 60s)
4. Jika error → increment `consecutiveFails`, tandai mati jika >= 5
5. Jeda `--delay` ms, lalu ulangi sampai `--max` tercapai

## Konfigurasi Default

Edit objek `CONFIG` di bagian atas `modules/config.js`:

```javascript
const CONFIG = {
  target: "a6d1020e-e71e-43ed-91a5-39c9c88de017",
  maxVotes: 5,
  delay: 1,
  apiUrl: "http://127.0.0.1:8000/api/article?lang=en",
  proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "",
};
```

## Simulasi 100 User: 1 Proxy = 1 Orang

Setiap proxy berjalan di loop-nya sendiri yang sepenuhnya independen — begitu 1 request selesai, proxy itu langsung jeda sebesar `--delay` (plus `--jitter` acak) lalu menembak lagi, tanpa menunggu atau terpengaruh proxy lain. Ini meniru perilaku user asli yang ritmenya berbeda-beda.

```bash
node upvote-core.js \
  --id "chapter/<uuid>" \
  --max 100 \
  --proxy-dir ./wgcf-30 \
  --parallel \
  --concurrency 1 \
  --delay 1000 \
  --jitter 500
```

Dengan contoh di atas, tiap proxy menunggu `1000 + acak(0..500)` ms antar vote, sehingga 100 proxy tidak pernah menembak serentak secara sinkron.

Tips:

- **`--concurrency 1`** — cukup 1 vote per proxy (sesuai skenario 100 user vote 1x).
- **`--delay` + `--jitter`** — kombinasi keduanya membuat ritme tiap proxy unik seperti user asli.
- **`--global-concurrency 0`** (default) — tanpa batas, tiap proxy sepenuhnya independen. Jika resource terbatas, set nilai seperti `20` untuk membatasi request serentak; sisanya mengantre otomatis.
- **`--timeout 5000`** — di jaringan lambat, timeout terlalu pendek memicu retry yang memboroskan resource.
- **`--max-retry 0`** — matikan retry jika hanya ingin menguji akurasi rate limiter, bukan keandalan koneksi.
- **`--stats-interval 2000`** — kurangi frekuensi render dashboard terminal.

## Skenario Pengujian Rate Limiter

Untuk menguji apakah rate limiter berbasis IP Anda bekerja dengan benar:

1. **Siapkan N proxy** (masing-masing dengan IP sumber berbeda), misalnya 30 interface WireGuard lokal.
2. **Jalankan dengan `--max N`** dan `--concurrency 1` agar setiap proxy mengirim tepat 1 vote.
3. **Verifikasi di server**: harus ada tepat N vote tercatat, tanpa duplikat.
4. **Uji threshold**: jalankan dengan `--max` melebihi limit per-IP, pastikan server menolak vote berlebih dengan status 429.
5. **Uji backoff**: tool akan otomatis menunggu sesuai `Retry-After` — verifikasi server mengirim header tersebut dengan benar.

## Lisensi

Internal use — tool testing untuk pengembangan web komik Anda.
