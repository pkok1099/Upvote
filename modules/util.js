// modules/util.js — Helper kecil: delay, normalisasi proxy, ekstrak ID chapter.
const { URL } = require("url");

function normalizeProxy(p) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p) ? p : "socks5://" + p;
}

function extractChapterId(input) {
  const trimmed = (input || "").trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    const segs = u.pathname.split("/");
    const i = segs.indexOf("chapter");
    if (i > -1 && segs.length > i + 1) return `chapter/${segs[i + 1]}`;
  } catch {}
  let raw = trimmed;
  if (raw.startsWith("chapter/")) raw = raw.slice("chapter/".length);
  const uuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  return uuid.test(raw) ? `chapter/${raw}` : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { sleep, normalizeProxy, extractChapterId };
