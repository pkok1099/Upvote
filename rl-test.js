// rl-test.js — Tes sederhana: apakah ada rate limit? Kirim N vote berurutan
// lewat SATU koneksi keep-alive (1 flow = 1 egress IP di wpmulti). Cetak
// progres tiap 100, stop di respons non-200/errno!=0. Tanpa framework.
//
// Pakai:
//   node rl-test.js [--proxy socks5://127.0.0.1:1080] [--url <apiUrl>] [--id <uuid>] [--n 1000]
// Default: proxy socks5://127.0.0.1:1080, url+id dari config.js.
const rawArgv = process.argv.slice();
process.argv = ["node", "rl-test.js"]; // cegah config.js parse argumen script ini
const config = require("./modules/cli");
const { ProxyAgent } = require("./modules/tunnel");
const http = require("http");
const https = require("https");

const args = {};
for (let i = 2; i < rawArgv.length; i++) {
  if (rawArgv[i] === "--proxy") args.proxy = rawArgv[++i];
  else if (rawArgv[i] === "--url") args.url = rawArgv[++i];
  else if (rawArgv[i] === "--id") args.id = rawArgv[++i];
  else if (rawArgv[i] === "--n") args.n = parseInt(rawArgv[++i], 10);
}
args.proxy = args.proxy || "socks5://127.0.0.1:1080";
args.url = args.url || config.apiUrl;
args.id = args.id || config.target;
args.n = args.n || 1000;

const u = new URL(args.url);
const isHttps = u.protocol === "https:";
const lib = isHttps ? https : http;
const port = u.port || (isHttps ? 443 : 80);
const path = u.pathname + u.search;
const body = JSON.stringify({ path: `chapter/${String(args.id).replace(/^chapter\//, "")}`, type: "reaction0" });

// keepAlive + maxSockets 1 => satu koneksi dipakai ulang = satu IP
const agent = new ProxyAgent(args.proxy, { keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });

function one() {
  return new Promise((res) => {
    const r = lib.request({
      host: u.hostname, port, method: "POST", path, agent,
      headers: { accept: "application/json", "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (x) => { let d = ""; x.on("data", (c) => (d += c)); x.on("end", () => res({ s: x.statusCode, h: x.headers, d })); });
    r.on("error", (e) => res({ s: "ERR", h: {}, d: e.message }));
    r.setTimeout(25000, () => r.destroy(new Error("timeout")));
    r.write(body); r.end();
  });
}

(async () => {
  console.log(`Target : ${args.url}`);
  console.log(`Proxy  : ${args.proxy} (keep-alive, 1 koneksi = 1 IP)`);
  console.log(`Jumlah : ${args.n} vote berurutan\n`);
  let ok = 0;
  const t0 = Date.now();
  for (let i = 1; i <= args.n; i++) {
    const r = await one();
    let errno = null;
    try { errno = JSON.parse(r.d).errno; } catch {}
    if (r.s !== 200) {
      console.log(`\n⛔ STOP di req #${i}: HTTP ${r.s} errno=${errno} retry-after=${r.h["retry-after"] || "-"}`);
      console.log(`   body: ${String(r.d).slice(0, 160)}`);
      break;
    }
    if (errno !== 0) {
      console.log(`\n⛔ STOP di req #${i}: HTTP 200 tapi errno=${errno} (vote ditolak server)`);
      console.log(`   body: ${String(r.d).slice(0, 160)}`);
      break;
    }
    ok++;
    if (i % 100 === 0) console.log(`  ${i} OK @${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  const dt = (Date.now() - t0) / 1000;
  console.log(`\n✅ HASIL: ${ok}/${args.n} sukses dari 1 IP dalam ${dt.toFixed(0)}s (${(ok / dt).toFixed(1)} req/s)`);
  console.log(ok === args.n ? "→ TIDAK ADA rate limit pada rentang ini." : "→ Ada penolakan, lihat STOP di atas.");
  agent.destroy();
})();