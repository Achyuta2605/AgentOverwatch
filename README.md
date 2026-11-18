# AgentGate

**A security gateway between AI agents and their MCP tools.**

Coding agents like Claude Code and Cursor now call dozens of third-party MCP tools on their own. Any one of those tools can change its description to smuggle in instructions, return output with a hidden prompt injection, or get stuck in a loop that burns money. AgentGate sits in the middle of every tool call, so you can see what your agent is doing and, soon, stop it when something is wrong.

> **Status: week 1 of 6.** Today AgentGate is a transparent gateway that records every call. Blocking features land over the next weeks (see [Roadmap](#roadmap)).

## What it does today

- **Pass-through gateway for any stdio MCP server.** The agent and the server see exactly the same messages they would without it.
- **Logs every request in both directions** (agent to server and server to agent) with its arguments, result, status and latency, in a local SQLite file.
- **Flags problems:** protocol errors, tool-reported errors, cancelled calls and requests the server never answered.
- **Adds about 0.4 ms per call** (p50; 0.5 ms at p95), measured over 1,000 calls against a local server.

Nothing leaves your machine. The log lives in `~/.agentgate/agentgate.db`.

## Quick start

Requires Node.js 20 or newer. Install it from source (see the note below the examples) until it is published to npm.

Put `agentgate run --` in front of the command that starts any MCP server.

**Claude Code** (`.mcp.json` in your project, or `claude mcp add`):

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "agentgate",
      "args": ["run", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

```bash
claude mcp add filesystem -- agentgate run -- npx -y @modelcontextprotocol/server-filesystem .
```

**Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json`): the same `command` and `args` as above.

Then use your agent as normal, and look at what happened:

```bash
agentgate logs              # most recent calls
agentgate logs --problems   # only errors, cancellations, missing responses
agentgate logs --tool read_text_file
agentgate sessions          # one row per gateway session
```

```
TIME                 SESSION   SERVER             DIR  METHOD                     STATUS  LATENCY
-------------------  --------  -----------------  ---  -------------------------  ------  -------
2026-11-18 10:07:58  0cdcd6bf  server-filesystem  →    initialize                 ok      6 ms
2026-11-18 10:07:58  0cdcd6bf  server-filesystem  →    tools/list                 ok      10 ms
2026-11-18 10:07:58  0cdcd6bf  server-filesystem  ←    roots/list                 ok      2 ms
2026-11-18 10:08:02  0cdcd6bf  server-filesystem  →    tools/call read_text_file  ok      5 ms
```

That log is from a real Claude Code session. `←` is a request the server sent back to the agent.

> AgentGate is not on npm yet. Until it is, install it from source:
>
> ```bash
> git clone https://github.com/Achyuta2605/agentgate && cd agentgate
> npm install && npm run build && npm link   # puts `agentgate` on your PATH
> ```

## CLI

| Command | What it does |
| --- | --- |
| `agentgate run [--name <name>] [--db <path>] [-v] -- <command> [args...]` | Start an MCP server behind the gateway. `--name` sets the label in logs (otherwise guessed from the command). |
| `agentgate logs [--limit n] [--session id] [--server name] [--tool name] [--problems] [--json]` | Show recent calls. |
| `agentgate sessions [--limit n] [--json]` | Show recent sessions with call and problem counts. |

Set `AGENTGATE_DB` to keep the log somewhere else.

## How it works

```
 Claude Code / Cursor  ──stdio──▶  AgentGate  ──stdio──▶  MCP server
                       ◀─────────  │  logs   ◀─────────
                                   ▼
                          ~/.agentgate/agentgate.db
```

AgentGate starts the real server as a child process with your full environment, then relays newline-delimited JSON-RPC in both directions, in order. Each request is written to SQLite when it is seen and updated when its response arrives, so a crash still leaves a record. Payloads over 32 KB are truncated in the log, never in transit. The server's stderr passes straight through to your agent's log.

## Roadmap

| Week | Feature |
| --- | --- |
| 1 | Pass-through gateway and call log (**done**) |
| 2 | Tool pinning (block tools whose descriptions change after you approved them) and a YAML policy file |
| 3 | Prompt-injection scanner for tool outputs (fast rules, then Claude Haiku, then Claude Sonnet for hard cases), plus a public attack benchmark |
| 4 | Loop and budget guard: per-session limits on calls, repeats and spend |
| 5 | Local dashboard, remote (HTTP) MCP servers, nightly red-team agent |
| 6 | Public beta |

## Development

```bash
npm install
npm test          # builds, then runs unit and end-to-end tests
npm run lint
npm run typecheck
```

The end-to-end tests run a real MCP client against a fixture server through the built CLI.

## License

Apache 2.0
