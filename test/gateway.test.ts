import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CallRow, LogStore } from "../src/store.js";
import { CLI, type Connected, connect, FIXTURE, tempDir, waitFor } from "./helpers.js";

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

async function gateway(extra: Parameters<typeof connect>[0] = {}): Promise<Connected> {
  const c = await connect({ db: tmp.db, ...extra });
  open.push(c);
  return c;
}

function calls(): CallRow[] {
  const store = new LogStore(tmp.db);
  try {
    return store.listCalls({ limit: 1000 }).reverse();
  } finally {
    store.close();
  }
}

function toolCalls(name: string): CallRow[] {
  return calls().filter((c) => c.tool_name === name);
}

function textOf(result: unknown): string {
  return ((result as { content: { text: string }[] }).content[0] as { text: string }).text;
}

describe("pass-through", () => {
  it("shows the agent exactly the same tools as a direct connection", async () => {
    const direct = await connect({ direct: true });
    open.push(direct);
    const viaGateway = await gateway();
    expect(await viaGateway.client.listTools()).toEqual(await direct.client.listTools());
    expect(viaGateway.client.getServerVersion()).toEqual({ name: "echo-fixture", version: "1.2.3" });
  });

  it("forwards tool calls and returns the server's answer unchanged", async () => {
    const { client, errors } = await gateway();
    const result = await client.callTool({ name: "echo", arguments: { text: "hello, gateway" } });
    expect(textOf(result)).toBe("hello, gateway");
    expect(errors).toEqual([]);
  });

  it("passes the full environment through to the server", async () => {
    const { client } = await gateway({ env: { AGENTGATE_TEST_SECRET: "s3cret" } });
    const result = await client.callTool({ name: "env", arguments: { name: "AGENTGATE_TEST_SECRET" } });
    expect(textOf(result)).toBe("s3cret");
  });

  it("matches concurrent responses to the right requests when they come back out of order", async () => {
    const { client } = await gateway();
    const [slow, fast] = await Promise.all([
      client.callTool({ name: "slow", arguments: { ms: 300 } }),
      client.callTool({ name: "slow", arguments: { ms: 10 } }),
    ]);
    expect(textOf(slow)).toBe("waited 300");
    expect(textOf(fast)).toBe("waited 10");
    const rows = toolCalls("slow");
    expect(rows).toHaveLength(2);
    const byArg = Object.fromEntries(rows.map((r) => [JSON.parse(r.request_json ?? "{}").arguments.ms, r]));
    expect(byArg[300]?.duration_ms).toBeGreaterThanOrEqual(290);
    expect(byArg[10]?.duration_ms).toBeLessThan(250);
  });

  it("delivers large results whole while storing a truncated copy", async () => {
    const { client } = await gateway();
    const result = await client.callTool({ name: "big", arguments: { kb: 200 } });
    expect(textOf(result)).toHaveLength(200 * 1024);
    const [row] = toolCalls("big");
    expect(row?.response_bytes).toBeGreaterThan(200 * 1024);
    expect(row?.response_json?.length).toBeLessThan(40 * 1024);
    expect(row?.response_json).toContain("[truncated");
  });
});

