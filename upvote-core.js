#!/usr/bin/env node
/**
 * upvote-core.js — Versi Node.js dari inti pengirim vote (tanpa UI).
 *
 * Mengirim vote ke API Commento untuk chapter tertentu dengan:
 *   - Ekstraksi ID dari UUID polos, "chapter/<uuid>", atau URL lengkap
 *   - Penundaan antar vote (delay)
 *   - Penanganan 429 (Retry-After, lalu backoff eksponensial 1s -> 2s -> 4s ... cap 60s)
 *   - Pesan error jelas (HTTP, JSON, jaringan)
 *   - Dukungan proxy (jaga-jaga region lock):
 *       * HTTP/HTTPS proxy  -> via CONNECT tunneling
 *       * SOCKS5 proxy      -> via SOCKS5 handshake (tanpa auth)
 *       * Multi-proxy       -> pisahkan dengan koma, dirotasi round-robin tiap vote
 *       * Mode paralel      -> --parallel: 1 worker per proxy berjalan bersamaan
 *     Contoh: --proxy socks5://127.0.0.1:1080  atau  --proxy http://user:pass@host:port
 *     Contoh multi: --proxy socks5://127.0.0.1:1085,socks5://127.0.0.1:1086
 *     Contoh paralel: --proxy socks5://127.0.0.1:1085,...,socks5://127.0.0.1:1089 --parallel
 *     Tanpa skema (mis. 127.0.0.1:1080) dianggap SOCKS5.
 *
 * Cara pakai:
 *   node upvote-core.js --id a6d1020e-e71e-43ed-91a5-39c9c88de017 --max 5 --delay 100
 *   node upvote-core.js --id <id> --proxy socks5://127.0.0.1:1080
 *
 * Jika argumen tidak diberikan, digunakan nilai CONFIG di bawah.
 */

const http = require("http");
const https = require("https");
const net = require("net");
const dns = require("dns");
const { URL } = require("url");

const CONFIG = {
  target: "a6d1020e-e71e-43ed-91a5-39c9c88de017", // UUID / "chapter/<uuid>" / URL lengkap
  maxVotes: 5,        // jumlah vote maksimal
  delay: 100,         // ms antar vote (minimal 100)
  apiUrl: "https://commento.shngm.io/api/article?lang=en",
  proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "", // contoh: socks5://127.0.0.1:1080
};

const MAX_BACKOFF = 60000; // batas atas backoff (60 detik)

// --- Parsing argumen sederhana (tanpa dependensi) ---
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--id" || a === "--url") out.target = argv[++i];
    else if (a === "--max") out.maxVotes = parseInt(argv[++i], 10);
    else if (a === "--delay") out.delay = parseInt(argv[++i], 10);
    else if (a === "--proxy") out.proxy = argv[++i];
    else if (a === "--parallel") out.parallel = true;
    else if (a === "--ipv6") out.ipv6 = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else { out.unknown = a; }
  }
  return out;
}

const HELP = `
upvote-core.js — Inti pengirim vote (Node.js, tanpa UI)

Penggunaan:
  node upvote-core.js [opsi]

Opsi:
  --id, --url <val>   ID target: UUID polos, "chapter/<uuid>", atau URL lengkap chapter
  --max <n>           Jumlah vote maksimal (default: 5)
  --delay <ms>        Penundaan antar vote, minimal 100 ms (default: 100)
  --proxy <url>       Proxy untuk region lock (bisa lebih dari satu, pisahkan dengan koma;
                      tiap vote akan dirotasi round-robin):
                        socks5://127.0.0.1:1080  (SOCKS5, no-auth)
                        http://user:pass@host:port (HTTP CONNECT)
                        socks5://127.0.0.1:1085,socks5://127.0.0.1:1086
                      Tanpa skema (127.0.0.1:1080) dianggap SOCKS5.
  --parallel          Jalankan tiap proxy sebagai worker paralel (1 worker per proxy).
                      Total --max vote dibagi rata antar proxy. Default: round-robin berurutan.
  --ipv6              Paksa koneksi keluar hanya lewat IPv6 (berlaku untuk jalur langsung).
                      Untuk jalur proxy, egress IPv6 ditentukan oleh terowongan (wireproxy/WG),
                      bukan oleh script ini.
  -h, --help          Tampilkan bantuan ini

Environment (dipakai jika --proxy tidak diberikan):
  HTTPS_PROXY / HTTP_PROXY

Contoh:
  node upvote-core.js --id a6d1020e-e71e-43ed-91a5-39c9c88de017 --max 5 --delay 100
  node upvote-core.js --id a6d1020e-e71e-43ed-91a5-39c9c88de017 --proxy socks5://127.0.0.1:1080
`;

