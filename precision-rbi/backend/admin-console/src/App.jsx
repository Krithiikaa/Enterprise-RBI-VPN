// Precision RBI — admin dashboard  [SRV-10]
import React, { useEffect, useState, useCallback } from "react";
import { api } from "./api.js";

const C = {
  navy: "#0a2342", mid: "#0d3b6e", mint: "#7fffd4", text: "#e8f4f8",
  dim: "#a8d8ea", danger: "#d85a30", success: "#1d9e75",
  border: "0.5px solid rgba(168,216,234,0.18)",
};
const card = { background: C.mid, border: C.border, borderRadius: 14, padding: 20 };

function Capacity({ cap }) {
  if (!cap) return null;
  const color = cap.ramPct >= 90 ? C.danger : cap.ramPct >= 75 ? C.mint : C.success;
  return (
    <div style={card}>
      <h3 style={{ color: C.mint, fontFamily: "Georgia,serif", margin: "0 0 14px" }}>System Capacity</h3>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <span>Active sessions</span><b>{cap.active} / {cap.max}</b>
      </div>
      <div style={{ height: 10, background: "rgba(0,0,0,.3)", borderRadius: 6, overflow: "hidden", marginBottom: 14 }}>
        <div style={{ width: `${Math.min(100, (cap.active / cap.max) * 100)}%`, height: "100%", background: color, transition: "width .3s" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <span>RAM (est.)</span><b>{(cap.ramUsedMb / 1024).toFixed(1)} / {(cap.ramTotalMb / 1024).toFixed(1)} GB</b>
      </div>
      <div style={{ height: 10, background: "rgba(0,0,0,.3)", borderRadius: 6, overflow: "hidden" }}>
        <div style={{ width: `${Math.min(100, cap.ramPct)}%`, height: "100%", background: color, transition: "width .3s" }} />
      </div>
      {cap.warn && <p style={{ color: C.danger, fontSize: 12, marginTop: 12 }}>⚠ Approaching capacity — new sessions may be refused (HTTP 503).</p>}
    </div>
  );
}

function Sessions({ sessions, onEnd }) {
  return (
    <div style={card}>
      <h3 style={{ color: C.mint, fontFamily: "Georgia,serif", margin: "0 0 14px" }}>Active RBI Sessions</h3>
      {!sessions.length && <p style={{ color: C.dim }}>No active sessions.</p>}
      {sessions.map((s) => (
        <div key={s.sessionId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: C.border }}>
          <div>
            <div style={{ fontFamily: "monospace", fontSize: 12 }}>{s.sessionId.slice(0, 8)} · {s.userId}</div>
            <div style={{ color: C.dim, fontSize: 11 }}>{s.ageSec}s · last ping {s.lastHeartbeatAgoSec}s ago</div>
          </div>
          <button onClick={() => onEnd(s.sessionId)} style={{ background: C.danger, color: "#fff", border: 0, borderRadius: 7, padding: "5px 11px", cursor: "pointer", fontSize: 12 }}>End</button>
        </div>
      ))}
    </div>
  );
}

function Alerts({ alerts }) {
  return (
    <div style={card}>
      <h3 style={{ color: C.mint, fontFamily: "Georgia,serif", margin: "0 0 14px" }}>Flagged Users</h3>
      {!alerts.length && <p style={{ color: C.dim }}>No active alerts.</p>}
      {alerts.map((a, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: C.border }}>
          <span style={{ fontFamily: "monospace" }}>{a.userId}</span>
          <span style={{ color: C.danger }}>{a.type} ×{a.count}</span>
        </div>
      ))}
    </div>
  );
}

function Events({ events }) {
  return (
    <div style={{ ...card, gridColumn: "1 / -1" }}>
      <h3 style={{ color: C.mint, fontFamily: "Georgia,serif", margin: "0 0 14px" }}>Recent BDR Events</h3>
      <div style={{ maxHeight: 280, overflow: "auto" }}>
        {!events.length && <p style={{ color: C.dim }}>No events logged.</p>}
        {events.map((e, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "150px 160px 70px 1fr", gap: 10, padding: "5px 0", borderBottom: C.border, fontSize: 12 }}>
            <span style={{ color: C.dim }}>{new Date(e.ts).toLocaleTimeString()}</span>
            <span style={{ color: e.known ? C.mint : C.danger }}>{e.type}</span>
            <span style={{ fontFamily: "monospace" }}>{e.userId}</span>
            <span style={{ color: C.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.url || ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [data, setData] = useState(null);
  const [events, setEvents] = useState([]);
  const [err, setErr] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const d = await api.dashboard();
      setData(d);
      const ev = await api.events(1, 50);
      setEvents(ev.events || []);
      setErr(null);
    } catch (e) { setErr(e.message); }
  }, []);

  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, [refresh]);

  const onEnd = async (id) => { await api.endSession(id); refresh(); };

  return (
    <div style={{ background: C.navy, color: C.text, minHeight: "100vh", fontFamily: "Montserrat,system-ui,sans-serif", padding: 28 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h1 style={{ fontFamily: "Georgia,serif", fontSize: 26, margin: 0 }}>Precision <span style={{ color: C.mint }}>RBI</span> · Admin</h1>
        <div style={{ fontSize: 12, color: C.dim }}>
          {data?.health?.status === "ok" ? <span style={{ color: C.success }}>● broker online v{data.health.version}</span> : <span style={{ color: C.danger }}>● broker offline</span>}
        </div>
      </header>
      {err && <div style={{ ...card, borderColor: C.danger, marginBottom: 16, color: C.danger }}>Error: {err} (check ADMIN_PASS / credentials)</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 16 }}>
        <Capacity cap={data?.capacity} />
        <Sessions sessions={data?.sessions || []} onEnd={onEnd} />
        <Alerts alerts={data?.alerts || []} />
        <Events events={events} />
      </div>
    </div>
  );
}
