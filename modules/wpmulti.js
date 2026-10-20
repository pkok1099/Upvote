// modules/wpmulti.js — Integrasi wpmulti (N sesi WireGuard, 1 listener SOCKS5).
// Deteksi jumlah sesi aktif dari endpoint debug wpmulti (/debug/sessions).
const net = require("net");

// Hitung sesi dari JSON /debug/sessions: array objek -> panjang array.
function countSessions(jsonText) {
  try {
    const arr = JSON.parse(jsonText);
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

// Ambil jumlah sesi dari http://<debugAddr>/debug/sessions. Return 0 bila gagal.
async function detectSessions(debugAddr) {
  const addr = debugAddr || "127.0.0.1:2081";
  const url = `http://${addr}/debug/sessions`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return 0;
    return countSessions(await res.text());
  } catch {
    return 0;
  } finally {
    clearTimeout(t);
  }
}

// Tunggu port TCP terbuka (endpoint siap menerima koneksi).
function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000);
  return new Promise((resolve, reject) => {
    const attempt = () => {
      let settled = false;
      const sock = net.connect({ host, port });
      sock.setTimeout(1000, () => sock.destroy());
      sock.once("connect", () => {
        settled = true;
        sock.destroy();
        resolve();
      });
      const onFail = () => {
        if (settled) return;
        settled = true;
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`Timeout menunggu ${host}:${port}`));
        else setTimeout(attempt, 300);
      };
      sock.once("error", onFail);
      sock.once("close", onFail);
    };
    attempt();
  });
}

module.exports = { countSessions, detectSessions, waitForPort };