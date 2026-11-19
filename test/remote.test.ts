import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseHeaders, redactUrl } from "../src/run.js";
import { LogStore } from "../src/store.js";
import { CLI, ROOT, tempDir } from "./helpers.js";

let tmp: ReturnType<typeof tempDir>;
let server: ChildProcess | undefined;
const clients: Client[] = [];

beforeEach(() => {
  tmp = tempDir();
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  server?.kill();
  server = undefined;
  tmp.cleanup();
});

async function startServer(env: Record<string, string> = {}): Promise<string> {
  server = spawn(process.execPath, [join(ROOT, "test", "fixtures", "http-server.mjs")], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    server?.stdout?.once("data", (d: Buffer) => resolve(d.toString().trim()));
    server?.once("exit", () => reject(new Error("fixture server exited")));
  });
}

async function viaGateway(args: string[]): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "run", "--db", tmp.db, ...args],
    env: { ...(process.env as Record<string, string>), AGENTOVERWATCH_ANTHROPIC_API_KEY: "", ANTHROPIC_API_KEY: "" },
    stderr: "pipe",
  });
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? "";

describe("remote servers", () => {
  it("proxies a Streamable HTTP server with the same protection as a local one", async () => {
    const url = await startServer();
    const c = await viaGateway(["--url", url]);
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(["echo", "fetch_page"]);
    expect(text(await c.callTool({ name: "echo", arguments: { text: "over http" } }))).toBe("over http");
    const injected = await c.callTool({ name: "fetch_page", arguments: {} });
    expect(injected.isError).toBe(true);
    expect(text(injected)).toMatch(/looks like a prompt injection/);

    const store = new LogStore(tmp.db);
    try {
      expect(store.listSessions()[0]).toMatchObject({ server_name: "127.0.0.1", command: url });
      expect(
        store
          .listPins("127.0.0.1")
          .map((p) => p.tool_name)
          .sort(),
      ).toEqual(["echo", "fetch_page"]);
    } finally {
      store.close();
    }
  });

  it("sends headers such as Authorization", async () => {
    const url = await startServer({ FIXTURE_REQUIRE_AUTH: "1" });
    const c = await viaGateway(["--url", url, "--name", "secure", "-H", "Authorization: Bearer test-token"]);
    expect(text(await c.callTool({ name: "echo", arguments: { text: "ok" } }))).toBe("ok");
  });

  it("answers the agent with an error instead of hanging when the server is unreachable", async () => {
    const url = await startServer({ FIXTURE_REQUIRE_AUTH: "1" });
    // Without the header every request is refused, starting with initialize.
    await expect(viaGateway(["--url", url])).rejects.toThrow(/the request to the MCP server failed/);
  });
});

describe("helpers", () => {
  it("hides secrets in logged URLs", () => {
    expect(redactUrl("https://user:pw@mcp.example.com/mcp?token=abc&x=1")).toBe(
      "https://mcp.example.com/mcp?token=***&x=***",
    );
  });
  it("parses headers", () => {
    expect(parseHeaders(["Authorization: Bearer a:b", "X-Team:  core "])).toEqual({
      Authorization: "Bearer a:b",
      "X-Team": "core",
    });
    expect(() => parseHeaders(["nope"])).toThrow(/Name: value/);
  });
});
