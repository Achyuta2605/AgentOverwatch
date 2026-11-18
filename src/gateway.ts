import { performance } from "node:perf_hooks";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { PRODUCT_NAME } from "./brand.js";
import type { Guard, ToolDefinition } from "./guard.js";
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
  /** Policy and pinning checks. Without one the gateway is a pure pass-through logger. */
  guard?: Guard;
  /** How long to wait for a person to answer an approval request. */
  approvalTimeoutMs?: number;
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

/** Prefix for ids of requests the gateway itself sends to the agent, so they never collide with the server's. */
const OWN_ID_PREFIX = "agentoverwatch-";

/**
 * Sits between an agent and an MCP server. Messages are forwarded unchanged and in order, except where
 * the guard intervenes: `tools/list` results are filtered and `tools/call` requests can be blocked or
 * held for a person's approval. Every request in either direction is logged.
 */
export class Gateway {
  private readonly pending = new Map<string, Pending>();
  private readonly ownRequests = new Map<string, (result: AnyMessage) => void>();
  private readonly heldCalls = new Set<string>();
  private readonly warn: (message: string) => void;
  private agentCanElicit = false;
  private nextOwnId = 1;
  private closed = false;

  constructor(private readonly opts: GatewayOptions) {
    this.warn = opts.warn ?? ((m) => process.stderr.write(`[agentoverwatch] ${m}\n`));
  }

  /** Wires both transports together. The server transport should already be started. */
  async start(): Promise<void> {
    const { agent, server } = this.opts;
    agent.onmessage = (m) => this.fromAgent(m as AnyMessage);
    server.onmessage = (m) => this.fromServer(m as AnyMessage);
    agent.onerror = (e) => this.warn(`agent transport error: ${e.message}`);
    server.onerror = (e) => this.warn(`server transport error: ${e.message}`);
    await agent.start();
  }

  /** Number of requests still waiting for a response. */
  get inFlight(): number {
    return this.pending.size;
  }

  // ---- agent → server -------------------------------------------------------------------

  private fromAgent(m: AnyMessage): void {
    if (this.closed) return;

    // Answers to the gateway's own approval requests stop here.
    if (m.method === undefined && typeof m.id === "string" && this.ownRequests.has(m.id)) {
      const resolve = this.ownRequests.get(m.id);
      this.ownRequests.delete(m.id);
      resolve?.(m);
      return;
    }

    if (m.method === "notifications/cancelled" && this.heldCalls.has(keyOf("agent", m.params?.requestId))) {
      // The call never reached the server, so the server must not see the cancellation either.
      this.heldCalls.delete(keyOf("agent", m.params?.requestId));
      this.safely(() => this.observe("agent", m));
      return;
    }

    this.safely(() => this.observe("agent", m));
    if (m.method === "initialize")
      this.agentCanElicit = Boolean((m.params?.capabilities as Record<string, unknown>)?.elicitation);

    const guard = this.opts.guard;
    if (guard && m.method === "tools/call" && m.id !== undefined) {
      const name = typeof m.params?.name === "string" ? m.params.name : "";
      const args = m.params?.arguments as Record<string, unknown> | undefined;
      let decision: ReturnType<Guard["checkCall"]>;
      try {
        decision = guard.checkCall(name, args);
      } catch (err) {
        decision = { action: "block", reason: `policy check failed: ${(err as Error).message}`, by: "error" };
      }
      if (decision.action === "block") {
        this.respondBlocked(m, decision.reason, decision.by);
        return;
      }
      if (decision.action === "approve") {
        void this.holdForApproval(m, name, args, decision.reason);
        return;
      }
    }
    this.send("server", m);
  }

  private async holdForApproval(
    m: AnyMessage,
    name: string,
    args: Record<string, unknown> | undefined,
    reason: string,
  ): Promise<void> {
    const guard = this.opts.guard as Guard;
    const k = keyOf("agent", m.id);
    if (!this.agentCanElicit) {
      guard.recordApproval(name, false, "agent cannot show approval prompts");
      this.respondBlocked(
        m,
        `${reason}, but this agent cannot show approval prompts. Allow the tool in the policy file to use it.`,
        "approval:unsupported",
      );
      return;
    }
    this.heldCalls.add(k);
    const answer = await this.askAgent(
      `${PRODUCT_NAME}: allow "${name}"?\n\nArguments:\n${JSON.stringify(args ?? {}, null, 2).slice(0, 1500)}`,
    );
    if (!this.heldCalls.has(k) || this.closed) return; // cancelled while waiting
    this.heldCalls.delete(k);
    if (answer === "accept") {
      guard.recordApproval(name, true, "approved in the agent's prompt");
      this.send("server", m);
    } else {
      guard.recordApproval(
        name,
        false,
        answer === "timeout" ? "approval timed out" : `approval prompt answered: ${answer}`,
      );
      this.respondBlocked(
        m,
        answer === "timeout"
          ? `no approval for "${name}" within the time limit`
          : `the approval prompt for "${name}" was declined`,
        "approval:declined",
      );
    }
  }

