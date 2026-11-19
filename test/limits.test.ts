import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, policyFor } from "../src/config.js";
import { DEFAULT_LIMITS, Limiter, type Limits } from "../src/limits.js";
import { LogStore } from "../src/store.js";
import { type Connected, connect, tempDir } from "./helpers.js";

const off: Limits = {
  maxCalls: 0,
  maxCallsPerMinute: 0,
  maxIdenticalCalls: 0,
  repeatWindowSec: 300,
  maxConsecutiveErrors: 0,
  maxOutputTokens: 0,
  maxCallsPerDay: 0,
  onLimit: "block",
};

function limiter(l: Partial<Limits>, clock = { t: 0 }, today = () => 0) {
  return new Limiter({ ...off, ...l }, today, () => clock.t);
}

function call(lim: Limiter, tool: string, args: unknown = {}) {
  const d = lim.check(tool, args);
  if (d.action === "allow") lim.record(tool, args);
  return d;
}

describe("limiter", () => {
  it("stops the same call repeated within the window, but not different arguments", () => {
    const clock = { t: 0 };
    const lim = limiter({ maxIdenticalCalls: 3, repeatWindowSec: 60 }, clock);
    for (let i = 0; i < 3; i++) expect(call(lim, "search", { q: "x" }).action).toBe("allow");
    const d = call(lim, "search", { q: "x" });
    expect(d).toMatchObject({ action: "block", kind: "repeat" });
    expect(d.action !== "allow" && d.reason).toMatch(/"search" was called 3 times with the same arguments in 1 minute/);
    expect(call(lim, "search", { q: "y" }).action).toBe("allow");
    // Argument order does not matter.
    expect(call(lim, "search", { b: 1, a: 2 }).action).toBe("allow");
    clock.t = 61_000;
    expect(call(lim, "search", { q: "x" }).action).toBe("allow");
  });

  it("stops a tool that keeps failing, and resets on success", () => {
    const lim = limiter({ maxConsecutiveErrors: 2 });
    lim.result("run", true, 10);
    expect(call(lim, "run").action).toBe("allow");
    lim.result("run", true, 10);
    expect(call(lim, "run")).toMatchObject({ action: "block", kind: "errors" });
    expect(call(lim, "other").action).toBe("allow");
    lim.result("run", false, 10);
    expect(call(lim, "run").action).toBe("allow");
  });

  it("limits calls per minute, per session, output and per day", () => {
    const clock = { t: 0 };
    const rate = limiter({ maxCallsPerMinute: 2 }, clock);
    call(rate, "a", 1);
    call(rate, "a", 2);
    expect(call(rate, "a", 3)).toMatchObject({ kind: "rate" });
    clock.t = 60_001;
    expect(call(rate, "a", 4).action).toBe("allow");

    const total = limiter({ maxCalls: 2 });
    call(total, "a", 1);
    call(total, "a", 2);
    expect(call(total, "a", 3)).toMatchObject({ kind: "calls" });

    const output = limiter({ maxOutputTokens: 100 });
    output.result("read", false, 400);
    expect(call(output, "read")).toMatchObject({ kind: "output" });

    let today = 4;
    const daily = limiter({ maxCallsPerDay: 5 }, { t: 0 }, () => today);
    expect(call(daily, "a").action).toBe("allow");
    today = 5;
    expect(call(daily, "a")).toMatchObject({ kind: "daily" });
  });

  it("approving a limit allows one more batch of the same size", () => {
    const lim = limiter({ maxCalls: 2, onLimit: "approve" });
    call(lim, "a", 1);
    call(lim, "a", 2);
    expect(call(lim, "a", 3)).toMatchObject({ action: "approve", kind: "calls" });
    lim.grant("calls");
    expect(call(lim, "a", 3).action).toBe("allow");
    expect(call(lim, "a", 4).action).toBe("allow");
    expect(call(lim, "a", 5).action).toBe("approve");
  });
});

