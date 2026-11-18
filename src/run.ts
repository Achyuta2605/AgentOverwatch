import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Gateway } from "./gateway.js";
import { LogStore } from "./store.js";
import { UpstreamProcess } from "./upstream.js";

export interface RunOptions {
  command: string;
  args: string[];
  name?: string;
  dbPath?: string;
  verbose?: boolean;
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
  if (opts.verbose) log(`session ${sessionId.slice(0, 8)} started for ${serverName}`);

  const agent = new StdioServerTransport();
  const gateway = new Gateway({ agent, server, store, sessionId, warn: log });

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
