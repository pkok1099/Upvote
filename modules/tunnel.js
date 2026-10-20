// modules/tunnel.js — Tunnel SOCKS5, HTTP CONNECT, dan Custom Agent Keep-Alive.
const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const config = require("./cli");
const { ipv6ToBytes, formatHostPort } = require("./util");

// --- Tunnel SOCKS5 ---
const SOCKS5_GREETING = Buffer.from([0x05, 0x01, 0x00]);
const socks5ReqCache = new Map();
function getSocks5ReqBuf(targetHost, targetPort) {
  const cacheKey = `${targetHost}:${targetPort}`;
  let reqBuf = socks5ReqCache.get(cacheKey);
  if (!reqBuf) {
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(Number(targetPort), 0);

    let atypByte, addrBuf;
    if (net.isIP(targetHost) === 6) {
      atypByte = 0x04;
      addrBuf = ipv6ToBytes(targetHost);
    } else if (net.isIP(targetHost) === 4) {
      atypByte = 0x01;
      addrBuf = Buffer.from(targetHost.split(".").map(Number));
    } else {
      atypByte = 0x03;
      addrBuf = Buffer.concat([Buffer.from([Buffer.byteLength(targetHost)]), Buffer.from(targetHost, "utf8")]);
    }
    reqBuf = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, atypByte]), addrBuf, portBuf]);
    socks5ReqCache.set(cacheKey, reqBuf);
  }
  return reqBuf;
}

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

    const onTimeout = () => cleanup(new Error("Timeout handshake SOCKS5"));
    const onClose = () => cleanup(new Error("Koneksi SOCKS5 ditutup sebelum handshake selesai"));

    socket.on("timeout", onTimeout);
    socket.setTimeout(config.timeoutMs);
    socket.on("error", cleanup);
    socket.on("close", onClose);

    socket.on("connect", () => {
      socket.write(SOCKS5_GREETING);
    });

    const reqBuf = getSocks5ReqBuf(targetHost, targetPort);

    let stage = 0;
    let buf = Buffer.alloc(0);

    const onData = (chunk) => {
      socket.setTimeout(config.timeoutMs);
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return cleanup(new Error("Autentikasi SOCKS5 ditolak"));
        stage = 1;
        buf = buf.subarray(2);
        socket.write(reqBuf);
      }
      if (stage === 1) {
        if (buf.length < 4) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return cleanup(new Error("SOCKS5 CONNECT gagal"));

        const atyp = buf[3];
        let expectedLen;
        if (atyp === 0x01) {
          expectedLen = 10;
        } else if (atyp === 0x04) {
          expectedLen = 22;
        } else if (atyp === 0x03) {
          if (buf.length < 5) return;
          expectedLen = 7 + buf[4];
        } else {
          return cleanup(new Error(`SOCKS5 CONNECT ATYP tidak valid: ${atyp}`));
        }

        if (buf.length < expectedLen) return;

        handled = true;
        socket.removeListener("data", onData);
        socket.removeListener("error", cleanup);
        socket.removeListener("close", onClose);
        socket.removeListener("timeout", onTimeout);
        socket.setTimeout(0);

        if (buf.length > expectedLen) {
          socket.unshift(buf.subarray(expectedLen));
        }
        resolve(socket);
      }
    };

    socket.on("data", onData);
  });
}

// --- Tunnel HTTP CONNECT ---
const httpProxyMetaCache = new Map();
function getHttpProxyMeta(proxy) {
  let meta = httpProxyMetaCache.get(proxy);
  if (!meta) {
    const proxyUrl = new URL(proxy);
    const port = proxyUrl.port || (proxyUrl.protocol === "https:" ? 443 : 80);
    const lib = proxyUrl.protocol === "https:" ? https : http;
    let authHeader = null;
    if (proxyUrl.username || proxyUrl.password) {
      const auth = Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString("base64");
      authHeader = `Basic ${auth}`;
    }
    meta = {
      hostname: proxyUrl.hostname,
      port,
      lib,
      authHeader,
    };
    httpProxyMetaCache.set(proxy, meta);
  }
  return meta;
}

