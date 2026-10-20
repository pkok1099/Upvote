// modules/proxy-loader.js — Muat daftar proxy dari folder config atau argumen --proxy.
// Mengisi rt.PROXIES. Bila --proxy-replicas auto, jumlah sesi diambil dari
// endpoint debug wpmulti (/debug/sessions) via async init().
const fs = require("fs");
const path = require("path");
const config = require("./cli");
const rt = require("./runtime");
const { normalizeProxy } = require("./util");

function loadProxiesFromDir(dir) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) return [];
  const list = [];
  let entries = [];
  try {
    entries = fs.readdirSync(abs);
  } catch {
    return [];
  }
  for (const f of entries) {
    if (!f.endsWith(".conf")) continue;
    const fullPath = path.join(abs, f);
    try {
      if (!fs.statSync(fullPath).isFile()) continue;
      const txt = fs.readFileSync(fullPath, "utf8");
      const m = txt.match(/BindAddress\s*=\s*.*?[:\s](\d+)\s*$/im);
      if (m) list.push(`socks5://127.0.0.1:${m[1]}`);
    } catch {
      continue;
    }
  }
  return list;
}

// Gandakan tiap proxy N kali. Satu lane = satu koneksi keep-alive sendiri, jadi
// endpoint round-robin (1 proxy -> banyak IP backend) bisa dipakai banyak lane
// paralel sekaligus -> backend menyebar ke banyak IP.
function replicate(list, n) {
  if (n <= 1 || list.length === 0) return list;
  const out = [];
  for (let i = 0; i < n; i++) for (const p of list) out.push(p);
  return out;
}

function loadBase() {
  if (config.opts.proxyDir || config.CONFIG.proxyDir) {
    return loadProxiesFromDir(config.opts.proxyDir || config.CONFIG.proxyDir);
  }
  return (config.opts.proxy ?? config.CONFIG.proxy)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map(normalizeProxy);
}

// Isi rt.PROXIES. Async krn --proxy-replicas auto perlu probe wpmulti.
async function init() {
  const base = loadBase();
  let replicas = config.proxyReplicas;
  if (config.proxyReplicasAuto) {
    const { detectSessions } = require("./wpmulti");
    const n = await detectSessions(config.wpmultiDebug);
    replicas = n > 0 ? n : 1;
    console.error(`[wpmulti] auto-detect ${n} sesi (debug ${config.wpmultiDebug}) -> ${replicas} lane/proxy`);
  }
  rt.PROXIES = replicate(base, replicas);
  return rt.PROXIES;
}

module.exports = { loadProxiesFromDir, replicate, init };
