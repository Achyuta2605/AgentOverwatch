# Policy file reference

AgentOverwatch reads the first of these it finds:

1. `--config <path>` on `agentoverwatch run`
2. the `AGENTOVERWATCH_CONFIG` environment variable
3. `./agentoverwatch.yaml` in the directory the agent starts servers from
4. `~/.agentoverwatch/config.yaml`

No file means defaults: pin tools and block changed ones, scan for injection (`auto`), default limits. An invalid file stops the server from starting. Check it with `agentoverwatch check-config [server]`, which prints the merged policy for a server. `agentoverwatch init` writes a starter file.

```yaml
version: 1
servers:
  "*":            # defaults for every server
    ...
  filesystem:     # one server, by the name shown in `agentoverwatch sessions`
    ...
```

A server's section is merged over `"*"`. Lists (`deny`, `approve`, `rules`) are combined; single values are overridden.

## pinning

| Key | Values | Default | Meaning |
| --- | --- | --- | --- |
| `pinning` | `block`, `warn`, `off` | `block` | What to do when a tool's name, description or schema changes after it was first seen. `block` hides it until you approve it (`agentoverwatch approve`, or the dashboard). |
| `new_tools` | `allow`, `block` | `allow` | Tools that appear after a server was first pinned. `block` holds them for approval. |

## tools

| Key | Meaning |
| --- | --- |
| `tools.allow` | If set, only these tools are visible and callable. Globs (`read_*`). |
| `tools.deny` | Hidden and blocked. |
| `tools.approve` | A person approves each call in the agent's prompt. Agents that cannot show prompts get a block. |

## rules

Checks on call arguments. Each rule needs at least one of `deny_paths`, `allow_paths`, `deny_regex`.

| Key | Default | Meaning |
| --- | --- | --- |
| `tool` | `"*"` | Tool name glob. |
| `arg` | `"*"` | Argument name, dot path (`options.target`), or `"*"` for every string argument. |
| `deny_paths` | | Path globs the value must not match. `~` is expanded, relative paths resolve against the agent's directory, `file://` URLs are understood. |
| `allow_paths` | | The value must match one of these. |
| `deny_regex` | | Case-insensitive regular expressions the value must not match. |
| `message` | | Shown to the agent when the rule blocks a call. |

```yaml
rules:
  - arg: "*"
    deny_paths: ["~/.ssh/**", "~/.aws/**", "**/.env", "**/.env.*"]
  - tool: run_command
    arg: command
    deny_regex: ['rm\s+-rf\s+/', 'curl[^|]*\|\s*(ba)?sh']
    message: Destructive or piped-install commands are blocked.
```

## injection

| Key | Values | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | `off`, `rules`, `auto`, `full` | `auto` | `rules`: local rules only. `auto`: rules, then Claude for unclear output. `full`: Claude checks everything rules do not block. `auto` and `full` fall back to `rules` without an API key. |
| `action` | `block`, `warn` | `block` | What to do with output judged to be an injection. Suspicious output always passes with a warning. |
| `scan_descriptions` | `true`, `false` | `true` | Also scan tool descriptions and hide poisoned tools. |

The API key comes from `AGENTOVERWATCH_ANTHROPIC_API_KEY`, then `ANTHROPIC_API_KEY`.

## limits

`0` turns a limit off. When one is reached, `on_limit: approve` asks you whether to keep going (yes allows one more batch of the same size); `block` refuses the call.

| Key | Default | Meaning |
| --- | --- | --- |
| `max_identical_calls` | `10` | Same tool and same arguments within `repeat_window`. |
| `repeat_window` | `5m` | Seconds, or `30s`, `5m`, `1h`. |
| `max_consecutive_errors` | `8` | One tool failing in a row. |
| `max_calls_per_minute` | `120` | |
| `max_calls` | `1000` | Per session. |
| `max_output_tokens` | `2000000` | Estimated tokens of tool output per session (about 4 characters per token). |
| `max_calls_per_day` | `0` | Per server, across sessions, local calendar day. |
| `on_limit` | `approve` | `approve` or `block`. |

## A complete example

```yaml
version: 1
servers:
  "*":
    pinning: block
    rules:
      - arg: "*"
        deny_paths: ["~/.ssh/**", "~/.aws/**", "**/.env"]
    injection:
      mode: auto
    limits:
      max_identical_calls: 8
      on_limit: approve

  filesystem:
    tools:
      approve: [write_file, edit_file, move_file]

  gmail:
    injection:
      mode: full          # every email is outside text
    tools:
      approve: [send_email]
    limits:
      max_calls_per_day: 500
```
