# Precision RBI — Architecture

> Scope note: this document is honest about what this build can and cannot do
> versus a production Zscaler deployment. Where the original spec assumed
> something that is technically impossible (silent CA injection from an
> extension) or optimistic (512 MB RBI sessions), this document states the real
> constraint and the chosen resolution. Sections marked **(GAP)** are deliberate.

---

## 1. System architecture diagram

```
                          TEAM MEMBER MACHINE
  ┌───────────────────────────────────────────────────────────────┐
  │  Chrome (MV3)                                                    │
  │  ┌──────────────┐   ┌───────────────┐   ┌────────────────────┐ │
  │  │ service-worker│   │ content-script │   │ rbi-viewer tab     │ │
  │  │  - PAC proxy  │   │  - DLP/BDR     │   │  - noVNC canvas    │ │
  │  │  - heartbeat  │   │    telemetry   │   │  - pixels only     │ │
  │  │  - teardown A │   │  - watermark   │   │  - teardown C(src) │ │
  │  └──────┬───────┘   └───────┬────────┘   └─────────┬──────────┘ │
  └─────────┼──────────────────┼──────────────────────┼────────────┘
            │ PAC: PROXY        │ POST /api/bdr-event   │ wss:// pixels
            │ host:8080         │                       │
   ─ ─ ─ ─ ─│─ ─ ─ ─ ─ ─ WireGuard split tunnel (10.225.244.0/24) ─ ─
            ▼                   ▼                       ▼
  ┌───────────────────────────────────────────────────────────────┐
  │                    KALI HOST  (docker compose)                  │
  │                                                                 │
  │   nginx :443  ── TLS term ─┬─ /rbi/*  ─────► session-broker     │
  │   (rate limit, WS upgrade) ├─ /proxy  ─────► proxy-service       │
  │                            ├─ /api/bdr ────► bdr-service         │
  │                            └─ /admin   ────► admin-console       │
  │                                                                 │
  │   proxy-service :8080 (MITM) :8888 (PAC)                         │
  │      │ per request: extract URL/headers                         │
  │      ├──────────────► ssl-inspector ──► ml-engine :8001 ──┐      │
  │      │                (decrypt, features)  (score 0-100)  │      │
  │      │                                    redis (1h cache)◄┘      │
  │      ▼ decision by score + policy                               │
  │   ┌─────────┬───────────────────┬──────────────────────┐        │
  │   │ ALLOW   │ ISOLATE (>thr)    │ BLOCK (>block_thr)    │        │
  │   │ forward │ redirect to RBI   │ return block page     │        │
  │   └─────────┴─────────┬─────────┴──────────────────────┘        │
  │                       ▼                                          │
  │          session-broker :3001 ── docker.sock ──► RBI pool        │
  │            - spawn rbi-container (rbi-net, internal)             │
  │            - watchdog (teardown B)                              │
  │            - WS bridge  (teardown C)                            │
  │                       │                                          │
  │     ┌─────────────────┴───────────────┐  rbi-net (NO LAN egress)│
  │     │ rbi-container  (1 per session)   │                         │
  │     │  Xvfb → Chromium → x11vnc        │  the ONLY thing that    │
  │     │  → websockify → noVNC :6080      │  ever runs hostile JS   │
  │     └──────────────────────────────────┘                        │
  │                                                                 │
  │   redis  •  sandbox(ClamAV)  •  bdr-service  •  admin-console    │
  │   vpn-server (WireGuard udp/51820)                              │
  └───────────────────────────────────────────────────────────────┘
```

---

## 2. Request lifecycle

### ALLOW path (low risk)
1. Browser issues request; PAC sends it to `proxy-service:8080`.
2. proxy-service terminates/relays, hands URL + headers (and, for HTTPS it can
   decrypt, the body snippet) to `ssl-inspector`.
3. ssl-inspector builds a feature bundle and `POST /score` to `ml-engine`.
4. ml-engine returns `{ score, category, reason }`; score < `ISOLATE_THRESHOLD`.
5. proxy-service forwards the original request upstream and streams the response
   back to the browser unchanged. Decision is written to the audit log.

### ISOLATE path (risky)
1–4. As above, but `score >= ISOLATE_THRESHOLD` (and `< BLOCK_THRESHOLD`).
5. proxy-service returns an interstitial / 307 to the extension, which calls
   `POST /rbi/api/start-session`.
6. session-broker checks `MAX_SESSIONS`, allocates a host port, `docker run`s an
   `rbi-container` on `rbi-net` (internal, no LAN egress), returns `{ wsUrl }`.
7. The container loads the risky URL in its **own** Chromium. Hostile JS executes
   **inside the container**, never on the user machine.
8. x11vnc → websockify → noVNC stream the framebuffer; the viewer tab renders
   pixels on a canvas. Keyboard/mouse events go the other way. Only pixels and
   input cross the trust boundary.
