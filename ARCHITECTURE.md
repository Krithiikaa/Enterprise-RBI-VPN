# ARCHITECTURE.md — Aegis Enterprise RBI & VPN

This document describes the system architecture, the capacity of the
reference development machine, where the system breaks under load, how to
scale it to production fleets of 100 and 500 concurrent users, and the
security posture of the deployment as shipped.

---

## 1. System Architecture

### 1.1 Request / data flow

```
                            CLIENT MACHINE (thin client — pixels only)
 ┌──────────────────────────────────────────────────────────────────────┐
 │  Chrome + Aegis MV3 Extension                                          │
 │   • popup  → toggle VPN, "Remote Browsing Session"                     │
 │   • service-worker → chrome.proxy (fixed_servers), session lifecycle   │
 │   • viewer tab → noVNC client (canvas, keyboard, mouse)                │
 └───────┬───────────────────────────────────────────┬──────────────────┘
         │  (1) HTTPS/WS control + pixels             │  (2) VPN egress
         │      to the edge                           │      when toggle ON
         ▼                                            ▼
 ┌───────────────────────┐                  ┌───────────────────────────┐
 │  NGINX  (edge :8080)   │                  │  PROXY-GATEWAY (:3128)     │
 │  reverse proxy / LB    │                  │  forward proxy            │
 │   /api/   → broker     │                  │   • HTTP forward          │
 │   /vnc/   → ws-relay   │                  │   • HTTPS CONNECT tunnel  │
 │   /viewer/→ ws-relay   │                  │     (raw TCP, no MITM)    │
 │   /healthz             │                  │   • optional Basic auth   │
 └───┬──────────────┬─────┘                  │   • optional upstream →   │
     │              │                        │     VPN-SERVER (WireGuard)│
     ▼              ▼                        └─────────────┬─────────────┘
 ┌─────────────┐  ┌──────────────────┐                    │
 │ SESSION-    │  │  WS-RELAY (:9200) │                    ▼
 │ BROKER      │  │  • serves viewer  │            ┌───────────────┐
 │ (:9000)     │  │  • serves noVNC   │            │   INTERNET /  │
 │ • auth      │  │  • bridges /vnc/  │            │   internal    │
 │ • capacity  │  │    WS ⇄ websockify│            │   network     │
 │ • lifecycle │  └─────────┬─────────┘            └───────────────┘
 └──────┬──────┘            │
        │ REST              │ resolves target container by name
        ▼                   │ erv-browser-<id>:6080
 ┌─────────────────────┐    │
 │ RBI-MANAGER (:9100)  │   │
 │ • dockerode spawner  │   │
 │ • TTL reaper         │   │
 │ • orphan sweep       │   │
 └──────────┬───────────┘   │
            │ docker run     │
            ▼                ▼
 ┌────────────────────────────────────────────────────────────────┐
 │  PER-SESSION BROWSER CONTAINER  (rbi-browser:latest)             │
 │  Xvfb → fluxbox → chromium (--no-sandbox, kiosk)                 │
 │  → x11vnc (-localhost) → websockify :6080                        │
 │  one container per user, AutoRemove, capped RAM/CPU/shm, TTL     │
 │  attached to rbi-net; reachable only via ws-relay loopback path  │
 └────────────────────────────────────────────────────────────────┘
```

### 1.2 Linear control path (prompt Section 7 form)

```
Client Browser → Extension → Nginx → Session Broker → RBI Manager
              → RBI Container (Chromium) → Internet
                                   ↑
              Pixels stream back:  RBI Container → websockify
                                   → WS-Relay → Nginx → Extension viewer
```

### 1.3 Service responsibilities

| Service        | Port  | Role                                                              |
|----------------|-------|-------------------------------------------------------------------|
| nginx          | 8080  | Edge reverse proxy / load balancer; routes API, viewer, /vnc WS.  |
| session-broker | 9000  | Public API, Bearer-token auth, capacity policy, lifecycle gateway.|
| rbi-manager    | 9100  | Spawns/destroys per-session browser containers via Docker socket. |
| ws-relay       | 9200  | Serves noVNC viewer + client, bridges browser WS to websockify.   |
| proxy-gateway  | 3128  | Forward proxy: HTTP forward + HTTPS CONNECT tunnel; VPN egress.   |
| vpn-server     | —     | WireGuard endpoint for full-device VPN (optional OS-level path).  |

