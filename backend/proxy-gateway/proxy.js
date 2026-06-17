'use strict';
/**
 * proxy.js  (service: proxy-gateway)
 * -----------------------------------------------------------------------------
 * A standard forward proxy. This is what the Chrome extension's "VPN" toggle
 * points the browser at via the documented chrome.proxy API.
 *
 *   - Plain HTTP requests are forwarded.
 *   - HTTPS is handled with the CONNECT method: the proxy opens a raw TCP tunnel
 *     and blindly pipes bytes. It does NOT decrypt, inspect, or re-sign TLS.
 *
 * Because there is no TLS interception, NO root certificate ever needs to be
 * installed on any client. End-to-end encryption between the browser and the
 * destination is preserved. (If the organization later needs TLS inspection for
 * DLP, that root CA must be deployed transparently via MDM/Group Policy — an
 * extension cannot and must not do it silently. See ARCHITECTURE.md.)
 *
 * Optional: Basic-auth (PROXY_USER/PROXY_PASS) and upstream chaining to a
 * company VPN/proxy (UPSTREAM_VPN_HOST/PORT).
 */

const http = require('http');
const net = require('net');
const url = require('url');

const PORT = parseInt(process.env.PORT || '3128', 10);
const USER = process.env.PROXY_USER || '';
const PASS = process.env.PROXY_PASS || '';
const UP_HOST = process.env.UPSTREAM_VPN_HOST || '';
const UP_PORT = parseInt(process.env.UPSTREAM_VPN_PORT || '0', 10);
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

function log(level, ...args) {
  const order = { error: 0, warn: 1, info: 2, debug: 3 };
  if (order[level] <= order[LOG_LEVEL]) {
    console.log(`[${new Date().toISOString()}] [${level}] [proxy]`, ...args);
  }
}

const authEnabled = Boolean(USER && PASS);
const expectedAuth = authEnabled
  ? 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64')
  : null;

function checkAuth(headerVal) {
  if (!authEnabled) return true;
  return headerVal === expectedAuth;
}

const server = http.createServer((req, res) => {
  // Health endpoint (the proxy answers its own absolute-form requests too).
  if (req.url === '/__health' || req.url === 'http://localhost/__health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, service: 'proxy-gateway', auth: authEnabled }));
  }

  if (!checkAuth(req.headers['proxy-authorization'])) {
    res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="erv-proxy"' });
    return res.end('Proxy authentication required');
  }

  // Plain HTTP forwarding (absolute-form request URI).
  const target = url.parse(req.url);
  if (!target.host) {
    res.writeHead(400);
    return res.end('Bad proxy request');
  }

  const options = {
    host: UP_HOST || target.hostname,
    port: UP_PORT || target.port || 80,
    method: req.method,
    path: UP_HOST ? req.url : target.path, // chained upstream gets absolute URI
    headers: scrubHeaders(req.headers),
  };

  const upstream = http.request(options, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on('error', (e) => {
    log('warn', `HTTP forward error ${target.host}: ${e.message}`);
    if (!res.headersSent) res.writeHead(502);
    res.end('Upstream error');
  });
  req.pipe(upstream);
});

// HTTPS / WebSocket: CONNECT method -> raw TCP tunnel (no decryption).
server.on('connect', (req, clientSocket, head) => {
  if (!checkAuth(req.headers['proxy-authorization'])) {
    clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n' +
                       'Proxy-Authenticate: Basic realm="erv-proxy"\r\n\r\n');
    return clientSocket.destroy();
  }

  const [host, portStr] = req.url.split(':');
  const port = parseInt(portStr, 10) || 443;
  const dstHost = UP_HOST || host;
  const dstPort = UP_PORT || port;

  const serverSocket = net.connect(dstPort, dstHost, () => {
    if (UP_HOST) {
      // Chain through an upstream proxy: re-issue CONNECT to it.
      serverSocket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    } else {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    }
    if (head && head.length) serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });

  const onErr = (where) => (e) => {
    log('debug', `CONNECT ${host}:${port} ${where} error: ${e.message}`);
    clientSocket.destroy();
    serverSocket.destroy();
  };
  serverSocket.on('error', onErr('upstream'));
  clientSocket.on('error', onErr('client'));
});

function scrubHeaders(headers) {
  const out = { ...headers };
  delete out['proxy-authorization'];
  delete out['proxy-connection'];
  return out;
}

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, '0.0.0.0', () => {
  log('info', `proxy-gateway on :${PORT} | auth=${authEnabled} | upstream=${UP_HOST ? `${UP_HOST}:${UP_PORT}` : 'direct'}`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
