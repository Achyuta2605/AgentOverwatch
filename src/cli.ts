#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { CLI_NAME, CONFIG_FILE_NAME, PRODUCT_NAME } from "./brand.js";
import { ConfigError, loadConfig, policyFor, STARTER_CONFIG } from "./config.js";
import { formatCalls, formatDiff, formatEvents, formatPins, formatSessions } from "./format.js";
import { runGateway } from "./run.js";
import { defaultDbPath, LogStore } from "./store.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

function positiveInt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError("must be a positive whole number");
  return n;
}

const program = new Command()
  .name(CLI_NAME)
  .description(`${PRODUCT_NAME}: a security gateway between AI agents and their MCP tools.`)
  .version(version)
  .enablePositionalOptions();

program
  .command("run")
  .description(
    "Start an MCP server behind the gateway. Use it in place of the server's command in your agent's MCP config.",
  )
  .usage("[options] -- <command> [args...]")
  .argument("<command>", "command that starts the real MCP server")
  .argument("[args...]", "arguments for that command")
  .option("-n, --name <name>", "name to show for this server in logs (default: guessed from the command)")
  .option("--db <path>", "SQLite log file", defaultDbPath())
  .option("-c, --config <path>", `policy file (default: ./${CONFIG_FILE_NAME}, then ~/.agentoverwatch/config.yaml)`)
  .option("--approval-timeout <seconds>", "how long to wait for a person to approve a call", positiveInt, 120)
  .option("-v, --verbose", "print session start and end to stderr")
  .passThroughOptions()
  .addHelpText(
    "after",
    `
Example (Claude Code .mcp.json):
  "filesystem": {
    "command": "${CLI_NAME}",
    "args": ["run", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "."]
  }`,
  )
  .action(
    async (
      command: string,
      args: string[],
      opts: { name?: string; db: string; config?: string; approvalTimeout: number; verbose?: boolean },
    ) => {
      const code = await runGateway({
        command,
        args,
        name: opts.name,
        dbPath: opts.db,
        configPath: opts.config,
        approvalTimeoutMs: opts.approvalTimeout * 1000,
        verbose: opts.verbose,
      });
      process.exit(code);
    },
  );

