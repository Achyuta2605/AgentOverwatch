import { createHash } from "node:crypto";
import type { ServerPolicy } from "./config.js";
import { checkArguments, hiddenByPolicy, needsApproval } from "./policy.js";
import type { EventKind, LogStore, PinRow } from "./store.js";

export interface ToolDefinition {
  name: string;
  [key: string]: unknown;
}

export type CallDecision =
  | { action: "allow" }
  | { action: "block"; reason: string; by: string }
  | { action: "approve"; reason: string };

/** The parts of a tool definition that change what the model reads or sends. */
const PINNED_FIELDS = ["name", "title", "description", "inputSchema", "outputSchema", "annotations"] as const;

/** JSON with object keys sorted, so equal definitions always serialise identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function pinnedView(tool: ToolDefinition): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const f of PINNED_FIELDS) if (tool[f] !== undefined) view[f] = tool[f];
  return view;
}

export function fingerprint(tool: ToolDefinition): { hash: string; def: string } {
  const def = canonicalJson(pinnedView(tool));
  return { hash: createHash("sha256").update(def).digest("hex"), def };
}

/**
 * Applies one server's policy and tool pins. Owns no transport: the gateway asks it what to do.
 */
export class Guard {
  /** Tools hidden from the agent in this session, with the reason, so calls to them can be blocked. */
  private readonly hidden = new Map<string, { reason: string; by: string }>();

  constructor(
    private readonly opts: {
      store: LogStore;
      policy: ServerPolicy;
      serverName: string;
      sessionId: string;
      /** Directory relative paths in arguments are resolved against. */
      cwd: string;
      warn: (message: string) => void;
    },
  ) {}

  get serverName(): string {
    return this.opts.serverName;
  }

  get policy(): ServerPolicy {
    return this.opts.policy;
  }

  /** Records a security event for this server and session. */
  event(kind: EventKind, toolName: string | null, detail: string): void {
    this.opts.store.recordEvent({
      sessionId: this.opts.sessionId,
      serverName: this.opts.serverName,
      kind,
      toolName,
      detail,
      at: Date.now(),
    });
  }

  /**
   * Decides which tools from a `tools/list` result the agent may see. Pins first-seen tools,
   * detects changed definitions, and applies the allow/deny lists.
   */
  filterTools(tools: ToolDefinition[]): ToolDefinition[] {
    const { store, serverName, policy } = this.opts;
    const pins = store.getPins(serverName);
    const serverWasPinned = [...pins.values()].some((p) => p.approved_hash);
    const now = Date.now();
    const visible: ToolDefinition[] = [];

    for (const tool of tools) {
      if (typeof tool?.name !== "string") continue;
      const name = tool.name;
      this.hidden.delete(name);

      const policyReason = hiddenByPolicy(policy, name);
      if (policyReason) {
        this.hide(name, policyReason, "policy:tools");
        continue;
      }
      if (policy.pinning === "off") {
        visible.push(tool);
        continue;
      }

      const { hash, def } = fingerprint(tool);
      const pin: PinRow | undefined = pins.get(name);

      if (!pin?.approved_hash) {
        if (serverWasPinned && policy.newTools === "block") {
          if (pin?.pending_hash !== hash)
            this.event("pin_new_tool", name, "new tool appeared after the server was pinned");
          store.pinPending(serverName, name, hash, def, now);
          this.hide(
            name,
            `tool "${name}" appeared after this server was pinned and needs approval (run: agentoverwatch approve ${serverName} ${name})`,
            "pin:new",
          );
          continue;
        }
        store.pinApproved(serverName, name, hash, def, now);
        this.event("pin_created", name, serverWasPinned ? "new tool pinned on first use" : "pinned on first use");
        visible.push(tool);
        continue;
      }

      if (pin.approved_hash === hash) {
        if (pin.pending_hash) store.clearPending(serverName, name);
        visible.push(tool);
        continue;
      }

      // The definition differs from the one that was approved.
      if (pin.pending_hash !== hash) {
        this.event(
          "pin_changed",
          name,
          `definition changed since it was pinned (${changedFields(pin.approved_def, def)})`,
        );
        this.opts.warn(
          `tool "${name}" on ${serverName} changed since it was approved. Review: agentoverwatch diff ${serverName} ${name}`,
        );
      }
      store.pinPending(serverName, name, hash, def, now);
      if (policy.pinning === "warn") {
        visible.push(tool);
        continue;
      }
      this.hide(
        name,
        `tool "${name}" changed since it was approved, so it is blocked until a person reviews it (run: agentoverwatch diff ${serverName} ${name})`,
        "pin:changed",
      );
    }
    return visible;
  }

  /** Hides a tool from the agent for this session and blocks calls to it. */
  hide(name: string, reason: string, by: string): void {
    this.hidden.set(name, { reason, by });
    this.event("tool_hidden", name, reason);
  }

  /** Decides whether a `tools/call` may go through. */
  checkCall(name: string, args: Record<string, unknown> | undefined): CallDecision {
    const { policy, store, serverName } = this.opts;

    const policyReason = hiddenByPolicy(policy, name);
    if (policyReason) return this.block(name, policyReason, "policy:tools");

    const hidden = this.hidden.get(name);
    if (hidden) return this.block(name, hidden.reason, hidden.by);

    // The agent may call a tool it listed in an earlier session, so check stored state as well.
    if (policy.pinning === "block") {
      const pin = store.getPins(serverName).get(name);
      if (pin?.pending_hash) {
        const by = pin.approved_hash ? "pin:changed" : "pin:new";
        const reason = pin.approved_hash
          ? `tool "${name}" changed since it was approved, so it is blocked until a person reviews it (run: agentoverwatch diff ${serverName} ${name})`
          : `tool "${name}" needs approval before first use (run: agentoverwatch approve ${serverName} ${name})`;
        return this.block(name, reason, by);
      }
    }

    const violation = checkArguments(policy, name, args, this.opts.cwd);
    if (violation) {
      return this.block(
        name,
        `${violation.reason} (${violation.arg}: ${truncate(violation.value, 120)})`,
        "policy:rule",
      );
    }

    if (needsApproval(policy, name)) return { action: "approve", reason: `policy requires approval for "${name}"` };
    return { action: "allow" };
  }

  private block(name: string, reason: string, by: string): CallDecision {
    this.event("call_blocked", name, reason);
    return { action: "block", reason, by };
  }

  recordApproval(name: string, granted: boolean, detail: string): void {
    this.event(granted ? "approval_granted" : "approval_denied", name, detail);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Names the top-level fields that differ between two canonical definitions. */
export function changedFields(oldDef: string | null, newDef: string): string {
  if (!oldDef) return "no previous definition";
  const a = JSON.parse(oldDef) as Record<string, unknown>;
  const b = JSON.parse(newDef) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const changed = keys.filter((k) => canonicalJson(a[k]) !== canonicalJson(b[k]));
  return changed.length ? `changed: ${changed.join(", ")}` : "no visible difference";
}