describe("logging", () => {
  it("records each tool call with status, latency and both sides' identity", async () => {
    const { client } = await gateway();
    await client.callTool({ name: "echo", arguments: { text: "logged" } });

    const [row] = toolCalls("echo");
    expect(row).toMatchObject({
      method: "tools/call",
      direction: "agent_to_server",
      status: "ok",
      server_name: "echo-server",
    });
    expect(JSON.parse(row?.request_json ?? "")).toEqual({ name: "echo", arguments: { text: "logged" } });
    expect(JSON.parse(row?.response_json ?? "").content[0].text).toBe("logged");
    expect(row?.duration_ms).toBeGreaterThanOrEqual(0);

    const methods = calls().map((c) => c.method);
    expect(methods).toContain("initialize");
    expect(methods).toContain("tools/call");

    const store = new LogStore(tmp.db);
    const [session] = store.listSessions();
    store.close();
    expect(session).toMatchObject({
      client_name: "test-agent",
      client_version: "9.9.9",
      server_info_name: "echo-fixture",
      server_info_version: "1.2.3",
    });
  });

  it("marks tool-reported failures as tool errors with the message", async () => {
    const { client } = await gateway();
    const result = await client.callTool({ name: "fail", arguments: {} });
    expect(result.isError).toBe(true);
    expect(toolCalls("fail")[0]).toMatchObject({ status: "tool_error", error_message: "disk is full" });
  });

  it("marks calls to unknown tools as failed", async () => {
    const { client } = await gateway();
    const result = await client.callTool({ name: "does-not-exist", arguments: {} }).catch((e: Error) => e);
    expect(result).toBeTruthy();
    expect(["error", "tool_error"]).toContain(toolCalls("does-not-exist")[0]?.status);
  });

  it("marks requests the agent cancels as cancelled", async () => {
    const { client } = await gateway();
    const ac = new AbortController();
    const pending = client.callTool({ name: "slow", arguments: { ms: 2000 } }, undefined, { signal: ac.signal });
    await waitFor(() => toolCalls("slow").length === 1);
    ac.abort();
    await expect(pending).rejects.toThrow();
    const row = await waitFor(() => toolCalls("slow").find((r) => r.status === "cancelled"));
    expect(row.duration_ms).toBeLessThan(2000);
  });

  it("uses the --name option as the server name", async () => {
    const { client } = await gateway({ extraGatewayArgs: ["--name", "my-tools"] });
    await client.callTool({ name: "echo", arguments: { text: "x" } });
    expect(toolCalls("echo")[0]?.server_name).toBe("my-tools");
  });
});

describe("lifecycle", () => {
  it("ends the session and stops the server when the agent disconnects", async () => {
    const c = await gateway();
    await c.client.callTool({ name: "echo", arguments: { text: "x" } });
    await c.client.close();
    const store = new LogStore(tmp.db);
    try {
      const session = await waitFor(() => store.listSessions().find((s) => s.ended_at !== null));
      expect(session.exit_code).toBe(0);
    } finally {
      store.close();
    }
  });

  it("exits with the server's exit code and records unanswered requests when the server dies", async () => {
    const { client } = await gateway();
    const closed = new Promise<void>((resolve) => {
      client.onclose = () => resolve();
    });
    await client.callTool({ name: "crash", arguments: {} });
    // This request is in flight when the server exits.
    void client.callTool({ name: "slow", arguments: { ms: 5000 } }).catch(() => {});
    await closed;
    const store = new LogStore(tmp.db);
    try {
      const session = await waitFor(() => store.listSessions().find((s) => s.ended_at !== null));
      expect(session.exit_code).toBe(3);
    } finally {
      store.close();
    }
    const slow = toolCalls("slow");
    if (slow.length) expect(slow[0]?.status).toBe("no_response");
  });

  it("reports a clear error when the server command does not exist", () => {
    const r = spawnSync(process.execPath, [CLI, "run", "--db", tmp.db, "--", "definitely-not-a-real-command-xyz"], {
      input: "",
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not start MCP server");
    expect(r.stdout).toBe("");
  });
});

describe("cli", () => {
  it("prints logged calls and sessions", async () => {
    const { client } = await gateway();
    await client.callTool({ name: "echo", arguments: { text: "x" } });
    await client.callTool({ name: "fail", arguments: {} });

    const logs = spawnSync(process.execPath, [CLI, "logs", "--db", tmp.db], { encoding: "utf8" });
    expect(logs.status).toBe(0);
    expect(logs.stdout).toContain("tools/call echo");
    expect(logs.stdout).toContain("TOOL ERROR");

    const problems = spawnSync(process.execPath, [CLI, "logs", "--problems", "--db", tmp.db], { encoding: "utf8" });
    expect(problems.stdout).toContain("tools/call fail");
    expect(problems.stdout).not.toContain("tools/call echo");

    const sessions = spawnSync(process.execPath, [CLI, "sessions", "--db", tmp.db], { encoding: "utf8" });
    expect(sessions.stdout).toContain("echo-server");
    expect(sessions.stdout).toContain("test-agent 9.9.9");
  });

  it("keeps FIXTURE path stable", () => {
    expect(FIXTURE).toMatch(/echo-server\.mjs$/);
  });
});
