import { performance } from "node:perf_hooks";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Direction, LogStore } from "./store.js";

type Side = "agent" | "server";

interface Pending {
  rowId: number;
  method: string;
  startedPerf: number;
}

export interface GatewayOptions {
  /** Transport facing the AI agent (Claude Code, Cursor, …). */
  agent: Transport;
  /** Transport facing the real MCP server. */
  server: Transport;
  store: LogStore;
  sessionId: string;
  /** Called for internal problems. Must never write to stdout, which belongs to the protocol. */
  warn?: (message: string) => void;
}

type AnyMessage = JSONRPCMessage & {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

/**
 * Sits between an agent and an MCP server. Every message is forwarded unchanged and in order;
 * every request in either direction is logged with its response, status and latency.
 *
 * Week 1 is pure pass-through. Later checks (tool pinning, policy, injection scanning,
 * budgets) plug in at `forward`, before a message reaches the other side.
 */
export class Gateway {
  private readonly pending = new Map<string, Pending>();
  private readonly warn: (message: string) => void;
  private closed = false;

  constructor(private readonly opts: GatewayOptions) {
    this.warn = opts.warn ?? ((m) => process.stderr.write(`[agentoverwatch] ${m}\n`));
  }

  /** Wires both transports together. The server transport should already be started. */
  async start(): Promise<void> {
    const { agent, server } = this.opts;
    agent.onmessage = (m) => this.forward("agent", m as AnyMessage);
    server.onmessage = (m) => this.forward("server", m as AnyMessage);
    agent.onerror = (e) => this.warn(`agent transport error: ${e.message}`);
    server.onerror = (e) => this.warn(`server transport error: ${e.message}`);
    await agent.start();
  }

  /** Number of requests still waiting for a response. */
  get inFlight(): number {
    return this.pending.size;
  }

  private forward(from: Side, message: AnyMessage): void {
    if (this.closed) return;
    try {
      this.observe(from, message);
    } catch (err) {
      // Logging must never break the agent's work.
      this.warn(`failed to log message: ${(err as Error).message}`);
    }
    const to = from === "agent" ? this.opts.server : this.opts.agent;
    to.send(message).catch((err: Error) =>
      this.warn(`could not deliver message to ${from === "agent" ? "server" : "agent"}: ${err.message}`),
    );
  }

  private observe(from: Side, m: AnyMessage): void {
    const { store, sessionId } = this.opts;
    const hasId = m.id !== undefined && m.id !== null;

    if (typeof m.method === "string") {
      if (!hasId) {
        if (m.method === "notifications/cancelled") this.cancel(from, m.params?.requestId);
        return;
      }
      const direction: Direction = from === "agent" ? "agent_to_server" : "server_to_agent";
      const toolName = m.method === "tools/call" && typeof m.params?.name === "string" ? m.params.name : null;
      if (m.method === "initialize" && from === "agent") {
        const info = m.params?.clientInfo as { name?: string; version?: string } | undefined;
        store.setClientInfo(sessionId, info?.name ?? null, info?.version ?? null, str(m.params?.protocolVersion));
      }
      const rowId = store.recordRequest({
        sessionId,
        direction,
        jsonrpcId: String(m.id),
        method: m.method,
        toolName,
        params: m.params,
        startedAt: Date.now(),
      });
      this.pending.set(key(from, m.id), { rowId, method: m.method, startedPerf: performance.now() });
      return;
    }

    if (!hasId) return;
    // A response travels the opposite way to its request.
    const requester: Side = from === "agent" ? "server" : "agent";
    const k = key(requester, m.id);
    const p = this.pending.get(k);
    if (!p) return;
    this.pending.delete(k);
    const durationMs = round(performance.now() - p.startedPerf);

    if (m.error) {
      store.finishRequest(p.rowId, { status: "error", response: m.error, errorMessage: m.error.message, durationMs });
      return;
    }
    const result = m.result ?? {};
    if (p.method === "initialize" && requester === "agent") {
      const info = result.serverInfo as { name?: string; version?: string } | undefined;
      store.setServerInfo(sessionId, info?.name ?? null, info?.version ?? null, str(result.protocolVersion));
    }
    const toolError = p.method === "tools/call" && result.isError === true;
    store.finishRequest(p.rowId, {
      status: toolError ? "tool_error" : "ok",
      response: result,
      errorMessage: toolError ? firstText(result) : null,
      durationMs,
    });
  }

  /** `notifications/cancelled` comes from the side that sent the original request. */
  private cancel(from: Side, requestId: unknown): void {
    if (typeof requestId !== "string" && typeof requestId !== "number") return;
    const k = key(from, requestId);
    const p = this.pending.get(k);
    if (!p) return;
    this.pending.delete(k);
    this.opts.store.finishRequest(p.rowId, {
      status: "cancelled",
      durationMs: round(performance.now() - p.startedPerf),
    });
  }

  /** Stops forwarding. Requests still pending are marked `no_response` when the session ends. */
  close(): void {
    this.closed = true;
    this.pending.clear();
  }
}

function key(requester: Side, id: unknown): string {
  return `${requester}:${JSON.stringify(id)}`;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

function firstText(result: Record<string, unknown>): string | null {
  const content = result.content;
  if (!Array.isArray(content)) return null;
  const text = content.find((c) => c && typeof c === "object" && (c as { type?: string }).type === "text") as
    | { text?: string }
    | undefined;
  return text?.text ? text.text.slice(0, 500) : null;
}
