// upvote-core.js — Entry point (pengirim vote masal, independent proxy loop).
// Logika utama telah dipisah ke modul-modul kecil di ./modules/.
const config = require("./modules/cli");
const rt = require("./modules/runtime");

// Anggaran request global: mode count-real pakai maxRequests (target = vote masuk).
rt.budget = config.COUNT_REAL ? config.maxRequests : config.maxVotes;

// Muat daftar proxy ke rt.PROXIES, lalu jalankan orchestrator.
const { init } = require("./modules/proxy-loader");
const { spamVote } = require("./modules/runner");

init().then(spamVote).catch((err) => {
  console.error("❌ Fatal error:", err.message || err);
  process.exit(1);
});
