// modules/worker.js — Anggaran vote, retry, log sukses, dan worker independen per proxy.
const config = require("./config");
const rt = require("./runtime");
const { sleep } = require("./util");
const { acquireSlot, releaseSlot } = require("./semaphore");
const { sendVoteViaAgent, sendVoteDirect, parseVoteResponse } = require("./vote");
const { saveCheckpointAsync } = require("./checkpoint");

// --- Anggaran Vote Global (anti-overshoot): klaim sebelum kirim, kembalikan jika gagal ---
function claimBudget() {
  if (rt.budget <= 0) return false;
  rt.budget--;
  return true;
}
function releaseBudget() {
  rt.budget++;
}

// Tandai lane mati sekali saja & jaga counter global, agar worker lain cukup
// cek rt.deadCount (O(1)) alih-alih memindai semua lane tiap iterasi (O(N)).
function markLaneDead(lane) {
  if (lane && !lane.dead) { lane.dead = true; rt.deadCount++; }
}

// --- Eksekusi Retry ---
async function attemptWithRetries(lane, chapterPath) {
  for (let attempt = 0; attempt <= config.maxRetry; attempt++) {
    if (lane && lane.dead) return { success: false };
    if (lane) { lane.lastStatus = "KIRIM"; lane.lastStatusAt = Date.now(); }

    try {
      const res = lane ? await sendVoteViaAgent(chapterPath, lane.agent) : await sendVoteDirect(chapterPath);

      if (res.ok) {
        const parsed = parseVoteResponse(res.text);
        if (parsed.valid) {
          if (lane) { lane.consecutiveFails = 0; lane.lastStatus = "OK"; lane.lastStatusAt = Date.now(); }
          rt.state.lastReaction0 = parsed.reaction0;
          return { success: true, reaction0: parsed.reaction0 };
        }
        // HTTP 2xx tapi errno != 0 atau reaction0 tidak ada: vote TIDAK work
        rt.state.invalid++;
        if (lane) {
          lane.consecutiveFails++;
          if (lane.consecutiveFails >= config.DEAD_THRESHOLD) { markLaneDead(lane); lane.lastStatus = "MATI"; }
          if (!lane.dead) lane.lastStatus = "INVALID";
          lane.lastStatusAt = Date.now();
        }
        return { success: false, invalid: true, errno: parsed.errno, errmsg: parsed.errmsg };
      }

      if (res.status === 429) {
        if (lane) { lane.lastStatus = "429"; lane.lastStatusAt = Date.now(); }
        if (lane) {
          const ra = res.headerGet("Retry-After");
          const wait = ra && !isNaN(parseInt(ra, 10)) ? parseInt(ra, 10) * 1000 : (lane.backoff = Math.min((lane.backoff || 500) * 2, config.MAX_BACKOFF));
          await sleep(wait);
        } else {
          await sleep(1000);
        }
        continue;
      }

      if (lane) {
        lane.consecutiveFails++;
        if (lane.consecutiveFails >= config.DEAD_THRESHOLD) { markLaneDead(lane); lane.lastStatus = "MATI"; }
        if (!lane.dead) lane.lastStatus = "ERROR";
        lane.lastStatusAt = Date.now();
      }
    } catch (err) {
      if (lane) {
        lane.consecutiveFails++;
        if (lane.consecutiveFails >= config.DEAD_THRESHOLD) { markLaneDead(lane); lane.lastStatus = "MATI"; }
        if (!lane.dead) lane.lastStatus = "ERROR";
        lane.lastStatusAt = Date.now();
      }
    }
  }
  return { success: false };
}

// --- Log Sukses Real-Time ---
// Tidak mencetak baris terpisah; cukup rekam info vote sukses terakhir agar
// ditampilkan menyatu di baris statistik oleh startStats().
function logSuccessRealtime(lane, reaction0) {
  rt.state.lastSuccessLabel = lane ? `[P${String(lane.id).padStart(2, "0")}]` : "[DIRECT]";
  rt.state.lastReaction0 = reaction0;
  if (lane) lane.lastReaction0 = reaction0;
}

// --- INDEPENDENT WORKER PER PROXY ---
async function independentWorker(lane, chapterPath, lanes) {
  // Sebar awalan handshake SOCKS5+TLS agar tidak semua proxy nembak bersamaan
  // (hindari thundering herd saat ratusan proxy start di t=0).
  if (config.ramp > 0 && lane && rt.LANES.length > 1) {
    await sleep(Math.round(((lane.id - 1) / rt.LANES.length) * config.ramp));
  }

  while (!rt.stopping) {
    if (lane && lane.dead) break;
    if (lane && lane.sent >= lane.cap) break;
    if (rt.LANES.length > 0 && rt.deadCount >= rt.LANES.length) break;
    if (rt.state.started >= config.maxVotes * 3) break;

    if (!claimBudget()) break;

    rt.state.started++;

    // 1. Tunggu slot global agar tidak semua proxy menembak bersamaan (hemat resource)
    await acquireSlot();
    if (rt.stopping) {
      releaseSlot();
      releaseBudget();
      break;
    }

    // 2. Eksekusi request sampai selesai (durasi request bisa bervariasi)
    let r;
    try {
      r = await attemptWithRetries(lane, chapterPath);
    } finally {
      releaseSlot();
    }

    if (r.success) {
      rt.state.sent++;
      if (lane) lane.sent++;
      logSuccessRealtime(lane, r.reaction0);
      saveCheckpointAsync();
    } else {
      releaseBudget();
      rt.state.failed++;
      if (lane) lane.failed++;
    }

    // 3. Jeda mandiri khusus proxy ini saja; jitter membuat ritme tiap proxy unik seperti user asli
    const laneDelay = config.delay + (config.jitter > 0 ? Math.floor(Math.random() * (config.jitter + 1)) : 0);
    if (laneDelay > 0) {
      await sleep(laneDelay);
    }
  }
}

module.exports = { claimBudget, releaseBudget, attemptWithRetries, logSuccessRealtime, independentWorker };
