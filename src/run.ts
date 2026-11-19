import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ConfigError, type LoadedConfig, loadConfig, policyFor } from "./config.js";
import { Gateway } from "./gateway.js";
import { Guard } from "./guard.js";
import { Limiter } from "./limits.js";
import { apiKeyFromEnv, ClaudeClassifier, Scanner } from "./scanner/index.js";
import { LogStore } from "./store.js";
import { UpstreamProcess } from "./upstream.js";

export interface RunOptions {
  /** Local server: the command that starts it. */
  command?: string;
  args: string[];
  /** Remote server: its MCP endpoint. Used instead of `command`. */
  url?: string;
  /** Extra HTTP headers for a remote server, such as Authorization. Never logged. */
  headers?: Record<string, string>;
  /** Remote servers speak Streamable HTTP by default; `sse` is for older servers. */
  remoteTransport?: "http" | "sse";
  name?: string;
  dbPath?: string;
  /** Policy file. Defaults to ./agentoverwatch.yaml, then ~/.agentoverwatch/config.yaml. */
  configPath?: string;
  verbose?: boolean;
  /** How long to wait for a person to approve a call. */
  approvalTimeoutMs?: number;
}

/**
 * Guesses a readable server name from its launch command:
 * `npx -y @modelcontextprotocol/server-filesystem /tmp` → `server-filesystem`.
 */
export function inferServerName(command: string, args: string[]): string {
  const launchers = new Set(["npx", "pnpx", "bunx", "uvx", "node", "python", "python3", "deno", "bun", "uv", "docker"]);
  const cmd = basename(command).replace(/\.(cmd|exe|bat)$/i, "");
  if (!launchers.has(cmd)) return cmd;
  const target = args.find((a) => !a.startsWith("-") && !["run", "exec", "--"].includes(a));
  if (!target) return cmd;
  const last = target.split("/").pop() ?? target;
  return (last.replace(/@[^@]*$/, "") || target).replace(/\.(m?js|ts|py)$/, "");
}

/** A readable name for a remote server: `https://mcp.linear.app/mcp` → `mcp.linear.app`. */
export function inferRemoteName(url: string): string {
  return new URL(url).hostname;
}

/** The URL as it is safe to log: no credentials, no query values (they often hold tokens). */
export function redactUrl(url: string): string {
  const u = new URL(url);
  u.username = "";
  u.password = "";
  for (const key of [...u.searchParams.keys()]) u.searchParams.set(key, "***");
  return u.toString().replace(/%2A%2A%2A/g, "***");
}

/** Parses repeated `Name: value` options. */
export function parseHeaders(list: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of list) {
    const i = h.indexOf(":");
    if (i <= 0) throw new Error(`header "${h}" should look like "Name: value"`);
    out[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  return out;
}

/** Runs one gateway session and resolves with the exit code the process should use. */
export async function runGateway(opts: RunOptions): Promise<number> {
  const log = (m: string) => process.stderr.write(`[agentoverwatch] ${m}\n`);

  // Load the policy before anything starts: a broken policy must stop the server, not be ignored.
  let loaded: LoadedConfig;
  try {
    loaded = loadConfig(opts.configPath);
  } catch (err) {
    log(err instanceof ConfigError ? err.message : `could not read policy file: ${(err as Error).message}`);
    return 1;
  }

  if (!opts.url && !opts.command) {
    log("give either the command that starts a local MCP server, or --url for a remote one");
    return 1;
  }
  let remote: URL | undefined;
  if (opts.url) {
    try {
      remote = new URL(opts.url);
      if (remote.protocol !== "https:" && remote.protocol !== "http:") throw new Error("only http and https URLs");
    } catch (err) {
      log(`invalid --url: ${(err as Error).message}`);
      return 1;
    }
  }

  const store = new LogStore(opts.dbPath);
  const sessionId = randomUUID();
  const serverName =
    opts.name ?? (remote ? inferRemoteName(remote.href) : inferServerName(opts.command as string, opts.args));

  let server: Transport;
  let local: UpstreamProcess | undefined;
  if (remote) {
    const requestInit = { headers: opts.headers ?? {} };
    server =
      opts.remoteTransport === "sse"
        ? new SSEClientTransport(remote, { requestInit })
        : new StreamableHTTPClientTransport(remote, { requestInit });
  } else {
    local = new UpstreamProcess({ command: opts.command as string, args: opts.args });
    server = local;
  }
  try {
    await server.start();
  } catch (err) {
    log(
      remote
        ? `could not connect to ${redactUrl(remote.href)}: ${(err as Error).message}`
        : `could not start MCP server "${opts.command}": ${(err as Error).message}`,
    );
    store.close();
    return 1;
  }

  store.startSession({
    id: sessionId,
    serverName,
    command: remote ? redactUrl(remote.href) : [opts.command, ...opts.args].join(" "),
    pid: local?.pid ?? process.pid,
    startedAt: Date.now(),
  });
  if (opts.verbose) {
    log(`session ${sessionId.slice(0, 8)} started for ${serverName}`);
    log(loaded.path ? `policy: ${loaded.path}` : "policy: none found, using defaults (pin tools, block changed ones)");
  }

  const guard = new Guard({
    store,
    policy: policyFor(loaded.config, serverName),
    serverName,
    sessionId,
    cwd: process.cwd(),
    warn: log,
  });
  const injection = guard.policy.injection;
  const apiKey = apiKeyFromEnv();
  const wantsModel = injection.mode === "auto" || injection.mode === "full";
  const scanner = new Scanner({
    mode: injection.mode,
    model: wantsModel && apiKey ? new ClaudeClassifier({ apiKey }) : undefined,
  });
  if (opts.verbose) {
    const how =
      injection.mode === "off"
        ? "off"
        : scanner.usesModel
          ? `${injection.mode} (rules + Claude)`
          : `${injection.mode === "rules" ? "rules" : `${injection.mode}, rules only: no Anthropic API key set`}`;
    log(`injection scanning: ${how}, action: ${injection.action}`);
  }
  const limiter = new Limiter(guard.policy.limits, () => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    // The call being checked is already logged as pending, so it does not count against itself.
    return Math.max(0, store.countToolCalls(serverName, midnight.getTime()) - 1);
  });
  const agent = new StdioServerTransport();
  const gateway = new Gateway({
    agent,
    server,
    store,
    sessionId,
    guard,
    scanner,
    limiter,
    warn: log,
    approvalTimeoutMs: opts.approvalTimeoutMs,
  });

  return new Promise<number>((resolve) => {
    let finished = false;
    const finish = async (code: number | null, reason: string) => {
      if (finished) return;
      finished = true;
      gateway.close();
      if (opts.verbose) log(`session ${sessionId.slice(0, 8)} ending: ${reason}`);
      await (local ? local.close() : server.close().catch(() => {}));
      try {
        store.endSession(sessionId, Date.now(), code);
      } finally {
        store.close();
      }
      resolve(code ?? 0);
    };

    if (local) {
      local.onexit = (code, signal) => {
        void finish(code ?? (signal ? 1 : 0), `server exited (${signal ?? code})`);
      };
    }
    // The agent closing our stdin is the normal way a session ends.
    process.stdin.once("end", () => void finish(0, "agent closed the connection"));
    process.stdin.once("close", () => void finish(0, "agent closed the connection"));
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(sig, () => void finish(0, `received ${sig}`));
    }

    gateway.start().catch((err: Error) => {
      log(`gateway failed to start: ${err.message}`);
      void finish(1, "start failure");
    });
  });
}
