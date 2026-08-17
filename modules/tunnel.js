// modules/tunnel.js — Tunnel SOCKS5, HTTP CONNECT, dan Custom Agent Keep-Alive.
const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const config = require("./config");

// --- Tunnel SOCKS5 ---
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

    socket.setTimeout(config.timeoutMs, () => cleanup(new Error("Timeout handshake SOCKS5")));
    socket.on("error", cleanup);

    socket.on("connect", () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });

    let stage = 0;
    let buf = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return cleanup(new Error("Autentikasi SOCKS5 ditolak"));
        stage = 1;
        buf = Buffer.alloc(0);
        const hostBuf = Buffer.from(targetHost, "utf8");
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(Number(targetPort), 0);
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, portBuf]));
      } else if (stage === 1) {
        if (buf.length < 4) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return cleanup(new Error(`SOCKS5 CONNECT gagal`));

        handled = true;
        socket.removeAllListeners("data");
        socket.removeAllListeners("error");
        socket.removeAllListeners("timeout");
        socket.setTimeout(0);
        resolve(socket);
      }
    });
  });
}

// --- Tunnel HTTP CONNECT ---
function httpConnectTunnel({ proxy, targetHost, targetPort }) {
  return new Promise((resolve, reject) => {
    const proxyUrl = new URL(proxy);
    const proxyPort = proxyUrl.port || (proxyUrl.protocol === "https:" ? 443 : 80);
    const proxyLib = proxyUrl.protocol === "https:" ? https : http;
    const headers = { Host: `${targetHost}:${targetPort}` };

    if (proxyUrl.username || proxyUrl.password) {
      const auth = Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString("base64");
      headers["Proxy-Authorization"] = `Basic ${auth}`;
    }

    const req = proxyLib.request({
      host: proxyUrl.hostname,
      port: proxyPort,
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers,
    });

    req.setTimeout(config.timeoutMs, () => {
      req.destroy(new Error("Timeout HTTP CONNECT proxy"));
    });

    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`HTTP CONNECT ditolak dengan status: ${res.statusCode}`));
        return;
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
    super(Object.assign({ keepAlive: true, keepAliveMsecs: 15000, freeSocketTimeout: 30000 }, optsAgent));
    this.proxy = proxy;
  }

  createConnection(options, callback) {
    const targetHost = options.servername || options.host || config.apiHost;
    const targetPort = options.port || config.apiPort;

    const finish = (tunnelSocket) => {
      if (!config.isHttps) {
        callback(null, tunnelSocket);
        return;
      }
      const tlsSocket = tls.connect({
        socket: tunnelSocket,
        servername: targetHost,
        ALPNProtocols: ["http/1.1"],
      });

      tlsSocket.on("error", () => {
        tunnelSocket.destroy();
      });

      callback(null, tlsSocket);
    };

    const proxyUrl = new URL(this.proxy);
    const scheme = proxyUrl.protocol.toLowerCase();

    if (scheme === "socks5:" || scheme === "socks:") {
      connectSocks5({
        proxyHost: proxyUrl.hostname,
        proxyPort: proxyUrl.port || 1080,
        targetHost,
        targetPort,
      }).then(finish).catch((err) => callback(err));
    } else {
      httpConnectTunnel({
        proxy: this.proxy,
        targetHost,
        targetPort,
      }).then(finish).catch((err) => callback(err));
    }
  }
}

module.exports = { connectSocks5, httpConnectTunnel, ProxyAgent };
