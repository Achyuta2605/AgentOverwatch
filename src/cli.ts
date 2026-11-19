#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import { formatBench, runBench } from "./bench.js";
import { CLI_NAME, CONFIG_FILE_NAME, PRODUCT_NAME } from "./brand.js";
import { ConfigError, loadConfig, policyFor, STARTER_CONFIG } from "./config.js";
import { startDashboard } from "./dashboard/server.js";
import { formatCalls, formatDiff, formatEvents, formatPins, formatSessions } from "./format.js";
import { claudeGenerator, evaluate, formatReport, generateCases } from "./redteam.js";
import { parseHeaders, runGateway } from "./run.js";
import { apiKeyFromEnv, ClaudeClassifier, type ScanMode, Scanner } from "./scanner/index.js";
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
  .usage("[options] -- <command> [args...]  |  [options] --url <url>")
  .argument("[command]", "command that starts the real MCP server")
  .argument("[args...]", "arguments for that command")
  .option("-n, --name <name>", "name to show for this server in logs (default: guessed from the command or URL)")
  .option("--url <url>", "a remote MCP server (Streamable HTTP) instead of a local command")
  .option(
    "-H, --header <header>",
    'HTTP header for a remote server, e.g. "Authorization: Bearer $TOKEN" (repeatable)',
    (v: string, all: string[]) => [...all, v],
    [] as string[],
  )
  .option("--sse", "the remote server uses the older HTTP+SSE transport")
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
  }

Example (remote server):
  "linear": {
    "command": "${CLI_NAME}",
    "args": ["run", "--url", "https://mcp.example.com/mcp", "-H", "Authorization: Bearer \${LINEAR_TOKEN}"]
  }`,
  )
  .action(
    async (
      command: string | undefined,
      args: string[],
      opts: {
        name?: string;
        db: string;
        config?: string;
        approvalTimeout: number;
        verbose?: boolean;
        url?: string;
        header: string[];
        sse?: boolean;
      },
    ) => {
      if (opts.url && command) throw new Error("give either --url or a command, not both");
      const code = await runGateway({
        command,
        args,
        url: opts.url,
        headers: parseHeaders(opts.header),
        remoteTransport: opts.sse ? "sse" : "http",
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

program
  .command("dashboard")
  .description("Open the local dashboard: live calls, blocked calls, security events and tool pins")
  .option("-p, --port <port>", "port on 127.0.0.1", positiveInt, 4319)
  .option("--db <path>", "SQLite log file", defaultDbPath())
  .action(async (opts: { port: number; db: string }) => {
    const store = new LogStore(opts.db);
    const { url, close } = await startDashboard({ store, port: opts.port }).catch((err: NodeJS.ErrnoException) => {
      store.close();
      throw new Error(
        err.code === "EADDRINUSE" ? `port ${opts.port} is in use; pick another with --port` : err.message,
      );
    });
    console.log(`${PRODUCT_NAME} dashboard: ${url}  (Ctrl+C to stop)`);
    const stop = async () => {
      await close();
      store.close();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

program
  .command("redteam")
  .description("Have Claude write fresh prompt injections and measure the scanner against them (needs an API key)")
  .option("-t, --techniques <n>", "attack techniques to try", positiveInt, 6)
  .option("-p, --per <n>", "attacks per technique", positiveInt, 5)
  .option("-b, --benign <n>", "tricky normal outputs", positiveInt, 10)
  .option("-o, --out <dir>", "where to save the cases and the report", "redteam-results")
  .action(async (opts: { techniques: number; per: number; benign: number; out: string }) => {
    const apiKey = apiKeyFromEnv();
    if (!apiKey) throw new Error("set AGENTOVERWATCH_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY");
    const day = Math.floor(Date.now() / 86_400_000);
    const cases = await generateCases(claudeGenerator(apiKey), {
      day,
      techniques: opts.techniques,
      perTechnique: opts.per,
      benign: opts.benign,
    });
    if (cases.length === 0) throw new Error("Claude returned no cases");
    const rules = await evaluate(new Scanner({ mode: "rules", cacheSize: 0 }), cases);
    const auto = await evaluate(
      new Scanner({ mode: "auto", model: new ClaudeClassifier({ apiKey }), cacheSize: 0 }),
      cases,
    );
    const stamp = new Date().toISOString().slice(0, 10);
    mkdirSync(opts.out, { recursive: true });
    writeFileSync(join(opts.out, `${stamp}.jsonl`), `${cases.map((c) => JSON.stringify(c)).join("\n")}\n`);
    const md = `${formatReport(auto, "rules + Claude")}\n\n${formatReport(rules, "rules only").replace(/### Missed[\s\S]*$/, "")}`;
    writeFileSync(join(opts.out, `${stamp}.md`), md);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
    console.log(md);
  });

program
  .command("bench")
  .description("Measure the injection scanner: attacks caught, normal outputs wrongly blocked, added time")
  .argument("[files...]", "JSONL case files (default: the bundled test set, plus bench/external if fetched)")
  .option("-m, --mode <mode>", "rules | auto | full (auto and full call Claude and need an API key)", "rules")
  .option("-n, --limit <n>", "only the first n cases of each file", positiveInt)
  .option("--json", "print the raw report")
  .option("-v, --verbose", "list the ids of missed attacks and wrongly blocked outputs")
  .action(async (files: string[], opts: { mode: string; limit?: number; json?: boolean; verbose?: boolean }) => {
    if (!["rules", "auto", "full"].includes(opts.mode)) throw new Error(`unknown mode "${opts.mode}"`);
    const mode = opts.mode as ScanMode;
    const apiKey = apiKeyFromEnv();
    if (mode !== "rules" && !apiKey) {
      throw new Error(`mode "${mode}" calls Claude: set AGENTOVERWATCH_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY`);
    }
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const targets = files.length
      ? files
      : ["cases", "external"].flatMap((d) => {
          const dir = join(root, "bench", d);
          return existsSync(dir)
            ? readdirSync(dir)
                .filter((f) => f.endsWith(".jsonl"))
                .map((f) => join(dir, f))
            : [];
        });
    if (targets.length === 0) throw new Error("no case files found");
    const model = mode !== "rules" && apiKey ? new ClaudeClassifier({ apiKey }) : undefined;
    const reports = [];
    for (const file of targets) {
      const report = await runBench(file, { mode, model, limit: opts.limit });
      reports.push(report);
      if (!opts.json) console.log(`${formatBench(report, opts.verbose)}\n`);
    }
    if (opts.json) console.log(JSON.stringify(reports, null, 2));
  });

program.parseAsync().catch((err: Error) => {
  process.stderr.write(`${CLI_NAME}: ${err.message}\n`);
  process.exit(1);
});
