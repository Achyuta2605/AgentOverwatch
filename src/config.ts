import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { CONFIG_ENV_VAR, CONFIG_FILE_NAME, HOME_DIR_NAME } from "./brand.js";

/**
 * The policy file. Everything is optional: an empty file (or no file) means
 * "pin tools and block changed ones, allow everything else".
 *
 * ```yaml
 * version: 1
 * servers:
 *   "*":                      # defaults for every server
 *     pinning: block          # block | warn | off
 *   filesystem:               # a server name, as shown by `agentoverwatch sessions`
 *     tools:
 *       deny: [write_file, move_file]
 *       approve: [edit_file]  # ask a human first
 *     rules:
 *       - arg: path
 *         deny_paths: ["~/.ssh/**", "**\/.env"]
 * ```
 */

const toolList = z.array(z.string().min(1)).optional();

export const RuleSchema = z
  .object({
    /** Tool name glob the rule applies to. */
    tool: z.string().min(1).default("*"),
    /** Argument to check: a name, a dot path (`options.target`), or "*" for every string argument. */
    arg: z.string().min(1).default("*"),
    /** Path globs the value must not match (after expanding ~ and resolving relative paths). */
    deny_paths: z.array(z.string().min(1)).optional(),
    /** If set, the value must match at least one of these path globs. */
    allow_paths: z.array(z.string().min(1)).optional(),
    /** Regular expressions (case-insensitive) the value must not match. */
    deny_regex: z.array(z.string().min(1)).optional(),
    /** Shown to the agent when the rule blocks a call. */
    message: z.string().optional(),
  })
  .strict()
  .refine((r) => r.deny_paths || r.allow_paths || r.deny_regex, {
    message: "a rule needs at least one of deny_paths, allow_paths or deny_regex",
  });

export const ServerPolicySchema = z
  .object({
    /** What to do when a pinned tool's definition changes. */
    pinning: z.enum(["block", "warn", "off"]).optional(),
    /** What to do with tools that first appear after the server was pinned. */
    new_tools: z.enum(["allow", "block"]).optional(),
    tools: z
      .object({
        /** If set, only these tools (globs) are visible and callable. */
        allow: toolList,
        /** These tools (globs) are hidden and blocked. */
        deny: toolList,
        /** These tools (globs) need a human to approve each call. */
        approve: toolList,
      })
      .strict()
      .optional(),
    rules: z.array(RuleSchema).optional(),
  })
  .strict();

export const ConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    servers: z.record(z.string(), ServerPolicySchema).default({}),
  })
  .strict();

export type Rule = z.infer<typeof RuleSchema>;
export type ServerPolicyInput = z.infer<typeof ServerPolicySchema>;
export type Config = z.infer<typeof ConfigSchema>;

/** The policy for one server after merging the "*" defaults. */
export interface ServerPolicy {
  pinning: "block" | "warn" | "off";
  newTools: "allow" | "block";
  allow?: string[];
  deny: string[];
  approve: string[];
  rules: Rule[];
}

export class ConfigError extends Error {}

export interface LoadedConfig {
  config: Config;
  /** The file it came from, or null when no file was found and defaults apply. */
  path: string | null;
}

/** Where to look for the policy file, in order. */
export function configCandidates(cwd = process.cwd()): string[] {
  return [join(cwd, CONFIG_FILE_NAME), join(homedir(), HOME_DIR_NAME, "config.yaml")];
}

/**
 * Loads the policy. An explicit path (flag or env var) must exist. A file that exists but is
 * invalid is an error, never silently ignored: a security tool should fail closed.
 */
export function loadConfig(explicitPath?: string, cwd = process.cwd()): LoadedConfig {
  const chosen = explicitPath ?? process.env[CONFIG_ENV_VAR];
  if (chosen) {
    const path = resolve(cwd, chosen);
    if (!existsSync(path)) throw new ConfigError(`policy file not found: ${path}`);
    return { config: parseConfig(readFileSync(path, "utf8"), path), path };
  }
  for (const path of configCandidates(cwd)) {
    if (existsSync(path)) return { config: parseConfig(readFileSync(path, "utf8"), path), path };
  }
  return { config: ConfigSchema.parse({}), path: null };
}

export function parseConfig(text: string, source = "policy file"): Config {
  let raw: unknown;
  try {
    raw = YAML.parse(text) ?? {};
  } catch (err) {
    throw new ConfigError(`${source}: invalid YAML: ${(err as Error).message}`);
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  - ${i.path.join(".") || "(top level)"}: ${i.message}`);
    throw new ConfigError(`${source} is invalid:\n${problems.join("\n")}`);
  }
  for (const [server, policy] of Object.entries(result.data.servers)) {
    for (const [i, rule] of (policy.rules ?? []).entries()) {
      for (const re of rule.deny_regex ?? []) {
        try {
          new RegExp(re, "i");
        } catch (err) {
          throw new ConfigError(`${source}: servers.${server}.rules.${i}.deny_regex: ${(err as Error).message}`);
        }
      }
    }
  }
  return result.data;
}

/** Merges the "*" defaults with the named server's policy. Lists are combined; scalars are overridden. */
export function policyFor(config: Config, serverName: string): ServerPolicy {
  const base = config.servers["*"] ?? {};
  const own = serverName === "*" ? {} : (config.servers[serverName] ?? {});
  const allow = own.tools?.allow ?? base.tools?.allow;
  return {
    pinning: own.pinning ?? base.pinning ?? "block",
    newTools: own.new_tools ?? base.new_tools ?? "allow",
    allow: allow ? [...allow] : undefined,
    deny: [...(base.tools?.deny ?? []), ...(own.tools?.deny ?? [])],
    approve: [...(base.tools?.approve ?? []), ...(own.tools?.approve ?? [])],
    rules: [...(base.rules ?? []), ...(own.rules ?? [])],
  };
}

export const STARTER_CONFIG = `# AgentOverwatch policy file. Docs: https://github.com/Achyuta2605/agentoverwatch#policy-file
version: 1
servers:
  # Defaults for every server.
  "*":
    pinning: block        # block | warn | off: what to do when a tool's definition changes
    new_tools: allow      # allow | block: tools that appear after a server was first pinned
    rules:
      # Never let any tool touch SSH keys, cloud credentials or .env files.
      - arg: "*"
        deny_paths: ["~/.ssh/**", "~/.aws/**", "~/.config/gcloud/**", "**/.env", "**/.env.*"]
        message: Access to credential files is blocked by policy.

  # Settings for one server, by the name shown in \`agentoverwatch sessions\`.
  # filesystem:
  #   tools:
  #     deny: [move_file]
  #     approve: [write_file, edit_file]   # ask a human before each call
`;
