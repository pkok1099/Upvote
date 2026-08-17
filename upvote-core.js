// upvote-core.js — Entry point (pengirim vote masal, independent proxy loop).
// Logika utama telah dipisah ke modul-modul kecil di ./modules/.
const config = require("./modules/config");
const rt = require("./modules/runtime");

// Inisialisasi anggaran vote global dari target.
rt.budget = config.maxVotes;

// Muat daftar proxy ke rt.PROXIES (berjalan saat di-require).
require("./modules/proxy-loader");

// Jalankan orchestrator utama.
const { spamVote } = require("./modules/runner");
spamVote();
