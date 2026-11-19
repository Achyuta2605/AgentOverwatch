import { canonicalJson } from "./guard.js";

/** Limits for one server, after merging the "*" defaults. 0 turns a limit off. */
export interface Limits {
  /** Calls per session. */
  maxCalls: number;
  /** Calls in any 60-second window. */
  maxCallsPerMinute: number;
  /** The same tool with the same arguments, within `repeatWindowSec`. The classic stuck-agent loop. */
  maxIdenticalCalls: number;
  repeatWindowSec: number;
  /** One tool failing this many times in a row. */
  maxConsecutiveErrors: number;
  /** Estimated tokens of tool output fed back to the agent in a session (about 4 characters per token). */
  maxOutputTokens: number;
  /** Calls to this server per calendar day (local time), across all sessions. */
  maxCallsPerDay: number;
  /** block: refuse the call. approve: ask a person whether to keep going (falls back to block). */
  onLimit: "block" | "approve";
}

export const DEFAULT_LIMITS: Limits = {
  maxCalls: 1000,
  maxCallsPerMinute: 120,
  maxIdenticalCalls: 10,
  repeatWindowSec: 300,
  maxConsecutiveErrors: 8,
  maxOutputTokens: 2_000_000,
  maxCallsPerDay: 0,
  onLimit: "approve",
};

export type LimitKind = "calls" | "rate" | "repeat" | "errors" | "output" | "daily";

export type LimitDecision = { action: "allow" } | { action: "block" | "approve"; kind: LimitKind; reason: string };

/**
 * Keeps per-session counters and decides when an agent has gone off the rails. Approving a limit
 * raises it by the same amount again, so a person is asked at most once per "batch".
 */
export class Limiter {
  private calls = 0;
  private outputTokens = 0;
  private readonly recent: number[] = [];
  private readonly repeats = new Map<string, number[]>();
  private readonly errorStreak = new Map<string, number>();
  /** Extra headroom granted by a person, per limit. */
  private readonly granted: Record<LimitKind, number> = {
    calls: 0,
    rate: 0,
    repeat: 0,
    errors: 0,
    output: 0,
    daily: 0,
  };

  constructor(
    private readonly limits: Limits,
    /** Calls already made to this server today, for the daily limit. */
    private readonly callsToday: () => number = () => 0,
    private readonly now: () => number = Date.now,
  ) {}

  /** Called before a tool call is forwarded. Does not count the call; `record` does. */
  check(tool: string, args: unknown): LimitDecision {
    const l = this.limits;
    const t = this.now();
    const over = (kind: LimitKind, reason: string): LimitDecision => ({
      action: l.onLimit,
      kind,
      reason: `${reason}. This looks like a loop or a runaway task: stop and check with the user before continuing`,
    });

    const errors = this.errorStreak.get(tool) ?? 0;
    if (l.maxConsecutiveErrors && errors >= l.maxConsecutiveErrors + this.granted.errors)
      return over("errors", `"${tool}" has failed ${errors} times in a row`);

    if (l.maxIdenticalCalls) {
      const times = this.window(this.repeats.get(key(tool, args)) ?? [], t - l.repeatWindowSec * 1000);
      if (times.length >= l.maxIdenticalCalls + this.granted.repeat)
        return over(
          "repeat",
          `"${tool}" was called ${times.length} times with the same arguments in ${fmtWindow(l.repeatWindowSec)}`,
        );
    }

    if (l.maxCallsPerMinute) {
      const inMinute = this.window(this.recent, t - 60_000).length;
      if (inMinute >= l.maxCallsPerMinute + this.granted.rate)
        return over("rate", `${inMinute} tool calls in the last minute (limit ${l.maxCallsPerMinute})`);
    }

    if (l.maxCalls && this.calls >= l.maxCalls + this.granted.calls)
      return over("calls", `this session has made ${this.calls} tool calls (limit ${l.maxCalls})`);

    if (l.maxOutputTokens && this.outputTokens >= l.maxOutputTokens + this.granted.output)
      return over(
        "output",
        `tools have returned about ${Math.round(this.outputTokens / 1000)}k tokens of output this session (limit ${Math.round(l.maxOutputTokens / 1000)}k)`,
      );

    if (l.maxCallsPerDay) {
      const today = this.callsToday();
      if (today >= l.maxCallsPerDay + this.granted.daily)
        return over("daily", `${today} calls to this server today (daily limit ${l.maxCallsPerDay})`);
    }
    return { action: "allow" };
  }

  /** Counts a call that is being forwarded. */
  record(tool: string, args: unknown): void {
    const t = this.now();
    this.calls++;
    this.recent.push(t);
    const k = key(tool, args);
    const list = this.repeats.get(k) ?? [];
    list.push(t);
    this.repeats.set(k, list);
    // Keep memory bounded in long sessions.
    if (this.recent.length > 10_000) this.recent.splice(0, this.recent.length - 10_000);
    if (this.repeats.size > 5_000) this.repeats.delete(this.repeats.keys().next().value as string);
  }

  /** Called when a forwarded call returns. */
  result(tool: string, isError: boolean, outputChars: number): void {
    this.outputTokens += Math.ceil(outputChars / 4);
    this.errorStreak.set(tool, isError ? (this.errorStreak.get(tool) ?? 0) + 1 : 0);
  }

  /** A person said to keep going: allow another batch of the same size. */
  grant(kind: LimitKind): void {
    const l = this.limits;
    const step: Record<LimitKind, number> = {
      calls: l.maxCalls,
      rate: l.maxCallsPerMinute,
      repeat: l.maxIdenticalCalls,
      errors: l.maxConsecutiveErrors,
      output: l.maxOutputTokens,
      daily: l.maxCallsPerDay,
    };
    this.granted[kind] += step[kind];
  }

  get stats(): { calls: number; outputTokens: number } {
    return { calls: this.calls, outputTokens: this.outputTokens };
  }

  /** Drops timestamps older than `since` (in place) and returns the list. */
  private window(list: number[], since: number): number[] {
    let drop = 0;
    while (drop < list.length && (list[drop] as number) < since) drop++;
    if (drop) list.splice(0, drop);
    return list;
  }
}

function key(tool: string, args: unknown): string {
  return `${tool}\0${canonicalJson(args ?? {})}`;
}

function fmtWindow(sec: number): string {
  return sec % 60 === 0 ? `${sec / 60} minute${sec === 60 ? "" : "s"}` : `${sec} seconds`;
}
