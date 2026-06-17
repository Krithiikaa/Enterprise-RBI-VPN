// Precision RBI — admin API client  [SRV-10]
const base = "";

async function get(path) {
  const r = await fetch(base + path, { headers: { Accept: "application/json" } });
  if (r.status === 401) throw new Error("unauthorized");
  return r.json();
}

export const api = {
  dashboard: () => get("/api/dashboard"),
  events: (page = 1, limit = 50) => get(`/api/events?page=${page}&limit=${limit}`),
  endSession: (sessionId) =>
    fetch("/api/end-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).then((r) => r.json()),
};
