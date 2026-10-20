// modules/cli.js — Nilai default dari config.js root, parsing argumen CLI, penanganan IPv6.
const dns = require("dns");
const net = require("net");
const { URL } = require("url");
const { extractChapterId } = require("./util");

// config.js root adalah sumber default (diedit pengguna). Key opsional;
// key kosong/tak ada jatuh ke DEFAULTS di bawah.
const DEFAULTS = {
  target: "a6d1020e-e71e-43ed-91a5-39c9c88de017",
  maxVotes: 5,
  delay: 1,
  apiUrl: "http://127.0.0.1:8000/api/article?lang=en",
  proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "",
  proxyDir: "",
  proxyReplicas: 1, // Gandakan tiap proxy jadi N lane (manfaatkan backend round-robin multi-IP)
  keepAlive: true,  // Reuse koneksi. Set false utk proxy round-robin per-flow (wpmulti): tiap request = IP baru
  stallTimeout: 60000, // Paksa putus socket bila mandek (ms). 0 = mati
  countReal: false, // true = --max dihitung dari vote yang BENAR MASUK (delta reaction0), bukan request
};
const CONFIG = Object.assign({}, DEFAULTS, require("../config"));

const MAX_BACKOFF = 60000;      // Cap backoff 429 (60 detik)
const DEAD_THRESHOLD = 5;       // Proxy ditandai mati setelah N kegagalan beruntun
const DEFAULT_TIMEOUT = 3000;   // Timeout default per request (3 detik)
const DEFAULT_RETRY = 1;        // Maksimal retry transient error per request
const DEFAULT_CONCURRENCY = 1;  // Jumlah worker mandiri per proxy
const DEFAULT_GLOBAL_CONCURRENCY = 0; // 0 = tanpa batas: tiap proxy sepenuhnya independen
const DEFAULT_STATS_MS = 1000;  // Interval statistik terminal (1 detik)
const DEFAULT_DASHBOARD_MS = 500; // Interval dashboard tabel real-time
const DEFAULT_CHECKPOINT = ".upvote-checkpoint.json";

// --- Parsel Argumen CLI ---
function parseArgs(argv) {
  const out = {};
  const ids = [];
  const hasVal = (i) => i + 1 < argv.length && !argv[i + 1].startsWith("--");
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--id" || a === "--url") {
      if (hasVal(i)) {
        const v = argv[++i];
        // Bisa berkoma atau diulang: --id a --id b, atau --id "a,b"
        if (v != null) for (const part of String(v).split(",")) { const t = part.trim(); if (t) ids.push(t); }
        out.target = v;
      }
    }
    else if (a === "--max") { if (hasVal(i)) out.maxVotes = parseInt(argv[++i], 10); }
    else if (a === "--delay") { if (hasVal(i)) out.delay = parseInt(argv[++i], 10); }
    else if (a === "--proxy") { if (hasVal(i)) out.proxy = argv[++i]; }
    else if (a === "--api-url") { if (hasVal(i)) out.apiUrl = argv[++i]; }
    else if (a === "--proxy-dir") { if (hasVal(i)) out.proxyDir = argv[++i]; }
    else if (a === "--proxy-replicas") {
      if (hasVal(i)) {
        const v = argv[++i];
        out.proxyReplicas = v === "auto" ? "auto" : parseInt(v, 10);
      }
    }
    else if (a === "--wpmulti-debug") { if (hasVal(i)) out.wpmultiDebug = argv[++i]; }
    else if (a === "--stall-timeout") { if (hasVal(i)) out.stallTimeout = parseInt(argv[++i], 10); }
    else if (a === "--count-real") out.countReal = true;
    else if (a === "--vote-types" || a === "--vote-type") { if (hasVal(i)) out.voteTypes = argv[++i]; }
    else if (a === "--max-requests") { if (hasVal(i)) out.maxRequests = parseInt(argv[++i], 10); }
    else if (a === "--concurrency") { if (hasVal(i)) out.concurrency = parseInt(argv[++i], 10); }
    else if (a === "--global-concurrency") { if (hasVal(i)) out.globalConcurrency = parseInt(argv[++i], 10); }
    else if (a === "--chapter-concurrency") { if (hasVal(i)) out.chapterConcurrency = parseInt(argv[++i], 10); }
    else if (a === "--auto-tune") out.autoTune = true;
    else if (a === "--auto-tune-target") { if (hasVal(i)) out.autoTuneTarget = parseInt(argv[++i], 10); }
    else if (a === "--auto-tune-window") { if (hasVal(i)) out.autoTuneWindow = parseInt(argv[++i], 10); }
    else if (a === "--auto-tune-max") { if (hasVal(i)) out.autoTuneMax = parseInt(argv[++i], 10); }
    else if (a === "--auto-tune-probe") { if (hasVal(i)) out.autoTuneProbeEvery = parseInt(argv[++i], 10); }
    else if (a === "--jitter") { if (hasVal(i)) out.jitter = parseInt(argv[++i], 10); }
    else if (a === "--timeout") { if (hasVal(i)) out.timeout = parseInt(argv[++i], 10); }
    else if (a === "--max-retry") { if (hasVal(i)) out.maxRetry = parseInt(argv[++i], 10); }
    else if (a === "--stats-interval") { if (hasVal(i)) out.statsInterval = parseInt(argv[++i], 10); }
    else if (a === "--dashboard-interval") { if (hasVal(i)) out.dashboardInterval = parseInt(argv[++i], 10); }
    else if (a === "--no-dashboard") out.noDashboard = true;
    else if (a === "--no-keepalive") out.noKeepalive = true;
    else if (a === "--checkpoint") { if (hasVal(i)) out.checkpoint = argv[++i]; }
    else if (a === "--resume") out.resume = true;
    else if (a === "--parallel") out.parallel = true;
    else if (a === "--ipv6") out.ipv6 = true;
    else if (a === "--keepalive-idle") { if (hasVal(i)) out.keepaliveIdle = parseInt(argv[++i], 10); }
    else if (a === "--ramp") { if (hasVal(i)) out.ramp = parseInt(argv[++i], 10); }
    else if (a === "--help" || a === "-h") out.help = true;
    else { out.unknown = a; }
  }
  if (ids.length) out.ids = ids;
  return out;
}

