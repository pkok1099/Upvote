// modules/runner.js — Orchestrator utama: siapkan lane, jalankan worker, tampilkan ringkasan.
const fs = require("fs");
const { Table } = require("cmd-table");
const config = require("./cli");
const rt = require("./runtime");
const { extractChapterId } = require("./util");
const { loadCheckpoint, flushCheckpointSync } = require("./checkpoint");
const { buildLanes } = require("./lanes");
const { startStats, buildDashboardFrame, renderStatsLine, buildStatsLine } = require("./dashboard");
const { independentWorker, buildCombos } = require("./worker");

// --- Graceful Shutdown ---
function gracefulShutdown(signal) {
  if (rt.stopping) {
    process.stdout.write("\n⚠️ Memaksa keluar...\n");
    process.exit(130);
  }
  rt.stopping = true;
  process.stdout.write(`\n\u23f9 Menerima ${signal}, menghentikan dengan anggun...\n`);
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// --- Main Runner ---
async function spamVote() {
  const chapterPath = extractChapterId(config.target);
  if (config.invalidTarget || (!config.multiTarget && !chapterPath)) {
    console.error("❌ ID target tidak valid! Masukkan UUID, chapter/<uuid>, atau URL lengkap chapter (boleh berkoma untuk multi).");
    process.exit(1);
  }
  if (config.invalidVoteType) {
    const bad = config.voteTypes.filter((t) => !/^reaction\d+$/.test(t)).join(", ");
    console.error(`❌ Tipe vote tidak valid: ${bad}. Format harus reaction<angka> (mis. reaction0, reaction1, reaction2).`);
    process.exit(1);
  }
  const targetPaths = config.targets.length ? config.targets : [chapterPath];
  rt.TARGETS = targetPaths;
  // Batas per-chapter awal: dari --chapter-concurrency kalau ada, kalau tidak dari auto-tune.
  rt.chapterLimit = config.chapterConcurrency > 0 ? config.chapterConcurrency : (config.AUTO_TUNE ? config.autoTuneStart : 0);

  const resumed = config.opts.resume ? loadCheckpoint() : false;
  if (resumed) rt.budget = Math.max((config.COUNT_REAL ? config.maxRequests : config.maxVotes) - rt.state.sent, 0);

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
  console.log(`Target Path : ${targetPaths.join(", ")}${config.multiTarget ? ` (${targetPaths.length} ID)` : ""}`);
  console.log(`Vote Tipe   : ${config.voteTypes.join(", ")}${config.multiType ? ` (${config.voteTypes.length} tipe, counter terpisah)` : ""}`);
  console.log(`Max Vote    : ${config.maxVotes}${config.COUNT_REAL ? " (masuk)" : " (request)"}${resumed ? ` (Resume dari ${rt.state.sent})` : ""}`);
  const perChapterLabel = config.AUTO_TUNE
    ? `auto (target ${config.autoTuneTarget}%, start ${config.autoTuneStart})`
    : config.chapterConcurrency === 0 ? "tanpa batas" : config.chapterConcurrency;
  console.log(`Worker/Proxy: ${config.concurrency} worker | Delay: ${config.delay}ms${config.jitter > 0 ? ` +jitter ${config.jitter}ms` : ""} | Global concurrency: ${config.globalConcurrency === 0 ? "tanpa batas" : config.globalConcurrency} | Per-counter: ${perChapterLabel}`);
  console.log(`Timeout     : ${config.timeoutMs}ms | Retry Maks: ${config.maxRetry}`);
  console.log(`Total Proxy : ${rt.PROXIES.length ? rt.PROXIES.length + " proxy" : "(Direct)"}`);
  console.log(`Mode        : ${mode}`);
  console.log(`Checkpoint  : ${config.checkpointFile}`);
  console.log("==================================================\n");

  buildLanes();
  const statsTimer = startStats();
  let autoTimer = null;
  if (config.AUTO_TUNE) {
    const { startAutoTune } = require("./autotune");
    autoTimer = startAutoTune();
  }

  const combos = buildCombos(targetPaths, config.voteTypes);
  const workers = [];
  const activeLanes = rt.LANES.length > 0 ? rt.LANES : [null];
  for (const lane of activeLanes) {
    for (let i = 0; i < config.concurrency; i++) {
      workers.push(independentWorker(lane, targetPaths, combos));
    }
  }

  const t0 = Date.now();

  // Watchdog straggler: kalau tak ada progres (sent bertambah) selama stallMs,
  // paksa putus semua socket agent -> request yang menggantung error -> worker
  // lanjut/berhenti, bukan macet sampai run tak pernah selesai.
  let stallTimer = null;
  if (config.stallMs > 0) {
    let lastSent = rt.state.sent;
    let lastProgress = Date.now();
    stallTimer = setInterval(() => {
      if (rt.state.sent !== lastSent) { lastSent = rt.state.sent; lastProgress = Date.now(); return; }
      const targetUnreached = config.COUNT_REAL ? rt.state.entered < config.maxVotes : rt.state.sent < config.maxVotes;
      if (Date.now() - lastProgress >= config.stallMs && targetUnreached) {
        for (const lane of rt.LANES) { try { lane.agent.destroy(); } catch {} }
        lastProgress = Date.now();
      }
    }, Math.min(config.stallMs, 5000));
  }

  try {
    await Promise.all(workers);
  } finally {
    if (stallTimer) clearInterval(stallTimer);
    if (autoTimer) clearInterval(autoTimer);
    if (statsTimer) clearInterval(statsTimer);
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
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
  console.log(` Sukses Kirim : ${rt.state.sent}/${config.COUNT_REAL ? config.maxRequests : config.maxVotes} request`);
  console.log(` Vote MASUK    : ${rt.state.entered} (konversi ${rt.state.sent > 0 ? ((rt.state.entered / rt.state.sent) * 100).toFixed(1) : "0"}%)`);
  if (config.AUTO_TUNE) console.log(` Auto-tune   : target ${config.autoTuneTarget}% | limit/chapter akhir ${rt.chapterLimit}`);
  console.log(` Total Gagal  : ${rt.state.failed}`);
  if (rt.state.invalid > 0) console.log(` Respons Invalid: ${rt.state.invalid} (errno != 0 / nilai counter(tipe) tidak ada)`);
  if (rt.state.lastValue !== null) console.log(` Vote di Server (${rt.state.lastType}): ${rt.state.lastValue.toLocaleString("id-ID")}`);
  if (config.multiType) console.log(` Tipe divote : ${config.voteTypes.join(", ")}`);

  // --- Tabel TOTAL (kotak lengkap) ---
  console.log("\n 📦 RINGKASAN TOTAL:");
  const pct = rt.state.sent > 0 ? ((rt.state.entered / rt.state.sent) * 100).toFixed(1) : "0.0";
  const totalTable = Table.fromVertical({
    "Request Terkirim": rt.state.sent,
    "Vote Masuk": rt.state.entered,
    "Konversi": `${pct}%`,
    "Gagal": rt.state.failed,
    "Invalid": rt.state.invalid,
    "Proxy Mati": `${rt.deadCount}/${rt.LANES.length}`,
    "Counter Server": rt.state.lastValue !== null ? `${rt.state.lastValue.toLocaleString("id-ID")} (${rt.state.lastType})` : "-",
    "Kecepatan": `${rt.currentRate.toFixed(1)} req/s`,
    "Durasi": `${elapsed} detik`,
  });
  console.log(totalTable.render());

  // Rincian per-counter. Multi-tipe: tiap (chapter,tipe) counter terpisah.
  if (config.multiType) {
    console.log("\n 📑 RINCIAN PER-COUNTER (chapter × tipe):");
    const t = new Table({ columns: [{ name: "ID" }, { name: "Tipe" }, { name: "Request" }, { name: "Masuk" }, { name: "Konversi" }, { name: "Counter" }] });
    for (const tp of targetPaths) {
      for (const ty of config.voteTypes) {
        const tr = rt.perTarget[`${tp}|${ty}`] || { entered: 0, sent: 0, max: null };
        const p = tr.sent > 0 ? ((tr.entered / tr.sent) * 100).toFixed(1) : "0.0";
        t.addRow([tp.replace("chapter/", ""), ty, tr.sent, tr.entered, `${p}%`, tr.max !== null ? tr.max.toLocaleString("id-ID") : "-"]);
      }
    }
    console.log(t.render());
  } else if (config.multiTarget) {
    // Multi-target: rincian vote masuk per chapter (counter terpisah).
    console.log("\n 📑 RINCIAN PER-ID:");
    const t = new Table({ columns: [{ name: "ID" }, { name: "Request" }, { name: "Masuk" }, { name: "Konversi" }, { name: "Counter" }] });
    for (const tp of targetPaths) {
      const key = `${tp}|${config.voteTypes[0]}`;
      const tr = rt.perTarget[key] || rt.perTarget[tp] || { entered: 0, sent: 0, max: null };
      const p = tr.sent > 0 ? ((tr.entered / tr.sent) * 100).toFixed(1) : "0.0";
      t.addRow([tp.replace("chapter/", ""), tr.sent, tr.entered, `${p}%`, tr.max !== null ? tr.max.toLocaleString("id-ID") : "-"]);
    }
    console.log(t.render());
  }
  console.log("==================================================");

  const reachedTarget = config.COUNT_REAL ? rt.state.entered >= config.maxVotes : rt.state.sent >= config.maxVotes;
  if (reachedTarget) {
    try { fs.unlinkSync(config.checkpointFile); } catch {}
    console.log(`🎉 Target tercapai (${config.COUNT_REAL ? rt.state.entered + " vote masuk" : rt.state.sent + " request"})! Checkpoint dihapus.`);
    process.exit(0);
  } else if (rt.stopping) {
    console.log(`⏹ Dihentikan oleh pengguna (${rt.state.entered} masuk / ${rt.state.sent} request). Progres disimpan, jalankan --resume untuk melanjutkan.`);
    process.exit(130);
  } else {
    console.log(`⚠️ Target belum tercapai (${rt.state.entered} masuk / ${rt.state.sent} request dari target ${config.maxVotes}). Jalankan dengan --resume untuk melanjutkan.`);
    process.exit(1);
  }
}

module.exports = { spamVote };
