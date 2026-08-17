// modules/vote.js — Dispatcher request vote + validasi respons.
const http = require("http");
const https = require("https");
const config = require("./config");

// --- Dispatcher Request ---
function sendVoteViaAgent(chapterPath, agent) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ path: chapterPath, type: "reaction0" });
    const reqLib = config.isHttps ? https : http;
    const req = reqLib.request(
      {
        host: config.apiHost,
        port: config.apiPort,
        method: "POST",
        path: config.apiPath,
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

    req.setTimeout(config.timeoutMs, () => {
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
  const t = setTimeout(() => ctrl.abort(), config.timeoutMs);

  try {
    const res = await fetch(config.apiUrl, {
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

// --- Validasi Respons Vote ---
// Format respons server: {"errno":0,"errmsg":"","data":[{"reaction0":4961884}]}
// Vote dianggap WORK jika errno === 0 dan data[0].reaction0 berupa angka.
function parseVoteResponse(text) {
  try {
    const json = JSON.parse(text);
    const errno = json?.errno;
    const errmsg = json?.errmsg || "";
    const reaction0 = json?.data?.[0]?.reaction0;
    const valid = errno === 0 && typeof reaction0 === "number";
    return { valid, errno, errmsg, reaction0 };
  } catch {
    return { valid: false, errno: null, errmsg: "JSON tidak valid", reaction0: null };
  }
}

module.exports = { sendVoteViaAgent, sendVoteDirect, parseVoteResponse };
