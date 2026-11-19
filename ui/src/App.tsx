import { useEffect, useState } from "react";
import { approvePins, type Call, type Event, getJson, type Overview, type Pin, type Session, usePoll } from "./api";

type Tab = "overview" | "calls" | "events" | "pins" | "sessions";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "calls", label: "Calls" },
  { id: "events", label: "Security events" },
  { id: "pins", label: "Tool pins" },
  { id: "sessions", label: "Sessions" },
];

const time = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const ago = (ms: number) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

function useHashTab(): [Tab, (t: Tab) => void] {
  const read = () => (TABS.some((t) => `#${t.id}` === location.hash) ? (location.hash.slice(1) as Tab) : "overview");
  const [tab, setTab] = useState<Tab>(read);
  useEffect(() => {
    const on = () => setTab(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [tab, (t) => (location.hash = t)];
}

export function App() {
  const [tab, setTab] = useHashTab();
  const pins = usePoll<Pin[]>("/api/pins", 5000);
  const pending = pins.data?.filter((p) => p.state !== "pinned").length ?? 0;
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/90 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-2 font-semibold">
            <svg viewBox="0 0 32 32" className="h-6 w-6" aria-hidden="true">
              <path d="M16 2 4 7v8c0 7.5 5.1 13.7 12 15 6.9-1.3 12-7.5 12-15V7z" className="fill-emerald-500" />
              <path d="m11 16 3.5 3.5L21.5 12" className="fill-none stroke-white" strokeWidth="2.5" />
            </svg>
            AgentOverwatch
          </div>
          <nav className="-mx-1 flex gap-1 overflow-x-auto text-sm">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`whitespace-nowrap rounded-md px-3 py-1.5 ${
                  tab === t.id
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                }`}
              >
                {t.label}
                {t.id === "pins" && pending > 0 && (
                  <span className="ml-1.5 rounded-full bg-amber-500 px-1.5 text-xs font-semibold text-white">{pending}</span>
                )}
              </button>
            ))}
          </nav>
          <span className="ml-auto flex items-center gap-1.5 text-xs text-zinc-500">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" /> live
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        {tab === "overview" && <OverviewTab go={setTab} />}
        {tab === "calls" && <CallsTab />}
        {tab === "events" && <EventsTab />}
        {tab === "pins" && <PinsTab pins={pins.data} refresh={pins.refresh} />}
        {tab === "sessions" && <SessionsTab />}
      </main>
    </div>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 ${className}`}>
      {children}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: "bad" | "warn" | "good" }) {
  const color =
    tone === "bad"
      ? "text-red-600 dark:text-red-400"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : "text-zinc-900 dark:text-zinc-100";
  return (
    <Card className="p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`tabular mt-1 text-2xl font-semibold ${color}`}>{value}</div>
    </Card>
  );
}

function OverviewTab({ go }: { go: (t: Tab) => void }) {
  const { data } = usePoll<Overview>("/api/overview");
  const blocked = usePoll<Call[]>("/api/calls?filter=blocked&limit=8");
  const events = usePoll<Event[]>("/api/events?limit=100");
  const e = data?.events ?? {};
  const injections = (e.injection_blocked ?? 0) + (e.injection_warned ?? 0);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Last 24 hours</h1>
        <p className="text-sm text-zinc-500">Every tool call your agents made through AgentOverwatch.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Tool calls" value={data?.toolCalls ?? "–"} />
        <Stat label="Blocked" value={data?.blocked ?? "–"} tone={data?.blocked ? "bad" : undefined} />
        <Stat label="Injections caught" value={injections} tone={injections ? "bad" : undefined} />
        <Stat label="Suspicious outputs" value={e.injection_suspected ?? 0} tone={e.injection_suspected ? "warn" : undefined} />
        <Stat label="Loops stopped" value={e.limit_reached ?? 0} tone={e.limit_reached ? "warn" : undefined} />
        <Stat label="Active sessions" value={data?.activeSessions ?? "–"} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <ListHeader title="Recently blocked" onMore={() => go("calls")} />
          <CallList calls={blocked.data} empty="Nothing blocked yet." />
        </Card>
        <Card>
          <ListHeader title="Security events" onMore={() => go("events")} />
          <EventList events={events.data} compact />
        </Card>
      </div>
      <p className="text-xs text-zinc-500">
        Median added time per call: {data?.p50Ms != null ? `${data.p50Ms} ms` : "–"} · Data stays on this machine.
      </p>
    </div>
  );
}

function ListHeader({ title, onMore }: { title: string; onMore?: () => void }) {
  return (
    <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <h2 className="text-sm font-semibold">{title}</h2>
      {onMore && (
        <button type="button" onClick={onMore} className="text-xs text-emerald-700 hover:underline dark:text-emerald-400">
          View all
        </button>
      )}
    </div>
  );
}

const STATUS: Record<string, string> = {
  ok: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  blocked: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  error: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
  tool_error: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
  pending: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
};
function Badge({ status }: { status: string }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS[status] ?? "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}

function CallList({ calls, empty, onPick }: { calls?: Call[]; empty: string; onPick?: (c: Call) => void }) {
  if (!calls) return <p className="p-4 text-sm text-zinc-500">Loading…</p>;
  if (calls.length === 0) return <p className="p-4 text-sm text-zinc-500">{empty}</p>;
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {calls.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            onClick={() => onPick?.(c)}
            className="w-full px-4 py-2.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
          >
            <div className="flex items-center gap-2 text-sm">
              <Badge status={c.status} />
              <span className="font-mono">{c.tool_name ?? c.method}</span>
              <span className="text-zinc-400">on {c.server_name}</span>
              <span className="tabular ml-auto text-xs text-zinc-500">{ago(c.started_at)}</span>
            </div>
            {c.error_message && <p className="mt-1 line-clamp-2 text-xs text-zinc-600 dark:text-zinc-400">{c.error_message}</p>}
          </button>
        </li>
      ))}
    </ul>
  );
}

function CallsTab() {
  const [filter, setFilter] = useState<"all" | "blocked" | "problems">("all");
  const [picked, setPicked] = useState<number | null>(null);
  const { data } = usePoll<Call[]>(`/api/calls?limit=200${filter === "all" ? "" : `&filter=${filter}`}`);
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
      <Card>
        <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          {(["all", "blocked", "problems"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded-md px-2.5 py-1 text-xs capitalize ${filter === f ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"}`}
            >
              {f}
            </button>
          ))}
        </div>
        <CallList calls={data} empty="No calls yet." onPick={(c) => setPicked(c.id)} />
      </Card>
      <div className="lg:sticky lg:top-20 lg:self-start">
        {picked ? <CallDetail id={picked} /> : <Card className="p-6 text-sm text-zinc-500">Pick a call to see its arguments and result.</Card>}
      </div>
    </div>
  );
}

