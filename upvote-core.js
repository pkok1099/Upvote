#!/usr/bin/env node
/**
 * upvote-core.js — Inti pengirim vote (Node.js, tanpa UI). Versi HEAVY DUTY.
 *
 * Fitur:
 *   - Ekstraksi ID dari UUID polos, "chapter/<uuid>", atau URL lengkap
 *   - Penanganan 429 (Retry-After, lalu backoff eksponensial, cap 60s)
 *   - Pesan error jelas (HTTP, JSON, jaringan)
 *   - Proxy: HTTP CONNECT / SOCKS5 (tanpa auth), multi-proxy, mode paralel
 *   - [HD] Keep-alive connection pool per proxy (reuse tunnel + TLS) -> 3-5x lebih cepat
 *   - [HD] --concurrency N : N request bersamaan per proxy
 *   - [HD] Timeout request (--timeout, default 15s) agar worker tidak hang
 *   - [HD] Max retry + dead-proxy detection (proxy gagal beruntun ditandai mati)
 *   - [HD] Statistik real-time (vote/detik, ETA, sukses/gagal per proxy)
 *   - [HD] Checkpoint + --resume (lanjut dari progress terakhir)
 *   - [HD] --proxy-dir <dir> : muat semua proxy dari folder config wireproxy
 *
 * Cara pakai:
 *   node upvote-core.js --id <uuid> --max 30 --parallel --proxy-dir wgcf-30
 *   node upvote-core.js --id <uuid> --max 1000 --parallel --concurrency 3 --proxy-dir accounts
 *   node upvote-core.js --id <uuid> --max 1000 --resume      # lanjut dari checkpoint
 */

const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const dns = require("dns");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const CONFIG = {
  target: "a6d1020e-e71e-43ed-91a5-39c9c88de017",
  maxVotes: 5,
  delay: 100,
  apiUrl: "https://commento.shngm.io/api/article?lang=en",
  proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "",
};

const MAX_BACKOFF = 60000;   // cap backoff 429 (60 detik)
const DEAD_THRESHOLD = 5;    // proxy mati setelah N kegagalan beruntun
const DEFAULT_TIMEOUT = 15000;
const DEFAULT_RETRY = 3;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_STATS_MS = 2000;
const DEFAULT_CHECKPOINT = ".upvote-checkpoint.json";

// --- Parsing argumen ---
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--id" || a === "--url") out.target = argv[++i];
    else if (a === "--max") out.maxVotes = parseInt(argv[++i], 10);
    else if (a === "--delay") out.delay = parseInt(argv[++i], 10);
    else if (a === "--proxy") out.proxy = argv[++i];
    else if (a === "--proxy-dir") out.proxyDir = argv[++i];
    else if (a === "--concurrency") out.concurrency = parseInt(argv[++i], 10);
    else if (a === "--timeout") out.timeout = parseInt(argv[++i], 10);
    else if (a === "--max-retry") out.maxRetry = parseInt(argv[++i], 10);
    else if (a === "--stats-interval") out.statsInterval = parseInt(argv[++i], 10);
    else if (a === "--checkpoint") out.checkpoint = argv[++i];
    else if (a === "--resume") out.resume = true;
    else if (a === "--parallel") out.parallel = true;
    else if (a === "--ipv6") out.ipv6 = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else { out.unknown = a; }
  }
  return out;
}

const HELP = `
upvote-core.js — Inti pengirim vote (Node.js, HEAVY DUTY)

Penggunaan:
  node upvote-core.js [opsi]

Opsi dasar:
  --id, --url <val>   ID target: UUID polos, "chapter/<uuid>", atau URL lengkap
  --max <n>           Jumlah vote sukses yang ingin dicapai (default: 5)
  --delay <ms>        Penundaan antar percobaan per worker, min 100 ms (default: 100)

Proxy:
  --proxy <list>      Proxy dipisah koma (socks5://, http://, atau host:port polos=SOCKS5)
  --proxy-dir <dir>   Muat semua proxy dari folder config wireproxy (baca port BindAddress)
  --parallel          1 kelompok worker per proxy (dipakai bersama --concurrency)
  --concurrency <n>   Jumlah request bersamaan per proxy (default: ${DEFAULT_CONCURRENCY})

Keandalan (heavy duty):
  --timeout <ms>      Timeout tiap request (default: ${DEFAULT_TIMEOUT})
  --max-retry <n>     Retry maks per vote saat error transient (default: ${DEFAULT_RETRY})
  --checkpoint <file> File checkpoint (default: ${DEFAULT_CHECKPOINT})
  --resume            Lanjutkan dari checkpoint terakhir
  --stats-interval <ms> Interval cetak statistik (default: ${DEFAULT_STATS_MS})
  --ipv6              Paksa jalur langsung hanya IPv6 (egress proxy ikut terowongan)
  -h, --help          Tampilkan bantuan ini

Contoh heavy duty:
  node upvote-core.js --id <uuid> --max 1000 --parallel --concurrency 3 --proxy-dir accounts
  node upvote-core.js --id <uuid> --max 1000 --resume
`;