function printHelp() {
  console.log(HELP);
}

const opts = parseArgs(process.argv);
const target = opts.target ?? CONFIG.target;
const maxVotes = opts.maxVotes ?? CONFIG.maxVotes;
const delay = Math.max(opts.delay ?? CONFIG.delay, 100); // minimal 100ms
const apiUrl = CONFIG.apiUrl;
let PROXIES = (opts.proxy ?? CONFIG.proxy)
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p) ? p : "socks5://" + p)); // tanpa skema = SOCKS5
const PARALLEL = opts.parallel === true;
const IPV6 = opts.ipv6 === true;

/** Paksa seluruh resolusi DNS & koneksi keluar hanya lewat IPv6. */
function enforceIpv6() {
  dns.setDefaultResultOrder("ipv6first");
  const realLookup = dns.lookup.bind(dns);
  dns.lookup = function (hostname, options, callback) {
    let cb = callback;
    let opts = options;
    if (typeof opts === "function") { cb = opts; opts = {}; }
    if (typeof opts === "number") opts = { family: opts };
    return realLookup(hostname, Object.assign({}, opts, { family: 6 }), cb);
  };
}
if (IPV6) enforceIpv6();

/** Ekstrak path chapter dari UUID polos, "chapter/<uuid>", atau URL lengkap. */
function extractChapterId(input) {
  const trimmed = (input || "").trim();
  if (!trimmed) return null;
  try {
    const urlObj = new URL(trimmed);
    const segs = urlObj.pathname.split("/");
    const i = segs.indexOf("chapter");
    if (i > -1 && segs.length > i + 1) return `chapter/${segs[i + 1]}`;
  } catch {
    // bukan URL lengkap, lanjut cek sebagai ID langsung
  }
  let raw = trimmed;
  if (raw.startsWith("chapter/")) raw = raw.slice("chapter/".length);
  const uuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  return uuid.test(raw) ? `chapter/${raw}` : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Buka tunnel TCP lewat proxy HTTP/HTTPS menggunakan metode CONNECT.
 * Mengembalikan socket tunnel yang sudah jadi.
 */
function httpConnectTunnel({ proxy, target }) {
  return new Promise((resolve, reject) => {
    const proxyUrl = new URL(proxy);
    const targetUrl = new URL(target);
    const targetPort = targetUrl.port || 443;
    const proxyPort = proxyUrl.port || (proxyUrl.protocol === "https:" ? 443 : 80);
    const proxyLib = proxyUrl.protocol === "https:" ? https : http;

    const connectHeaders = { Host: `${targetUrl.hostname}:${targetPort}` };
    if (proxyUrl.username || proxyUrl.password) {
      const auth = Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString("base64");
      connectHeaders["Proxy-Authorization"] = `Basic ${auth}`;
    }

    const connectReq = proxyLib.request({
      host: proxyUrl.hostname,
      port: proxyPort,
      method: "CONNECT",
      path: `${targetUrl.hostname}:${targetPort}`,
      headers: connectHeaders,
    });

    connectReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Proxy CONNECT gagal: ${res.statusCode} ${res.statusMessage}`));
        return;
      }
      resolve(socket);
    });
    connectReq.on("error", reject);
    connectReq.end();
  });
}

/**
 * Buka tunnel lewat proxy SOCKS5 (tanpa auth, resolving domain di sisi proxy).
 * Mengembalikan socket tunnel yang sudah jadi.
 */
function connectSocks5({ proxyHost, proxyPort, targetHost, targetPort }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxyHost, port: Number(proxyPort) }, () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00])); // greeting: SOCKS5, 1 metode, no-auth
    });

    let stage = 0;
    let buf = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) {
          reject(new Error("SOCKS5 handshake gagal (nego metode)"));
          socket.destroy();
          return;
        }
        stage = 1;
        buf = Buffer.alloc(0);
        const hostBuf = Buffer.from(targetHost, "utf8");
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(Number(targetPort), 0);
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
          hostBuf,
          portBuf,
        ]);
        socket.write(req); // CONNECT ke targetHost:targetPort
      } else if (stage === 1) {
        if (buf.length < 4) return;
        if (buf[0] !== 0x05) {
          reject(new Error("SOCKS5 respons tidak valid"));
          socket.destroy();
          return;
        }
        const rep = buf[1];
        if (rep !== 0x00) {
          const map = {
            1: "general failure", 2: "connection not allowed", 3: "network unreachable",
            4: "host unreachable", 5: "connection refused", 6: "TTL expired",
            7: "command not supported", 8: "address type not supported",
          };
          reject(new Error(`SOCKS5 CONNECT gagal: ${map[rep] || rep}`));
          socket.destroy();
          return;
        }
        resolve(socket); // tunnel siap
      }
    });

    socket.on("error", reject);
    socket.setTimeout(15000, () => {
      reject(new Error("SOCKS5 timeout"));
      socket.destroy();
    });
  });
}

/** Kirim HTTPS request di atas socket tunnel yang sudah terbuka. */
function httpsOverSocket(socket, { url, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const t = new URL(url);
    const req = https.request(
      {
        host: t.hostname,
        port: t.port || 443,
        method,
        path: t.pathname + t.search,
        headers,
        socket,
        agent: false,
        servername: t.hostname,
      },
      (resp) => {
        let data = "";
        resp.on("data", (c) => (data += c));
        resp.on("end", () => {
          socket.destroy(); // tutup tunnel agar tidak menumpuk di mode paralel
          resolve({ status: resp.statusCode, statusText: resp.statusMessage, headers: resp.headers, body: data });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Kirim satu vote; kembalikan bentuk seragam { ok, status, statusText, headerGet, text }. */
async function sendVote(path, proxy) {
  const body = JSON.stringify({ path, type: "reaction0" });
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  };

  if (proxy) {
    const proxyUrl = new URL(proxy);
    const scheme = proxyUrl.protocol.toLowerCase();
    let socket;
    if (scheme === "socks5:" || scheme === "socks:") {
      const api = new URL(apiUrl);
      socket = await connectSocks5({
        proxyHost: proxyUrl.hostname,
        proxyPort: proxyUrl.port || 1080,
        targetHost: api.hostname,
        targetPort: api.port || 443,
      });
    } else {
      socket = await httpConnectTunnel({ proxy, target: apiUrl });
    }
    const r = await httpsOverSocket(socket, { url: apiUrl, method: "POST", headers, body });
    const h = r.headers || {};
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: r.statusText,
      headerGet: (k) => h[String(k).toLowerCase()] ?? null,
      text: r.body,
    };
  }

  const res = await fetch(apiUrl, { method: "POST", headers, body });
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    headerGet: (k) => res.headers.get(k),
    text: await res.text(),
  };
}

/**
 * Satu worker pengirim vote.
 * pickProxy() dipanggil tiap percobaan untuk menentukan proxy yang dipakai.
 */
async function voteWorker({ path, pickProxy, quota, label, counter }) {
  let sent = 0;
  let backoff = 0;

  while (sent < quota) {
    const proxy = pickProxy();

    try {
      const res = await sendVote(path, proxy);

      if (!res.ok) {
        if (res.status === 429) {
          const ra = res.headerGet("Retry-After");
          const retryMs = ra && !isNaN(parseInt(ra, 10))
            ? parseInt(ra, 10) * 1000
            : (backoff === 0 ? 1000 : backoff * 2);
          backoff = Math.min(retryMs, MAX_BACKOFF);
          console.warn(`[${label}] Rate limit (429). Berhenti ${backoff / 1000} dtk lalu coba lagi...`);
          await sleep(backoff);
          continue;
        }
        console.error(`[${label}] Gagal: Server merespons ${res.status} ${res.statusText}.`);
        await sleep(delay);
        continue;
      }

      let data;
      try {
        data = JSON.parse(res.text);
      } catch {
        console.error(`[${label}] Gagal: Respon bukan JSON valid. Cek koneksi atau format respons API.`);
        await sleep(delay);
        continue;
      }

      sent++;
      backoff = 0; // reset backoff setelah berhasil
      const n = ++counter.total;
      const reaction0 = data?.data?.[0]?.reaction0;
      if (reaction0 !== undefined) {
        console.log(`[${label}] Vote ${n}/${maxVotes} terkirim. Reaction0 saat ini: ${reaction0}`);
      } else {
        console.warn(`[${label}] ⚠️ Vote ${n} terkirim, tapi respons tidak berisi reaction0. Format API mungkin berubah.`);
      }
      await sleep(delay);
    } catch (err) {
      console.error(`[${label}] Gagal: Error jaringan. Periksa koneksi internet / proxy Anda. (${err.message})`);
      await sleep(delay);
    }
  }
}

/** Inti pengiriman vote: paralel (1 worker per proxy) atau round-robin berurutan. */
async function spamVote() {
  const path = extractChapterId(target);
  if (!path) {
    console.error("❌ ID target tidak valid! Masukkan UUID (mis. a6d1020e-e71e-43ed-91a5-39c9c88de017) atau URL lengkap chapter.");
    process.exit(1);
  }

  const mode = PARALLEL && PROXIES.length > 1
    ? "paralel (1 worker per proxy)"
    : PROXIES.length > 1
      ? "round-robin"
      : PROXIES.length
        ? "proxy tunggal"
        : "langsung";

  console.log(`Target path : ${path}`);
  console.log(`Max vote    : ${maxVotes}`);
  console.log(`Delay       : ${delay} ms`);
  console.log(`Proxy       : ${PROXIES.length ? PROXIES.join(", ") : "(langsung, tanpa proxy)"}`);
  console.log(`Mode        : ${mode}`);
  console.log(`IPv6 only   : ${IPV6 ? "ya" : "tidak"}\n`);

  const counter = { total: 0 };

  if (PARALLEL && PROXIES.length > 1) {
    // Bagi kuota vote rata antar proxy; sisa dibagikan ke worker pertama
    const base = Math.floor(maxVotes / PROXIES.length);
    let remainder = maxVotes % PROXIES.length;
    const workers = [];
    PROXIES.forEach((proxy, i) => {
      const quota = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
      if (quota > 0) {
        workers.push(voteWorker({ path, pickProxy: () => proxy, quota, label: `P${i + 1}`, counter }));
      }
    });
    await Promise.all(workers);
  } else if (PROXIES.length > 1) {
    // Round-robin: satu worker, proxy dirotasi tiap vote
    let idx = 0;
    await voteWorker({
      path,
      pickProxy: () => PROXIES[idx++ % PROXIES.length],
      quota: maxVotes,
      label: "RR",
      counter,
    });
  } else {
    const proxy = PROXIES[0] || null;
    await voteWorker({ path, pickProxy: () => proxy, quota: maxVotes, label: proxy ? "P1" : "direct", counter });
  }

  console.log("\n🎉 Semua vote berhasil terkirim!");
}

if (opts.help) {
  printHelp();
  process.exit(0);
}

if (opts.unknown) {
  console.error(`❌ Argumen tidak dikenal: ${opts.unknown}\nJalankan dengan -h atau --help untuk bantuan.`);
  process.exit(1);
}

spamVote();
