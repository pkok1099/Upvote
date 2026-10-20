// selfcheck.js — assert-based sanity check, no framework. Jalankan: node selfcheck.js
const assert = require("assert");
const { parseVoteResponse } = require("./modules/vote");
const { extractChapterId } = require("./modules/util");

// parseVoteResponse
assert.strictEqual(parseVoteResponse('{"errno":0,"errmsg":"","data":[{"reaction0":42}]}').valid, true);
assert.strictEqual(parseVoteResponse('{"errno":0,"data":[]}').valid, false);
assert.strictEqual(parseVoteResponse('{"errno":1,"data":[{"reaction0":1}]}').valid, false);
assert.strictEqual(parseVoteResponse("not json").valid, false);
// Multi-tipe: kunci field harus cocok tipe yang diminta
assert.strictEqual(parseVoteResponse('{"errno":0,"data":[{"reaction1":5}]}', "reaction1").valid, true);
assert.strictEqual(parseVoteResponse('{"errno":0,"data":[{"reaction1":5}]}', "reaction1").value, 5);
assert.strictEqual(parseVoteResponse('{"errno":0,"data":[{"reaction1":5}]}', "reaction0").valid, false, "tipe salah -> invalid");

// extractChapterId
const u = "00000000-0000-0000-0000-000000000000";
assert.strictEqual(extractChapterId(u), `chapter/${u}`);
assert.strictEqual(extractChapterId(`chapter/${u}`), `chapter/${u}`);
assert.strictEqual(extractChapterId(`https://x.io/chapter/${u}/1`), `chapter/${u}`);
assert.strictEqual(extractChapterId("bogus"), null);
assert.strictEqual(extractChapterId("https://site.com/chapter/not-a-uuid"), null);
assert.strictEqual(extractChapterId("https://site.com/chapter/"), null);

// ipv6ToBytes: literal IPv6 -> 16 byte
const { ipv6ToBytes, formatHostPort } = require("./modules/util");
assert.strictEqual(ipv6ToBytes("::1").toString("hex"), "00000000000000000000000000000001");
assert.strictEqual(ipv6ToBytes("[::1]").toString("hex"), "00000000000000000000000000000001");
assert.throws(() => ipv6ToBytes("2001::1::2"), /IPv6 tidak valid/);
assert.strictEqual(ipv6ToBytes("2001:db8::1").toString("hex"), "20010db8000000000000000000000001");
assert.strictEqual(ipv6ToBytes("::ffff:1.2.3.4").toString("hex"), "00000000000000000000ffff01020304");
assert.strictEqual(ipv6ToBytes("fe80::1%eth0").toString("hex"), "fe800000000000000000000000000001");
assert.strictEqual(formatHostPort("2001:db8::1", 443), "[2001:db8::1]:443");
assert.strictEqual(formatHostPort("[2001:db8::1]", 443), "[2001:db8::1]:443");
assert.strictEqual(formatHostPort("1.2.3.4", 80), "1.2.3.4:80");

const config = require("./modules/cli");
const rt = require("./modules/runtime");
const { acquireSlot, releaseSlot } = require("./modules/semaphore");

// replicate: gandakan proxy utk backend round-robin
const { replicate } = require("./modules/proxy-loader");
assert.deepStrictEqual(replicate(["a", "b"], 2), ["a", "b", "a", "b"]);
assert.deepStrictEqual(replicate(["a"], 1), ["a"]);
assert.deepStrictEqual(replicate([], 5), []);

// applyReactionDelta: baseline di req pertama, jumlahkan kenaikan positif saja
const { applyReactionDelta } = require("./modules/util");
const seen = { max: null, entered: 0 };
assert.strictEqual(applyReactionDelta(seen, 1000), 0, "observasi pertama = baseline");
assert.strictEqual(applyReactionDelta(seen, 1003), 3, "naik 3");
assert.strictEqual(applyReactionDelta(seen, 1003), 0, "mandek = 0");
assert.strictEqual(applyReactionDelta(seen, 1001), 0, "turun = 0 (tak dihitung)");
assert.strictEqual(applyReactionDelta(seen, 1005), 2, "naik dari max 1003 -> 2");
assert.strictEqual(seen.entered, 5, "total masuk 3+2");
assert.strictEqual(applyReactionDelta(seen, null), 0);
assert.strictEqual(applyReactionDelta(seen, NaN), 0, "NaN = 0");
assert.strictEqual(seen.max, 1005, "max tidak dirusak NaN");
assert.strictEqual(seen.entered, 5, "entered tidak dirusak NaN");
assert.strictEqual(applyReactionDelta(seen, Infinity), 0, "Infinity = 0");