9. Teardown fires by whichever of A/B/C happens first (see §3).

> `BLOCK` path: proxy-service returns a styled block page; nothing is rendered
> or isolated.

---

## 3. Security model

**Trust boundary.** The user's machine is *untrusted to run remote code* and the
server is the enforcement point. The single architectural guarantee (HC-01) is:
**code from an isolated site executes only inside its `rbi-container`; the client
receives pixels and sends input — never executable content.** `rbi-net` is a
Docker `internal` network, so a compromised container cannot reach the host LAN
or the internet; it can only talk to session-broker's WS bridge.

**What never reaches the user machine:** isolated-site JavaScript, DOM, cookies,
downloaded files (those go to the sandbox), and any site-set local storage. The
viewer canvas is the only surface, and it carries no executable payload.

**CA cert scope and the silent-injection reality (correction to HC-03).**
A Chrome extension **cannot** install a trusted root CA — Chrome exposes no API
for it, by design. Consequences and the chosen resolution:

| Traffic | Needs client to trust proxy CA? | How it works here |
|---|---|---|
| Plain HTTP | No | PAC routes it; inspected directly. |
| Risky HTTPS site (isolated) | **No** | Rendered server-side; client gets pixels. The MITM/cert problem is sidestepped entirely. |
| Non-isolated HTTPS that you want fully inspected | **Yes** | Requires the CA trusted via OS keystore / MDM / GPO on a **managed device**. The extension cannot do this silently. |

So the extension genuinely delivers zero-config for the *proxy routing* and the
*isolation* path. Full TLS inspection of normal traffic is a **managed-device
feature**, not an extension feature. The generated CA (`./ca`, created at first
boot) is for that managed-device deployment and is scoped to internal use only;
its private key never leaves the host and should be rotated per the README.

**Docker socket exposure.** session-broker mounts `/var/run/docker.sock` to spawn
sibling containers — this is effectively host-root and is the most sensitive part
of the system. It is mitigated by: keeping session-broker on internal networks
only, dropping all caps on spawned containers (`CapDrop: ALL`,
`no-new-privileges`), and never passing user-controlled strings into image names
or command arrays. For production, replace the raw socket with a brokered proxy
(e.g. a hardened `docker-socket-proxy` allow-listing only create/start/stop/rm).
**(GAP vs production.)**

**Session isolation guarantees.** One container per session, `AutoRemove`, tmpfs
for `/tmp` and `/run`, memory + CPU caps, no shared volumes. Nothing persists
between sessions.

**Three independent teardown paths (HC-05).** All call the same idempotent
`endSession()`; the first to fire claims the session, the rest no-op:
- **A — tab close:** `chrome.tabs.onRemoved` → `POST /api/end-session`.
- **B — heartbeat watchdog:** server reaps any session silent for
  `HEARTBEAT_TIMEOUT_MS` (covers crashed client, killed laptop, lost network).
- **C — WebSocket disconnect:** the noVNC bridge `close` event tears down (covers
  viewer crash / network blip without tab close).
None depends on another being reachable.

---

## 4. Dev machine capacity analysis (Ryzen 3 7320U, 7.21 GiB RAM)

**Honest correction:** the spec's 512 MB/session is not survivable for a real
Chromium + Xvfb + x11vnc + websockify stack. Measured floor is ~700 MB idle and
800 MB–1.2 GB under a content-heavy page. We budget **1024 MB/session**.

RAM budget (steady state):

| Component | Reserved |
|---|---|
| OS + Xfce + zsh + Docker daemon | ~1.4 GB |
| redis | 0.32 GB |
| ml-engine (FastAPI + bundled blocklists) | 0.50 GB |
| proxy-service | 0.38 GB |
| ssl-inspector | 0.26 GB |
| sandbox (ClamAV resident) | 0.77 GB |
| bdr-service | 0.19 GB |
| admin-console | 0.26 GB |
| nginx + vpn-server | 0.26 GB |
| **Service + OS subtotal** | **~4.3 GB** |
| Free for RBI sessions | ~2.9 GB of 7.21 GB |

`floor(2.9 GB / 1.0 GB) ≈ 2–3` comfortable sessions; **3 is the safe ceiling,
4 is the hard cap (`MAX_SESSIONS=4`) and will push into swap under load.** This is
why the admin capacity gauge alerts at **75 %** (3/4) and the broker refuses the
5th session with HTTP 503.

> The spec's "5–8 sessions" assumed 512 MB and no ClamAV resident set. If you
> drop the `sandbox` service and cap pages, you can reach ~4 stable sessions.

CPU: 8 logical cores; each session capped at 0.5 vCPU. Three sessions = 1.5 vCPU
of the rendering load plus ~1 vCPU for proxy/ml under traffic — comfortable. **RAM
degrades first, not CPU.** First symptom under overload: swap thrash → noVNC frame
latency spikes → heartbeats miss → watchdog starts reaping. The gauge is there to
stop you before that point.

