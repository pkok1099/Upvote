# Upvote — Simulasi Vote & Uji Rate Limiter

Tool CLI berbasis Node.js untuk mensimulasikan vote massal pada sistem voting web komik Anda sendiri. Dirancang untuk pengujian pre-launch: memverifikasi akurasi rate limiter berbasis IP, mendeteksi tumpang tindih vote, dan mengukur throughput server di bawah beban.

## Fitur

- **Independent Worker Loop** — Setiap proxy berjalan di loop asinkronnya sendiri. Begitu 1 request selesai, proxy langsung jeda sebesar `--delay` lalu menembak lagi tanpa menunggu proxy lain.
- **Keep-Alive Connection Pool** — Reuse tunnel TLS & SOCKS5 untuk meminimalkan latency antar-request.
- **Checkpoint Asinkron** — Progres disimpan tanpa membekukan event loop. Bisa di-resume kapan saja.
- **Circuit Breaker** — Proxy yang gagal beruntun otomatis ditandai mati dan di-skip.
- **Backoff 429** — Menghormati header `Retry-After` dari server saat rate limit aktif.
- **Dashboard Real-Time** — Statistik terminal: vote sukses, gagal, kecepatan (vote/s), ETA, dan jumlah proxy mati.
- **Dukungan IPv6 Only** — `--ipv6` memaksa resolusi dan jalur IPv6 (AAAA only, tanpa fallback IPv4), termasuk lewat proxy SOCKS5: target di-resolve ke literal IPv6 lebih dulu agar proxy tak memilih IPv4.

## Persyaratan

- Node.js >= 18 (untuk `fetch` native)
- Server vote berjalan di `http://127.0.0.1:8000` (default)
- Opsional: proxy SOCKS5/HTTP atau file config WireGuard/WGCF (`.conf`)

## Instalasi

```bash
cd upvote
# Tidak perlu npm install — hanya menggunakan modul bawaan Node.js
```

## Penggunaan

```bash
node upvote-core.js [opsi]
```

### Opsi Dasar

| Opsi | Deskripsi | Default |
|------|-----------|---------|
| `--id, --url <val>` | ID target: UUID polos, `chapter/<uuid>`, atau URL lengkap. **Multi-ID**: pisah koma (`--id a,b`) atau ulang flag (`--id a --id b`); vote dirotasi round-robin, tiap ID punya counter `reaction0` sendiri | UUID di CONFIG |
| `--max <n>` | Target jumlah vote sukses. Dengan `--count-real`, artinya jumlah vote yang **benar-benar masuk** (Δ `reaction0`), bukan jumlah request | `5` |
| `--count-real` | Anggap `--max` sebagai vote yang benar-benar masuk (Δ `reaction0`), bukan request. Tampilkan % konversi live | off |
| `--max-requests <n>` | Batas request pengaman saat `--count-real` (server bisa diam-diam membuang vote) | `50×--max` |
| `--vote-types <list>` | Tipe reaksi yang divote, pisah koma (mis. `reaction0,reaction1,reaction2`). **Tiap `(chapter,tipe)` = counter server terpisah**, jadi menambah tipe memecah tekanan tulis persis seperti multi-ID (`C/(K×T)`) → konversi naik, tapi laju tiap tipe turun (1/N) | `reaction0` |
| `--delay <ms>` | Jeda per proxy setelah request selesai (min 0) | `1` |

### Pengaturan Proxy

| Opsi | Deskripsi | Default |
|------|-----------|---------|
| `--proxy <list>` | Daftar proxy dipisah koma (`socks5://`, `http://`, `host:port`) | env `HTTPS_PROXY` |
| `--proxy-dir <dir>` | Folder berisi file config WireGuard/WGCF (`.conf`) | — |
| `--proxy-replicas <n|auto>` | Gandakan tiap proxy jadi N lane paralel; manfaatkan backend round-robin multi-IP dari 1 endpoint. `auto` = ambil jumlah sesi dari wpmulti `/debug/sessions` | `1` |
| `--wpmulti-debug <addr>` | Alamat debug wpmulti untuk mode `auto` | `127.0.0.1:2081` |
| `--no-keepalive` | Tiap request buka koneksi baru. Wajib untuk proxy round-robin per-flow (mis. `wpmulti`) agar tiap request dapat IP berbeda | off |
| `--parallel` | Jalankan worker paralel untuk setiap proxy | off |
| `--concurrency <n>` | Jumlah worker simultan per proxy | `1` |
| `--global-concurrency <n>` | Batas total request serentak lintas semua proxy; `0` = tanpa batas/independen | `0` |
| `--chapter-concurrency <n>` | Batas request serentak **per chapter**. Server pakai counter read-modify-write per chapter; tulis serentak berlebih ke chapter sama bikin vote saling menimpa (drop). Rasio aman C/K ≤ 2. `0` = tanpa batas | `0` |
| `--auto-tune` | **Atur otomatis** batas per-chapter agar konversi vote "masuk" tetap ≥ target tanpa setel manual. Controller: slow-start (×2) temukan knee, backoff ×0.5 saat drop (butuh 2 window buruk berturut), lalu jaga "ceiling" aman + probe jarang | off |
| `--auto-tune-target <pct>` | Persen konversi minimum yang dijaga oleh `--auto-tune` | `90` |
| `--auto-tune-window <ms>` | Jendela pengukuran auto-tune | `3000` |
| `--auto-tune-max <n>` | Batas atas per-chapter saat auto-tune | `16` |
| `--auto-tune-probe <n>` | Setelah backoff, tunggu N window "aman" sebelum probe naik lagi | `12` |
| `--jitter <ms>` | Variasi acak tambahan delay tiap proxy agar ritme setiap proxy unik | `0` |

