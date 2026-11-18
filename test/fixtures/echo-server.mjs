// A small MCP server used by the tests. Run with: node test/fixtures/echo-server.mjs
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-fixture", version: "1.2.3" });

server.registerTool("echo", { description: "Echo text back", inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: "text", text }],
}));

server.registerTool("fail", { description: "Always reports a tool error" }, async () => ({
  isError: true,
  content: [{ type: "text", text: "disk is full" }],
}));

server.registerTool("slow", { description: "Waits, then answers", inputSchema: { ms: z.number() } }, async ({ ms }) => {
  await new Promise((r) => setTimeout(r, ms));
  return { content: [{ type: "text", text: `waited ${ms}` }] };
});

server.registerTool(
  "env",
  { description: "Reads one environment variable", inputSchema: { name: z.string() } },
  async ({ name }) => ({
    content: [{ type: "text", text: process.env[name] ?? "<unset>" }],
  }),
);

server.registerTool(
  "big",
  { description: "Returns a large result", inputSchema: { kb: z.number() } },
  async ({ kb }) => ({
    content: [{ type: "text", text: "x".repeat(kb * 1024) }],
  }),
);

server.registerTool("crash", { description: "Exits the process" }, async () => {
  setTimeout(() => process.exit(3), 10);
  return { content: [{ type: "text", text: "bye" }] };
});

await server.connect(new StdioServerTransport());
