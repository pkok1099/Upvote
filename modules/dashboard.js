// modules/dashboard.js — Statistik real-time, tabel per-proxy, dan frame dashboard.
const { Table, colorize } = require("cmd-table");
const config = require("./cli");
const rt = require("./runtime");

function statusColor(status) {
  switch (status) {
    case "OK": return "green";
    case "MATI": return "red";
    case "429": return "yellow";
    case "ERROR": return "magenta";
    case "INVALID": return "yellow";
    case "KIRIM": return "cyan";
    default: return "gray";
  }
}

// Nama tipe pendek utk tampilan: reaction0 -> r0, reaction1 -> r1, ...
function shortType(t) {
  return String(t || "reaction0").replace(/^reaction/, "r");
}

// Bangun baris statistik ringkas (tanpa wrap).
function buildStatsLine(rate) {
  const target = config.maxVotes;
  const remaining = Math.max(target - (config.COUNT_REAL ? rt.state.entered : rt.state.sent), 0);
  const eta = rate > 0 ? Math.round(remaining / rate) : -1;
  const lastInfo =
    rt.state.lastSuccessLabel !== null && typeof rt.state.lastValue === "number"
      ? `${shortType(rt.state.lastType)}=${rt.state.lastValue.toLocaleString("id-ID")}`
      : null;
  const pct = rt.state.sent > 0 ? ((rt.state.entered / rt.state.sent) * 100).toFixed(0) : "0";
  const enterSeg = config.COUNT_REAL
    ? `MASUK: ${rt.state.entered}/${target} (${pct}%)`
    : `Masuk: ${rt.state.entered} (${pct}%)`;

  const at = rt.autoTuneInfo;
  const tuneSeg = config.AUTO_TUNE
    ? at
      ? `Limit/ch: ${rt.chapterLimit}/${at.ceiling} (win ${at.conv.toFixed(0)}%, ${at.phase})`
      : `Limit/ch: ${rt.chapterLimit}`
    : rt.chapterLimit > 0
      ? `Limit/ch: ${rt.chapterLimit}`
      : null;

  const segments = [
    enterSeg,
    `Req: ${rt.state.sent}${config.COUNT_REAL ? "/" + config.maxRequests : ""}`,
    tuneSeg,
    lastInfo,
    `Gagal: ${rt.state.failed}`,
    `Kecepatan: ${rate.toFixed(1)} req/s`,
    `Proxy Mati: ${rt.deadCount}/${rt.LANES.length}`,
    `ETA: ${eta >= 0 ? eta + "s" : "?"}`,
  ].filter(Boolean);

  const maxLen = Math.max((process.stdout.isTTY ? process.stdout.columns || 80 : Infinity) - 1, 20);
  let line = "[STATISTIK]";
  for (const seg of segments) {
    if ((line + " | " + seg).length <= maxLen) line += " | " + seg;
  }
  return line;
}

// Render satu baris statistik di tempat yang sama tanpa wrap.
function renderStatsLine(text) {
  if (!process.stdout.isTTY) {
    process.stdout.write(`\r${text}`);
    return;
  }
  const width = process.stdout.columns || 80;
  const maxLen = Math.max(width - 1, 20);
  const padded = text.padEnd(maxLen, " ");
  let prefix = "\r";
  if (rt.prevRenderedLen > 0 && rt.prevRenderedWidth > 0) {
    const prevLines = Math.max(Math.ceil(rt.prevRenderedLen / rt.prevRenderedWidth), 1);
    if (prevLines > 1) prefix = `\x1b[${prevLines - 1}A\r`;
  }
  process.stdout.write(prefix + padded + "\x1b[0J");
  rt.prevRenderedLen = padded.length;
  rt.prevRenderedWidth = width;
}