const HELP = `
upvote-core.js — Independent Proxy Loop Heavy Duty

Penggunaan:
  node upvote-core.js [opsi]

Opsi Dasar:
  --id, --url <val>   ID target: UUID polos, "chapter/<uuid>", atau URL lengkap.
                      Multi-ID: pisah koma ("a,b") atau ulang flag (--id a --id b).
                      Tiap ID dapat counter reaction0 sendiri; vote dirotasi round-robin.
  --max <n>           Target jumlah vote sukses (default: 5)
  --delay <ms>        Jeda waktu per proxy setelah request selesai, min 0 ms (default: 1)

Pengaturan Proxy:
  --proxy <list>      Daftar proxy dipisah koma (socks5://, http://, host:port)
  --proxy-dir <dir>   Folder berisi file config Wireproxy/WGCF (.conf)
  --proxy-replicas <n|auto> Gandakan tiap proxy jadi N lane paralel; manfaatkan backend round-robin multi-IP dari 1 endpoint. "auto" = ambil jumlah sesi dari wpmulti /debug/sessions (default: ${DEFAULTS.proxyReplicas})
  --wpmulti-debug <addr> Alamat debug wpmulti utk "auto" (default: 127.0.0.1:2081)
  --api-url <url>     URL API vote lengkap (default: ${CONFIG.apiUrl})
  --parallel          Jalankan worker mandiri paralel untuk setiap proxy
  --concurrency <n>   Jumlah worker mandiri simultan per proxy (default: ${DEFAULT_CONCURRENCY})
  --global-concurrency <n> Batas total request serentak lintas semua proxy; 0 = tanpa batas/independen (default: ${DEFAULT_GLOBAL_CONCURRENCY})
  --chapter-concurrency <n> Batas request serentak PER chapter. Server pakai counter read-modify-write per chapter; terlalu banyak tulis serentak ke chapter yang sama -> vote saling menimpa (drop). Rasio aman: nilai ini <= 2. 0 = tanpa batas (default: 0)
  --auto-tune         Atur otomatis batas per-chapter agar konversi vote "masuk" tetap >= target (default 90%), tanpa setel manual
  --auto-tune-target <pct> Persen konversi minimum yang dijaga (default: 90)
  --auto-tune-window <ms> Jendela pengukuran auto-tune (default: 3000)
  --auto-tune-max <n> Batas atas per-chapter saat auto-tune (default: 16)
  --auto-tune-probe <n> Setelah backoff, tunggu N window "aman" sebelum coba naikkan batas lagi (default: 12)
  --jitter <ms>     Variasi acak tambahan delay tiap proxy agar ritme setiap proxy unik (default: 0)

Keandalan & Performa:
  --timeout <ms>      Timeout batas waktu tiap request HTTP (default: ${DEFAULT_TIMEOUT}ms)
  --max-retry <n>     Batas maksimal retry saat koneksi bermasalah (default: ${DEFAULT_RETRY})
  --checkpoint <file> File penyimpanan progres (default: ${DEFAULT_CHECKPOINT})
  --resume            Lanjutkan proses dari checkpoint terakhir
  --stats-interval <ms> Frekuensi pembaruan statistik terminal (default: ${DEFAULT_STATS_MS}ms)
  --dashboard-interval <ms> Frekuensi pembaruan dashboard tabel real-time (default: ${DEFAULT_DASHBOARD_MS}ms)
  --no-dashboard      Nonaktifkan dashboard tabel real-time (hanya baris statistik)
  --no-keepalive      Nonaktifkan keep-alive: tiap request buka koneksi baru. Wajib utk proxy
                      round-robin per-flow (mis. wpmulti) agar tiap request dapat IP berbeda
  --ipv6              Paksa jalur jaringan menggunakan IPv6
  --keepalive-idle <ms> Waktu socket keep-alive idle ditahan sebelum ditutup & handshake diulang (default: 15000)
  --ramp <ms>         Sebar awalan handshake antar proxy dalam window ini untuk hindari burst saat ratusan proxy start (default: 0 = mati)
  --stall-timeout <ms> Paksa putus socket bila tak ada progres vote selama ms ini (0 = mati, default 60000); cegah worker menggantung saat request straggler
  --count-real        Anggap --max sebagai vote yang BENAR MASUK (delta reaction0), bukan jumlah request. Tampilkan % konversi
  --vote-types <list> Tipe reaksi yang divote, pisah koma (default: reaction0). Tiap (chapter,tipe) = counter server TERPISAH; menambah tipe memecah tekanan tulis (seperti multi-ID). Contoh: --vote-types reaction0,reaction1,reaction2
  --max-requests <n>  Batas request pengaman saat --count-real (default: 50x --max)
  -h, --help          Tampilkan pesan bantuan ini
`;

