// modules/dashboard.js — Statistik real-time, tabel per-proxy, dan frame dashboard.
const { Table, colorize } = require("cmd-table");
const config = require("./config");
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

// Bangun baris statistik ringkas (tanpa wrap).
function buildStatsLine(rate) {
  const remaining = Math.max(config.maxVotes - rt.state.sent, 0);
  const eta = rate > 0 ? Math.round(remaining / rate) : -1;
  const deadCount = rt.LANES.filter((l) => l.dead).length;
  const lastInfo =
    rt.state.lastSuccessLabel !== null && typeof rt.state.lastReaction0 === "number"
      ? `Terakhir: ${rt.state.lastSuccessLabel} reaction0=${rt.state.lastReaction0.toLocaleString("id-ID")}`
      : null;

  const segments = [
    `Sukses: ${rt.state.sent}/${config.maxVotes}`,
    lastInfo,
    `Gagal: ${rt.state.failed}`,
    `Kecepatan: ${rate.toFixed(1)} vote/s`,
    `Proxy Mati: ${deadCount}/${rt.LANES.length}`,
    `Invalid: ${rt.state.invalid}`,
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
  const out = text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text;
  const padded = out.padEnd(maxLen, " ");
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
    const terakhir = l.lastReaction0;

    table.addRow({
      ID: `P${String(l.id).padStart(2, "0")}`,
      Alamat: l.proxy,
      OK: l.sent,
      GAG: l.failed,
      // colorize() dipanggil di sini, bukan lewat opsi `formatter`
      // (formatter bukan opsi Column yang didukung cmd-table)
      Status: colorize(status, statusColor(status)),
      Terakhir:
        terakhir == null
          ? "-"
          : typeof terakhir === "number"
            ? terakhir.toLocaleString("id-ID")
            : terakhir,
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
  if (!final && availRows && rt.LANES.length > availRows - overhead) {
    pageSize = Math.max(availRows - overhead, 5);
    const numPages = Math.ceil(rt.LANES.length / pageSize);
    if (typeof now === "number") rt.dashboardPage = Math.floor(now / (config.dashboardInterval * 3)) % numPages;
  }
  const tableText = buildDashboardTable(rt.dashboardPage, pageSize);
  const statsLine = buildStatsLine(rt.currentRate);
  const pageInfo = pageSize > 0 ? `  [Hal. ${rt.dashboardPage + 1}/${Math.ceil(rt.LANES.length / pageSize)}]` : "";
  const title = `📊 DASHBOARD REAL-TIME — ${rt.LANES.length} Proxy Aktif${pageInfo}`;
  return `${title}\n${tableText}\n${statsLine}`;
}

// Gambar ulang frame di tempat yang sama (TTY) atau cetak bila berubah (non-TTY).
function renderDashboardFrame(text) {
  const height = text.split("\n").length;
  if (!process.stdout.isTTY) {
    if (text === rt.lastFrameText) return;
    rt.lastFrameText = text;
    process.stdout.write("\n" + text + "\n");
    return;
  }
  const prefix = rt.lastFrameHeight > 0 ? `\x1b[${rt.lastFrameHeight}A\r` : "\r";
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