// Multi-target: delta independen per chapter (counter reaction0 terpisah)
const per = {};
for (const p of ["chapter/a", "chapter/b"]) per[p] = { max: null, entered: 0, sent: 0 };
applyReactionDelta(per["chapter/a"], 100); // baseline a
applyReactionDelta(per["chapter/b"], 500); // baseline b
applyReactionDelta(per["chapter/a"], 102); // a +2
applyReactionDelta(per["chapter/b"], 501); // b +1
assert.strictEqual(per["chapter/a"].entered, 2);
assert.strictEqual(per["chapter/b"].entered, 1);
assert.strictEqual(per["chapter/a"].entered + per["chapter/b"].entered, 3, "agregat = jumlah per-ID");

// nextAutoLimit: slow-start naik x2; butuh 2 window buruk berturut utk backoff; probe jarang
const { nextAutoLimit } = require("./modules/util");
{
  const st = (o) => ({ limit: 1, ceiling: 16, phase: "slowstart", safeWindows: 0, badStreak: 0, ...o });
  // slow-start: naik x2 sampai ceiling
  assert.strictEqual(nextAutoLimit(st({ limit: 2 }), 100, 90, 16, 12).limit, 4, "slowstart naik x2");
  assert.strictEqual(nextAutoLimit(st({ limit: 4 }), 100, 90, 16, 12).limit, 8, "slowstart terus x2");
  // satu window buruk -> belum backoff (tahan, catat streak)
  const b1 = nextAutoLimit(st({ limit: 8 }), 50, 90, 16, 12);
  assert.strictEqual(b1.limit, 8, "1 window buruk -> tahan");
  assert.strictEqual(b1.badStreak, 1, "catat streak");
  // dua window buruk berturut -> backoff x0.5, ceiling = limit baru, fase avoid
  const d1 = nextAutoLimit(st({ limit: 8, badStreak: 1 }), 50, 90, 16, 12);
  assert.strictEqual(d1.limit, 4, "2 window buruk -> backoff x0.5");
  assert.strictEqual(d1.ceiling, 4, "ceiling dipelajari dari backoff");
  assert.strictEqual(d1.phase, "avoid");
  assert.strictEqual(nextAutoLimit(st({ limit: 1, phase: "avoid" }), 10, 90, 16, 12).limit, 1, "tak turun di bawah 1");
  // pulih ke ceiling: limit < ceiling -> +1
  const rec = nextAutoLimit(st({ limit: 2, ceiling: 4, phase: "avoid" }), 95, 90, 16, 12);
  assert.strictEqual(rec.limit, 3, "pulih +1 menuju ceiling");
  assert.strictEqual(rec.ceiling, 4, "ceiling tetap");
  // di ceiling, belum cukup window aman -> tahan
  assert.strictEqual(nextAutoLimit(st({ limit: 4, ceiling: 4, phase: "avoid", safeWindows: 5 }), 95, 90, 16, 12).limit, 4, "di ceiling -> tahan sampai probe");
  // di ceiling, cukup window aman -> probe naik
  const pr = nextAutoLimit(st({ limit: 4, ceiling: 4, phase: "avoid", safeWindows: 11 }), 95, 90, 16, 12);
  assert.strictEqual(pr.limit, 5, "probe naikkan ceiling");
  assert.strictEqual(pr.ceiling, 5, "ceiling ikut naik saat probe");
  // probe dibatasi maxLimit
  assert.strictEqual(nextAutoLimit(st({ limit: 16, ceiling: 16, phase: "avoid", safeWindows: 11 }), 95, 90, 16, 12).limit, 16, "probe dibatasi max");
}

// parseArgs multi-ID
const { parseArgs } = require("./modules/cli");
assert.deepStrictEqual(parseArgs(["node", "x", "--id", "a,b,c"]).ids, ["a", "b", "c"]);
assert.deepStrictEqual(parseArgs(["node", "x", "--id", "a", "--id", "b"]).ids, ["a", "b"]);
assert.strictEqual(parseArgs(["node", "x", "--id", "a,b"]).target, "a,b");
assert.strictEqual(parseArgs(["node", "x", "--vote-types", "reaction0,reaction1"]).voteTypes, "reaction0,reaction1");
assert.strictEqual(parseArgs(["node", "x", "--vote-type", "reaction2"]).voteTypes, "reaction2");
assert.strictEqual(parseArgs(["node", "x", "--max", "--delay", "5"]).maxVotes, undefined);
assert.strictEqual(parseArgs(["node", "x", "--max", "--delay", "5"]).delay, 5);
assert.strictEqual(parseArgs(["node", "x", "--max"]).maxVotes, undefined);

// wpmulti: hitung sesi dari JSON /debug/sessions
const { countSessions } = require("./modules/wpmulti");
assert.strictEqual(countSessions('[{"index":0},{"index":1},{"index":2}]'), 3);
assert.strictEqual(countSessions("[]"), 0);
assert.strictEqual(countSessions("bukan json"), 0);