const opts = parseArgs(process.argv);
if (opts.help) { console.log(HELP); process.exit(0); }
if (opts.unknown) {
  console.error(`❌ Argumen tidak dikenal: ${opts.unknown}\nJalankan dengan -h atau --help untuk bantuan.`);
  process.exit(1);
}

const target = opts.target ?? CONFIG.target;
const maxVotes = opts.maxVotes ?? CONFIG.maxVotes;
const delay = Math.max(opts.delay ?? CONFIG.delay, 100);
const apiUrl = CONFIG.apiUrl;
const concurrency = Math.max(opts.concurrency ?? DEFAULT_CONCURRENCY, 1);
const timeoutMs = Math.max(opts.timeout ?? DEFAULT_TIMEOUT, 1000);
const maxRetry = Math.max(opts.maxRetry ?? DEFAULT_RETRY, 0);
const statsInterval = Math.max(opts.statsInterval ?? DEFAULT_STATS_MS, 500);
const checkpointFile = opts.checkpoint ?? DEFAULT_CHECKPOINT;
const PARALLEL = opts.parallel === true;
const IPV6 = opts.ipv6 === true;

const apiUrlObj = new URL(apiUrl);
const apiHost = apiUrlObj.hostname;
const apiPath = apiUrlObj.pathname + apiUrlObj.search;

// --- Bangun daftar proxy ---
function normalizeProxy(p) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p) ? p : "socks5://" + p;
}
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
let PROXIES = [];
if (opts.proxyDir) {
  PROXIES = loadProxiesFromDir(opts.proxyDir);
} else {
  PROXIES = (opts.proxy ?? CONFIG.proxy).split(",").map((p) => p.trim()).filter(Boolean).map(normalizeProxy);
}

// --- Paksa IPv6 (jalur langsung) ---
function enforceIpv6() {
  dns.setDefaultResultOrder("ipv6first");
  const realLookup = dns.lookup.bind(dns);
  dns.lookup = function (hostname, options, callback) {
    let cb = callback, o = options;
    if (typeof o === "function") { cb = o; o = {}; }
    if (typeof o === "number") o = { family: o };
    return realLookup(hostname, Object.assign({}, o, { family: 6 }), cb);
  };
}
if (IPV6) enforceIpv6();

// --- Ekstrak ID chapter ---
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

// --- Tunnel SOCKS5 (return socket mentah) ---
function connectSocks5({ proxyHost, proxyPort, targetHost, targetPort }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxyHost, port: Number(proxyPort) }, () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    let stage = 0, buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) { reject(new Error("SOCKS5 nego gagal")); socket.destroy(); return; }
        stage = 1; buf = Buffer.alloc(0);
        const hostBuf = Buffer.from(targetHost, "utf8");
        const portBuf = Buffer.alloc(2); portBuf.writeUInt16BE(Number(targetPort), 0);
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, portBuf]));
      } else if (stage === 1) {
        if (buf.length < 4) return;
        if (buf[0] !== 0x05) { reject(new Error("SOCKS5 respons tidak valid")); socket.destroy(); return; }
        const rep = buf[1];
        if (rep !== 0x00) {
          const map = { 1: "general failure", 2: "not allowed", 3: "network unreachable", 4: "host unreachable", 5: "connection refused", 6: "TTL expired", 7: "cmd not supported", 8: "addr type not supported" };
          reject(new Error(`SOCKS5 CONNECT gagal: ${map[rep] || rep}`)); socket.destroy(); return;
        }
        socket.setTimeout(0); // clear handshake timeout
        resolve(socket);
      }
    });
    socket.on("error", reject);
    socket.setTimeout(15000, () => { reject(new Error("SOCKS5 timeout")); socket.destroy(); });
  });
}

// --- Tunnel HTTP CONNECT (return socket mentah) ---
function httpConnectTunnel({ proxy, targetHost, targetPort }) {
  return new Promise((resolve, reject) => {
    const proxyUrl = new URL(proxy);
    const proxyPort = proxyUrl.port || (proxyUrl.protocol === "https:" ? 443 : 80);
    const proxyLib = proxyUrl.protocol === "https:" ? https : http;
    const headers = { Host: `${targetHost}:${targetPort}` };
    if (proxyUrl.username || proxyUrl.password) {
      const auth = Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString("base64");
      headers["Proxy-Authorization"] = `Basic ${auth}`;
    }
    const req = proxyLib.request({ host: proxyUrl.hostname, port: proxyPort, method: "CONNECT", path: `${targetHost}:${targetPort}`, headers });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) { reject(new Error(`Proxy CONNECT gagal: ${res.statusCode}`)); return; }
      resolve(socket);
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { reject(new Error("CONNECT timeout")); req.destroy(); });
    req.end();
  });
}

