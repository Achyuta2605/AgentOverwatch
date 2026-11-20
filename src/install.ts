import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CLI_NAME } from "./brand.js";

/**
 * `agentoverwatch install` / `uninstall`: rewrites the MCP config files of Claude Code, Cursor,
 * Claude Desktop and Windsurf so every server starts through the gateway, and back again.
 * Nothing but the `mcpServers` entries is touched, and a backup is written first.
 */

export type Client = "claude-code" | "cursor" | "claude-desktop" | "windsurf";
export const CLIENTS: Client[] = ["claude-code", "cursor", "claude-desktop", "windsurf"];

export interface ConfigLocation {
  client: Client;
  scope: "project" | "global";
  file: string;
  /** Path to the `mcpServers` object inside the JSON, e.g. ["projects", "/repo", "mcpServers"]. */
  pointer: string[];
  label: string;
}

/** Where each client keeps its MCP servers. Only files that exist are returned. */
export function findConfigs(
  opts: { home?: string; cwd?: string; platform?: NodeJS.Platform; appData?: string } = {},
): ConfigLocation[] {
  const home = opts.home ?? homedir();
  const cwd = resolve(opts.cwd ?? process.cwd());
  const platform = opts.platform ?? process.platform;
  const appData = opts.appData ?? process.env.APPDATA ?? join(home, "AppData", "Roaming");
  const desktop =
    platform === "darwin"
      ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : platform === "win32"
        ? join(appData, "Claude", "claude_desktop_config.json")
        : join(home, ".config", "Claude", "claude_desktop_config.json");

  const out: ConfigLocation[] = [
    {
      client: "claude-code",
      scope: "project",
      file: join(cwd, ".mcp.json"),
      pointer: ["mcpServers"],
      label: "Claude Code (this project, shared)",
    },
    {
      client: "cursor",
      scope: "project",
      file: join(cwd, ".cursor", "mcp.json"),
      pointer: ["mcpServers"],
      label: "Cursor (this project)",
    },
    {
      client: "claude-code",
      scope: "global",
      file: join(home, ".claude.json"),
      pointer: ["mcpServers"],
      label: "Claude Code (all projects)",
    },
    {
      client: "claude-code",
      scope: "project",
      file: join(home, ".claude.json"),
      pointer: ["projects", cwd, "mcpServers"],
      label: "Claude Code (this project, local)",
    },
    {
      client: "cursor",
      scope: "global",
      file: join(home, ".cursor", "mcp.json"),
      pointer: ["mcpServers"],
      label: "Cursor (all projects)",
    },
    { client: "claude-desktop", scope: "global", file: desktop, pointer: ["mcpServers"], label: "Claude Desktop" },
    {
      client: "windsurf",
      scope: "global",
      file: join(home, ".codeium", "windsurf", "mcp_config.json"),
      pointer: ["mcpServers"],
      label: "Windsurf",
    },
  ];
  return out.filter((l) => existsSync(l.file));
}

type Entry = Record<string, unknown>;

function isWrapped(entry: Entry, command: string): boolean {
  const cmd = typeof entry.command === "string" ? entry.command : "";
  const args = Array.isArray(entry.args) ? entry.args : [];
  return (
    cmd === command ||
    /(^|[\\/])agentoverwatch(\.cmd|\.exe)?$/.test(cmd) ||
    (args[0] === "run" && args.some((a) => /agentoverwatch/.test(String(a))))
  );
}

export type WrapResult = { status: "wrapped"; entry: Entry } | { status: "skipped"; reason: string };

/** Routes one server entry through the gateway. */
export function wrapEntry(name: string, entry: Entry, command = CLI_NAME): WrapResult {
  if (!entry || typeof entry !== "object") return { status: "skipped", reason: "not a server entry" };
  if (isWrapped(entry, command)) return { status: "skipped", reason: "already protected" };
  if (entry.disabled === true) return { status: "skipped", reason: "disabled" };
  const rest: Entry = { ...entry };

  if (typeof entry.command === "string") {
    const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
    delete rest.command;
    delete rest.args;
    delete rest.type;
    return {
      status: "wrapped",
      entry: {
        ...rest,
        ...(entry.type ? { type: "stdio" } : {}),
        command,
        args: ["run", "--name", name, "--", entry.command, ...args],
      },
    };
  }

  const url =
    typeof entry.url === "string" ? entry.url : typeof entry.serverUrl === "string" ? entry.serverUrl : undefined;
  if (url) {
    if (entry.type === "ws" || /^wss?:/.test(url))
      return { status: "skipped", reason: "WebSocket servers are not supported yet" };
    const sse = entry.type === "sse" || entry.transport === "sse" || /\/sse\/?$/.test(url);
    const headers =
      entry.headers && typeof entry.headers === "object" ? (entry.headers as Record<string, unknown>) : {};
    for (const k of ["url", "serverUrl", "headers", "type", "transport"]) delete rest[k];
    if (rest.oauth || rest.auth)
      return { status: "skipped", reason: "uses OAuth sign-in, which the gateway cannot do for it yet" };
    return {
      status: "wrapped",
      entry: {
        ...rest,
        ...(entry.type ? { type: "stdio" } : {}),
        command,
        args: [
          "run",
          "--name",
          name,
          "--url",
          url,
          ...(sse ? ["--sse"] : []),
          ...Object.entries(headers).flatMap(([k, v]) => ["-H", `${k}: ${String(v)}`]),
        ],
      },
    };
  }
  return { status: "skipped", reason: "no command or url" };
}

