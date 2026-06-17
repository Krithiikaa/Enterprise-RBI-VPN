/* Precision RBI — standalone PAC template  [SRV-02]
 * The live PAC is served by proxy.js at http://<host>:8888/pac.js with the
 * configured host/port substituted. This file documents the canonical PAC the
 * extension also generates client-side (background/service-worker.js buildPac()).
 * Both must stay in sync. Local/RFC1918 traffic stays DIRECT so on-LAN resources
 * and the gateway's own APIs are reachable without looping through the proxy. */
function FindProxyForURL(url, host) {
  if (isPlainHostName(host) ||
      shExpMatch(host, "10.*") ||
      shExpMatch(host, "192.168.*") ||
      shExpMatch(host, "172.16.*") ||
      shExpMatch(host, "127.*") ||
      shExpMatch(host, "localhost")) {
    return "DIRECT";
  }
  return "PROXY __PROXY_HOST__:__PROXY_PORT__; DIRECT";
}