const opts = parseArgs(process.argv);
if (opts.help) { console.log(HELP); process.exit(0); }
if (opts.unknown) {
  console.error(`❌ Argumen tidak dikenal: ${opts.unknown}\nGunakan -h untuk bantuan.`);
  process.exit(1);
}

const target = opts.target ?? CONFIG.target;
// Multi-target: --id bisa berkoma/berulang. Semua dinormalisasi ke "chapter/<uuid>".
// Bila ada yang invalid -> null (validasi di runner).
const rawTargets = (opts.ids && opts.ids.length) ? opts.ids
  : (typeof CONFIG.target === "string" && CONFIG.target.includes(","))
  ? CONFIG.target.split(",").map((s) => s.trim()).filter(Boolean)
  : [target];
const targets = Array.from(new Set(rawTargets)).map((t) => extractChapterId(t));
const invalidTarget = targets.some((t) => t === null);
const chapterPaths = targets.filter(Boolean);

const maxVotesRaw = opts.maxVotes ?? CONFIG.maxVotes;
const maxVotes = Math.max(Number.isFinite(maxVotesRaw) ? maxVotesRaw : 5, 1);

const delayRaw = opts.delay ?? CONFIG.delay;
const delay = Math.max(Number.isFinite(delayRaw) ? delayRaw : 1, 0); // Boleh 0ms atau 1ms

const apiUrl = opts.apiUrl ?? CONFIG.apiUrl;

const concurrencyRaw = opts.concurrency ?? DEFAULT_CONCURRENCY;
const concurrency = Math.max(Number.isFinite(concurrencyRaw) ? concurrencyRaw : DEFAULT_CONCURRENCY, 1);

const globalConcurrencyRaw = opts.globalConcurrency ?? DEFAULT_GLOBAL_CONCURRENCY;
const globalConcurrency = Math.max(Number.isFinite(globalConcurrencyRaw) ? globalConcurrencyRaw : DEFAULT_GLOBAL_CONCURRENCY, 0);

// Gate per-chapter: batasi request serentak ke SATU chapter. Server pakai counter
// read-modify-write per chapter (lost-update); jaga C/K kecil -> konversi tinggi.
// 0 = tanpa batas. Default 2 kalau multi-target & tak diisi (rasio aman -+98%).
const chapterConcurrencyRaw = opts.chapterConcurrency;
const chapterConcurrency = Math.max(Number.isFinite(chapterConcurrencyRaw) ? chapterConcurrencyRaw : 0, 0);

