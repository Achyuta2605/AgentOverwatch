#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command, InvalidArgumentError } from "commander";
import { CLI_NAME, PRODUCT_NAME } from "./brand.js";
import { formatCalls, formatSessions } from "./format.js";
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
  .action(async (command: string, args: string[], opts: { name?: string; db: string; verbose?: boolean }) => {
    const code = await runGateway({ command, args, name: opts.name, dbPath: opts.db, verbose: opts.verbose });
    process.exit(code);
  });

program
  .command("logs")
  .description("Show the most recent tool calls")
  .option("-l, --limit <n>", "number of calls", positiveInt, 30)
  .option("-s, --session <id>", "only this session (prefix is enough)")
  .option("--server <name>", "only this server")
  .option("-t, --tool <name>", "only calls to this tool")
  .option("-p, --problems", "only errors, tool errors, cancellations and missing responses")
  .option("--json", "print raw rows as JSON")
  .option("--db <path>", "SQLite log file", defaultDbPath())
  .action(
    (opts: {
      limit: number;
      session?: string;
      server?: string;
      tool?: string;
      problems?: boolean;
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

program.parseAsync().catch((err: Error) => {
  process.stderr.write(`${CLI_NAME}: ${err.message}\n`);
  process.exit(1);
});
