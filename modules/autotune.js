// modules/autotune.js — Auto-tune batas serentak per-chapter agar konversi
// vote "masuk" tetap di atas target (default 90%) tanpa setel manual.
//
// Server pakai counter read-modify-write per chapter -> makin banyak tulis
// serentak ke chapter sama, makin banyak yang hilang. Batas aman tak konstan
// (tergantung beban server), jadi controller mempelajarinya:
//   - slow-start: naik x2 sampai pertama kali konversi < target (temukan knee)
//   - setelah drop: backoff x0.5 + ingat "ceiling" (batas aman tertinggi)
//   - lalu pulih ke ceiling; naik lagi hanya sesekali (probe) agar jarang menembus knee
const config = require("./cli");
const rt = require("./runtime");
const { nextAutoLimit } = require("./util");
const { drainChapterSlots } = require("./semaphore");

function startAutoTune() {
  const state = {
    limit: rt.chapterLimit > 0 ? rt.chapterLimit : config.autoTuneStart,
    ceiling: config.autoTuneMax,
    phase: "slowstart",
    safeWindows: 0,
    badStreak: 0,
  };
  rt.chapterLimit = state.limit;
  let lastSent = rt.state.sent;
  let lastEntered = rt.state.entered;

  const timer = setInterval(() => {
    const dSent = rt.state.sent - lastSent;
    const dEntered = rt.state.entered - lastEntered;

    // Sampel belum cukup: JANGAN reset baseline, akumulasi ke window berikutnya.
    if (dSent < config.autoTuneMinSample) return;
    lastSent = rt.state.sent;
    lastEntered = rt.state.entered;

    // Konversi window, dibatasi 0..100 (vote organik bisa bikin >100%).
    const winConv = Math.min((dEntered / dSent) * 100, 100);
    const prev = state.limit;
    const r = nextAutoLimit(state, winConv, config.autoTuneTarget, config.autoTuneMax, config.autoTuneProbeEvery);
    Object.assign(state, r);
    rt.chapterLimit = r.limit;
    if (r.limit > prev) {
      drainChapterSlots();
    }
    rt.autoTuneInfo = { limit: r.limit, prev, conv: winConv, dSent, dEntered, phase: r.phase, ceiling: r.ceiling };
    if (process.env.AUTO_TUNE_DEBUG) {
      process.stderr.write(`[autotune] win sent=${dSent} entered=${dEntered} conv=${winConv.toFixed(1)}% limit ${prev}->${r.limit} ceiling=${r.ceiling} (${r.phase})\n`);
    }
  }, config.autoTuneWindow);

  return timer;
}

module.exports = { startAutoTune };