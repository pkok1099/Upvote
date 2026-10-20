// modules/vote.js — Dispatcher request vote + validasi respons.
const http = require("http");
const https = require("https");
const config = require("./cli");

// Cache payload JSON + Buffer agar tidak di-stringify dan di-alloc berulang tiap request
const payloadCache = new Map();
function getVotePayload(chapterPath, type) {
  const key = `${chapterPath}|${type}`;
  let item = payloadCache.get(key);
  if (!item) {
    const body = JSON.stringify({ path: chapterPath, type });
    const buffer = Buffer.from(body, "utf8");
    item = {
      body,
      buffer,
      byteLength: buffer.length,
    };
    payloadCache.set(key, item);
  }
  return item;
}

// --- Dispatcher Request ---
// type: nama counter reaksi (reaction0/1/2/...). Default reaction0.
function sendVoteViaAgent(chapterPath, agent, type = "reaction0") {
  return new Promise((resolve, reject) => {
    const { buffer, byteLength } = getVotePayload(chapterPath, type);
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
          "content-length": byteLength,
        },
        agent,
      },
      (res) => {
        res.setEncoding("utf8");
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          req.setTimeout(0);
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage,
            headerGet: (k) => res.headers[String(k).toLowerCase()] ?? null,
            text: data,
          });
        });
        res.on("error", (err) => reject(err));
      }
    );

    req.setTimeout(config.timeoutMs, () => {
      req.destroy(new Error("Request timeout"));
    });

    req.on("error", (err) => {
      reject(err);
    });

    req.end(buffer);
  });
}

async function sendVoteDirect(chapterPath, type = "reaction0") {
  const { body } = getVotePayload(chapterPath, type);
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
// Kunci field = tipe yang diminta (reaction0/1/2/...). Vote dianggap WORK bila
// errno === 0 dan data[0][type] berupa angka.
function parseVoteResponse(text, type = "reaction0") {
  try {
    const json = JSON.parse(text);
    const errno = json?.errno;
    const errmsg = json?.errmsg || "";
    const value = json?.data?.[0]?.[type];
    const valid = errno === 0 && Number.isFinite(value) && value >= 0;
    return { valid, errno, errmsg, value, type };
  } catch {
    return { valid: false, errno: null, errmsg: "JSON tidak valid", value: null, type };
  }
}

module.exports = { sendVoteViaAgent, sendVoteDirect, parseVoteResponse };
