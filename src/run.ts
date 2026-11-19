import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, type LoadedConfig, loadConfig, policyFor } from "./config.js";
import { Gateway } from "./gateway.js";
import { Guard } from "./guard.js";
import { Limiter } from "./limits.js";
import { apiKeyFromEnv, ClaudeClassifier, Scanner } from "./scanner/index.js";
import { LogStore } from "./store.js";
import { UpstreamProcess } from "./upstream.js";

export interface RunOptions {
  command: string;
  args: string[];
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

  const store = new LogStore(opts.dbPath);
  const sessionId = randomUUID();
  const serverName = opts.name ?? inferServerName(opts.command, opts.args);

  const server = new UpstreamProcess({ command: opts.command, args: opts.args });
  try {
    await server.start();
  } catch (err) {
    log(`could not start MCP server "${opts.command}": ${(err as Error).message}`);
    store.close();
    return 1;
  }

  store.startSession({
    id: sessionId,
    serverName,
    command: [opts.command, ...opts.args].join(" "),
    pid: server.pid,
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
      await server.close();
      try {
        store.endSession(sessionId, Date.now(), code);
      } finally {
        store.close();
      }
      resolve(code ?? 0);
    };

    server.onexit = (code, signal) => {
      void finish(code ?? (signal ? 1 : 0), `server exited (${signal ?? code})`);
    };
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
