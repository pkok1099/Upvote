// modules/lanes.js — Bangun array lane (satu worker-loop per proxy).
const config = require("./config");
const rt = require("./runtime");
const { ProxyAgent } = require("./tunnel");

function buildLanes() {
  const laneCap = Math.max(Math.ceil(config.maxVotes / Math.max(rt.PROXIES.length, 1)), 1);
  rt.LANES = rt.PROXIES.map((proxy, i) => ({
    id: i + 1,
    proxy,
    agent: new ProxyAgent(proxy, { maxSockets: config.concurrency, maxFreeSockets: config.concurrency }),
    sent: 0,
    failed: 0,
    consecutiveFails: 0,
    backoff: 0,
    dead: false,
    cap: laneCap,
    lastReaction0: null,
    lastStatus: "IDLE",
    lastStatusAt: 0,
  }));
}

module.exports = { buildLanes };