describe("limits config", () => {
  it("has safe defaults and merges per-server values", () => {
    const config = parseConfig(
      `servers:\n  "*":\n    limits:\n      max_identical_calls: 4\n      repeat_window: 2m\n  github:\n    limits:\n      max_calls: 50\n      on_limit: block\n`,
    );
    expect(policyFor(parseConfig(""), "x").limits).toEqual(DEFAULT_LIMITS);
    expect(policyFor(config, "github").limits).toMatchObject({
      maxIdenticalCalls: 4,
      repeatWindowSec: 120,
      maxCalls: 50,
      onLimit: "block",
      maxCallsPerMinute: DEFAULT_LIMITS.maxCallsPerMinute,
    });
  });

  it("rejects bad values", () => {
    expect(() => parseConfig(`servers:\n  "*":\n    limits:\n      max_calls: -1\n`)).toThrow(/max_calls/);
    expect(() => parseConfig(`servers:\n  "*":\n    limits:\n      repeat_window: soon\n`)).toThrow(/repeat_window/);
  });
});

describe("limits in the gateway", () => {
  let tmp: ReturnType<typeof tempDir>;
  let open: Connected[] = [];
  beforeEach(() => {
    tmp = tempDir();
    open = [];
  });
  afterEach(async () => {
    for (const c of open) await c.client.close().catch(() => {});
    tmp.cleanup();
  });

  async function gateway(limitsYaml: string, onApproval?: Parameters<typeof connect>[0]["onApproval"]) {
    const config = join(tmp.dir, "policy.yaml");
    writeFileSync(config, `servers:\n  "*":\n    limits:\n${limitsYaml}`);
    const c = await connect({ db: tmp.db, config, onApproval });
    open.push(c);
    return c;
  }
  const echo = (c: Connected) => c.client.callTool({ name: "echo", arguments: { text: "again" } });
  const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? "";
  const store = <T>(fn: (s: LogStore) => T): T => {
    const s = new LogStore(tmp.db);
    try {
      return fn(s);
    } finally {
      s.close();
    }
  };

  it("blocks an agent stuck repeating the same call", async () => {
    const c = await gateway("      max_identical_calls: 3\n      on_limit: block\n");
    for (let i = 0; i < 3; i++) expect((await echo(c)).isError).toBeFalsy();
    const r = await echo(c);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Blocked by AgentOverwatch: "echo" was called 3 times with the same arguments/);
    expect(text(r)).toMatch(/stop and check with the user/);
    const rows = store((s) => s.listCalls({ toolName: "echo" }));
    expect(rows[0]).toMatchObject({ status: "blocked", blocked_by: "limit:repeat" });
    expect(store((s) => s.listEvents()).map((e) => e.kind)).toContain("limit_reached");
  });

  it("asks the person whether to keep going, and continues if they say yes", async () => {
    const prompts: string[] = [];
    const c = await gateway("      max_identical_calls: 2\n", (msg) => {
      prompts.push(msg);
      return "accept";
    });
    await echo(c);
    await echo(c);
    expect(text(await echo(c))).toBe("again");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/the agent may be stuck. "echo" was called 2 times/);
    expect(text(await echo(c))).toBe("again"); // inside the newly granted batch, no new prompt
    expect(prompts).toHaveLength(1);
  });

  it("blocks when the person says no", async () => {
    const c = await gateway("      max_identical_calls: 1\n", () => "decline");
    await echo(c);
    const r = await echo(c);
    expect(text(r)).toMatch(/prompt asking whether to continue was declined/);
    expect(store((s) => s.listCalls({ toolName: "echo" }))[0]).toMatchObject({ blocked_by: "limit:repeat" });
  });

  it("stops a tool that keeps failing", async () => {
    const c = await gateway("      max_consecutive_errors: 2\n      on_limit: block\n");
    await c.client.callTool({ name: "fail", arguments: {} });
    await c.client.callTool({ name: "fail", arguments: {} });
    const r = await c.client.callTool({ name: "fail", arguments: {} });
    expect(text(r)).toMatch(/"fail" has failed 2 times in a row/);
  });
});
