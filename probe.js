#!/usr/bin/env node
// probe.js — Cari ATURAN konversi vote: fixed % atau tergantung rate/konkurensi?
// Kirim N request ke endpoint nyata via keep-alive, catat delta tiap request.
//
// Pakai:
//   node probe.js --id <uuid> --n 200 --interval 0 --concurrency 1 \
//     --proxy socks5://127.0.0.1:1080 --api-url https://.../api/article?lang=en
//   node probe.js --id <uuid> --n 200 --concurrency 8 --vote-types reaction0,reaction1,reaction2
//
// Delta dihitung AGREGAT per (chapter,tipe): tiap pasangan = counter server
// terpisah. Saat konkurensi 1, delta = vote yang benar-benar masuk dari request itu.
const args = process.argv.slice(2);
const getArg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const id = getArg("--id", "a6d1020e-e71e-43ed-91a5-39c9c88de017");
const n = parseInt(getArg("--n", "200"), 10);
const interval = parseInt(getArg("--interval", "200"), 10);
const conc = Math.max(parseInt(getArg("--concurrency", "1"), 10), 1);
const proxy = getArg("--proxy", "socks5://127.0.0.1:1080");
const apiUrl = getArg("--api-url", "https://commento.shngm.io/api/article?lang=en");
const timeout = getArg("--timeout", "25000");
const types = getArg("--vote-types", "reaction0").split(",").map((s) => s.trim()).filter(Boolean);

// cli.js parse process.argv saat require -> set argv probe dulu.
const argv = ["node", "probe.js", "--id", id, "--api-url", apiUrl, "--proxy", proxy, "--timeout", timeout, "--no-dashboard"];
if (getArg("--no-keepalive", null) !== null) argv.push("--no-keepalive");
process.argv = argv;

const cli = require("./modules/cli");
const { ProxyAgent } = require("./modules/tunnel");
const { sendVoteViaAgent, parseVoteResponse } = require("./modules/vote");
const { extractChapterId, applyReactionDelta, sleep } = require("./modules/util");

// Multi-chapter: --id "a,b,c" -> rotasi tiap request (menguji lost-update per chapter).
const targetList = id.split(",").map((s) => extractChapterId(s.trim())).filter(Boolean);

(async () => {
  if (!targetList.length) { console.error("ID invalid"); process.exit(1); }

  const agents = [];
  for (let k = 0; k < conc; k++) {
    agents.push(new ProxyAgent(proxy, { maxSockets: 1, maxFreeSockets: 1, keepAlive: cli.keepAlive }));
  }

  const perCounter = {}; // "<chapter>|<tipe>" -> {max,entered,sent,first,last}
  const sumEntered = () => { let s = 0; for (const c in perCounter) s += perCounter[c].entered; return s; };
  let sent = 0, t0 = Date.now(), firstZero = null, zeroStreak = 0, maxZeroStreak = 0;
  let next = 1;

  console.log(`probe: ${targetList.length} ID × ${types.length} tipe [${types.join(",")}] conc=${conc} keepalive=${cli.keepAlive} n=${n} interval=${interval}ms proxy=${proxy}`);
  console.log("idx    lane  tipe      val        delta  cum  konv%   status");

  let tIdx = 0;
  async function worker(k) {
    const agent = agents[k];
    while (next <= n) {
      const i = next++;
      const combo = tIdx++;
      const chapterPath = targetList[combo % targetList.length];
      const type = types[Math.floor(combo / targetList.length) % types.length];
      const key = `${chapterPath}|${type}`;
      let res;
      try { res = await sendVoteViaAgent(chapterPath, agent, type); }
      catch (e) { console.log(`${String(i).padStart(4)}   ${k}     ${type.padEnd(9)} ERROR: ${e.message}`); await sleep(interval); continue; }
      sent++;
      const p = parseVoteResponse(res.text, type);
      let delta = 0;
      if (res.ok && p.valid) {
        const tr = perCounter[key] || (perCounter[key] = { max: null, entered: 0, sent: 0, first: undefined, last: undefined, chapter: chapterPath, type });
        tr.sent++;
        if (tr.first === undefined) tr.first = p.value;
        tr.last = p.value;
        delta = applyReactionDelta(tr, p.value);
        if (delta > 0) zeroStreak = 0;
        else { zeroStreak++; maxZeroStreak = Math.max(maxZeroStreak, zeroStreak); if (firstZero === null) firstZero = i; }
      }
      const global = sumEntered();
      const conv = sent > 0 ? ((global / sent) * 100).toFixed(1) : "0.0";
      const status = res.ok ? (p.valid ? (delta > 0 ? `+${delta}` : "DROP") : `INVALID(errno=${p.errno})`) : `HTTP ${res.status}`;
      console.log(`${String(i).padStart(4)}   ${k}     ${type.padEnd(9)} ${String(p.value).padEnd(10)} ${String(delta).padStart(5)}  ${String(global).padStart(4)} ${conv.padStart(5)}%   ${chapterPath.slice(8, 12)} ${status}`);
      if (i < n) await sleep(interval);
    }
  }

  await Promise.all(agents.map((_, k) => worker(k)));

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nRINGKAS: ${sumEntered()} masuk / ${sent} req = ${sent ? ((sumEntered() / sent) * 100).toFixed(1) : 0}% | ${dt}s | ${(sent / dt).toFixed(1)} req/s | drop pertama #${firstZero ?? "-"} | drop-beruntun max ${maxZeroStreak}`);
  if (targetList.length > 1 || types.length > 1) {
    console.log("\nPer-counter (ground truth = nilai akhir - nilai awal):");
    for (const c in perCounter) {
      const t = perCounter[c];
      const gt = t.first !== undefined ? t.last - t.first : "?";
      const conv = t.sent > 0 ? ((t.entered / t.sent) * 100).toFixed(1) : "0.0";
      console.log(`  ${c.padEnd(48)}  req=${String(t.sent).padStart(4)}  masuk(kum)=${String(t.entered).padStart(5)} (${conv}%)  deltaNilai=${gt}`);
    }
  }
  for (const a of agents) a.destroy();
})();
