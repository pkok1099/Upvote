// modules/proxy-loader.js — Muat daftar proxy dari folder config atau argumen --proxy.
// Saat di-require, langsung mengisi rt.PROXIES.
const fs = require("fs");
const path = require("path");
const config = require("./config");
const rt = require("./runtime");
const { normalizeProxy } = require("./util");

function loadProxiesFromDir(dir) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) return [];
  const list = [];
  for (const f of fs.readdirSync(abs)) {
    if (!f.endsWith(".conf")) continue;
    const txt = fs.readFileSync(path.join(abs, f), "utf8");
    const m = txt.match(/BindAddress\s*=\s*[\d.]+:(\d+)/i);
    if (m) list.push(`socks5://127.0.0.1:${m[1]}`);
  }
  return list;
}

if (config.opts.proxyDir) {
  rt.PROXIES = loadProxiesFromDir(config.opts.proxyDir);
} else {
  rt.PROXIES = (config.opts.proxy ?? config.CONFIG.proxy)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map(normalizeProxy);
}

module.exports = { loadProxiesFromDir };
