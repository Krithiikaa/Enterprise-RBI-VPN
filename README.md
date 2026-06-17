<div align="center">
  <img src="chrome-extension/icons/icon128.png" alt="Aegis Logo" width="128" />
  <h1>🛡️ Aegis — Enterprise RBI + VPN</h1>
  <p><strong>Next-Generation Self-Hosted Secure Routing & Remote Browser Isolation</strong></p>

  <img src="https://img.shields.io/badge/version-1.0.0-blue.svg" alt="Version" />
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License" />
  <img src="https://img.shields.io/badge/Chrome_Extension-MV3-orange.svg" alt="Chrome Extension" />
  <img src="https://img.shields.io/badge/Docker-Supported-2496ED.svg" alt="Docker" />
</div>

<hr/>

## ✨ Introduction

A self-hosted, on-premises system that brings zero-trust security to your enterprise through a **single, lightweight Chrome extension**. Aegis provides:

1. 🌐 **Secure Routing ("VPN"):** Browser traffic is intelligently routed through an internal forward-proxy gateway with a single toggle. HTTPS is safely tunneled, not decrypted—meaning **no intrusive certificates on client devices**.
2. 🔒 **Remote Browser Isolation (RBI):** High-risk browsing is containerized inside a disposable Docker environment **on the server**. Users receive a seamless, interactive pixel stream (noVNC). Nothing executes locally, and containers vanish when closed.

*Everything runs on your own infrastructure with zero external dependencies.*

---

## 📦 Download the Extension

Ready to get started on the client-side? You can download the packaged extension directly from this repository:

**📥 [Download Aegis Chrome Extension (rbi-extension.zip)](./rbi-extension.zip)**

### Installation Steps (Client)
1. Download and extract the `rbi-extension.zip` file.
2. Open Google Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top right).
4. Click **Load unpacked** and select the extracted folder.
5. Pin the **Aegis** shield icon 🛡️ to your toolbar for easy access!

---

## 🏗️ Architecture & What's Included

```text
enterprise-rbi-vpn/
├── backend/            # Docker Compose stack (run on the host)
└── chrome-extension/   # MV3 extension source code (packaged above)
```

**Core Services Engine:**
- `nginx` (Edge Reverse Proxy)
- `session-broker` (API + Auth + Capacity Management)
- `rbi-manager` (Spawns Browser Containers On-Demand)
- `ws-relay` (noVNC WebSockets Bridge)
- `proxy-gateway` (Forward Proxy for VPN Routing)
- `vpn-server` (Optional OS-Level WireGuard)

---

## 🚀 Server Setup (Backend Host)

> **Reference Host:** Kali Linux (or Debian/Ubuntu), AMD Ryzen 3 / Intel i3+, 4-8 GiB RAM.

### 1️⃣ Install Docker Engine

```bash
# Update and install dependencies
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

# Add Docker's official GPG key & repo
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" | sudo tee /etc/apt/sources.list.d/docker.list

# Install Docker
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Enable daemon and add user to docker group (Log out and back in after this!)
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

### 2️⃣ Configure Environment

```bash
cd enterprise-rbi-vpn/backend
cp .env.example .env

# Generate a strong cryptographic token for authentication
TOKEN=$(openssl rand -hex 32)
sed -i "s|^SESSION_TOKEN=.*|SESSION_TOKEN=${TOKEN}|" .env
echo "🔐 Your access token (share with team): ${TOKEN}"
```

### 3️⃣ Build and Launch Services

```bash
# Build the on-demand browser image
docker build -t rbi-browser:latest -f rbi-service/Dockerfile.browser rbi-service/

# Bring up the core Aegis stack
docker compose up -d --build

# Verify running services
docker compose ps
```

### 4️⃣ Health Checks & Network Details

```bash
# Edge Health
curl -s http://localhost:8080/healthz

# Broker API Health (Using your token)
curl -s -H "Authorization: Bearer ${TOKEN}" http://localhost:8080/api/status | jq .

# Proxy Gateway Health
curl -s http://localhost:3128/__health

# Get your Server IP (for team onboarding)
ip -4 addr show wlan0 | awk '/inet /{print $2}' | cut -d/ -f1
```

---

## 🛡️ Team Member Zero-Config Onboarding

Once the server is running and the extension is installed, users configure Aegis in seconds:

1. Click the **Aegis** icon in the toolbar, then click the **Gear (Settings)**.
2. Enter the **Gateway Server IP** (from Step 4) and the **Access Token**.
3. Click **Test connection** (it should turn green 🟢).
4. Click **Save**.

**Using Aegis:**
- 🛡️ **Secure Routing**: Toggle **ON** to instantly tunnel browser traffic through the corporate proxy. No OS-level changes.
- 🌍 **Remote Browsing**: Click **Open Remote Browsing Session** to safely visit high-risk sites in a disposable container. 

---

## 🛠️ Operations & Troubleshooting

Administrators can effortlessly manage the stack:

```bash
# View live logs of all services
docker compose logs -f

# Restart a specific service
docker compose restart session-broker

# Shut down the entire stack
docker compose down

# Wipe stray browser containers (Auto-cleaned normally)
docker rm -f $(docker ps -aq --filter "label=erv.role=rbi-browser") 2>/dev/null
```

### ⚙️ Performance Tuning (`.env`)

Tweak container resource limits based on your hardware. Apply changes with `docker compose up -d`.

| Variable | Description | Default |
|---|---|---|
| `MAX_CONCURRENT_SESSIONS` | Maximum simultaneous isolated browsers | `12` |
| `SESSION_MEM_LIMIT_MB` | RAM limit per disposable session | `380` |
| `SESSION_CPU_QUOTA` | CPU cores allocated per session | `0.5` |
| `SESSION_TTL_SECONDS` | Idle timeout before auto-destruct | `1800` |

---

<div align="center">
  <sub>Built for Security Teams. Designed for Humans. 🔒</sub>
</div>