// keepAlive wiring: agent memakai nilai config.keepAlive
const { buildLanes } = require("./modules/lanes");
rt.PROXIES = ["socks5://127.0.0.1:1080"];
config.keepAlive = false;
buildLanes();
assert.strictEqual(rt.LANES[0].agent.keepAlive, false, "keepAlive off -> agent harus off");
config.keepAlive = true;
buildLanes();
assert.strictEqual(rt.LANES[0].agent.keepAlive, true, "keepAlive on -> agent harus on");

// semaphore: globalConcurrency=0 tak pernah mengantre; >0 membatasi
(async () => {
  rt.activeSlots = 0;
  rt.slotQueue = [];
  config.globalConcurrency = 0;
  await acquireSlot();
  await acquireSlot();
  assert.strictEqual(rt.slotQueue.length, 0, "tanpa batas tak boleh antre");
  assert.strictEqual(rt.activeSlots, 2);
  releaseSlot();
  releaseSlot();
  assert.strictEqual(rt.activeSlots, 0);

  config.globalConcurrency = 1;
  rt.activeSlots = 0;
  await acquireSlot();
  let queued = false;
  const p = acquireSlot().then(() => { queued = true; });
  assert.strictEqual(rt.slotQueue.length, 1, "slot kedua harus antre");
  assert.strictEqual(queued, false);
  releaseSlot();
  await p;
  assert.strictEqual(queued, true);
  releaseSlot();
  assert.strictEqual(rt.activeSlots, 0);

  // chapter semaphore: batasi serentak per chapter, independen antar chapter
  const { acquireChapterSlot, releaseChapterSlot } = require("./modules/semaphore");
  rt.chapterLimit = 2;
  rt.chapterSlots = {};
  const cp = "chapter/aaaa";
  await acquireChapterSlot(cp);
  await acquireChapterSlot(cp);
  let cq = false;
  const cpq = acquireChapterSlot(cp).then(() => { cq = true; });
  assert.strictEqual(rt.chapterSlots[cp].queue.length, 1, "slot chapter ke-3 antre");
  assert.strictEqual(cq, false);
  await acquireChapterSlot("chapter/bbbb"); // chapter lain tak terpengaruh
  assert.strictEqual(rt.chapterSlots["chapter/bbbb"].active, 1, "chapter lain independen");
  releaseChapterSlot(cp);
  await cpq;
  assert.strictEqual(cq, true);
  releaseChapterSlot(cp); releaseChapterSlot(cp); releaseChapterSlot("chapter/bbbb");
  assert.strictEqual(rt.chapterSlots[cp].active, 0);
  rt.chapterLimit = 0;

  // checkpoint flushCheckpointSync & loadCheckpoint
  const fs = require("fs");
  const { flushCheckpointSync, loadCheckpoint } = require("./modules/checkpoint");
  const prevCpFile = config.checkpointFile;
  const testCpFile = ".test-cp-" + Date.now() + ".json";
  config.checkpointFile = testCpFile;
  const prevTargets = rt.TARGETS;
  const prevPerTarget = rt.perTarget;
  const prevSent = rt.state.sent;
  const prevFailed = rt.state.failed;
  const prevEntered = rt.state.entered;

  rt.TARGETS = ["chapter/00000000-0000-0000-0000-000000000000"];
  rt.state.sent = 10;
  rt.state.failed = 2;
  rt.state.entered = 8;
  rt.perTarget = { "chapter/00000000-0000-0000-0000-000000000000|reaction0": { max: 100, entered: 8, sent: 10 } };

  flushCheckpointSync();
  assert.strictEqual(fs.existsSync(testCpFile), true, "checkpoint tersimpan ke disk");

  rt.state.sent = 0;
  rt.state.failed = 0;
  rt.state.entered = 0;
  rt.perTarget = {};
  const loaded = loadCheckpoint();
  assert.strictEqual(loaded, true, "checkpoint berhasil dimuat");
  assert.strictEqual(rt.state.sent, 10);
  assert.strictEqual(rt.state.failed, 2);
  assert.strictEqual(rt.state.entered, 8);
  assert.strictEqual(rt.state.started, 12);
  assert.strictEqual(rt.perTarget["chapter/00000000-0000-0000-0000-000000000000|reaction0"].entered, 8);

  // Verifikasi loadCheckpoint target matching dengan normalisasi URL
  fs.writeFileSync(testCpFile, JSON.stringify({
    target: "https://site.com/chapter/00000000-0000-0000-0000-000000000000",
    sent: 25,
    failed: 3,
    entered: 20,
  }));
  assert.strictEqual(loadCheckpoint(), true, "checkpoint target cocok via normalisasi");
  assert.strictEqual(rt.state.sent, 25);

  try { fs.unlinkSync(testCpFile); } catch {}
  config.checkpointFile = prevCpFile;
  rt.TARGETS = prevTargets;
  rt.perTarget = prevPerTarget;
  rt.state.sent = prevSent;
  rt.state.failed = prevFailed;
  rt.state.entered = prevEntered;

  console.log("selfcheck OK");
})();