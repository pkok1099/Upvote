// config.js — Konfigurasi default yang bisa diedit pengguna (root repo).
// Nilai di sini menimpa DEFAULTS di modules/cli.js.
// Argumen CLI (--id, --max, --proxy-dir, dst) tetap menang atas file ini.
// Semua key opsional; hapus yang tidak dipakai.
module.exports = {
  // Target vote: UUID polos, "chapter/<uuid>", atau URL lengkap.
  target: "a6d1020e-e71e-43ed-91a5-39c9c88de017",

  // Jumlah vote sukses yang ingin dicapai.
  maxVotes: 5,

  // Jeda per proxy setelah tiap request (ms).
  delay: 1,

  // Endpoint vote.
  apiUrl: "https://commento.shngm.io/api/article?lang=en",

  // Daftar proxy dipisah koma (socks5://, http://, host:port). Kosong = direct.
  proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "",

  // Folder berisi file .conf Wireproxy/WGCF. Kosong = abaikan.
  // Set mis. "wgcf-30" agar tak perlu --proxy-dir tiap kali.
  proxyDir: "",

  // Gandakan tiap proxy jadi N lane paralel. Utk 1 endpoint dengan backend
  // round-robin (mis. 1200 IP): set 1200 agar semua IP terpakai.
  proxyReplicas: 1,

  // Reuse koneksi keep-alive. Set false bila proxy round-robin IP per-flow
  // (mis. wpmulti): tiap request buka flow baru -> dapat egress IP baru.
  keepAlive: true,

  // Alamat debug wpmulti (/debug/sessions) utk --proxy-replicas auto.
  wpmultiDebug: "127.0.0.1:2081",

  // Paksa putus socket bila tak ada progres vote selama ms ini (0 = mati).
  // Cegah run besar macet karena request straggler menggantung.
  stallTimeout: 60000,
};
