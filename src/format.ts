import type { CallRow, SessionRow } from "./store.js";

const STATUS_LABEL: Record<string, string> = {
  ok: "ok",
  error: "ERROR",
  tool_error: "TOOL ERROR",
  cancelled: "cancelled",
  no_response: "NO RESPONSE",
  pending: "pending",
};

function time(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r.at(i) ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths.at(i) ?? 0))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

export function formatCalls(calls: CallRow[]): string {
  if (calls.length === 0) return "No calls logged yet.";
  const rows = [...calls]
    .reverse()
    .map((c) => [
      time(c.started_at),
      c.session_id.slice(0, 8),
      c.server_name,
      c.direction === "agent_to_server" ? "→" : "←",
      c.tool_name ? `tools/call ${c.tool_name}` : c.method,
      STATUS_LABEL[c.status] ?? c.status,
      c.duration_ms === null ? "" : `${Math.round(c.duration_ms)} ms`,
      c.error_message ? c.error_message.replace(/\s+/g, " ").slice(0, 60) : "",
    ]);
  return table(["TIME", "SESSION", "SERVER", "DIR", "METHOD", "STATUS", "LATENCY", "DETAIL"], rows);
}

export function formatSessions(sessions: SessionRow[]): string {
  if (sessions.length === 0) return "No sessions logged yet.";
  const rows = sessions.map((s) => [
    s.id.slice(0, 8),
    time(s.started_at),
    s.server_name,
    s.client_name ? `${s.client_name} ${s.client_version ?? ""}`.trim() : "",
    String(s.call_count ?? 0),
    String(s.error_count ?? 0),
    s.ended_at === null ? "running" : `exited ${s.exit_code ?? "?"}`,
  ]);
  return table(["SESSION", "STARTED", "SERVER", "CLIENT", "CALLS", "PROBLEMS", "STATE"], rows);
}
