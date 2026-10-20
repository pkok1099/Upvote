#!/usr/bin/env node
// rl-test-direct.js — Tes rate limit, MANDIRI (tanpa proxy, tanpa modul lokal).
// Kirim N vote berurutan lewat SATU koneksi keep-alive ke endpoint langsung.
// Cetak progres tiap 100, stop di respons non-200 / errno!=0.
//
// Pakai:
//   node rl-test-direct.js [--url <apiUrl>] [--id <uuid>] [--n 1000]
// Default: url dari config.js bila ada, id default contoh.

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--url") args.url = process.argv[++i];
  else if (a === "--id") args.id = process.argv[++i];
  else if (a === "--n") args.n = parseInt(process.argv[++i], 10);
  else if (a === "--respect-retry") args.respectRetry = true;
  else if (a === "--max-wait") args.maxWait = parseInt(process.argv[++i], 10);
}

// Default dari config.js root (bila ada), tanpa require (script tetap mandiri).
let cfgUrl = "https://commento.shngm.io/api/article?lang=en";
try {
  const c = require(path.resolve(__dirname, "config.js"));
  if (c && c.apiUrl) cfgUrl = c.apiUrl;
} catch {}

const apiUrl = args.url || cfgUrl;
const id = args.id || "c8aa4306-4d92-41f8-b800-d29b192ac34d";
const n = args.n || 1000;

const u = new URL(apiUrl);
const isHttps = u.protocol === "https:";
const lib = isHttps ? https : http;
const port = u.port || (isHttps ? 443 : 80);
const reqPath = u.pathname + u.search;
const chapterPath = "chapter/" + String(id).replace(/^chapter\//, "");
const body = JSON.stringify({ path: chapterPath, type: "reaction0" });

// keepAlive + maxSockets:1 => satu koneksi dipakai ulang = satu IP sumber.
const agent = new lib.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1, timeout: 25000 });

function one() {
  return new Promise((res) => {
    const r = lib.request({
      host: u.hostname, port, method: "POST", path: reqPath, agent,
      headers: { accept: "application/json", "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (x) => { let d = ""; x.on("data", (c) => (d += c)); x.on("end", () => res({ s: x.statusCode, h: x.headers, d })); });
    r.on("error", (e) => res({ s: "ERR", h: {}, d: e.message }));
    r.setTimeout(25000, () => r.destroy(new Error("timeout")));
    r.write(body); r.end();
  });
}

(async () => {
  const respectRetry = args.respectRetry === true;
  const maxWait = args.maxWait || 60000;
  console.log(`Target : ${apiUrl}`);
  console.log(`Mode   : DIRECT (tanpa proxy), keep-alive 1 koneksi`);
  console.log(`Jumlah : ${n} vote berurutan${respectRetry ? " (hormati Retry-After)" : ""}\n`);
  let ok = 0;
  let retries = 0;
  let firstFailureAt = null;
  let firstRetryAfter = null;
  let windows = 0;
  let sawRateLimit = false;
  const t0 = Date.now();
  for (let i = 1; i <= n; ) {
    const r = await one();
    let errno = null, retcode = null;
    try { const j = JSON.parse(r.d); errno = j.errno; retcode = j.retcode; } catch {}

    if (r.s !== 200 || errno !== 0) {
      if (firstFailureAt === null) firstFailureAt = i;
      const isRate = r.s === 429 || retcode === 40029;
      const ra = parseInt(r.h["retry-after"], 10);
      const wait = !isNaN(ra) ? ra * 1000 : 1000;

      if (isRate && respectRetry) {
        if (wait > maxWait) {
          console.log(`\nSTOP: Retry-After ${wait / 1000}s > --max-wait ${maxWait / 1000}s`);
          break;
        }
        retries++;
        windows++;
        sawRateLimit = true;
        if (firstRetryAfter === null) firstRetryAfter = wait / 1000;
        console.log(`  #${i} kena ${r.s} (retcode=${retcode}), tunggu ${wait / 1000}s lalu lanjut...`);
        await new Promise((res) => setTimeout(res, wait));
        continue; // coba req yang sama lagi
      }

      console.log(`\nSTOP di req #${i}: HTTP ${r.s} errno=${errno} retcode=${retcode} retry-after=${r.h["retry-after"] || "-"}`);
      console.log(`   body: ${String(r.d).slice(0, 160)}`);
      if (isRate) console.log(`   -> RATE LIMIT terdeteksi setelah ${ok} sukses beruntun (pakai --respect-retry utk lanjut).`);
      else console.log(`   -> Bukan rate limit (blokir/WAF/geo?).`);
      break;
    }

    ok++;
    i++;
    if (i % 100 === 0) console.log(`  ${i} OK @${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  const dt = (Date.now() - t0) / 1000;
  console.log(`\nHASIL: ${ok}/${n} sukses dalam ${dt.toFixed(0)}s (${(ok / dt).toFixed(1)} req/s efektif)`);
  if (firstFailureAt !== null) {
    if (sawRateLimit) {
      console.log(`  Rate limit terdeteksi di req #${firstFailureAt} (setelah ${firstFailureAt - 1} sukses beruntun).`);
      if (firstRetryAfter && firstFailureAt > 1) console.log(`  Retry-After: ${firstRetryAfter}s -> limit ~${firstFailureAt - 1} req / ${firstRetryAfter}s (~${((firstFailureAt - 1) / firstRetryAfter).toFixed(1)} req/s per IP).`);
      console.log(`  Total kena 429: ${retries} kali, window tunggu: ${windows}.`);
    } else {
      console.log(`  Gagal bukan karena 429 (lihat STOP di atas) — kemungkinan blokir/WAF, bukan rate limit.`);
    }
  } else {
    console.log("  TIDAK ADA rate limit pada rentang ini.");
  }
  agent.destroy();
})();