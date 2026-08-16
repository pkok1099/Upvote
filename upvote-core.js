
/**
 * upvote-core.js — Pengirim Vote Masal (Independent Proxy Loop)
 *
 * Fitur Utama Perbaikan:
 * 1. Independent Worker Loop: Setiap proxy berjalan di loop asinkronnya sendiri.
 * Begitu 1 request di Proxy A selesai, Proxy A langsung pause sebesar --delay (misal 1ms),
 * lalu menembak lagi tanpa tergantung proxy lain.
 * 2. Keep-Alive Pool: Reuse connection tunnel TLS & SOCKS5 agar latency antar-request minim.
 * 3. Asynchronous Checkpoint: Menulis checkpoint tanpa membekukan event loop Node.js.
 * 4. Circuit Breaker: Auto-skip proxy yang mengalami kegagalan beruntun (dead detection).
 * 5. Real-Time Observability: Dashboard statistik terminal dengan perhitungan rate presisi.
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
  delay: 1, // Default 1ms delay antar request per proxy
  apiUrl: "https://commento.shngm.io/api/article?lang=en",
  proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "",
};

const MAX_BACKOFF = 60000;      // Cap backoff 429 (60 detik)
const DEAD_THRESHOLD = 5;       // Proxy ditandai mati setelah N kegagalan beruntun
const DEFAULT_TIMEOUT = 3000;   // Timeout default per request (3 detik)
const DEFAULT_RETRY = 1;        // Maksimal retry transient error per request
const DEFAULT_CONCURRENCY = 1;  // Jumlah worker mandiri per proxy
const DEFAULT_STATS_MS = 1000;  // Interval statistik terminal (1 detik)
const DEFAULT_CHECKPOINT = ".upvote-checkpoint.json";

// --- Parsel Argumen CLI ---
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
upvote-core.js — Independent Proxy Loop Heavy Duty

Penggunaan:
  node upvote-core.js [opsi]

Opsi Dasar:
  --id, --url <val>   ID target: UUID polos, "chapter/<uuid>", atau URL lengkap
  --max <n>           Target jumlah vote sukses (default: 5)
  --delay <ms>        Jeda waktu per proxy setelah request selesai, min 0 ms (default: 1)

Pengaturan Proxy:
  --proxy <list>      Daftar proxy dipisah koma (socks5://, http://, host:port)
  --proxy-dir <dir>   Folder berisi file config Wireproxy/WGCF (.conf)
  --parallel          Jalankan worker mandiri paralel untuk setiap proxy
  --concurrency <n>   Jumlah worker mandiri simultan per proxy (default: ${DEFAULT_CONCURRENCY})

Keandalan & Performa:
  --timeout <ms>      Timeout batas waktu tiap request HTTP (default: ${DEFAULT_TIMEOUT}ms)
  --max-retry <n>     Batas maksimal retry saat koneksi bermasalah (default: ${DEFAULT_RETRY})
  --checkpoint <file> File penyimpanan progres (default: ${DEFAULT_CHECKPOINT})
  --resume            Lanjutkan proses dari checkpoint terakhir
  --stats-interval <ms> Frekuensi pembaruan statistik terminal (default: ${DEFAULT_STATS_MS}ms)
  --ipv6              Paksa jalur jaringan menggunakan IPv6
  -h, --help          Tampilkan pesan bantuan ini
`;

const opts = parseArgs(process.argv);
if (opts.help) { console.log(HELP); process.exit(0); }
if (opts.unknown) {
  console.error(`❌ Argumen tidak dikenal: ${opts.unknown}\nGunakan -h untuk bantuan.`);
  process.exit(1);
}

const target = opts.target ?? CONFIG.target;
const maxVotes = opts.maxVotes ?? CONFIG.maxVotes;
const delay = Math.max(opts.delay ?? CONFIG.delay, 0); // Boleh 0ms atau 1ms
const apiUrl = CONFIG.apiUrl;
const concurrency = Math.max(opts.concurrency ?? DEFAULT_CONCURRENCY, 1);
const timeoutMs = Math.max(opts.timeout ?? DEFAULT_TIMEOUT, 500);
const maxRetry = Math.max(opts.maxRetry ?? DEFAULT_RETRY, 0);
const statsInterval = Math.max(opts.statsInterval ?? DEFAULT_STATS_MS, 200);
const checkpointFile = opts.checkpoint ?? DEFAULT_CHECKPOINT;
const PARALLEL = opts.parallel === true;
const IPV6 = opts.ipv6 === true;

const apiUrlObj = new URL(apiUrl);
const apiHost = apiUrlObj.hostname;
const apiPath = apiUrlObj.pathname + apiUrlObj.search;

// --- Pengelolaan Proxy ---
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

// --- Penanganan IPv6 ---
if (IPV6) {
  dns.setDefaultResultOrder("ipv6first");
  const realLookup = dns.lookup.bind(dns);
  dns.lookup = function (hostname, options, callback) {
    let cb = callback, o = options;
    if (typeof o === "function") { cb = o; o = {}; }
    if (typeof o === "number") o = { family: o };
    return realLookup(hostname, Object.assign({}, o, { family: 6 }), cb);
  };
}

// --- Helper Ekstrak ID Chapter ---
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

// --- Tunnel SOCKS5 ---
function connectSocks5({ proxyHost, proxyPort, targetHost, targetPort }) {
  return new Promise((resolve, reject) => {
    let handled = false;
    const socket = net.connect({ host: proxyHost, port: Number(proxyPort) });
    
    const cleanup = (err) => {
      if (handled) return;
      handled = true;
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(timeoutMs, () => cleanup(new Error("Timeout handshake SOCKS5")));
    socket.on("error", cleanup);

    socket.on("connect", () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });

    let stage = 0;
    let buf = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return cleanup(new Error("Autentikasi SOCKS5 ditolak"));
        stage = 1;
        buf = Buffer.alloc(0);
        const hostBuf = Buffer.from(targetHost, "utf8");
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(Number(targetPort), 0);
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, portBuf]));
      } else if (stage === 1) {
        if (buf.length < 4) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return cleanup(new Error(`SOCKS5 CONNECT gagal`));
        
        handled = true;
        socket.removeAllListeners("data");
        socket.removeAllListeners("error");
        socket.removeAllListeners("timeout");
        socket.setTimeout(0);
        resolve(socket);
      }
    });
  });
}

// --- Tunnel HTTP CONNECT ---
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

    const req = proxyLib.request({
      host: proxyUrl.hostname,
      port: proxyPort,
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers,
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Timeout HTTP CONNECT proxy"));
    });

    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`HTTP CONNECT ditolak dengan status: ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });

    req.on("error", (err) => reject(err));
    req.end();
  });
}

// --- Custom HTTPS Agent dengan Keep-Alive ---
class ProxyAgent extends https.Agent {
  constructor(proxy, optsAgent) {
    super(Object.assign({ keepAlive: true, keepAliveMsecs: 15000, freeSocketTimeout: 30000 }, optsAgent));
    this.proxy = proxy;
  }

  createConnection(options, callback) {
    const targetHost = options.servername || options.host || apiHost;
    const targetPort = options.port || 443;

    const wrapTLS = (tunnelSocket) => {
      const tlsSocket = tls.connect({
        socket: tunnelSocket,
        servername: targetHost,
        ALPNProtocols: ["http/1.1"],
      });

      tlsSocket.on("error", () => {
        tunnelSocket.destroy();
      });

      callback(null, tlsSocket);
    };

    const proxyUrl = new URL(this.proxy);
    const scheme = proxyUrl.protocol.toLowerCase();

    if (scheme === "socks5:" || scheme === "socks:") {
      connectSocks5({
        proxyHost: proxyUrl.hostname,
        proxyPort: proxyUrl.port || 1080,
        targetHost,
        targetPort,
      }).then(wrapTLS).catch((err) => callback(err));
    } else {
      httpConnectTunnel({
        proxy: this.proxy,
        targetHost,
        targetPort,
      }).then(wrapTLS).catch((err) => callback(err));
    }
  }
}

// --- Dispatcher Request ---
function sendVoteViaAgent(chapterPath, agent) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ path: chapterPath, type: "reaction0" });
    const req = https.request(
      {
        host: apiHost,
        port: 443,
        method: "POST",
        path: apiPath,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        agent,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage,
            headerGet: (k) => res.headers[String(k).toLowerCase()] ?? null,
            text: data,
          })
        );
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Request timeout"));
    });

    req.on("error", (err) => {
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

async function sendVoteDirect(chapterPath) {
  const body = JSON.stringify({ path: chapterPath, type: "reaction0" });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body,
      signal: ctrl.signal,
    });
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headerGet: (k) => res.headers.get(k),
      text: await res.text(),
    };
  } finally {
    clearTimeout(t);
  }
}

// --- Checkpoint Management ---
const state = { sent: 0, failed: 0, started: 0 };
let isSavingCheckpoint = false;
let pendingCheckpointSave = false;

function saveCheckpointAsync() {
  if (isSavingCheckpoint) {
    pendingCheckpointSave = true;
    return;
  }
  isSavingCheckpoint = true;

  const payload = JSON.stringify({
    target,
    maxVotes,
    sent: state.sent,
    failed: state.failed,
    ts: Date.now(),
  });

  const tempFile = `${checkpointFile}.tmp`;
  fs.writeFile(tempFile, payload, (err) => {
    if (!err) {
      fs.rename(tempFile, checkpointFile, () => {
        isSavingCheckpoint = false;
        if (pendingCheckpointSave) {
          pendingCheckpointSave = false;
          saveCheckpointAsync();
        }
      });
    } else {
      isSavingCheckpoint = false;
    }
  });
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

// --- Eksekusi Retry ---
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
          const wait = ra && !isNaN(parseInt(ra, 10)) ? parseInt(ra, 10) * 1000 : (lane.backoff = Math.min((lane.backoff || 500) * 2, MAX_BACKOFF));
          await sleep(wait);
        } else {
          await sleep(1000);
        }
        continue;
      }

      if (lane) {
        lane.consecutiveFails++;
        if (lane.consecutiveFails >= DEAD_THRESHOLD) lane.dead = true;
      }
    } catch (err) {
      if (lane) {
        lane.consecutiveFails++;
        if (lane.consecutiveFails >= DEAD_THRESHOLD) lane.dead = true;
      }
    }
  }
  return { success: false };
}

// --- INDEPENDENT WORKER PER PROXY ---
async function independentWorker(lane, chapterPath, lanes) {
  while (state.sent < maxVotes) {
    if (lane && lane.dead) break;
    if (lanes && lanes.length && lanes.every((l) => l.dead)) break;
    if (state.started >= maxVotes * 3) break;

    state.started++;

    // 1. Eksekusi request sampai selesai (durasi request bisa bervariasi)
    const r = await attemptWithRetries(lane, chapterPath);

    if (r.success) {
      state.sent++;
      if (lane) lane.sent++;
      saveCheckpointAsync();
    } else {
      state.failed++;
      if (lane) lane.failed++;
    }

    // 2. SETELAH SELESAI, hanya jeda sebesar `delay` ms khusus untuk proxy ini saja
    if (delay > 0) {
      await sleep(delay);
    }
  }
}

// --- Dashboard Statistik Real-Time ---
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

    process.stdout.write(
      `\r[STATISTIK] Sukses: ${state.sent}/${maxVotes} | Gagal: ${state.failed} | Kecepatan: ${rate.toFixed(1)} vote/s | ETA: ${eta >= 0 ? eta + "s" : "?"} | Proxy Mati: ${deadCount}/${LANES.length}   `
    );

    lastSent = state.sent;
    lastTime = now;
  }, statsInterval);

  return timer;
}

// --- Build Lanes ---
let LANES = [];
function buildLanes() {
  LANES = PROXIES.map((proxy, i) => ({
    id: i + 1,
    proxy,
    agent: new ProxyAgent(proxy, { maxSockets: concurrency, maxFreeSockets: concurrency }),
    sent: 0,
    failed: 0,
    consecutiveFails: 0,
    backoff: 0,
    dead: false,
  }));
}

// --- Main Runner ---
async function spamVote() {
  const chapterPath = extractChapterId(target);
  if (!chapterPath) {
    console.error("❌ ID target tidak valid! Masukkan UUID atau URL lengkap chapter.");
    process.exit(1);
  }

  const resumed = opts.resume ? loadCheckpoint() : false;

  const mode = PROXIES.length === 0
    ? "Direct (Tanpa Proxy)"
    : PROXIES.length === 1
    ? "Single Proxy"
    : PARALLEL
    ? `Paralel Independent (${concurrency} worker/proxy)`
    : `Round-Robin (${concurrency} worker)`;

  console.log("==================================================");
  console.log(" 🚀 INDEPENDENT PROXY LOOP UPVOTE RUNNER");
  console.log("==================================================");
  console.log(`Target Path : ${chapterPath}`);
  console.log(`Max Vote    : ${maxVotes}${resumed ? ` (Resume dari ${state.sent})` : ""}`);
  console.log(`Worker/Proxy: ${concurrency} worker | Delay post-request: ${delay}ms`);
  console.log(`Timeout     : ${timeoutMs}ms | Retry Maks: ${maxRetry}`);
  console.log(`Total Proxy : ${PROXIES.length ? PROXIES.length + " proxy" : "(Direct)"}`);
  console.log(`Mode        : ${mode}`);
  console.log(`Checkpoint  : ${checkpointFile}`);
  console.log("==================================================\n");

  buildLanes();
  const statsTimer = startStats();

  const workers = [];
  if (PROXIES.length === 0) {
    for (let i = 0; i < concurrency; i++) workers.push(independentWorker(null, chapterPath, null));
  } else if (PARALLEL || PROXIES.length > 1) {
    for (const lane of LANES) {
      for (let i = 0; i < concurrency; i++) workers.push(independentWorker(lane, chapterPath, LANES));
    }
  } else {
    for (let i = 0; i < concurrency; i++) workers.push(independentWorker(LANES[0], chapterPath, LANES));
  }

  const t0 = Date.now();
  await Promise.all(workers);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (statsTimer) {
    clearInterval(statsTimer);
    process.stdout.write("\n");
  }

  for (const lane of LANES) lane.agent.destroy();

  console.log("\n==================================================");
  console.log(` 🏁 EKSEKUSI SELESAI DALAM ${elapsed} DETIK`);
  console.log("==================================================");
  console.log(` Sukses Kirim : ${state.sent}/${maxVotes}`);
  console.log(` Total Gagal  : ${state.failed}`);
  
  if (PROXIES.length) {
    console.log("\n Detail Per-Proxy:");
    for (const l of LANES) {
      const statusText = l.dead ? " [MATI]" : "";
      console.log(`   [P${String(l.id).padStart(2, "0")}] ${l.proxy}  | ✅ ${l.sent}  | ❌ ${l.failed}${statusText}`);
    }
  }
  console.log("==================================================");

  if (state.sent >= maxVotes) {
    try { fs.unlinkSync(checkpointFile); } catch {}
    console.log("🎉 Target vote berhasil dicapai! Checkpoint dihapus.");
  } else {
    console.log(`⚠️ Target belum tercapai (${state.sent}/${maxVotes}). Jalankan dengan opsi --resume untuk melanjutkan.`);
  }
}

spamVote();