Two Docker networks isolate planes: `edge-net` (nginx ⇄ broker/relay) and
`rbi-net` (relay/proxy ⇄ spawned browser containers). Browser containers are
never published to the host; they are reachable only by Docker DNS name on
`rbi-net`, and x11vnc binds loopback so only the in-container websockify can
attach.

### 1.4 The "VPN" toggle

The extension does **not** install a system service. ON =
`chrome.proxy.settings.set` with `fixed_servers` pointing at the
proxy-gateway, plus a `bypassList` for the edge host and localhost so control
and pixel traffic never loop through the proxy. OFF =
`chrome.proxy.settings.clear`, leaving no trace. An OS-level full-device VPN
is available separately through the bundled WireGuard server for teams that
need all device traffic tunneled, not just the browser.

---

## 2. Current Machine Capacity (reference dev host)

Reference host: AMD Ryzen 3 7320U (4 cores / 8 threads), ~7.2 GiB RAM,
~3.2 GiB swap, Kali Linux, Docker engine.

### 2.1 Per-container budget (as shipped in `.env.example`)

| Resource         | Per session | Source                       |
|------------------|-------------|------------------------------|
| Memory hard cap  | 380 MB      | `SESSION_MEM_LIMIT_MB=380`   |
| CPU quota        | 0.5 vCPU    | `SESSION_CPU_QUOTA=0.5`      |
| /dev/shm         | 256 MB      | `SESSION_SHM_MB=256`         |
| Idle TTL         | 1800 s      | `SESSION_TTL_SECONDS=1800`   |
| Concurrency cap  | 12          | `MAX_CONCURRENT_SESSIONS=12` |

### 2.2 Memory math

```
Host RAM total                 ~7.2  GiB  (~7370 MB)
OS + Xfce + Docker engine      ~1.6  GiB  reserved
Backend services (6 × ~80MB)   ~0.5  GiB  nginx/broker/manager/relay/proxy/wg
Usable for sessions            ~5.1  GiB  (~5220 MB)

5220 MB / 380 MB per session  ≈ 13.7 theoretical sessions
Configured ceiling            = 12 sessions   ← deliberately under theoretical
```

The 380 MB cap is the limiting term. Twelve concurrent isolated browsers fit
inside usable RAM with a safety margin before swap is touched. The cap is set
to 12 rather than 13–14 so a single heavy page (media-rich site, many tabs)
cannot push total usage into swap, which would degrade every session at once.

### 2.3 CPU headroom

8 threads × 0.5 vCPU quota = capacity for ~16 "fully busy" sessions on paper,
but real Chromium rendering is bursty. At 12 sessions, simultaneous heavy
renders (video, complex CSS, JS-heavy SPAs) can saturate all cores briefly.
Interactivity stays acceptable because load rarely peaks across all sessions
at the same instant; sustained all-session video is the worst case.

### 2.4 Practical verdict

- **Comfortable:** 6–8 concurrent sessions doing normal browsing.
- **Configured maximum:** 12 sessions (RAM-bounded, with headroom).
- **Degradation point:** beyond ~12, RAM crosses into swap → all sessions
  stutter; CPU contention compounds it. The broker rejects new sessions at
  the cap rather than overcommitting, so the machine never thrashes.

This is a **development / pilot** capacity. It demonstrates the full system
end-to-end for a small team; it is not the 100-user production target, which
requires the fleet design in Section 4.

---

## 3. Bottleneck Analysis

Ordered by which limit is hit first as concurrent users climb.

1. **RAM (first to break).** Each browser is ~380 MB capped; real Chromium
   wants more for heavy pages. On the dev host, RAM is exhausted at ~12–14
   sessions. Past that the kernel swaps, latency spikes across every session
   simultaneously, and the experience collapses non-gracefully — which is why
   the broker enforces a hard ceiling instead of letting it happen.

2. **CPU (close second under active use).** Chromium rendering and video
   decode are CPU-heavy. Even with RAM available, 12 simultaneously *active*
   sessions can saturate 8 threads during render bursts, raising input-to-
   pixel latency. CPU becomes the binding constraint before RAM only when
   sessions are unusually compute-heavy (continuous video on all of them).

3. **Single Docker host / control plane (structural ceiling).** The
   rbi-manager spawns containers on one engine via one socket, and session
   state lives in an in-memory `Map`. This is fine for one host but is the
   hard wall for horizontal growth: you cannot exceed one machine's RAM/CPU,
   and state is lost if the manager restarts. Removing this is the central
   change for production (Section 4).