// Bangun tabel besar per-proxy (semua proxy, dipaginasi bila tak muat terminal).
function buildDashboardTable(page, pageSize) {
  const table = new Table({
    compact: true,
    responsiveMode: "hide",
    terminalWidth: process.stdout.columns || 80,
  });

  table.addColumn({ name: "ID", minWidth: 4, priority: 0 });
  table.addColumn({ name: "Alamat", priority: 90, truncate: "…" });
  table.addColumn({ name: "OK", align: "right", priority: 10 });
  table.addColumn({ name: "GAG", align: "right", priority: 50 });
  table.addColumn({ name: "Status", priority: 5 });
  table.addColumn({ name: "Terakhir", align: "right", priority: 80 });

  for (const l of rt.LANES) {
    const status = l.dead ? "MATI" : (l.lastStatus || "IDLE");
    const terakhir =
      typeof l.lastValue === "number"
        ? `${shortType(l.lastType)}=${l.lastValue.toLocaleString("id-ID")}`
        : null;

    table.addRow({
      ID: `P${String(l.id).padStart(2, "0")}`,
      Alamat: l.proxy,
      OK: l.sent,
      GAG: l.failed,
      // colorize() dipanggil di sini, bukan lewat opsi `formatter`
      // (formatter bukan opsi Column yang didukung cmd-table)
      Status: colorize(status, statusColor(status)),
      Terakhir: terakhir == null ? "-" : terakhir,
    });
  }

  if (pageSize && pageSize > 0 && rt.LANES.length > pageSize) {
    const pageIndex = Number.isFinite(page) ? Math.max(page, 0) : 0;
    const pages = table.getPages(pageSize); // Table[]
    const clampedIndex = Math.min(pageIndex, pages.length - 1);
    return pages[clampedIndex].render();
  }

  return table.render();
}

// Susun frame lengkap: judul + tabel + baris statistik.
function buildDashboardFrame(now, final) {
  const availRows = process.stdout.isTTY ? (process.stdout.rows || 24) : 0;
  const overhead = 5; // judul + border atas + header + border bawah + baris statistik
  let pageSize = 0;
  if (!final && availRows && rt.LANES.length > 0 && rt.LANES.length > availRows - overhead) {
    pageSize = Math.max(availRows - overhead, 5);
    const numPages = Math.ceil(rt.LANES.length / pageSize);
    if (typeof now === "number" && numPages > 0) rt.dashboardPage = Math.floor(now / (config.dashboardInterval * 3)) % numPages;
  }
  const tableText = buildDashboardTable(rt.dashboardPage, pageSize);
  const statsLine = buildStatsLine(rt.currentRate);
  const pageInfo = (pageSize > 0 && rt.LANES.length > 0) ? `  [Hal. ${rt.dashboardPage + 1}/${Math.ceil(rt.LANES.length / pageSize)}]` : "";
  const title = `📊 DASHBOARD REAL-TIME — ${rt.LANES.length} Proxy Aktif${pageInfo}`;
  return `${title}\n${tableText}\n${statsLine}`;
}

// Gambar ulang frame di tempat yang sama (TTY) atau cetak bila berubah (non-TTY).
function renderDashboardFrame(text) {
  if (!process.stdout.isTTY) {
    const line = buildStatsLine(rt.currentRate);
    if (line === rt.lastFrameText) return;
    rt.lastFrameText = line;
    process.stdout.write(line + "\n");
    return;
  }
  const height = text.split("\n").length;
  const prefix = rt.lastFrameHeight > 1 ? `\x1b[${rt.lastFrameHeight - 1}A\r` : "\r";
  process.stdout.write(prefix + text + "\x1b[0J");
  rt.lastFrameHeight = height;
}

function startStats() {
  let lastSent = rt.state.sent;
  let lastTime = Date.now();

  const timer = setInterval(() => {
    const now = Date.now();
    const dt = (now - lastTime) / 1000;
    const rate = dt > 0 ? (rt.state.sent - lastSent) / dt : 0;
    rt.currentRate = rate;

    if (config.DASHBOARD) {
      renderDashboardFrame(buildDashboardFrame(now, false));
    } else {
      renderStatsLine(buildStatsLine(rate));
    }

    lastSent = rt.state.sent;
    lastTime = now;
  }, config.DASHBOARD ? config.dashboardInterval : config.statsInterval);

  return timer;
}

module.exports = { statusColor, buildStatsLine, renderStatsLine, buildDashboardTable, buildDashboardFrame, renderDashboardFrame, startStats };