// --- Agent keep-alive per proxy (reuse tunnel + TLS) ---
class ProxyAgent extends https.Agent {
  constructor(proxy, optsAgent) {
    super(Object.assign({ keepAlive: true }, optsAgent));
    this.proxy = proxy;
  }
  createConnection(options, callback) {
    const targetHost = options.servername || options.host || apiHost;
    const targetPort = options.port || 443;
    const wrap = (tunnelSocket) => {
      const tlsSocket = tls.connect({ socket: tunnelSocket, servername: targetHost, ALPNProtocols: ["http/1.1"] });
      callback(null, tlsSocket);
    };
    const proxyUrl = new URL(this.proxy);
    const scheme = proxyUrl.protocol.toLowerCase();
    if (scheme === "socks5:" || scheme === "socks:") {
      connectSocks5({ proxyHost: proxyUrl.hostname, proxyPort: proxyUrl.port || 1080, targetHost, targetPort })
        .then(wrap).catch((e) => callback(e));
    } else {
      httpConnectTunnel({ proxy: this.proxy, targetHost, targetPort })
        .then(wrap).catch((e) => callback(e));
    }
  }
}

// --- Kirim satu vote lewat agent (keep-alive) dengan timeout ---
function sendVoteViaAgent(chapterPath, agent) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ path: chapterPath, type: "reaction0" });
    const req = https.request({
      host: apiHost, port: 443, method: "POST", path: apiPath,
      headers: { accept: "application/json", "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      agent,
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode, statusText: res.statusMessage,
        headerGet: (k) => res.headers[String(k).toLowerCase()] ?? null,
        text: data,
      }));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("request timeout")));
    req.write(body);
    req.end();
  });
}

// --- Kirim satu vote langsung (fetch) dengan timeout ---
async function sendVoteDirect(chapterPath) {
  const body = JSON.stringify({ path: chapterPath, type: "reaction0" });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body, signal: ctrl.signal,
    });
    return {
      ok: res.ok, status: res.status, statusText: res.statusText,
      headerGet: (k) => res.headers.get(k), text: await res.text(),
    };
  } finally {
    clearTimeout(t);
  }
}

// --- State global + checkpoint ---
const state = { sent: 0, failed: 0, started: 0 };
function saveCheckpoint() {
  try {
    fs.writeFileSync(checkpointFile, JSON.stringify({ target, maxVotes, sent: state.sent, failed: state.failed, ts: Date.now() }));
  } catch {}
}
function loadCheckpoint() {
  try {
    if (!fs.existsSync(checkpointFile)) return false;
    const cp = JSON.parse(fs.readFileSync(checkpointFile, "utf8"));
    if (cp.target === target) {
      state.sent = cp.sent || 0;
      state.failed = cp.failed || 0;
      state.started = state.sent + state.failed;
      return true;
    }
  } catch {}
  return false;
}

// --- Worker ---
async function attemptWithRetries(lane, chapterPath) {
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    if (lane && lane.dead) return { success: false };
    try {
      const res = lane ? await sendVoteViaAgent(chapterPath, lane.agent) : await sendVoteDirect(chapterPath);
      if (res.ok) {
        if (lane) lane.consecutiveFails = 0;
        let reaction0;
        try { reaction0 = JSON.parse(res.text)?.data?.[0]?.reaction0; } catch {}
        return { success: true, reaction0 };
      }
      if (res.status === 429) {
        if (lane) {
          const ra = res.headerGet("Retry-After");
          const wait = ra && !isNaN(parseInt(ra, 10)) ? parseInt(ra, 10) * 1000 : ((lane.backoff = Math.min((lane.backoff || 500) * 2, MAX_BACKOFF)));
          await sleep(wait);
        } else {
          await sleep(1000);
        }
        continue; // 429 tidak dihitung sebagai kegagalan proxy
      }
      if (lane) {
        lane.consecutiveFails++;
        if (lane.consecutiveFails >= DEAD_THRESHOLD) lane.dead = true;
      }
      await sleep(delay);
    } catch (err) {
      if (lane) {
        lane.consecutiveFails++;
        if (lane.consecutiveFails >= DEAD_THRESHOLD) lane.dead = true;
      }
      await sleep(delay);
    }
  }
  return { success: false };
}