  /** Sends an elicitation to the agent and resolves with accept, decline, cancel or timeout. */
  private askAgent(message: string): Promise<string> {
    const id = `${OWN_ID_PREFIX}${this.nextOwnId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.ownRequests.delete(id);
        resolve("timeout");
      }, this.opts.approvalTimeoutMs ?? 120_000);
      timer.unref?.();
      this.ownRequests.set(id, (reply) => {
        clearTimeout(timer);
        const action = reply.result?.action;
        resolve(typeof action === "string" ? action : "decline");
      });
      this.opts.agent
        .send({
          jsonrpc: "2.0",
          id,
          method: "elicitation/create",
          params: { message, requestedSchema: { type: "object", properties: {} } },
        } as JSONRPCMessage)
        .catch((err: Error) => {
          this.ownRequests.delete(id);
          clearTimeout(timer);
          this.warn(`could not ask for approval: ${err.message}`);
          resolve("decline");
        });
    });
  }

  /** Answers a blocked tool call as a tool error, so the model sees why and can adapt. */
  private respondBlocked(m: AnyMessage, reason: string, by: string): void {
    const result = { isError: true, content: [{ type: "text", text: `Blocked by ${PRODUCT_NAME}: ${reason}` }] };
    const k = keyOf("agent", m.id);
    const p = this.pending.get(k);
    if (p) {
      this.pending.delete(k);
      this.safely(() =>
        this.opts.store.finishRequest(p.rowId, {
          status: "blocked",
          response: result,
          errorMessage: reason,
          durationMs: round(performance.now() - p.startedPerf),
          blockedBy: by,
        }),
      );
    }
    this.opts.agent
      .send({ jsonrpc: "2.0", id: m.id as string | number, result } as JSONRPCMessage)
      .catch((err: Error) => this.warn(`could not deliver blocked-call response: ${err.message}`));
  }

  // ---- server → agent -------------------------------------------------------------------

  private fromServer(m: AnyMessage): void {
    if (this.closed) return;
    const guard = this.opts.guard;
    let outgoing = m;

    if (guard && m.method === undefined && m.result && Array.isArray(m.result.tools)) {
      const req = this.pending.get(keyOf("agent", m.id));
      if (req?.method === "tools/list") {
        try {
          outgoing = { ...m, result: { ...m.result, tools: guard.filterTools(m.result.tools as ToolDefinition[]) } };
        } catch (err) {
          // Fail closed: if the check itself breaks, show no tools rather than unchecked ones.
          this.warn(`tool check failed, hiding all tools: ${(err as Error).message}`);
          outgoing = { ...m, result: { ...m.result, tools: [] } };
        }
      }
    }

    // Log what the server actually sent, then forward what the agent is allowed to see.
    this.safely(() => this.observe("server", m));
    this.send("agent", outgoing);
  }

  // ---- shared ---------------------------------------------------------------------------

  private send(to: Side, message: AnyMessage): void {
    const t = to === "server" ? this.opts.server : this.opts.agent;
    t.send(message).catch((err: Error) => this.warn(`could not deliver message to ${to}: ${err.message}`));
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      // Logging must never break the agent's work.
      this.warn(`failed to log message: ${(err as Error).message}`);
    }
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
      this.pending.set(keyOf(from, m.id), { rowId, method: m.method, startedPerf: performance.now() });
      return;
    }

    if (!hasId) return;
    // A response travels the opposite way to its request.
    const requester: Side = from === "agent" ? "server" : "agent";
    const k = keyOf(requester, m.id);
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
    const k = keyOf(from, requestId);
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
    this.heldCalls.clear();
    for (const resolve of this.ownRequests.values()) resolve({ jsonrpc: "2.0", id: 0, result: { action: "cancel" } });
    this.ownRequests.clear();
  }
}

function keyOf(requester: Side, id: unknown): string {
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
