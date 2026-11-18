import type { CallRow, EventRow, PinRow, SessionRow } from "./store.js";

const STATUS_LABEL: Record<string, string> = {
  ok: "ok",
  error: "ERROR",
  tool_error: "TOOL ERROR",
  cancelled: "cancelled",
  no_response: "NO RESPONSE",
  pending: "pending",
  blocked: "BLOCKED",
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

export function formatPins(pins: PinRow[]): string {
  if (pins.length === 0) return "No tools pinned yet. Pins are created the first time a server lists its tools.";
  const rows = pins.map((p) => [
    p.server_name,
    p.tool_name,
    p.pending_hash ? (p.approved_hash ? "CHANGED, blocked" : "NEW, needs approval") : "pinned",
    p.approved_hash ? p.approved_hash.slice(0, 12) : "",
    p.pending_hash ? p.pending_hash.slice(0, 12) : "",
    p.approved_at ? time(p.approved_at) : "",
  ]);
  return table(["SERVER", "TOOL", "STATE", "PINNED HASH", "PENDING HASH", "APPROVED"], rows);
}

export function formatEvents(events: EventRow[]): string {
  if (events.length === 0) return "No security events yet.";
  const rows = [...events]
    .reverse()
    .map((e) => [
      time(e.at),
      e.server_name,
      e.kind,
      e.tool_name ?? "",
      (e.detail ?? "").replace(/\s+/g, " ").slice(0, 90),
    ]);
  return table(["TIME", "SERVER", "EVENT", "TOOL", "DETAIL"], rows);
}

/** Pretty JSON with sorted keys, so two definitions line up for diffing. */
function pretty(def: string | null): string[] {
  if (!def) return [];
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([k, x]) => [k, sort(x)]),
          )
        : v;
  const obj = sort(JSON.parse(def)) as Record<string, unknown>;
  // Show descriptions line by line: that is where poisoned instructions usually hide.
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.includes("\n")) {
      lines.push(`${k}:`);
      for (const l of v.split("\n")) lines.push(`  | ${l}`);
    } else {
      for (const l of `${k}: ${JSON.stringify(v, null, 2)}`.split("\n")) lines.push(l);
    }
  }
  return lines;
}

/** Line diff (longest common subsequence) of the approved and pending definitions. */
export function formatDiff(pin: PinRow): string {
  if (!pin.pending_def) return `${pin.server_name}/${pin.tool_name} has no pending change.`;
  const a = pretty(pin.approved_def);
  const b = pretty(pin.pending_def);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const at = (i: number, j: number) => dp.at(i)?.at(j) ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      (dp.at(i) as number[])[j] = a.at(i) === b.at(j) ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a.at(i) === b.at(j)) {
      out.push(`  ${a.at(i)}`);
      i++;
      j++;
    } else if (i < n && (j >= m || at(i + 1, j) >= at(i, j + 1))) {
      out.push(`- ${a.at(i)}`);
      i++;
    } else {
      out.push(`+ ${b.at(j)}`);
      j++;
    }
  }
  const header = pin.approved_def
    ? `${pin.server_name}/${pin.tool_name}: changes since it was approved (- approved, + now)`
    : `${pin.server_name}/${pin.tool_name}: new tool awaiting approval`;
  return `${header}\n\n${out.join("\n")}\n\nApprove with: agentoverwatch approve ${pin.server_name} ${pin.tool_name}`;
}
