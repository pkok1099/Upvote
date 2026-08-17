// modules/semaphore.js — Semaphore global: batasi total request serentak lintas semua proxy.
const config = require("./config");
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
    next();
  } else {
    rt.activeSlots--;
  }
}

module.exports = { acquireSlot, releaseSlot };
