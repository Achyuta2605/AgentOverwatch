import { useCallback, useEffect, useRef, useState } from "react";

export interface Overview {
  toolCalls: number;
  blocked: number;
  problems: number;
  sessions: number;
  activeSessions: number;
  p50Ms: number | null;
  events: Record<string, number>;
}
export interface Session {
  id: string;
  server_name: string;
  command: string;
  client_name: string | null;
  client_version: string | null;
  started_at: number;
  ended_at: number | null;
  call_count: number;
  error_count: number;
  alive: boolean;
}
export interface Call {
  id: number;
  session_id: string;
  server_name: string;
  direction: string;
  method: string;
  tool_name: string | null;
  status: string;
  error_message: string | null;
  started_at: number;
  duration_ms: number | null;
  blocked_by: string | null;
  request_preview: string | null;
  request_json?: string | null;
  response_json?: string | null;
}
export interface Event {
  id: number;
  session_id: string | null;
  server_name: string;
  kind: string;
  tool_name: string | null;
  detail: string | null;
  at: number;
}
export interface Pin {
  server_name: string;
  tool_name: string;
  state: "pinned" | "changed" | "new";
  diff: string | null;
  approved_at: number | null;
}

const token = () => document.querySelector<HTMLMetaElement>('meta[name="agentoverwatch-token"]')?.content ?? "";

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export async function approvePins(server: string, tool?: string): Promise<string[]> {
  const res = await fetch("/api/pins/approve", {
    method: "POST",
    headers: { "content-type": "application/json", "x-agentoverwatch-token": token() },
    body: JSON.stringify({ server, tool }),
  });
  if (!res.ok) throw new Error(await res.text());
  return ((await res.json()) as { approved: string[] }).approved;
}

/** Fetches a path and refreshes it every few seconds while the tab is visible. */
export function usePoll<T>(path: string, everyMs = 2000): { data: T | undefined; error: string | null; refresh: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const current = useRef(path);
  current.current = path;
  const load = useCallback(() => {
    getJson<T>(path)
      .then((d) => {
        if (current.current === path) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: Error) => setError(e.message));
  }, [path]);
  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, everyMs);
    return () => clearInterval(t);
  }, [load, everyMs]);
  return { data, error, refresh: load };
}