/** Opens the log database, runs fn, and always closes it. */
function withStore<T>(db: string, fn: (store: LogStore) => T): T {
  const store = new LogStore(db);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

program
  .command("logs")
  .description("Show the most recent tool calls")
  .option("-l, --limit <n>", "number of calls", positiveInt, 30)
  .option("-s, --session <id>", "only this session (prefix is enough)")
  .option("--server <name>", "only this server")
  .option("-t, --tool <name>", "only calls to this tool")
  .option("-p, --problems", "only errors, tool errors, blocked calls, cancellations and missing responses")
  .option("-b, --blocked", "only calls the gateway blocked")
  .option("--json", "print raw rows as JSON")
  .option("--db <path>", "SQLite log file", defaultDbPath())
  .action(
    (opts: {
      limit: number;
      session?: string;
      server?: string;
      tool?: string;
      problems?: boolean;
      blocked?: boolean;
      json?: boolean;
      db: string;
    }) => {
      const store = new LogStore(opts.db);
      try {
        const calls = store.listCalls({
          limit: opts.limit,
          sessionId: opts.session,
          serverName: opts.server,
          toolName: opts.tool,
          onlyProblems: opts.problems,
          onlyBlocked: opts.blocked,
        });
        console.log(opts.json ? JSON.stringify(calls, null, 2) : formatCalls(calls));
      } finally {
        store.close();
      }
    },
  );

program
  .command("sessions")
  .description("Show recent gateway sessions")
  .option("-l, --limit <n>", "number of sessions", positiveInt, 20)
  .option("--json", "print raw rows as JSON")
  .option("--db <path>", "SQLite log file", defaultDbPath())
  .action((opts: { limit: number; json?: boolean; db: string }) => {
    const store = new LogStore(opts.db);
    try {
      const sessions = store.listSessions(opts.limit);
      console.log(opts.json ? JSON.stringify(sessions, null, 2) : formatSessions(sessions));
    } finally {
      store.close();
    }
  });

program
  .command("pins")
  .description("Show pinned tool definitions and any that changed")
  .argument("[server]", "only this server")
  .option("--json", "print raw rows as JSON")
  .option("--db <path>", "SQLite log file", defaultDbPath())
  .action((server: string | undefined, opts: { json?: boolean; db: string }) => {
    const pins = withStore(opts.db, (s) => s.listPins(server));
    console.log(opts.json ? JSON.stringify(pins, null, 2) : formatPins(pins));
  });

program
  .command("diff")
  .description("Show how a changed tool differs from the version you approved")
  .argument("<server>", "server name")
  .argument("[tool]", "tool name (default: every changed tool on the server)")
  .option("--db <path>", "SQLite log file", defaultDbPath())
  .action((server: string, tool: string | undefined, opts: { db: string }) => {
    const pins = withStore(opts.db, (s) => s.listPins(server)).filter(
      (p) => p.pending_hash && (!tool || p.tool_name === tool),
    );
    if (pins.length === 0) {
      console.log(tool ? `${server}/${tool} has no pending change.` : `${server} has no pending changes.`);
      return;
    }
    console.log(pins.map(formatDiff).join("\n\n"));
  });

program
  .command("approve")
  .description("Trust the current definition of changed or new tools")
  .argument("<server>", "server name")
  .argument("[tool]", "tool name (default: every pending tool on the server)")
  .option("--db <path>", "SQLite log file", defaultDbPath())
  .action((server: string, tool: string | undefined, opts: { db: string }) => {
    const approved = withStore(opts.db, (s) => s.approvePending(server, tool, Date.now()));
    if (approved.length === 0) {
      console.log(tool ? `${server}/${tool} has nothing to approve.` : `${server} has nothing to approve.`);
      process.exitCode = 1;
      return;
    }
    console.log(`Approved ${approved.length} tool(s) on ${server}: ${approved.join(", ")}`);
    console.log("Restart the agent's MCP connection (or start a new session) to use them.");
  });

program
  .command("reset-pins")
  .description("Forget every pin for a server; its tools are pinned again on next use")
  .argument("<server>", "server name")
  .option("--db <path>", "SQLite log file", defaultDbPath())
  .action((server: string, opts: { db: string }) => {
    const n = withStore(opts.db, (s) => s.resetPins(server));
    console.log(`Removed ${n} pin(s) for ${server}.`);
  });

program
  .command("events")
  .description("Show security events: pins created or changed, tools hidden, calls blocked, approvals")
  .option("-l, --limit <n>", "number of events", positiveInt, 30)
  .option("--server <name>", "only this server")
  .option("--json", "print raw rows as JSON")
  .option("--db <path>", "SQLite log file", defaultDbPath())
  .action((opts: { limit: number; server?: string; json?: boolean; db: string }) => {
    const events = withStore(opts.db, (s) => s.listEvents({ limit: opts.limit, serverName: opts.server }));
    console.log(opts.json ? JSON.stringify(events, null, 2) : formatEvents(events));
  });

program
  .command("init")
  .description(`Write a starter ${CONFIG_FILE_NAME} in the current directory`)
  .option("-f, --force", "overwrite an existing file")
  .action((opts: { force?: boolean }) => {
    const path = resolve(CONFIG_FILE_NAME);
    if (existsSync(path) && !opts.force) {
      console.error(`${path} already exists (use --force to overwrite).`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(path, STARTER_CONFIG);
    console.log(`Wrote ${path}`);
  });

program
  .command("check-config")
  .description("Validate the policy file and show the effective policy for a server")
  .argument("[server]", "server name to show the merged policy for", "*")
  .option("-c, --config <path>", "policy file")
  .action((server: string, opts: { config?: string }) => {
    try {
      const { config, path } = loadConfig(opts.config);
      console.log(path ? `Policy file: ${path} (valid)` : "No policy file found; defaults apply.");
      console.log(JSON.stringify(policyFor(config, server), null, 2));
    } catch (err) {
      console.error(err instanceof ConfigError ? err.message : (err as Error).message);
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((err: Error) => {
  process.stderr.write(`${CLI_NAME}: ${err.message}\n`);
  process.exit(1);
});
