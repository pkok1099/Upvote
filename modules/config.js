// modules/config.js — Konfigurasi, parsing argumen CLI, dan penanganan IPv6.
const dns = require("dns");
const { URL } = require("url");

const CONFIG = {
  target: "a6d1020e-e71e-43ed-91a5-39c9c88de017",
  maxVotes: 5,
  delay: 1, // Default 1ms delay antar request per proxy
  apiUrl: "http://127.0.0.1:8000/api/article?lang=en",
  proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "",
};

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
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--id" || a === "--url") out.target = argv[++i];
    else if (a === "--max") out.maxVotes = parseInt(argv[++i], 10);
    else if (a === "--delay") out.delay = parseInt(argv[++i], 10);
    else if (a === "--proxy") out.proxy = argv[++i];
    else if (a === "--api-url") out.apiUrl = argv[++i];
    else if (a === "--proxy-dir") out.proxyDir = argv[++i];
    else if (a === "--concurrency") out.concurrency = parseInt(argv[++i], 10);
    else if (a === "--global-concurrency") out.globalConcurrency = parseInt(argv[++i], 10);
    else if (a === "--jitter") out.jitter = parseInt(argv[++i], 10);
    else if (a === "--timeout") out.timeout = parseInt(argv[++i], 10);
    else if (a === "--max-retry") out.maxRetry = parseInt(argv[++i], 10);
    else if (a === "--stats-interval") out.statsInterval = parseInt(argv[++i], 10);
    else if (a === "--dashboard-interval") out.dashboardInterval = parseInt(argv[++i], 10);
    else if (a === "--no-dashboard") out.noDashboard = true;
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
  --api-url <url>     URL API vote lengkap (default: ${CONFIG.apiUrl})
  --parallel          Jalankan worker mandiri paralel untuk setiap proxy
  --concurrency <n>   Jumlah worker mandiri simultan per proxy (default: ${DEFAULT_CONCURRENCY})
  --global-concurrency <n> Batas total request serentak lintas semua proxy; 0 = tanpa batas/independen (default: ${DEFAULT_GLOBAL_CONCURRENCY})
  --jitter <ms>     Variasi acak tambahan delay tiap proxy agar ritme setiap proxy unik (default: 0)

Keandalan & Performa:
  --timeout <ms>      Timeout batas waktu tiap request HTTP (default: ${DEFAULT_TIMEOUT}ms)
  --max-retry <n>     Batas maksimal retry saat koneksi bermasalah (default: ${DEFAULT_RETRY})
  --checkpoint <file> File penyimpanan progres (default: ${DEFAULT_CHECKPOINT})
  --resume            Lanjutkan proses dari checkpoint terakhir
  --stats-interval <ms> Frekuensi pembaruan statistik terminal (default: ${DEFAULT_STATS_MS}ms)
  --dashboard-interval <ms> Frekuensi pembaruan dashboard tabel real-time (default: ${DEFAULT_DASHBOARD_MS}ms)
  --no-dashboard      Nonaktifkan dashboard tabel real-time (hanya baris statistik)
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
const apiUrl = opts.apiUrl ?? CONFIG.apiUrl;
const concurrency = Math.max(opts.concurrency ?? DEFAULT_CONCURRENCY, 1);
const globalConcurrency = Math.max(opts.globalConcurrency ?? DEFAULT_GLOBAL_CONCURRENCY, 0);
const jitter = Math.max(opts.jitter ?? 0, 0);
const timeoutMs = Math.max(opts.timeout ?? DEFAULT_TIMEOUT, 500);
const maxRetry = Math.max(opts.maxRetry ?? DEFAULT_RETRY, 0);
const statsInterval = Math.max(opts.statsInterval ?? DEFAULT_STATS_MS, 200);
const dashboardInterval = Math.max(opts.dashboardInterval ?? DEFAULT_DASHBOARD_MS, 100);
const DASHBOARD = opts.noDashboard !== true;
const checkpointFile = opts.checkpoint ?? DEFAULT_CHECKPOINT;
const PARALLEL = opts.parallel === true;
const IPV6 = opts.ipv6 === true;

const apiUrlObj = new URL(apiUrl);
const apiHost = apiUrlObj.hostname;
const apiPath = apiUrlObj.pathname + apiUrlObj.search;
const isHttps = apiUrlObj.protocol === "https:";
const apiPort = apiUrlObj.port || (isHttps ? 443 : 80);

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
  maxVotes,
  delay,
  apiUrl,
  concurrency,
  globalConcurrency,
  jitter,
  timeoutMs,
  maxRetry,
  statsInterval,
  dashboardInterval,
  DASHBOARD,
  checkpointFile,
  PARALLEL,
  IPV6,
  apiHost,
  apiPath,
  isHttps,
  apiPort,
};