### Keandalan & Performa

| Opsi | Deskripsi | Default |
|------|-----------|---------|
| `--timeout <ms>` | Timeout tiap request HTTP | `3000` |
| `--max-retry <n>` | Maksimal retry saat koneksi bermasalah | `1` |
| `--stall-timeout <ms>` | Paksa putus socket bila tak ada progres vote selama ms ini; cegah run macet karena straggler | `60000` |
| `--checkpoint <file>` | File penyimpanan progres | `.upvote-checkpoint.json` |
| `--resume` | Lanjutkan dari checkpoint terakhir | off |
| `--stats-interval <ms>` | Frekuensi pembaruan statistik terminal | `1000` |
| `--ipv6` | Paksa jalur jaringan IPv6 only (AAAA, tanpa fallback IPv4) | off |
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

Edit `config.js` di root repo (sumber default). Argumen CLI tetap menang:

```javascript
// config.js
module.exports = {
  target: "a6d1020e-e71e-43ed-91a5-39c9c88de017",
  maxVotes: 5,
  delay: 1,
  apiUrl: "http://127.0.0.1:8000/api/article?lang=en",
  proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "",
  proxyDir: "", // mis. "wgcf-30" agar tak perlu --proxy-dir
};
```

Parsing CLI + penanganan IPv6 ada di `modules/cli.js`.

## 1 Proxy, Banyak IP (Backend Round-Robin)

Kalau endpoint proxy Anda adalah **1 titik masuk** yang backend-nya round-robin ke
banyak IP (mis. `wpmulti`: N sesi WireGuard, 1 listener SOCKS5/HTTP, tiap **flow**
= 1 IP egress berbeda), tool bisa memakainya.

Kunci penting: `wpmulti` memilih tunnel **per flow (5-tuple)**, dengan *sticky
affinity* — satu koneksi TCP selalu memakai IP yang sama. Maka:

- **Keep-alive harus dimatikan** (`--no-keepalive`), kalau tidak request beruntun
  memakai satu koneksi → satu IP terus.
- **Perbanyak lane paralel** (`--proxy-replicas`) supaya banyak flow jalan
  bersamaan → banyak IP terpakai sekaligus.

```bash
# 1 endpoint wpmulti, 1200 sesi -> 1200 flow paralel (tiap request IP baru)
node upvote-core.js \
  --id "chapter/<uuid>" \
  --max 1200 \
  --proxy "socks5://127.0.0.1:1080" \
  --proxy-replicas auto \
  --no-keepalive \
  --concurrency 1 \
  --delay 0
```

`--proxy-replicas auto` menanyakan jumlah sesi aktif ke wpmulti
(`/debug/sessions`) lalu menyetel jumlah lane otomatis — tak perlu tahu jumlah
`.conf` sesi secara manual.

### Launcher satu perintah: `wpmulti.sh`

Build + jalankan wpmulti, tunggu listener siap, jalankan vote dengan
`--proxy-replicas auto`, lalu matikan:

```bash
./wpmulti.sh ./wp-conf 1200 0 "chapter/<uuid>" --no-keepalive
#           conf-dir votes delay target-id        opsi upvote lain...
```

Env: `WPMULTI_DIR` (default `/home/ubuntu/wpmulti-lib`), `SOCKS_ADDR`
(`127.0.0.1:1080`), `HTTP_ADDR` (`127.0.0.1:2080`), `DEBUG_ADDR` (`127.0.0.1:2081`).

Atau set permanen di `config.js` root:

```javascript
proxy: "socks5://127.0.0.1:1080",
proxyReplicas: "auto",
wpmultiDebug: "127.0.0.1:2081",
keepAlive: false,
```

Catatan:

- `--concurrency` mengalikan lane: total worker = `lane × concurrency`. Untuk 1200 IP cukup `--concurrency 1`, `--proxy-replicas 1200`.
- `--global-concurrency <n>` membatasi request serentak (dan flow) bila backend/HP terbatas.
- `--ramp <ms>` sebar handshake awal agar 1200 flow tidak menembak serentak di t=0.
- Tanpa `--no-keepalive`, round-robin per-flow hanya terpakai saat lane cukup banyak (tiap lane dapat satu flow tetap). Kombinasi `--proxy-replicas` + `--no-keepalive` paling agresif menyebar IP.
- Kalau backend round-robin **per sesi** (bukan per flow) seperti 1 proxy → banyak IP tetap, cukup pakai `--proxy-replicas` (keep-alive boleh hidup).

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
