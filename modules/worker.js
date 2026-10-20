// modules/worker.js — Anggaran vote, retry, log sukses, dan worker independen per proxy.
const config = require("./cli");
const rt = require("./runtime");
const { sleep, applyReactionDelta } = require("./util");
const { acquireSlot, releaseSlot, acquireChapterSlot, releaseChapterSlot } = require("./semaphore");
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

// Tandai kegagalan beruntun; matikan lane bila melewati ambang.
function markFailure(lane) {
  if (!lane) return;
  lane.consecutiveFails++;
  if (lane.consecutiveFails >= config.DEAD_THRESHOLD) { markLaneDead(lane); lane.lastStatus = "MATI"; }
  else lane.lastStatus = "ERROR";
  lane.lastStatusAt = Date.now();
}

function isDone() {
  if (rt.stopping) return true;
  if (config.COUNT_REAL) return rt.state.entered >= config.maxVotes || rt.state.started >= config.maxRequests;
  return rt.state.sent >= config.maxVotes || rt.state.started >= config.maxVotes * 3;
}

function parseRetryAfter(ra, fallbackMs) {
  let delayMs = fallbackMs;
  if (ra) {
    const trimmed = String(ra).trim();
    if (/^\d+$/.test(trimmed)) {
      delayMs = parseInt(trimmed, 10) * 1000;
    } else {
      const parsed = Date.parse(trimmed);
      if (!isNaN(parsed)) {
        delayMs = Math.max(parsed - Date.now(), 0);
      }
    }
  }
  return Math.min(Math.max(delayMs, 500), config.MAX_BACKOFF);
}

// --- Eksekusi Retry ---
// counterKey = "<chapter>|<tipe>" — tiap (chapter,tipe) di server counter terpisah.
async function attemptWithRetries(lane, chapterPath, counterKey, type) {
  for (let attempt = 0; attempt <= config.maxRetry; attempt++) {
    if (lane && lane.dead) return { success: false };
    if (lane) { lane.lastStatus = "KIRIM"; lane.lastStatusAt = Date.now(); }

    try {
      const res = lane
        ? await sendVoteViaAgent(chapterPath, lane.agent, type)
        : await sendVoteDirect(chapterPath, type);

      if (res.ok) {
        const parsed = parseVoteResponse(res.text, type);
        if (parsed.valid) {
          if (lane) {
            lane.consecutiveFails = 0;
            lane.backoff = 0;
            lane.lastStatus = "OK";
            lane.lastStatusAt = Date.now();
          }
          rt.state.lastValue = parsed.value;
          rt.state.lastType = type;
          // Hitung vote yang benar-benar masuk (delta counter) per (chapter,tipe),
          // bukan sekadar HTTP 200. O(1) akumulasi delta langsung tanpa looping properti.
          const tr = rt.perTarget[counterKey] || (rt.perTarget[counterKey] = { chapter: chapterPath, type, max: null, entered: 0, sent: 0 });
          const delta = applyReactionDelta(tr, parsed.value);
          tr.sent++;
          rt.seenReaction.max = tr.max;
          if (delta > 0) rt.state.entered += delta;
          return { success: true, value: parsed.value, type };
        }
        // HTTP 2xx tapi errno != 0 atau nilai counter tidak ada: vote TIDAK work
        rt.state.invalid++;
        if (lane) {
          lane.consecutiveFails++;
          if (lane.consecutiveFails >= config.DEAD_THRESHOLD) { markLaneDead(lane); lane.lastStatus = "MATI"; }
          else lane.lastStatus = "INVALID";
          lane.lastStatusAt = Date.now();
        }
        return { success: false, invalid: true, errno: parsed.errno, errmsg: parsed.errmsg };
      }

      if (res.status === 429) {
        const ra = res.headerGet("Retry-After");
        if (lane) {
          lane.lastStatus = "429";
          lane.lastStatusAt = Date.now();
          const fallback = (lane.backoff = Math.min((lane.backoff || 500) * 2, config.MAX_BACKOFF));
          const wait = parseRetryAfter(ra, fallback);
          await sleep(wait);
        } else {
          const wait = parseRetryAfter(ra, 1000);
          await sleep(wait);
        }
        continue;
      }

      markFailure(lane);
    } catch (err) {
      markFailure(lane);
    }

    if (attempt < config.maxRetry) {
      await sleep(200 * (attempt + 1));
    }
  }
  return { success: false };
}