---

## 5. Production scaling specification

### 100 concurrent users
- **Minimum:** 32 vCPU / 128 GB RAM / 500 GB SSD. ~100 GB for sessions at 1 GB
  each, the rest for services + headroom + page bursts.
- **Recommended:** 48 vCPU / 192 GB RAM. Run RBI containers on dedicated render
  nodes separate from the control plane.
- **Architecture changes:** multiple stateless `session-broker` replicas behind
  nginx, all sharing Redis as the session registry (the broker is already written
  to persist to Redis and reconcile on boot, so this is mostly a deploy change);
  replace the raw docker.sock with a per-node socket-proxy; move the audit log
  off the local volume to Postgres or an object store.
- **AWS equivalent:** ~`c7i.12xlarge` (48 vCPU / 96 GB) is CPU-rich but RAM-light
  for this workload; `r7i.8xlarge` (32 vCPU / 256 GB) fits better. ~$1,500–2,000 /
  month on-demand, materially less on a 1-yr reserved/savings plan. Add a small
  control-plane instance (`m7i.large`) for nginx/broker/redis.

### 500 concurrent users
- **Minimum:** a small fleet — ~5–8 render nodes (`r7i.8xlarge` class) + a control
  plane, fronted by an NLB. ~500 GB RAM aggregate for sessions alone.
- **Kubernetes migration:** at this scale containers-per-session is better modeled
  as Pods. Each RBI session = a Pod with the resource caps from this build; a
  custom scheduler/operator replaces the broker's `docker run`; HPA on the render
  node group; Redis → managed (ElastiCache). The teardown logic ports directly —
  paths A/B/C become Pod delete + a liveness controller + a sidecar that watches
  the WS. Estimate $8k–15k/month depending on session duration and utilization.

---

## 6. Zscaler ZT Browser feature-parity table

| Zscaler ZT Browser feature | This build | Gap |
|---|---|---|
| Remote browser isolation (pixel streaming) | Chromium+Xvfb+x11vnc+noVNC per session | Zscaler uses a custom low-latency codec (DOM mirroring + adaptive pixel); noVNC is heavier and higher-latency. |
| ML-based isolation decision | ml-engine: URL features + bundled blocklists + content heuristics | Zscaler trains on a global telemetry corpus; ours is heuristics + static feeds. **(GAP)** |
| Inline SSL inspection | ssl-inspector (server-side) | Works only on managed devices for non-isolated TLS (CA trust). **(GAP, see §3)** |
| DLP (clipboard/download/print/watermark) | content-script + watermark overlay (isolation path enforced server-side) | Client-side controls are best-effort; OS-level capture is not preventable. **(GAP)** |
| File sandboxing | sandbox (ClamAV + static triage) | Zscaler detonates in full dynamic sandboxes; ours is static + signature. **(GAP)** |
| Browser detection & response (BDR) | bdr-service telemetry + threshold alerts | Detection signals are heuristic, not behaviorally modeled. |
| Zero-trust access / posture | WireGuard split tunnel + per-peer config | No device-posture / identity-provider integration. **(GAP)** |
| Admin policy + audit | admin-console (policy editor, audit log, capacity) | Single-tenant, no RBAC/SSO. **(GAP)** |
| Global PoP network | single self-hosted node | Out of scope by design. **(GAP)** |

---

## 7. Known limitations vs production Zscaler (honest assessment)

1. **Latency.** noVNC pixel streaming is noticeably laggier than Zscaler's
   purpose-built protocol, especially on video/scroll. Acceptable for risky-site
   isolation, not for primary browsing.
2. **SSL inspection requires managed devices.** The "silent, zero-import" promise
   only holds for proxy routing and the isolation path; full TLS inspection needs
   the CA pushed via MDM. Stated plainly because the spec assumed otherwise.
3. **Client-side DLP is best-effort.** Canvas/Notification hooks are telemetry and
   deterrents, not guarantees — OS screenshots, photos of the screen, and
   accessibility APIs bypass page JS entirely.
4. **Single node, no HA.** A host reboot drops all sessions; the broker reconciles
   and reaps orphans on boot but does not migrate live sessions.
5. **docker.sock is a privilege concentration point** (see §3) — fine for a lab,
   needs a socket-proxy before any real deployment.
6. **ML is heuristic.** Good for catching obvious phishing/obfuscation; it will
   both miss novel threats and occasionally over-isolate. Tune thresholds against
   your own traffic.
7. **Capacity is small by design** for this host: 3 safe / 4 hard-cap sessions.
   Horizontal scale is the answer, not vertical, past ~4.

---

*Legal/operational note:* SSL inspection and browser-activity logging capture
employee/user traffic. Deploy only on devices and users you are authorized to
monitor, with appropriate notice/consent and policy review. This is a control
question, not a code question, but it is the difference between an enterprise
security tool and surveillance.