4. **WS-relay fan-out (high-scale concern).** Every session streams pixels
   through ws-relay. At hundreds of concurrent high-FPS streams a single
   relay's network and event loop saturate; relays must be scaled out and
   placed near the browser nodes.

5. **Network egress / proxy-gateway (load-dependent).** All VPN-ON traffic
   funnels through one proxy process. Heavy download workloads make its
   bandwidth and connection table the limit; it scales horizontally behind a
   load balancer once it matters.

**Summary:** on a single host, **RAM is the first wall (~12 users)**. To go
beyond one host, the **in-memory state + single-engine spawner** is the
structural bottleneck that must be re-architected.

---

## 4. Production Scaling Specification

The single-host design is kept intentionally simple for the dev machine. To
serve 100 or 500 concurrent users, the topology changes from "one box runs
everything" to "a control plane orchestrates a fleet of browser nodes."

### 4.1 Architectural changes required

1. **Externalize session state.** Replace the in-memory `Map` in broker and
   manager with a shared store (Redis or equivalent): session id → assigned
   node, container id, owner, TTL. This makes the control plane stateless and
   restart-safe, and lets multiple broker/manager replicas cooperate.
2. **Separate control plane from browser nodes.** Broker, manager-coordinator,
   nginx, relays, and Redis run on small control nodes. Browsers run on
   dedicated **browser nodes**, each running a manager-agent that spawns
   containers locally. The coordinator places sessions on the least-loaded
   node.
3. **Autoscale browser nodes.** Track aggregate RAM headroom; add nodes when
   utilization crosses a threshold, drain and remove them when idle. Each node
   advertises capacity = usable RAM / per-session cap.
4. **Scale ws-relay horizontally** and co-locate relays with browser nodes to
   keep pixel traffic on the internal network; load-balance viewer/WS at the
   edge with sticky routing per session id.
5. **Scale proxy-gateway** behind the edge LB; run WireGuard with multiple
   peers / HA if OS-level VPN is in scope.
6. **Per-user identity.** Replace the single shared `SESSION_TOKEN` with SSO
   (OIDC/SAML) at the broker so sessions are attributable and quota-able per
   user (see Section 5).

### 4.2 100-user server spec

Assume ~600 MB per session in production (more generous than the 380 MB dev
cap, to handle real pages comfortably).

| Option | Topology | Aggregate spec |
|--------|----------|----------------|
| Single large node | 1 host runs everything | 64 vCPU, 96–128 GB RAM, NVMe, 1 Gbps |
| Fleet (recommended) | 1 control node + 3–4 browser nodes | control: 8 vCPU / 16 GB; each browser node: 16 vCPU / 32 GB hosting ~30 sessions |

- 100 × 600 MB ≈ 60 GB session RAM + overhead → ~96 GB on a single node, or
  ~25–30 sessions per 32 GB browser node across 3–4 nodes in the fleet.
- The fleet option is recommended even at 100 users because it removes the
  single-host failure mode and is the same shape you grow into for 500.

### 4.3 500-user server spec

Single-host is no longer viable; fleet is mandatory.

| Component | Spec / count |
|-----------|--------------|
| Control plane | 2× (8 vCPU / 16 GB) for HA — broker, coordinator, nginx |
| Redis | 1 small HA pair (4 GB) for session registry |
| Browser nodes | ~16 nodes × (16 vCPU / 32 GB), ~30 sessions each = ~480, plus headroom node(s) |
| WS-relay | co-located on browser nodes or 3–4 dedicated relay nodes |
| Proxy-gateway | 2–3 instances behind LB |
| Aggregate | ~300 GB session RAM, ~280 vCPU across the fleet |

### 4.4 AWS equivalent cost estimate (rough, on-demand, us-east-1)

Indicative only; spot, reservations, and savings plans cut this substantially.

| Scale | Instances (example) | ~Monthly on-demand |
|-------|--------------------|--------------------|
| Dev / pilot (12) | 1× t3.xlarge (4 vCPU / 16 GB) | ~$120 |
| 100 users (fleet) | 1× m6i.2xlarge control + 4× m6i.2xlarge browser + small Redis | ~$1,400–1,800 |
| 100 users (single) | 1× r6i.4xlarge (16 vCPU / 128 GB) | ~$1,000–1,200 |
| 500 users (fleet) | 2× m6i.2xlarge control + 16× m6i.2xlarge browser + ElastiCache + ALB + egress | ~$6,500–9,000 |