function pretty(json: string | null | undefined): string {
  if (!json) return "(none)";
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

function CallDetail({ id }: { id: number }) {
  const [call, setCall] = useState<Call>();
  useEffect(() => {
    getJson<Call>(`/api/calls/${id}`).then(setCall).catch(() => setCall(undefined));
  }, [id]);
  if (!call) return <Card className="p-6 text-sm text-zinc-500">Loading…</Card>;
  return (
    <Card>
      <div className="space-y-1 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <Badge status={call.status} />
          <span className="font-mono text-sm">{call.tool_name ?? call.method}</span>
        </div>
        <div className="text-xs text-zinc-500">
          {time(call.started_at)} · {call.server_name} · {call.duration_ms != null ? `${call.duration_ms} ms` : "no response"}
          {call.blocked_by && ` · blocked by ${call.blocked_by}`}
        </div>
        {call.error_message && <p className="text-sm text-red-700 dark:text-red-400">{call.error_message}</p>}
      </div>
      <Block title="Request" body={pretty(call.request_json)} />
      <Block title={call.response_json?.includes('"original"') ? "Response (what the server really sent is under “original”)" : "Response"} body={pretty(call.response_json)} />
    </Card>
  );
}

function Block({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-4 py-3">
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h3>
      <pre className="max-h-80 overflow-auto rounded-lg bg-zinc-50 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words dark:bg-zinc-950">
        {body}
      </pre>
    </div>
  );
}

const EVENT_TEXT: Record<string, { label: string; tone: "bad" | "warn" | "info" }> = {
  injection_blocked: { label: "Injection blocked", tone: "bad" },
  injection_warned: { label: "Injection let through with a warning", tone: "warn" },
  injection_suspected: { label: "Suspicious output", tone: "warn" },
  call_blocked: { label: "Call blocked", tone: "bad" },
  tool_hidden: { label: "Tool hidden", tone: "warn" },
  pin_changed: { label: "Tool definition changed", tone: "bad" },
  pin_new_tool: { label: "New tool appeared", tone: "warn" },
  pin_created: { label: "Tool pinned", tone: "info" },
  approval_granted: { label: "Approved by you", tone: "info" },
  approval_denied: { label: "Approval declined", tone: "warn" },
  limit_reached: { label: "Limit reached", tone: "warn" },
};
const DOT = { bad: "bg-red-500", warn: "bg-amber-500", info: "bg-zinc-400" };

function EventList({ events, compact }: { events?: Event[]; compact?: boolean }) {
  if (!events) return <p className="p-4 text-sm text-zinc-500">Loading…</p>;
  const shown = compact ? events.filter((e) => e.kind !== "pin_created").slice(0, 6) : events;
  if (shown.length === 0) return <p className="p-4 text-sm text-zinc-500">No security events yet.</p>;
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {shown.map((e) => {
        const t = EVENT_TEXT[e.kind] ?? { label: e.kind, tone: "info" as const };
        return (
          <li key={e.id} className="flex gap-3 px-4 py-2.5">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[t.tone]}`} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-medium">{t.label}</span>
                {e.tool_name && <span className="font-mono text-zinc-600 dark:text-zinc-400">{e.tool_name}</span>}
                <span className="text-zinc-400">on {e.server_name}</span>
                <span className="tabular ml-auto text-xs text-zinc-500">{ago(e.at)}</span>
              </div>
              {e.detail && <p className="mt-0.5 line-clamp-3 text-xs text-zinc-600 dark:text-zinc-400">{e.detail}</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function EventsTab() {
  const { data } = usePoll<Event[]>("/api/events?limit=300");
  return (
    <Card>
      <ListHeader title="Security events" />
      <EventList events={data} />
    </Card>
  );
}

function PinsTab({ pins, refresh }: { pins?: Pin[]; refresh: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (!pins) return <p className="text-sm text-zinc-500">Loading…</p>;
  const pending = pins.filter((p) => p.state !== "pinned");
  const servers = [...new Set(pins.map((p) => p.server_name))];
  const approve = async (p: Pin) => {
    setBusy(`${p.server_name}/${p.tool_name}`);
    try {
      const done = await approvePins(p.server_name, p.tool_name);
      setMsg(`Approved ${done.join(", ")} on ${p.server_name}. It is available from the agent's next tool list.`);
      refresh();
    } catch (e) {
      setMsg(`Could not approve: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-6">
      {msg && <p className="rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">{msg}</p>}
      <div>
        <h1 className="text-lg font-semibold">Waiting for review</h1>
        <p className="text-sm text-zinc-500">Tools whose definition changed, or that appeared later, stay blocked until you approve them.</p>
      </div>
      {pending.length === 0 && <Card className="p-4 text-sm text-zinc-500">Nothing to review.</Card>}
      {pending.map((p) => (
        <Card key={`${p.server_name}/${p.tool_name}`}>
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              {p.state === "changed" ? "changed" : "new tool"}
            </span>
            <span className="font-mono text-sm">{p.tool_name}</span>
            <span className="text-sm text-zinc-400">on {p.server_name}</span>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => approve(p)}
              className="ml-auto rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {busy === `${p.server_name}/${p.tool_name}` ? "Approving…" : "Approve"}
            </button>
          </div>
          <pre className="max-h-96 overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {p.diff?.split("\n").map((line, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no identity
                key={i}
                className={`block ${line.startsWith("+") ? "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200" : line.startsWith("-") ? "bg-red-50 text-red-900 dark:bg-red-950/60 dark:text-red-200" : ""}`}
              >
                {line}
              </span>
            ))}
          </pre>
        </Card>
      ))}
      <div>
        <h2 className="mb-2 text-sm font-semibold">All pinned tools</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {servers.map((s) => (
            <Card key={s} className="p-4">
              <div className="mb-2 text-sm font-medium">{s}</div>
              <div className="flex flex-wrap gap-1.5">
                {pins
                  .filter((p) => p.server_name === s)
                  .map((p) => (
                    <span
                      key={p.tool_name}
                      className={`rounded px-1.5 py-0.5 font-mono text-xs ${p.state === "pinned" ? "bg-zinc-100 dark:bg-zinc-800" : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"}`}
                    >
                      {p.tool_name}
                    </span>
                  ))}
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

function SessionsTab() {
  const { data } = usePoll<Session[]>("/api/sessions?limit=100", 4000);
  if (!data) return <p className="text-sm text-zinc-500">Loading…</p>;
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
          <tr className="border-b border-zinc-200 dark:border-zinc-800">
            <th className="px-4 py-2.5 font-medium">Server</th>
            <th className="px-4 py-2.5 font-medium">Agent</th>
            <th className="px-4 py-2.5 font-medium">Started</th>
            <th className="px-4 py-2.5 text-right font-medium">Calls</th>
            <th className="px-4 py-2.5 text-right font-medium">Problems</th>
            <th className="px-4 py-2.5 font-medium">State</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {data.map((s) => (
            <tr key={s.id}>
              <td className="px-4 py-2.5">
                <div className="font-medium">{s.server_name}</div>
                <div className="max-w-xs truncate font-mono text-xs text-zinc-500" title={s.command}>
                  {s.command}
                </div>
              </td>
              <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
                {s.client_name ? `${s.client_name} ${s.client_version ?? ""}` : "–"}
              </td>
              <td className="tabular px-4 py-2.5 text-zinc-600 dark:text-zinc-400">{time(s.started_at)}</td>
              <td className="tabular px-4 py-2.5 text-right">{s.call_count}</td>
              <td className={`tabular px-4 py-2.5 text-right ${s.error_count ? "text-orange-600" : ""}`}>{s.error_count}</td>
              <td className="px-4 py-2.5">
                {s.alive ? (
                  <span className="text-emerald-600 dark:text-emerald-400">running</span>
                ) : (
                  <span className="text-zinc-500">ended</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
