# Aegis — Enterprise RBI + VPN

A self-hosted, on-premises system that gives a company two things from one
Chrome extension:

1. **Secure routing ("VPN")** — browser traffic is sent through an internal
   forward-proxy gateway with a single toggle. HTTPS is tunneled, not decrypted,
   so **no certificate is ever installed on any client device**.
2. **Remote Browser Isolation (RBI)** — risky browsing happens inside a
   throwaway Docker container **on the server**. The client only receives a
   pixel stream (noVNC). Nothing from that session executes on the user's
   machine; the container is destroyed when the tab closes.

Everything runs on your own network with **no external runtime dependencies**.

---

## What's in the box

```
enterprise-rbi-vpn/
├── backend/            # Docker Compose stack (run on the host)
└── chrome-extension/   # MV3 extension (load on each team member's Chrome)
```

Services: `nginx` (edge), `session-broker` (API + auth + capacity),
`rbi-manager` (spawns browser containers), `ws-relay` (noVNC bridge),
`proxy-gateway` (forward proxy), `vpn-server` (optional OS-level WireGuard).

---

## STEP 1 — Host machine setup (Kali Linux)

> Reference host: Kali Rolling, AMD Ryzen 3 7320U (8 threads), ~7 GiB RAM.

**1a. Install Docker Engine + Compose plugin**

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
# Docker's official repo (Debian base, which Kali tracks):
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/debian bookworm stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
# run docker without sudo (log out / back in afterwards):
sudo usermod -aG docker "$USER"
docker --version && docker compose version
```

**1b. Configure environment**

```bash
cd enterprise-rbi-vpn/backend
cp .env.example .env

# generate a strong shared token and drop it into .env:
TOKEN=$(openssl rand -hex 32)
sed -i "s|^SESSION_TOKEN=.*|SESSION_TOKEN=${TOKEN}|" .env
echo "Your access token (give this to team members): ${TOKEN}"

# (optional) WireGuard server key, only if you use the OS-level VPN:
sed -i "s|^WG_SERVER_PRIVATE_KEY=.*|WG_SERVER_PRIVATE_KEY=$(wg genkey 2>/dev/null || echo unset)|" .env
```

Confirm `RBI_NETWORK_NAME` in `.env` is `enterprise-rbi-vpn_rbi-net` (default).

**1c. Build the per-session browser image** (spawned on demand by the manager):

```bash
docker build -t rbi-browser:latest -f rbi-service/Dockerfile.browser rbi-service/
```

**1d. Bring the stack up**

```bash
docker compose up -d --build
docker compose ps
```

**1e. Verify the host is healthy**

```bash
# nginx edge:
curl -s http://localhost:8080/healthz                       # -> ok
# broker status (use your token):
curl -s -H "Authorization: Bearer ${TOKEN}" \
  http://localhost:8080/api/status | jq .                   # -> {ok:true,...}
# proxy gateway:
curl -s http://localhost:3128/__health                      # -> {ok:true,...}
```

Find the IP team members will use:

```bash
ip -4 addr show wlan0 | awk '/inet /{print $2}' | cut -d/ -f1   # e.g. 10.225.244.50
```

---

## STEP 2 — Chrome extension install

**Developer-mode load (fastest):**

1. Open `chrome://extensions` → toggle **Developer mode** (top right).
2. Click **Load unpacked** → select the `chrome-extension/` folder.
3. Pin the **Aegis** shield icon to the toolbar.

**Package a `.crx` for distribution (optional):**

```bash
# From a machine with Chrome installed:
google-chrome --pack-extension="$(pwd)/chrome-extension"
# Produces chrome-extension.crx + chrome-extension.pem (keep the .pem safe;
# reuse it to sign future versions). Distribute the .crx via your MDM/intranet.
```

> For managed fleets, the cleanest path is to host the unpacked extension and
> force-install it through Chrome Enterprise policy (`ExtensionInstallForcelist`).
> The exact-face fonts are optional: drop `Montserrat.woff2` and
> `PlayfairDisplay.woff2` into `chrome-extension/fonts/` to use them; otherwise
> the UI falls back to clean system serif/sans faces.

---

## STEP 3 — Team member zero-config onboarding

Each person, once:

1. Click the **Aegis** icon → gear (**Settings**).
2. Enter the **gateway server IP** (e.g. `10.225.244.50`) and the **access
   token** from Step 1b. Click **Test connection** → should say *Connected*.
   Click **Save**.
3. Back in the popup:
   - Flip **Secure Routing** **ON** → the browser's proxy is configured
     automatically. No system settings, no certificate import.
   - Click **Open Remote Browsing Session** → a new tab opens a fully isolated
     browser running on the host.

That's it. No IT visit, no manual proxy entry, no certificate steps.

---

## STEP 4 — Verification checklist

**Secure routing is active**

```bash
# With routing ON, visit a what-is-my-IP style internal page, or check the
# proxy logs to confirm the browser's requests flow through the gateway:
docker compose logs -f proxy-gateway
# You should see CONNECT/forward entries appear as the user browses.
```

Turn routing **OFF** in the popup, then confirm the override is gone in
`chrome://settings/system` → *Open your computer's proxy settings* shows no
extension-managed proxy (the extension calls `proxy.settings.clear`).

**A remote session really runs on the server**

```bash
# While a user has a Remote Browsing tab open:
docker ps --filter "label=erv.role=rbi-browser"
# -> one erv-browser-<id> container per active session.

# Watch it appear on click and disappear when the tab closes:
watch -n1 'docker ps --filter "label=erv.role=rbi-browser" --format "{{.Names}}\t{{.Status}}"'
```

**Active sessions / capacity via the API**

```bash
curl -s -H "Authorization: Bearer ${TOKEN}" \
  http://localhost:8080/api/status | jq '{active,free,max}'
```

**Graceful teardown** — close the remote tab; within a second the container is
gone (`docker ps` no longer lists it). If a client crashes, the server-side TTL
reaper (`SESSION_TTL_SECONDS`) destroys orphaned sessions automatically.

---

## Operations

```bash
docker compose logs -f                 # all services
docker compose restart session-broker  # restart one service
docker compose down                    # stop everything
docker compose down && docker compose up -d --build   # full redeploy
# clean up any stray browser containers (also done automatically on boot):
docker rm -f $(docker ps -aq --filter "label=erv.role=rbi-browser") 2>/dev/null
```

## Tuning capacity

Edit `.env`, then `docker compose up -d`:

| Variable | Meaning | Default |
|---|---|---|
| `MAX_CONCURRENT_SESSIONS` | Hard ceiling on remote sessions on this host | `12` |
| `SESSION_MEM_LIMIT_MB` | RAM cap per browser container | `380` |
| `SESSION_CPU_QUOTA` | CPU cores per container | `0.5` |
| `SESSION_TTL_SECONDS` | Auto-destroy idle sessions after | `1800` |

See `ARCHITECTURE.md` for capacity math, bottlenecks, and production scaling.

---

## Security note (read this)

This system **does not** intercept TLS, and the extension **cannot** silently
install a trusted root certificate — Chrome deliberately forbids that, and that
boundary is a feature, not a limitation. If your organization later needs TLS
inspection (DLP, content scanning), the inspection CA must be deployed
**transparently** through device management (MDM / Group Policy), never hidden
inside an extension. The honest, user-visible design here is intentional.
