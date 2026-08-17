// modules/runner.js — Orchestrator utama: siapkan lane, jalankan worker, tampilkan ringkasan.
const fs = require("fs");
const { Table, colorize } = require("cmd-table");
const config = require("./config");
const rt = require("./runtime");
const { extractChapterId } = require("./util");
const { loadCheckpoint, flushCheckpointSync } = require("./checkpoint");
const { buildLanes } = require("./lanes");
const { startStats, buildDashboardFrame, renderStatsLine, buildStatsLine } = require("./dashboard");
const { independentWorker } = require("./worker");

// --- Graceful Shutdown ---
function gracefulShutdown(signal) {
  if (rt.stopping) return;
  rt.stopping = true;
  process.stdout.write(`\n\u23f9 Menerima ${signal}, menghentikan dengan anggun...\n`);
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// --- Main Runner ---
async function spamVote() {
  const chapterPath = extractChapterId(config.target);
  if (!chapterPath) {
    console.error("❌ ID target tidak valid! Masukkan UUID atau URL lengkap chapter.");
    process.exit(1);
  }

  const resumed = config.opts.resume ? loadCheckpoint() : false;
  if (resumed) rt.budget = Math.max(config.maxVotes - rt.state.sent, 0);

  const mode = rt.PROXIES.length === 0
    ? "Direct (Tanpa Proxy)"
    : rt.PROXIES.length === 1
    ? "Single Proxy"
    : config.PARALLEL
    ? `Paralel Independent (${config.concurrency} worker/proxy)`
    : `Round-Robin (${config.concurrency} worker)`;

  console.log("==================================================");
  console.log(" 🚀 INDEPENDENT PROXY LOOP UPVOTE RUNNER");
  console.log("==================================================");
  console.log(`Target Path : ${chapterPath}`);
  console.log(`Max Vote    : ${config.maxVotes}${resumed ? ` (Resume dari ${rt.state.sent})` : ""}`);
  console.log(`Worker/Proxy: ${config.concurrency} worker | Delay: ${config.delay}ms${config.jitter > 0 ? ` +jitter ${config.jitter}ms` : ""} | Global concurrency: ${config.globalConcurrency === 0 ? "tanpa batas" : config.globalConcurrency}`);
  console.log(`Timeout     : ${config.timeoutMs}ms | Retry Maks: ${config.maxRetry}`);
  console.log(`Total Proxy : ${rt.PROXIES.length ? rt.PROXIES.length + " proxy" : "(Direct)"}`);
  console.log(`Mode        : ${mode}`);
  console.log(`Checkpoint  : ${config.checkpointFile}`);
  console.log("==================================================\n");

  buildLanes();
  const statsTimer = startStats();

  const workers = [];
  if (rt.PROXIES.length === 0) {
    for (let i = 0; i < config.concurrency; i++) workers.push(independentWorker(null, chapterPath, null));
  } else if (config.PARALLEL || rt.PROXIES.length > 1) {
    for (const lane of rt.LANES) {
      for (let i = 0; i < config.concurrency; i++) workers.push(independentWorker(lane, chapterPath, rt.LANES));
    }
  } else {
    for (let i = 0; i < config.concurrency; i++) workers.push(independentWorker(rt.LANES[0], chapterPath, rt.LANES));
  }

  const t0 = Date.now();
  await Promise.all(workers);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (statsTimer) clearInterval(statsTimer);
  const totalDt = (Date.now() - t0) / 1000;
  rt.currentRate = totalDt > 0 ? rt.state.sent / totalDt : 0;

  // Tampilkan frame dashboard final (tabel per-proxy lengkap) sekali saja.
  if (config.DASHBOARD) {
    process.stdout.write("\n" + buildDashboardFrame(Date.now(), true) + "\n");
  } else {
    renderStatsLine(buildStatsLine(rt.currentRate));
    process.stdout.write("\n");
  }

  flushCheckpointSync();
  for (const lane of rt.LANES) lane.agent.destroy();

  console.log("\n==================================================");
  console.log(` 🏁 EKSEKUSI SELESAI DALAM ${elapsed} DETIK`);
  console.log("==================================================");
  console.log(` Sukses Kirim : ${rt.state.sent}/${config.maxVotes}`);
  console.log(` Total Gagal  : ${rt.state.failed}`);
  if (rt.state.invalid > 0) console.log(` Respons Invalid: ${rt.state.invalid} (errno != 0 / reaction0 tidak ada)`);
  if (rt.state.lastReaction0 !== null) console.log(` Total Vote di Server: ${rt.state.lastReaction0.toLocaleString("id-ID")}`);

  // --- Tabel TOTAL (kotak lengkap) ---
  console.log("\n 📦 RINGKASAN TOTAL:");
  const totalTable = Table.fromVertical({
    "Sukses": `${rt.state.sent}/${config.maxVotes}`,
    "Gagal": rt.state.failed,
    "Invalid": rt.state.invalid,
    "Proxy Mati": `${rt.LANES.filter((l) => l.dead).length}/${rt.LANES.length}`,
    "Total Vote di Server": rt.state.lastReaction0 !== null ? rt.state.lastReaction0.toLocaleString("id-ID") : "-",
    "Kecepatan": `${rt.currentRate.toFixed(1)} vote/s`,
    "Durasi": `${elapsed} detik`,
  });
  console.log(totalTable.render());
  console.log("==================================================");

  if (rt.state.sent >= config.maxVotes) {
    try { fs.unlinkSync(config.checkpointFile); } catch {}
    console.log("🎉 Target vote berhasil dicapai! Checkpoint dihapus.");
    process.exit(0);
  } else if (rt.stopping) {
    console.log(`⏹ Dihentikan oleh pengguna (${rt.state.sent}/${config.maxVotes}). Progres disimpan, jalankan --resume untuk melanjutkan.`);
    process.exit(130);
  } else {
    console.log(`⚠️ Target belum tercapai (${rt.state.sent}/${config.maxVotes}). Jalankan dengan opsi --resume untuk melanjutkan.`);
    process.exit(1);
  }
}

module.exports = { spamVote };
