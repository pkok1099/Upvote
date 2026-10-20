// modules/util.js — Helper kecil: delay, normalisasi proxy, ekstrak ID chapter.
const { URL } = require("url");

function normalizeProxy(p) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p) ? p : "socks5://" + p;
}

function extractChapterId(input) {
  const trimmed = (input || "").trim();
  if (!trimmed) return null;
  const uuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  try {
    const u = new URL(trimmed);
    const segs = u.pathname.split("/");
    const i = segs.indexOf("chapter");
    if (i > -1 && segs.length > i + 1 && uuid.test(segs[i + 1])) return "chapter/" + segs[i + 1];
    return null;
  } catch {}
  let raw = trimmed;
  if (raw.startsWith("chapter/")) raw = raw.slice("chapter/".length);
  return uuid.test(raw) ? `chapter/${raw}` : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Konversi literal IPv6 -> 16 byte (stdlib tak menyediakan). Handle :: dan zona %if.
function ipv6ToBytes(host) {
  let h = String(host).trim().replace(/^\[|\]$/g, "").split("%")[0]; // buang zone id (%eth0)
  if (h.includes(".")) {
    // IPv4-mapped tail (mis. ::ffff:1.2.3.4)
    const lastColon = h.lastIndexOf(":");
    const v4 = h.slice(lastColon + 1).split(".").map(Number);
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    h = h.slice(0, lastColon + 1) + hi + ":" + lo;
  }
  const halves = h.split("::");
  if (halves.length > 2) throw new Error("IPv6 tidak valid: " + host);
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length > 1 ? (halves[1] ? halves[1].split(":") : []) : null;
  const groups = tail === null ? head : head.concat(Array(8 - head.length - tail.length).fill("0"), tail);
  if (groups.length !== 8) throw new Error("IPv6 tidak valid: " + host);
  const hexPattern = /^[0-9a-fA-F]{1,4}$/;
  for (const g of groups) {
    if (!hexPattern.test(g)) throw new Error("IPv6 tidak valid: " + host);
  }
  const buf = Buffer.alloc(16);
  groups.forEach((g, i) => buf.writeUInt16BE(parseInt(g, 16), i * 2));
  return buf;
}

// Bungkus host IPv6 untuk path/host:port (RFC 3986).
function formatHostPort(host, port) {
  const clean = String(host).replace(/^\[|\]$/g, "");
  return clean.includes(":") ? `[${clean}]:${port}` : `${clean}:${port}`;
}

// Hitung delta vote "masuk" dari nilai counter (reaction0/1/2) yang diobservasi.
// Counter server monoton naik (include trafik organik). Kita lacak nilai tertinggi
// dan jumlahkan pertambahan positif. Observasi pertama = baseline (delta 0, tak
// dihitung). Return delta yg ditambahkan (0 bila tak naik).
function applyReactionDelta(seen, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (seen.max === null || seen.max === undefined) { seen.max = value; return 0; }
  if (value <= seen.max) return 0;
  const delta = value - seen.max;
  seen.max = value;
  seen.entered = (seen.entered || 0) + delta;
  return delta;
}

// Auto-tune (controller) — jaga konversi di atas target dengan mempelajari "ceiling"
// (batas aman tertinggi). State mutable + konversi yang sudah dihaluskan (EMA) agar
// satu window bising tak langsung memicu backoff.
//
// state = { limit, ceiling, phase, safeWindows, badStreak }
//  - start: limit=start, ceiling=maxLimit, phase="slowstart"
//  - conv < target (2 window berturut) -> backoff: limit=floor(limit/2) (min 1),
//      ceiling=limit, phase="avoid"
//  - conv >= target -> aman: safeWindows++
//      - limit < ceiling -> +1 (pulih menuju ceiling)
//      - di ceiling & safeWindows >= probeEvery -> naikkan ceiling +1 (probe pelan)
//      - else tahan (cegah osilasi)
function nextAutoLimit(state, convPct, targetPct, maxLimit, probeEvery) {
  const badStreak = convPct < targetPct ? (state.badStreak || 0) + 1 : 0;
  if (badStreak >= 2) {
    const nl = Math.max(1, Math.floor(state.limit / 2));
    return { limit: nl, ceiling: nl, phase: "avoid", safeWindows: 0, badStreak: 0 };
  }
  if (convPct < targetPct) {
    return { limit: state.limit, ceiling: state.ceiling, phase: state.phase, safeWindows: 0, badStreak };
  }
  const safeWindows = (state.safeWindows || 0) + 1;
  if (state.phase === "slowstart" && state.limit < state.ceiling) {
    return { limit: Math.min(state.limit * 2, state.ceiling), ceiling: state.ceiling, phase: "slowstart", safeWindows, badStreak: 0 };
  }
  if (state.limit < state.ceiling) {
    return { limit: state.limit + 1, ceiling: state.ceiling, phase: "avoid", safeWindows, badStreak: 0 };
  }
  if (safeWindows >= probeEvery && state.ceiling < maxLimit) {
    return { limit: state.ceiling + 1, ceiling: state.ceiling + 1, phase: "avoid", safeWindows: 0, badStreak: 0 };
  }
  return { limit: state.limit, ceiling: state.ceiling, phase: "avoid", safeWindows, badStreak: 0 };
}

module.exports = { sleep, normalizeProxy, extractChapterId, ipv6ToBytes, formatHostPort, applyReactionDelta, nextAutoLimit };
