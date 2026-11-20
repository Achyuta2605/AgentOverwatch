import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyConfigs, findConfigs, unwrapEntry, wrapEntry } from "../src/install.js";
import { CLI, tempDir } from "./helpers.js";

describe("wrapping entries", () => {
  it("wraps a local server and restores it exactly", () => {
    const original = { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."], env: { A: "1" } };
    const r = wrapEntry("filesystem", original);
    expect(r).toEqual({
      status: "wrapped",
      entry: {
        env: { A: "1" },
        command: "agentoverwatch",
        args: ["run", "--name", "filesystem", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
      },
    });
    expect(r.status === "wrapped" && unwrapEntry(r.entry)).toEqual(original);
  });

  it("wraps remote servers with their headers, including Claude Code's typed form", () => {
    const original = {
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer ${TOKEN}" },
    };
    const r = wrapEntry("linear", original);
    expect(r.status === "wrapped" && r.entry).toEqual({
      type: "stdio",
      command: "agentoverwatch",
      args: ["run", "--name", "linear", "--url", "https://mcp.example.com/mcp", "-H", "Authorization: Bearer ${TOKEN}"],
    });
    expect(r.status === "wrapped" && unwrapEntry(r.entry)).toEqual(original);

    const cursorSse = { url: "https://old.example.com/sse" };
    const s = wrapEntry("old", cursorSse);
    expect(s.status === "wrapped" && s.entry.args).toContain("--sse");
    expect(s.status === "wrapped" && unwrapEntry(s.entry)).toEqual(cursorSse);
  });

  it("skips servers that are already protected, disabled, or unsupported", () => {
    expect(wrapEntry("a", { command: "agentoverwatch", args: ["run", "--", "x"] })).toMatchObject({
      reason: "already protected",
    });
    expect(wrapEntry("a", { command: "/usr/local/bin/agentoverwatch", args: [] })).toMatchObject({
      reason: "already protected",
    });
    expect(wrapEntry("a", { command: "x", disabled: true })).toMatchObject({ reason: "disabled" });
    expect(wrapEntry("a", { url: "wss://x.example/ws" })).toMatchObject({ status: "skipped" });
    expect(wrapEntry("a", { foo: 1 })).toMatchObject({ reason: "no command or url" });
    expect(unwrapEntry({ command: "npx", args: [] })).toBeNull();
  });
});

describe("config files", () => {
  let tmp: ReturnType<typeof tempDir>;
  let home: string;
  let project: string;
  beforeEach(() => {
    tmp = tempDir();
    home = join(tmp.dir, "home");
    project = join(tmp.dir, "repo");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["server-fs", "."] } } }, null, 2),
    );
    writeFileSync(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { web: { url: "https://w.example/mcp" } } }),
    );
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        userID: "keep-me",
        mcpServers: { gh: { type: "stdio", command: "gh-mcp" } },
        projects: {
          [project]: { allowedTools: [], mcpServers: { db: { command: "db-mcp" } } },
          "/other": { mcpServers: { x: { command: "x" } } },
        },
      }),
    );
  });
  afterEach(() => tmp.cleanup());

  const find = () => findConfigs({ home, cwd: project, platform: "linux" });

  it("finds the project and user config files that exist", () => {
    expect(find().map((l) => l.label)).toEqual([
      "Claude Code (this project, shared)",
      "Claude Code (all projects)",
      "Claude Code (this project, local)",
      "Cursor (all projects)",
    ]);
  });

  it("protects every server, keeps everything else, backs up, and undoes cleanly", () => {
    const before = readFileSync(join(home, ".claude.json"), "utf8");
    const dry = applyConfigs(find(), "install", { dryRun: true });
    expect(dry.changes.filter((c) => c.action === "protected")).toHaveLength(4);
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(before);

    const r = applyConfigs(find(), "install");
    expect(r.errors).toEqual([]);
    expect(r.backups).toHaveLength(3);
    const claude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    expect(claude.userID).toBe("keep-me");
    expect(claude.mcpServers.gh).toEqual({
      type: "stdio",
      command: "agentoverwatch",
      args: ["run", "--name", "gh", "--", "gh-mcp"],
    });
    expect(claude.projects[project].mcpServers.db.command).toBe("agentoverwatch");
    expect(claude.projects["/other"].mcpServers.x).toEqual({ command: "x" }); // another project: untouched
    expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.web.args).toContain("--url");
    expect(readdirSync(project).some((f) => f.startsWith(".mcp.json.agentoverwatch-backup-"))).toBe(true);

    // Running it again changes nothing.
    expect(applyConfigs(find(), "install").changes.every((c) => c.action === "skipped")).toBe(true);

    applyConfigs(find(), "uninstall");
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"))).toEqual(JSON.parse(before));
    expect(JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8"))).toEqual({
      mcpServers: { fs: { command: "npx", args: ["server-fs", "."] } },
    });
  });

  it("can limit to some servers, and leaves a broken file alone", () => {
    const r = applyConfigs(find(), "install", { only: ["fs"] });
    expect(r.changes.map((c) => c.server)).toEqual(["fs"]);
    writeFileSync(join(home, ".cursor", "mcp.json"), "{ not json");
    const bad = applyConfigs(find(), "install");
    expect(bad.errors[0]).toMatch(/could not read it as JSON/);
    expect(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).toBe("{ not json");
  });

  it("works from the command line", () => {
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [CLI, ...args], {
        cwd: project,
        env: { ...process.env, HOME: home, USERPROFILE: home },
        encoding: "utf8",
      });
    const dry = run("install", "--dry-run", "--project");
    expect(dry.stdout).toContain("would protect");
    expect(dry.stdout).toContain("Dry run");
    const real = run("install", "--client", "cursor");
    expect(real.stdout).toMatch(/✓ web\s+protected/);
    expect(real.stdout).toContain("agentoverwatch uninstall");
    expect(run("install", "--client", "nope").stderr).toMatch(/unknown client/);
  });
});
