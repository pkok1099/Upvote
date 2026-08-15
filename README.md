# Upvote Spammer Konfigurasi

Aplikasi web berbasis browser untuk mengirim vote otomatis ke chapter tertentu di platform Shinigami Asia menggunakan API Commento.

## ⚠️ Peringatan: Hanya untuk Pengujian

Alat ini **hanya** digunakan untuk menguji apakah sistem vote berfungsi dengan normal di lingkungan Anda. Jangan gunakan untuk menyerang atau membanjiri situs lain tanpa izin. Penyalahgunaan dapat melanggar ketentuan layanan dan dapat menimbulkan konsekuensi hukum. Pengguna bertanggung jawab atas penggunaan yang tidak diizinkan.

## Tujuan

Menyediakan alat sederhana berbasis browser untuk mengirim vote ke URL yang dipilih Anda, memungkinkan Anda memeriksa respons API dan memastikan semua parameter konfigurasi (URL, jumlah maksimal, penundaan) bekerja seperti yang diharapkan.

## Penggunaan Bertanggung Jawab

- Gunakan **hanya** pada aplikasi atau layanan yang Anda miliki atau yang Anda izinkan memiliki pengujian.
- Jangan verifikasi pada situs atau API yang tidak Anda kuasa.
- Selalu patuhi batasan dan jalankan dalam lingkungan yang dikontrol.
- Hentikan segera jika ada indikasi sistem sedang dihambat atau mengalami beban yang tidak terduga.

## Fitur

- Antarmuka web yang mudah digunakan (dibuat dengan Tailwind CSS)
- Konfigurasi dinamis: URL target, jumlah vote maksimal, dan penundaan
- Pelacakan real-time: menampilkan jumlah vote terkirim dan reaksi terbaru
- Validasi input otomatis
- Tombol stop untuk menghentikan proses voting kapan saja

## Cara Penggunaan

1. Buka file `upvote.html` di browser Anda (klik dua kali atau tarik ke browser).
2. Masukkan URL chapter target di kolom **URL Target**.
   - Format yang didukung: `https://app.shinigami.asia/chapter/<id-chapter>`
   - Contoh: `https://app.shinigami.asia/chapter/d0ff2906-1889-4a73-afa8-12dfbf1d5ee6`
3. Atur **Jumlah Vote Maksimal** (default: 900.000, minimal: 1).
4. Atur **Penundaan (ms per vote)** (default: 100ms, minimal: 100ms).
5. Klik tombol **Mulai Voting** untuk memulai.
6. Untuk menghentikan, klik tombol yang berubah menjadi **Menghentikan Voting...**.

## Teknis

- **Bahasa**: HTML, CSS, JavaScript (murni, tanpa dependensi luar selain Tailwind CSS CDN)
- **API yang dipanggil**: `https://commento.shngm.io/api/article?lang=en` (metode POST)
- **Tipe vote**: `reaction0`
- **Tidak memerlukan installasi**: Cukup buka file HTML di browser.

## Struktur Berkas

```
Upvote/
├── upvote.html      # Aplikasi utama (HTML + CSS + JS, berbasis browser)
├── upvote-core.js   # Versi Node.js (headless) dari inti pengirim vote, mendukung proxy
├── README.md        # Dokumentasi ini
└── LICENSE          # Lisensi MIT
```

## Versi Node.js (Core)

`upvote-core.js` adalah versi tanpa antarmuka yang berjalan di terminal:

```bash
node upvote-core.js --id a6d1020e-e71e-43ed-91a5-39c9c88de017 --max 5 --delay 100
node upvote-core.js --id <id> --proxy http://user:pass@host:port/   # lewat proxy (jaga-jaga region lock)
```

Mendukung input ID berupa UUID polos, `chapter/<uuid>`, atau URL lengkap, serta penanganan 429 (Retry-After + backoff eksponensial).

## Lisensi

Lihat file [LICENSE](LICENSE) untuk detail lisensi. Hak cipta (c) 2025 pkok1099.