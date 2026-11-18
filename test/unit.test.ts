import { describe, expect, it } from "vitest";
import { inferServerName } from "../src/run.js";
import { encodePayload, LogStore, MAX_STORED_BYTES } from "../src/store.js";

describe("inferServerName", () => {
  it.each([
    [["npx", ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]], "server-filesystem"],
    [["npx", ["-y", "@playwright/mcp@latest"]], "mcp"],
    [["uvx", ["mcp-server-git", "--repository", "."]], "mcp-server-git"],
    [["node", ["build/index.js"]], "index"],
    [["python3", ["-m", "my_server"]], "my_server"],
    [["/usr/local/bin/github-mcp-server", ["stdio"]], "github-mcp-server"],
    [["npx.cmd", ["-y", "some-server"]], "some-server"],
  ] as const)("%j → %s", ([cmd, args], expected) => {
    expect(inferServerName(cmd, [...args])).toBe(expected);
  });
});

describe("encodePayload", () => {
  it("keeps small payloads whole", () => {
    expect(encodePayload({ a: 1 })).toEqual({ text: '{"a":1}', bytes: 7 });
    expect(encodePayload(undefined)).toEqual({ text: null, bytes: 0 });
  });

  it("truncates large payloads and reports the full size", () => {
    const { text, bytes } = encodePayload({ s: "é".repeat(MAX_STORED_BYTES) });
    expect(bytes).toBeGreaterThan(MAX_STORED_BYTES * 2);
    expect(Buffer.byteLength(text ?? "")).toBeLessThan(MAX_STORED_BYTES + 100);
    expect(text).toContain(`${bytes} bytes total`);
  });
});

describe("LogStore", () => {
  function seeded() {
    const store = new LogStore(":memory:");
    store.startSession({ id: "s1-aaaa", serverName: "fs", command: "x", startedAt: 1 });
    store.startSession({ id: "s2-bbbb", serverName: "git", command: "y", startedAt: 2 });
    const a = store.recordRequest({
      sessionId: "s1-aaaa",
      direction: "agent_to_server",
      jsonrpcId: "1",
      method: "tools/call",
      toolName: "read_file",
      params: { name: "read_file" },
      startedAt: 10,
    });
    store.finishRequest(a, { status: "ok", response: { content: [] }, durationMs: 4 });
    const b = store.recordRequest({
      sessionId: "s2-bbbb",
      direction: "agent_to_server",
      jsonrpcId: "1",
      method: "tools/call",
      toolName: "git_push",
      params: {},
      startedAt: 20,
    });
    store.finishRequest(b, { status: "tool_error", errorMessage: "rejected", durationMs: 9 });
    store.recordRequest({
      sessionId: "s2-bbbb",
      direction: "agent_to_server",
      jsonrpcId: "2",
      method: "tools/list",
      toolName: null,
      params: {},
      startedAt: 30,
    });
    return store;
  }

  it("filters calls by session prefix, server, tool and problems", () => {
    const store = seeded();
    expect(store.listCalls({ sessionId: "s1" }).map((c) => c.tool_name)).toEqual(["read_file"]);
    expect(store.listCalls({ serverName: "git" })).toHaveLength(2);
    expect(store.listCalls({ toolName: "git_push" })[0]?.error_message).toBe("rejected");
    expect(store.listCalls({ onlyProblems: true }).map((c) => c.tool_name)).toEqual(["git_push"]);
    expect(store.listCalls({ limit: 1 })[0]?.method).toBe("tools/list");
  });

  it("marks pending calls as unanswered when a session ends", () => {
    const store = seeded();
    store.endSession("s2-bbbb", 99, 1);
    const listCall = store.listCalls({ serverName: "git" }).find((c) => c.method === "tools/list");
    expect(listCall?.status).toBe("no_response");
    const session = store.listSessions().find((s) => s.id === "s2-bbbb");
    expect(session).toMatchObject({ ended_at: 99, exit_code: 1, call_count: 2, error_count: 2 });
  });

  it("is safe to reopen an existing database", () => {
    const store = seeded();
    expect(store.db.pragma("user_version", { simple: true })).toBe(1);
  });
});
