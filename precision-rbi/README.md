# Precision RBI

Self-hosted enterprise Remote Browser Isolation — a Chrome MV3 extension plus a
Docker backend that does inline proxying, ML risk scoring, server-side isolation
of risky sites, DLP/BDR telemetry, file sandboxing, and a WireGuard VPN.

> **Read `ARCHITECTURE.md` first** for the honest security model, the CA-trust
> reality (an extension *cannot* silently install a root cert), and the true
> capacity of the dev host (**3 safe / 4 hard-cap concurrent sessions**, not 5–8).

---

## Prerequisites

Kali / Debian-based host:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin git openssl
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"   # then log out/in so `docker` works without sudo
docker --version                  # expect: Docker version 2x.x.x
docker compose version            # expect: Docker Compose version v2.x.x
```

---

## Step 1 — Backend setup (host machine)

```bash
git clone <your-repo> precision-rbi   # or unzip the delivered archive
cd precision-rbi/backend
cp .env.example .env
```

Edit `.env` — at minimum set these:

```ini
SERVER_PUBLIC_HOST=10.225.244.10      # your wlan0 IP: `ip -4 addr show wlan0`
ADMIN_PASS=$(openssl rand -base64 24) # paste the generated value
SESSION_MEM_MB=1024                   # do NOT drop below ~900 (Chromium needs it)
MAX_SESSIONS=4                        # honest ceiling for this host
```

Build and start:

```bash
docker compose build        # first build ~8–15 min (Ubuntu RBI + ClamAV pull sigs)
docker compose up -d
docker compose ps
```

Healthy output looks like (all `running`/`healthy`):

```
NAME                       STATUS                 PORTS
precision-rbi-nginx-1          Up (healthy)       0.0.0.0:80->80, 0.0.0.0:443->443
precision-rbi-session-broker-1 Up (healthy)
precision-rbi-proxy-service-1  Up
precision-rbi-ml-engine-1      Up (healthy)
precision-rbi-ssl-inspector-1  Up (healthy)
precision-rbi-redis-1          Up (healthy)
precision-rbi-sandbox-1        Up (healthy)
precision-rbi-bdr-service-1    Up (healthy)
precision-rbi-admin-console-1  Up (healthy)
precision-rbi-vpn-server-1     Up         0.0.0.0:51820->51820/udp
```

---

## Step 2 — Verify services

```bash
# broker
curl -sk https://$SERVER_PUBLIC_HOST/rbi/api/health | jq
# -> {"status":"ok","version":"0.1.0","capacity":{"active":0,"max":4,...}}

# ml-engine (via proxy score API)
curl -sk "https://$SERVER_PUBLIC_HOST/proxy/score?url=http://secure-paypa1-login.example" | jq
# -> {"score":100,"category":"MALWARE","decision":"BLOCK",...}

# PAC + CA bootstrap
curl -s http://$SERVER_PUBLIC_HOST/pac.js | head
curl -s http://$SERVER_PUBLIC_HOST/ca.crt -o /tmp/precision-rbi-ca.crt && file /tmp/precision-rbi-ca.crt

# bdr ingest
curl -sk -X POST https://$SERVER_PUBLIC_HOST/api/bdr-event \
  -H 'Content-Type: application/json' \
  -d '{"type":"CLIPBOARD_ATTEMPT","userId":"u-test","url":"http://x"}' | jq
```

---

## Step 3 — Chrome extension install

Load unpacked (per developer):

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the `chrome-extension/` folder.

Package as `.crx` for distribution:

```bash
# Generates chrome-extension.crx + a .pem signing key (keep the .pem safe).
google-chrome --pack-extension="$PWD/chrome-extension"
# Re-pack later with the SAME key:
google-chrome --pack-extension="$PWD/chrome-extension" --pack-extension-key="$PWD/chrome-extension.pem"
```

Distribute the `.crx` to the team (internal file share). For policy-managed
fleets, host it and push via `ExtensionInstallForcelist` group policy.

---

## Step 4 — Team member onboarding (near zero-setup)

1. Install the extension (load unpacked or the `.crx`).
2. Open **Options** (gear icon) → set **Server IP** to `SERVER_PUBLIC_HOST`,
   **HTTPS Port** `443`, **Proxy Port** `8080` → **Save** → **Test Connection**
   (expect `✓ Online`).
3. Click the toolbar icon → toggle **VPN** on. The PAC is applied automatically —
   no OS proxy settings to touch.
4. Click **Start Remote Session** → an isolated browser tab opens and streams.

> **One honest caveat (see ARCHITECTURE §3):** the toggle configures proxy
> *routing* with zero clicks, and the isolation path needs no cert. But full
> HTTPS *inspection* of normal browsing requires the gateway CA (`/ca.crt`) to be
> trusted on the device — that step is MDM/Group-Policy on managed machines, not
> something the extension can do silently. Unmanaged devices can import it once
> manually if you want full inspection.

---

## Step 5 — Verification checklist

```bash
# VPN/proxy actually routing? With VPN on, visit a known-bad test domain; you
# should get the Precision RBI block/isolate page, and the broker log shows it:
docker compose logs -f proxy-service | grep DECISION

# RBI session runs on the SERVER, not the client:
docker stats                       # watch an `rbi-xxxxxxxx` container appear/spike
docker ps --filter "label=precision-rbi.session"

# Admin console:
#   https://<SERVER>/admin/   (Basic auth: ADMIN_USER / ADMIN_PASS from .env)
```

---

## Troubleshooting

1. **`docker compose build` fails on ClamAV `freshclam`** — your build host is
   offline/rate-limited. Run `freshclam` on a connected machine and
   `COPY` its `/var/lib/clamav` into the sandbox image, or retry the build later.

2. **HTTPS sites show `NET::ERR_CERT_AUTHORITY_INVALID`** — expected for *inspected*
   (non-isolated) HTTPS until the gateway CA is trusted. Import `/ca.crt` on the
   device (or push via MDM). Isolated sites and plain HTTP are unaffected.

3. **`Start Remote Session` returns "Server at capacity"** — you hit `MAX_SESSIONS`.
   End an idle session in the admin console, or raise the cap only if RAM allows
   (`docker stats` — watch for swap).

4. **noVNC tab is blank / disconnects immediately** — the RBI image may be using a
   snap-shimmed Chromium. Rebuild: `docker compose build rbi-container` and confirm
   `chromium` resolves inside the image: `docker run --rm precision-rbi/rbi-container which chromium-browser`.

5. **`session-broker` can't spawn containers (`docker.sock` permission)** — ensure
   `/var/run/docker.sock` is mounted (it is in compose) and the daemon is running:
   `docker compose logs session-broker | tail`. On SELinux hosts add `:z` to the
   socket mount.