Drivers: browser-node compute dominates; data egress (pixel streams stay
internal, but VPN egress to the internet is billed) and ALB/relay bandwidth
are the next largest line items at 500 users. Autoscaling to actual concurrent
(not provisioned) usage typically saves 30–50%.

---

## 5. Security Posture Summary

### 5.1 What is protected

- **True server-side isolation.** Pages execute only inside the per-session
  container on the server. The client renders pixels via noVNC and sends only
  input events — no page code, scripts, or downloads touch the user's machine.
  This is the core RBI guarantee and it is enforced architecturally.
- **Ephemeral, sandboxed sessions.** One container per user, capped RAM/CPU/
  shm, `AutoRemove`, idle TTL reaper, and a boot-time orphan sweep
  (`erv.role=rbi-browser`). Compromise of a page is confined to a short-lived
  container that is destroyed on tab close or timeout.
- **No silent TLS interception, no hidden root CA.** The proxy-gateway tunnels
  HTTPS via `CONNECT` as raw TCP and never decrypts it. **No certificate is
  ever installed on any client.** This is a deliberate design choice: Chrome
  forbids extensions from silently trusting a root CA (a security boundary we
  refuse to subvert), and a routing proxy does not need to. End-to-end TLS
  between the browser and the destination stays intact.
- **Network segmentation.** `edge-net` and `rbi-net` separate the control
  plane from browser containers. Browser containers are never published to the
  host; x11vnc binds `-localhost` so only the in-container websockify can
  attach to the VNC port.
- **Authenticated control plane.** The broker requires a Bearer token with a
  timing-safe comparison; session ids are random and capability-scoped for
  heartbeat/teardown.
- **Reduced container privilege.** Browser containers drop capabilities and
  run the browser as a non-root kiosk user under `dumb-init`.
- **No external runtime dependencies.** noVNC is bundled into the relay image;
  the system runs air-gapped on an internal network once images are built.

### 5.2 Remaining risks (as shipped, for dev/pilot)

- **`x11vnc -nopw`.** The VNC server has no password; it relies on loopback
  binding and the per-session network path for protection. If the loopback/
  network assumption is broken, the VNC stream is unauthenticated.
- **`chromium --no-sandbox`.** Chromium's own sandbox is disabled inside the
  container (it conflicts with the container runtime without extra config).
  Defense rests on the container boundary and dropped capabilities, not
  Chromium's internal sandbox.
- **Single shared `SESSION_TOKEN`.** All users present the same token; sessions
  are not attributable to individuals and one leaked token authorizes anyone
  on the network to create sessions.
- **In-memory session state.** A manager/broker restart loses the session
  registry (containers are still reaped by sweep, but mappings are dropped).
- **Proxy-gateway auth optional.** If `PROXY_USER/PASS` are unset, anyone who
  can reach :3128 can use the forward proxy.

### 5.3 Production mitigations

- **Per-user identity & SSO.** Replace the shared token with OIDC/SAML at the
  broker; attribute and quota every session to a user; enable audit logging.
- **VNC authentication.** Enable x11vnc passwords (or per-session one-time
  tokens) and/or wrap the VNC path in mutual TLS, in addition to loopback
  binding.
- **Harden browser images.** Pin and scan base images, enable seccomp/AppArmor
  profiles, run read-only root filesystems where possible, and re-enable a
  Chromium sandbox strategy compatible with the runtime (e.g. user namespaces).
- **Mandatory proxy auth & egress policy.** Require proxy credentials, apply
  per-user egress allow/deny lists, and rate-limit.
- **Externalized, HA state.** Move session registry to Redis (Section 4) for
  restart-safety and multi-replica control.
- **TLS inspection, if ever required, done correctly.** If the organization
  genuinely needs to inspect TLS, deploy the root CA transparently via MDM /
  Group Policy on managed devices with full user disclosure — **never** hidden
  inside an extension. The extension intentionally does not and cannot do this.

### 5.4 Posture verdict

As shipped, the system is a sound **development/pilot** deployment: the RBI
isolation guarantee is real and architecturally enforced, traffic routing is
honest (no covert MITM), and the control plane is authenticated. The listed
residual risks are all acceptable for an internal pilot and each has a clear,
standard production mitigation. Closing the per-user identity, VNC auth, and
image-hardening items is the prerequisite before exposing the system to a
large or untrusted user population.
