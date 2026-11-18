import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export const ROOT = resolve(import.meta.dirname, "..");
export const CLI = join(ROOT, "dist", "cli.js");
export const FIXTURE = join(ROOT, "test", "fixtures", "echo-server.mjs");

export function tempDir(): { dir: string; db: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agentoverwatch-test-"));
  return { dir, db: join(dir, "log.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface Connected {
  client: Client;
  transport: StdioClientTransport;
  errors: Error[];
}

/** Connects an MCP client to the fixture server, either directly or through the gateway. */
export async function connect(opts: {
  db?: string;
  direct?: boolean;
  serverArgs?: string[];
  extraGatewayArgs?: string[];
  env?: Record<string, string>;
  /** Policy file for the gateway. */
  config?: string;
  /** If set, the client advertises elicitation support and answers approval prompts with this. */
  onApproval?: (message: string) => "accept" | "decline" | "cancel" | Promise<"accept" | "decline" | "cancel">;
}): Promise<Connected> {
  // Tests never call Claude: clear any API key so scanning is rules-only and deterministic.
  const env = {
    ...(process.env as Record<string, string>),
    AGENTOVERWATCH_ANTHROPIC_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    ...opts.env,
  };
  const serverCmd = [process.execPath, FIXTURE, ...(opts.serverArgs ?? [])];
  const transport = opts.direct
    ? new StdioClientTransport({ command: process.execPath, args: serverCmd.slice(1), env, stderr: "pipe" })
    : new StdioClientTransport({
        command: process.execPath,
        args: [
          CLI,
          "run",
          "--db",
          opts.db ?? "",
          ...(opts.config ? ["--config", opts.config] : []),
          ...(opts.extraGatewayArgs ?? []),
          "--",
          ...serverCmd,
        ],
        env,
        stderr: "pipe",
      });
  const errors: Error[] = [];
  const client = new Client(
    { name: "test-agent", version: "9.9.9" },
    { capabilities: opts.onApproval ? { elicitation: {} } : {} },
  );
  const onApproval = opts.onApproval;
  if (onApproval) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => ({
      action: await onApproval(String((req.params as { message?: string }).message)),
    }));
  }
  await client.connect(transport);
  // Registered after connect so it captures protocol-level problems such as non-JSON on stdout.
  const previous = transport.onerror;
  transport.onerror = (e) => {
    errors.push(e);
    previous?.(e);
  };
  return { client, transport, errors };
}

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}
