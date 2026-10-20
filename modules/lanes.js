// modules/lanes.js — Bangun array lane (satu worker-loop per proxy).
const config = require("./cli");
const rt = require("./runtime");
const { ProxyAgent } = require("./tunnel");

function buildLanes() {
  rt.deadCount = 0;
  const laneCap = Math.max(Math.ceil(config.maxVotes / Math.max(rt.PROXIES.length, 1)), 1);
  rt.LANES = rt.PROXIES.map((proxy, i) => ({
    id: i + 1,
    proxy,
    agent: new ProxyAgent(proxy, { maxSockets: config.concurrency, maxFreeSockets: config.concurrency, keepAlive: config.keepAlive }),
    sent: 0,
    failed: 0,
    consecutiveFails: 0,
    backoff: 0,
    dead: false,
    cap: laneCap,
    lastValue: null,
    lastType: "reaction0",
    lastStatus: "IDLE",
    lastStatusAt: 0,
  }));
}

module.exports = { buildLanes };