/** Restores the entry `wrapEntry` produced. Returns null if it was not wrapped by us. */
export function unwrapEntry(entry: Entry, command = CLI_NAME): Entry | null {
  if (!entry || typeof entry !== "object" || !isWrapped(entry, command)) return null;
  const args = (Array.isArray(entry.args) ? entry.args : []).map(String);
  const rest: Entry = { ...entry };
  delete rest.command;
  delete rest.args;
  const sep = args.indexOf("--");
  if (sep >= 0) {
    const [cmd, ...cmdArgs] = args.slice(sep + 1);
    if (!cmd) return null;
    return { ...rest, command: cmd, ...(cmdArgs.length ? { args: cmdArgs } : {}) };
  }
  const urlAt = args.indexOf("--url");
  if (urlAt >= 0 && args[urlAt + 1]) {
    const headers: Record<string, string> = {};
    args.forEach((a, i) => {
      if ((a === "-H" || a === "--header") && args[i + 1]) {
        const h = args[i + 1] as string;
        const c = h.indexOf(":");
        if (c > 0) headers[h.slice(0, c).trim()] = h.slice(c + 1).trim();
      }
    });
    const sse = args.includes("--sse");
    delete rest.type;
    return {
      ...rest,
      ...(entry.type ? { type: sse ? "sse" : "http" } : {}),
      url: args[urlAt + 1],
      ...(Object.keys(headers).length ? { headers } : {}),
    };
  }
  return null;
}

export interface Change {
  location: ConfigLocation;
  server: string;
  action: "protected" | "restored" | "skipped";
  reason?: string;
}

function at(obj: Record<string, unknown>, pointer: string[]): Record<string, Entry> | undefined {
  let cur: unknown = obj;
  for (const key of pointer) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur && typeof cur === "object" ? (cur as Record<string, Entry>) : undefined;
}

/**
 * Applies install or uninstall to the given locations. Files are only written when something changed,
 * after a timestamped backup, and atomically (write to a temp file, then rename).
 */
export function applyConfigs(
  locations: ConfigLocation[],
  mode: "install" | "uninstall",
  opts: { dryRun?: boolean; only?: string[]; command?: string; now?: Date } = {},
): { changes: Change[]; backups: string[]; errors: string[] } {
  const changes: Change[] = [];
  const backups: string[] = [];
  const errors: string[] = [];
  const byFile = new Map<string, ConfigLocation[]>();
  for (const l of locations) byFile.set(l.file, [...(byFile.get(l.file) ?? []), l]);

  for (const [file, locs] of byFile) {
    let json: Record<string, unknown>;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
      json = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch (err) {
      errors.push(`${file}: could not read it as JSON (${(err as Error).message}); left unchanged`);
      continue;
    }
    let dirty = false;
    for (const loc of locs) {
      const servers = at(json, loc.pointer);
      if (!servers) continue;
      for (const [name, entry] of Object.entries(servers)) {
        if (opts.only?.length && !opts.only.includes(name)) continue;
        if (mode === "install") {
          const r = wrapEntry(name, entry, opts.command);
          if (r.status === "wrapped") {
            servers[name] = r.entry;
            dirty = true;
            changes.push({ location: loc, server: name, action: "protected" });
          } else changes.push({ location: loc, server: name, action: "skipped", reason: r.reason });
        } else {
          const restored = unwrapEntry(entry, opts.command);
          if (restored) {
            servers[name] = restored;
            dirty = true;
            changes.push({ location: loc, server: name, action: "restored" });
          }
        }
      }
    }
    if (!dirty || opts.dryRun) continue;
    try {
      const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
      const backup = `${file}.agentoverwatch-backup-${stamp}`;
      copyFileSync(file, backup);
      backups.push(backup);
      const indent = /^\{\n(\s+)/.exec(raw)?.[1] ?? "  ";
      const tmp = `${file}.agentoverwatch-tmp`;
      writeFileSync(tmp, `${JSON.stringify(json, null, indent.includes("\t") ? "\t" : indent.length)}\n`);
      renameSync(tmp, file);
    } catch (err) {
      errors.push(`${file}: could not write it (${(err as Error).message})`);
    }
  }
  return { changes, backups, errors };
}

export function formatChanges(
  result: ReturnType<typeof applyConfigs>,
  mode: "install" | "uninstall",
  dryRun: boolean,
): string {
  const lines: string[] = [];
  const groups = new Map<string, Change[]>();
  for (const c of result.changes) groups.set(c.location.label, [...(groups.get(c.location.label) ?? []), c]);
  for (const [label, list] of groups) {
    lines.push(`${label}  (${list[0]?.location.file})`);
    for (const c of list) {
      const mark = c.action === "skipped" ? "  -" : "  ✓";
      const verb =
        c.action === "protected"
          ? dryRun
            ? "would protect"
            : "protected"
          : c.action === "restored"
            ? dryRun
              ? "would restore"
              : "restored"
            : `skipped: ${c.reason}`;
      lines.push(`${mark} ${c.server.padEnd(24)} ${verb}`);
    }
  }
  const done = result.changes.filter((c) => c.action !== "skipped").length;
  if (lines.length === 0)
    lines.push("No MCP servers found in Claude Code, Cursor, Claude Desktop or Windsurf config files.");
  else if (done === 0)
    lines.push(
      mode === "install" ? "\nNothing to change: every server is already protected." : "\nNothing to restore.",
    );
  else if (dryRun) lines.push("\nDry run: nothing was changed. Run again without --dry-run to apply.");
  else {
    for (const b of result.backups) lines.push(`Backup: ${b}`);
    lines.push(
      mode === "install"
        ? "\nRestart your agent (or reload its MCP servers) to start using AgentOverwatch. Undo with: agentoverwatch uninstall"
        : "\nRestart your agent to connect to the servers directly again.",
    );
  }
  for (const e of result.errors) lines.push(`Error: ${e}`);
  return lines.join("\n");
}