// Auto-tune: geser batas per-chapter otomatis agar konversi >= target.
const AUTO_TUNE = opts.autoTune === true || CONFIG.autoTune === true;
const autoTuneTargetRaw = opts.autoTuneTarget ?? CONFIG.autoTuneTarget;
const autoTuneTarget = Math.min(Math.max(Number.isFinite(autoTuneTargetRaw) ? autoTuneTargetRaw : 90, 50), 100);

const autoTuneWindowRaw = opts.autoTuneWindow ?? CONFIG.autoTuneWindow;
const autoTuneWindow = Math.max(Number.isFinite(autoTuneWindowRaw) ? autoTuneWindowRaw : 3000, 500);

const autoTuneMinSampleRaw = opts.autoTuneMinSample;
const autoTuneMinSample = Math.max(Number.isFinite(autoTuneMinSampleRaw) ? autoTuneMinSampleRaw : 10, 3); // minimal request/window; cukup besar agar konversi tak bising

const autoTuneMaxRaw = opts.autoTuneMax ?? CONFIG.autoTuneMax;
const autoTuneMax = Math.max(Number.isFinite(autoTuneMaxRaw) ? autoTuneMaxRaw : 16, 1);

const autoTuneStart = chapterConcurrency > 0 ? chapterConcurrency : 2; // mulai 2 (aman: C/K=2 -> ~98%), slow-start naikkan bila konversi aman

const autoTuneProbeEveryRaw = opts.autoTuneProbeEvery ?? CONFIG.autoTuneProbeEvery;
const autoTuneProbeEvery = Math.max(Number.isFinite(autoTuneProbeEveryRaw) ? autoTuneProbeEveryRaw : 12, 1); // window "aman" sebelum coba naikkan ceiling lagi

const jitterRaw = opts.jitter;
const jitter = Math.max(Number.isFinite(jitterRaw) ? jitterRaw : 0, 0);

const timeoutRaw = opts.timeout;
const timeoutMs = Math.max(Number.isFinite(timeoutRaw) ? timeoutRaw : DEFAULT_TIMEOUT, 500);

const maxRetryRaw = opts.maxRetry;
const maxRetry = Math.max(Number.isFinite(maxRetryRaw) ? maxRetryRaw : DEFAULT_RETRY, 0);

const statsIntervalRaw = opts.statsInterval;
const statsInterval = Math.max(Number.isFinite(statsIntervalRaw) ? statsIntervalRaw : DEFAULT_STATS_MS, 200);

const dashboardIntervalRaw = opts.dashboardInterval;
const dashboardInterval = Math.max(Number.isFinite(dashboardIntervalRaw) ? dashboardIntervalRaw : DEFAULT_DASHBOARD_MS, 100);

const DASHBOARD = opts.noDashboard !== true;
const checkpointFile = opts.checkpoint ?? DEFAULT_CHECKPOINT;
const PARALLEL = opts.parallel === true;
const IPV6 = opts.ipv6 === true;

const keepaliveIdleRaw = opts.keepaliveIdle;
const keepaliveIdle = Math.max(Number.isFinite(keepaliveIdleRaw) ? keepaliveIdleRaw : 15000, 1000);

const rampRaw = opts.ramp;
const ramp = Math.max(Number.isFinite(rampRaw) ? rampRaw : 0, 0);

const proxyReplicasRaw = opts.proxyReplicas ?? CONFIG.proxyReplicas ?? 1;
const proxyReplicasAuto = proxyReplicasRaw === "auto";
const proxyReplicasNum = Number.isFinite(proxyReplicasRaw) ? proxyReplicasRaw : 1;
const proxyReplicas = proxyReplicasAuto ? 1 : Math.max(proxyReplicasNum, 1);

const wpmultiDebug = opts.wpmultiDebug ?? CONFIG.wpmultiDebug ?? "127.0.0.1:2081";

const stallRaw = opts.stallTimeout ?? CONFIG.stallTimeout;
const stallMs = Math.max(Number.isFinite(stallRaw) ? stallRaw : 60000, 0);

const COUNT_REAL = opts.countReal === true || CONFIG.countReal === true;
// Mode count-real: batas request pengaman (default 50x target vote masuk).
const maxRequestsDefault = COUNT_REAL ? maxVotes * 50 : maxVotes;
const maxRequestsRaw = opts.maxRequests;
const maxRequests = Math.max(Number.isFinite(maxRequestsRaw) ? maxRequestsRaw : maxRequestsDefault, 1);

