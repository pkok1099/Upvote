// modules/semaphore.js — Semaphore global: batasi total request serentak lintas semua proxy.
const config = require("./cli");
const rt = require("./runtime");

function acquireSlot() {
  return new Promise((resolve) => {
    if (config.globalConcurrency === 0 || rt.activeSlots < config.globalConcurrency) {
      rt.activeSlots++;
      resolve();
    } else {
      rt.slotQueue.push(resolve);
    }
  });
}

function releaseSlot() {
  if (rt.slotQueue.length > 0) {
    const next = rt.slotQueue.shift();
    if (typeof next === "function") next();
  } else {
    rt.activeSlots = Math.max(0, rt.activeSlots - 1);
  }
}

// --- Semaphore per-counter (chapter|tipe) ---
// Batasi request serentak ke satu counter (chapter,tipe). Cegah lost-update.
// Batas diambil dari rt.chapterLimit (mutable) agar auto-tune bisa menggeser saat runtime.
// Penting: `active` = jumlah pemegang slot saat ini. Saat limit DITURUNKAN, active
// harus bisa turun mengikuti limit baru (release selalu active-- lalu isi ulang queue
// hanya selama active < limit) — kalau tidak, gate bocor.
function acquireChapterSlot(chapterPath) {
  return new Promise((resolve) => {
    if (rt.chapterLimit <= 0) return resolve();
    const s = rt.chapterSlots[chapterPath] || (rt.chapterSlots[chapterPath] = { active: 0, queue: [] });
    if (s.active < rt.chapterLimit) {
      s.active++;
      resolve();
    } else {
      s.queue.push(resolve);
    }
  });
}

function releaseChapterSlot(chapterPath) {
  const s = rt.chapterSlots[chapterPath];
  if (!s) return;
  s.active = Math.max(0, s.active - 1);
  if (rt.chapterLimit <= 0) {
    s.active = 0;
    while (s.queue.length > 0) {
      const next = s.queue.shift();
      if (typeof next === "function") next();
    }
    return;
  }
  while (s.queue.length > 0 && s.active < rt.chapterLimit) {
    s.active++;
    const next = s.queue.shift();
    if (typeof next === "function") next();
  }
}

function drainChapterSlots() {
  for (const key in rt.chapterSlots) {
    const s = rt.chapterSlots[key];
    if (!s) continue;
    if (rt.chapterLimit <= 0) {
      s.active = 0;
      while (s.queue.length > 0) {
        const next = s.queue.shift();
        if (typeof next === "function") next();
      }
    } else {
      while (s.queue.length > 0 && s.active < rt.chapterLimit) {
        s.active++;
        const next = s.queue.shift();
        if (typeof next === "function") next();
      }
    }
  }
}

module.exports = { acquireSlot, releaseSlot, acquireChapterSlot, releaseChapterSlot, drainChapterSlots };