// --- Log Sukses Real-Time ---
// Tidak mencetak baris terpisah; cukup rekam info vote sukses terakhir agar
// ditampilkan menyatu di baris statistik oleh startStats().
function logSuccessRealtime(lane, value, type) {
  rt.state.lastSuccessLabel = lane ? `[P${String(lane.id).padStart(2, "0")}]` : "[DIRECT]";
  rt.state.lastValue = value;
  rt.state.lastType = type || "reaction0";
  if (lane) {
    lane.lastValue = value;
    lane.lastType = type || "reaction0";
  }
}

// Bangun kombinasi target dan tipe reaksi sekali saja
function buildCombos(targets, voteTypes) {
  const list = Array.isArray(targets) && targets.length ? targets : [targets];
  const types = voteTypes && voteTypes.length ? voteTypes : ["reaction0"];
  const combos = [];
  for (const ch of list) {
    for (const ty of types) {
      combos.push({ chapterPath: ch, type: ty, key: `${ch}|${ty}` });
    }
  }
  return combos;
}

// --- INDEPENDENT WORKER PER PROXY ---
// targets: array chapter/<uuid>. Multi-target -> rotasi tiap request (round-robin);
// satu ID -> selalu ID itu. Tiap chapter punya counter reaction0 sendiri.
async function independentWorker(lane, targets, sharedCombos) {
  // Kombinasi (chapter × tipe): tiap pasangan = counter server terpisah.
  // Rotasi menyeluruh agar tekanan tulis tersebar ke semua counter secara rata.
  const combos = sharedCombos || buildCombos(targets, config.voteTypes);
  let tIdx = lane ? (lane.id - 1) : 0; // offset antar lane agar tidak seragam

  // Sebar awalan handshake SOCKS5+TLS agar tidak semua proxy nembak bersamaan
  // (hindari thundering herd saat ratusan proxy start di t=0).
  if (config.ramp > 0 && lane && rt.LANES.length > 1) {
    await sleep(Math.round(((lane.id - 1) / rt.LANES.length) * config.ramp));
  }

  // Invarian konfigurasi: hoist ke luar loop
  const gated = config.globalConcurrency > 0;

  while (!rt.stopping) {
    if (isDone()) {
      if (config.COUNT_REAL && rt.state.entered >= config.maxVotes) rt.targetReached = true;
      break;
    }
    if (lane && lane.dead) break;
    if (rt.LANES.length > 0 && rt.deadCount >= rt.LANES.length) break;
    if (!config.COUNT_REAL && rt.deadCount === 0 && lane && lane.sent >= lane.cap) break;

    if (!claimBudget()) break;

    rt.state.started++;
    const combo = combos[tIdx++ % combos.length];
    const chapterPath = combo.chapterPath;
    const type = combo.type;
    const counterKey = combo.key;

    // 1. Tunggu slot per-counter terlebih dahulu (cegah head-of-line blocking).
    const cGated = rt.chapterLimit > 0;
    if (cGated) {
      await acquireChapterSlot(counterKey);
      if (isDone()) {
        releaseChapterSlot(counterKey);
        releaseBudget();
        break;
      }
    }

    // 2. Tunggu slot global agar tidak semua proxy menembak bersamaan.
    // Saat globalConcurrency === 0 (independen penuh) tidak perlu antre: skip promise.
    if (gated) {
      await acquireSlot();
      if (isDone()) {
        releaseSlot();
        if (cGated) releaseChapterSlot(counterKey);
        releaseBudget();
        break;
      }
    }

    // 3. Eksekusi request sampai selesai (durasi request bisa bervariasi)
    let r;
    try {
      r = await attemptWithRetries(lane, chapterPath, counterKey, type);
    } finally {
      if (gated) releaseSlot();
      if (cGated) releaseChapterSlot(counterKey);
    }

    if (r.success) {
      rt.state.sent++;
      if (lane) lane.sent++;
      logSuccessRealtime(lane, r.value, r.type);
      saveCheckpointAsync();
    } else {
      releaseBudget();
      rt.state.failed++;
      if (lane) lane.failed++;
    }

    // 4. Jeda mandiri khusus proxy ini saja; jitter membuat ritme tiap proxy unik seperti user asli
    const laneDelay = config.delay + (config.jitter > 0 ? Math.floor(Math.random() * (config.jitter + 1)) : 0);
    if (laneDelay > 0) {
      await sleep(laneDelay);
    }
  }
}

module.exports = { claimBudget, releaseBudget, attemptWithRetries, logSuccessRealtime, independentWorker, buildCombos, isDone, parseRetryAfter };