const keepAlive = opts.noKeepalive ? false : (CONFIG.keepAlive !== false);

// Tipe reaksi yang divote. Tiap (chapter,tipe) = counter server terpisah, jadi
// menambah tipe memecah tekanan tulis (mirip multi-ID). Default: reaction0 saja.
const voteTypesRaw = opts.voteTypes ?? CONFIG.voteTypes ?? "reaction0";
const voteTypes = Array.from(new Set(
  String(voteTypesRaw).split(",").map((s) => s.trim()).filter(Boolean)
));
const invalidVoteType = voteTypes.length === 0 || voteTypes.some((t) => !/^reaction\d+$/.test(t));
const multiType = voteTypes.length > 1;

const apiUrlObj = new URL(apiUrl);
const apiHost = apiUrlObj.hostname;
const apiPath = apiUrlObj.pathname + apiUrlObj.search;
const isHttps = apiUrlObj.protocol === "https:";
const apiPort = apiUrlObj.port || (isHttps ? 443 : 80);

// --- Penanganan IPv6 ---
if (IPV6) {
  dns.setDefaultResultOrder("ipv6first");
  const customKey = Symbol.for("nodejs.util.promisify.custom");
  const origCustom = dns.lookup[customKey];
  const realLookup = dns.lookup.bind(dns);
  if (origCustom) realLookup[customKey] = origCustom;
  dns.lookup = function (hostname, options, callback) {
    let cb = callback, o = options;
    if (typeof o === "function") { cb = o; o = {}; }
    if (typeof o === "number") o = { family: o };
    const family = (o && o.family === 4) ? 4 : 6;
    return realLookup(hostname, Object.assign({}, o, { family }), cb);
  };
  if (origCustom) dns.lookup[customKey] = origCustom;
}

// Resolve hostname -> IPv6 literal (AAAA only). Dipakai jalur SOCKS5 saat IPV6
// aktif agar proxy mengirim ke alamat IPv6, bukan me-resolve domain sendiri
// (yang bisa memilih IPv4). Return null bila bukan IPV6 mode atau tak ada AAAA.
const dnsV6Cache = new Map();
function resolveIPv6(host) {
  if (!IPV6 || !host) return Promise.resolve(null);
  if (net.isIP(host) === 6) return Promise.resolve(host); // sudah literal IPv6
  if (net.isIP(host) === 4) return Promise.resolve(null); // literal IPv4: tak ada IPv6
  if (dnsV6Cache.has(host)) return Promise.resolve(dnsV6Cache.get(host));
  return new Promise((resolve) => {
    dns.lookup(host, { family: 6, all: false }, (err, addr) => {
      const res = err ? null : addr;
      if (res) dnsV6Cache.set(host, res);
      resolve(res);
    });
  });
}

module.exports = {
  CONFIG,
  MAX_BACKOFF,
  DEAD_THRESHOLD,
  DEFAULT_TIMEOUT,
  DEFAULT_RETRY,
  DEFAULT_CONCURRENCY,
  DEFAULT_GLOBAL_CONCURRENCY,
  DEFAULT_STATS_MS,
  DEFAULT_DASHBOARD_MS,
  DEFAULT_CHECKPOINT,
  parseArgs,
  HELP,
  opts,
  target,
  targets: chapterPaths,
  invalidTarget,
  multiTarget: chapterPaths.length > 1,
  maxVotes,
  delay,
  apiUrl,
  concurrency,
  globalConcurrency,
  chapterConcurrency,
  AUTO_TUNE,
  autoTuneTarget,
  autoTuneWindow,
  autoTuneMinSample,
  autoTuneMax,
  autoTuneStart,
  autoTuneProbeEvery,
  jitter,
  timeoutMs,
  maxRetry,
  statsInterval,
  dashboardInterval,
  DASHBOARD,
  checkpointFile,
  PARALLEL,
  IPV6,
  keepaliveIdle,
  ramp,
  proxyReplicas,
  proxyReplicasAuto,
  wpmultiDebug,
  stallMs,
  keepAlive,
  COUNT_REAL,
  maxRequests,
  voteTypes,
  invalidVoteType,
  multiType,
  resolveIPv6,
  apiHost,
  apiPath,
  isHttps,
  apiPort,
};