function httpConnectTunnel({ proxy, targetHost, targetPort }) {
  return new Promise((resolve, reject) => {
    const meta = getHttpProxyMeta(proxy);
    const hostPort = formatHostPort(targetHost, targetPort);
    const headers = { Host: hostPort };

    if (meta.authHeader) {
      headers["Proxy-Authorization"] = meta.authHeader;
    }

    const req = meta.lib.request({
      host: meta.hostname,
      port: meta.port,
      method: "CONNECT",
      path: hostPort,
      headers,
    });

    req.setTimeout(config.timeoutMs, () => {
      req.destroy(new Error("Timeout HTTP CONNECT proxy"));
    });

    req.on("connect", (res, socket, head) => {
      req.setTimeout(0);
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`HTTP CONNECT ditolak dengan status: ${res.statusCode}`));
        return;
      }
      if (head && head.length > 0) {
        socket.unshift(head);
      }
      resolve(socket);
    });

    req.on("error", (err) => reject(err));
    req.end();
  });
}

// --- Custom Agent dengan Keep-Alive (hormati protokol & port target) ---
class ProxyAgent extends (config.isHttps ? https.Agent : http.Agent) {
  constructor(proxy, optsAgent) {
    super(Object.assign({ keepAlive: true, keepAliveMsecs: 1000, timeout: config.keepaliveIdle }, optsAgent));
    this.proxy = proxy;
    const u = new URL(proxy);
    const scheme = u.protocol.toLowerCase();
    this.isSocks = scheme === "socks5:" || scheme === "socks:";
    this.proxyHost = u.hostname;
    this.proxyPort = u.port || (this.isSocks ? 1080 : (scheme === "https:" ? 443 : 80));
  }

  createConnection(options, callback) {
    const targetHost = options.servername || options.host || config.apiHost;
    const targetPort = options.port || config.apiPort;

    let once = true;
    const fail = (err) => { if (once) { once = false; callback(err); } };

    const finish = (tunnelSocket) => {
      if (!config.isHttps) {
        if (once) { once = false; callback(null, tunnelSocket); }
        return;
      }
      const tlsSocket = tls.connect({
        socket: tunnelSocket,
        servername: targetHost,
        ALPNProtocols: ["http/1.1"],
      });

      // Timeout handshake TLS: cegah koneksi menggantung selamanya (straggler),
      // krn req.setTimeout baru terpasang setelah handshake menghasilkan socket.
      const armed = setTimeout(() => {
        tlsSocket.destroy(new Error("Timeout handshake TLS"));
      }, config.timeoutMs);
      tlsSocket.once("secureConnect", () => clearTimeout(armed));
      tlsSocket.once("error", () => { clearTimeout(armed); tunnelSocket.destroy(); });
      tlsSocket.once("close", () => { clearTimeout(armed); tunnelSocket.destroy(); });

      if (once) { once = false; callback(null, tlsSocket); }
    };

    // IPV6 aktif: resolve target ke literal IPv6 lebih dulu agar proxy tak
    // me-resolve domain ke IPv4. SNI (tls servername) tetap hostname asli.
    config.resolveIPv6(targetHost).then((v6) => {
      const destHost = v6 || targetHost;
      if (this.isSocks) {
        connectSocks5({
          proxyHost: this.proxyHost,
          proxyPort: this.proxyPort,
          targetHost: destHost,
          targetPort,
        }).then(finish).catch(fail);
      } else {
        httpConnectTunnel({
          proxy: this.proxy,
          targetHost: destHost,
          targetPort,
        }).then(finish).catch(fail);
      }
    }).catch(fail);
  }
}

module.exports = { connectSocks5, httpConnectTunnel, ProxyAgent };