async function worker(lane, chapterPath, lanes) {
  while (state.sent < maxVotes) {
    if (lane && lane.dead) break;
    if (lanes && lanes.length && lanes.every((l) => l.dead)) break;
    if (state.started >= maxVotes * 3) break; // cap total percobaan agar tidak infinite
    state.started++;
    const r = await attemptWithRetries(lane, chapterPath);
    if (r.success) {
      state.sent++;
      if (lane) lane.sent++;
      saveCheckpoint();
    } else {
      state.failed++;
      if (lane) lane.failed++;
    }
  }
}

// --- Statistik ---
function startStats() {
  let lastSent = state.sent;
  let lastTime = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const dt = (now - lastTime) / 1000;
    const rate = dt > 0 ? (state.sent - lastSent) / dt : 0;
    const remaining = Math.max(maxVotes - state.sent, 0);
    const eta = rate > 0 ? Math.round(remaining / rate) : -1;
    const deadCount = LANES.filter((l) => l.dead).length;
    process.stdout.write(`\r[stats] terkirim=${state.sent}/${maxVotes} gagal=${state.failed} rate=${rate.toFixed(1)}/dtk ETA=${eta >= 0 ? eta + "s" : "?"} proxyMati=${deadCount}/${LANES.length}   `);
    lastSent = state.sent;
    lastTime = now;
  }, statsInterval);
  return timer;
}

// --- Lane (proxy + agent) ---
let LANES = [];
function buildLanes() {
  LANES = PROXIES.map((proxy, i) => ({
    id: i + 1, proxy,
    agent: new ProxyAgent(proxy, { maxSockets: concurrency, maxFreeSockets: concurrency }),
    sent: 0, failed: 0, consecutiveFails: 0, backoff: 0, dead: false,
  }));
}

// --- Main ---
async function spamVote() {
  const chapterPath = extractChapterId(target);
  if (!chapterPath) {
    console.error("❌ ID target tidak valid! Masukkan UUID atau URL lengkap chapter.");
    process.exit(1);
  }

  const resumed = opts.resume ? loadCheckpoint() : false;

  const mode = PROXIES.length === 0 ? "langsung"
    : PROXIES.length === 1 ? "proxy tunggal"
    : PARALLEL ? `paralel (${concurrency} konkuren/proxy)`
    : `round-robin (${concurrency} konkuren)`;

  console.log(`Target path : ${chapterPath}`);
  console.log(`Max vote    : ${maxVotes}${resumed ? ` (resume, sudah ${state.sent})` : ""}`);
  console.log(`Delay       : ${delay} ms | timeout=${timeoutMs}ms retry=${maxRetry}`);
  console.log(`Proxy       : ${PROXIES.length ? PROXIES.length + " proxy" : "(langsung)"}`);
  console.log(`Mode        : ${mode}`);
  console.log(`Checkpoint  : ${checkpointFile}`);
  console.log("");

  buildLanes();
  const statsTimer = PROXIES.length ? startStats() : null;

  const workers = [];
  if (PROXIES.length === 0) {
    for (let i = 0; i < concurrency; i++) workers.push(worker(null, chapterPath, null));
  } else if (PARALLEL || PROXIES.length > 1) {
    // tiap proxy dapat `concurrency` worker
    for (const lane of LANES) {
      for (let i = 0; i < concurrency; i++) workers.push(worker(lane, chapterPath, LANES));
    }
  } else {
    for (let i = 0; i < concurrency; i++) workers.push(worker(LANES[0], chapterPath, LANES));
  }

  const t0 = Date.now();
  await Promise.all(workers);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (statsTimer) { clearInterval(statsTimer); process.stdout.write("\n"); }

  // tutup semua agent (release socket keep-alive)
  for (const lane of LANES) lane.agent.destroy();

  console.log("\n==============================================");
  console.log(` SELESAI dalam ${elapsed}s`);
  console.log(` Terkirim : ${state.sent}/${maxVotes}`);
  console.log(` Gagal    : ${state.failed}`);
  if (PROXIES.length) {
    console.log(" Per-proxy:");
    for (const l of LANES) {
      console.log(`   P${String(l.id).padStart(2, " ")} ${l.proxy}  ✅${l.sent} ❌${l.failed}${l.dead ? "  [MATI]" : ""}`);
    }
  }
  console.log("==============================================");

  if (state.sent >= maxVotes) {
    try { fs.unlinkSync(checkpointFile); } catch {}
    console.log("🎉 Target tercapai! Checkpoint dihapus.");
  } else {
    console.log(`⚠️ Target belum tercapai (${state.sent}/${maxVotes}). Jalankan --resume untuk lanjut.`);
  }
}

spamVote();
