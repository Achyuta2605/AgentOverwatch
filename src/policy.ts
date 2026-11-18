import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import picomatch from "picomatch";
import type { Rule, ServerPolicy } from "./config.js";

export interface Violation {
  rule: Rule;
  /** Dot path of the offending argument. */
  arg: string;
  value: string;
  reason: string;
}

const toolMatchers = new Map<string, picomatch.Matcher>();

/** True if the tool name matches any of the globs (`*`, `?`, `[abc]`, `{a,b}`). */
export function matchesAny(globs: readonly string[], name: string): boolean {
  return globs.some((g) => {
    let m = toolMatchers.get(g);
    if (!m) {
      m = picomatch(g, { dot: true });
      toolMatchers.set(g, m);
    }
    return m(name);
  });
}

/** Why a tool is hidden from the agent by the allow/deny lists, or null if it is visible. */
export function hiddenByPolicy(policy: ServerPolicy, tool: string): string | null {
  if (matchesAny(policy.deny, tool)) return `tool "${tool}" is denied by policy`;
  if (policy.allow && !matchesAny(policy.allow, tool)) return `tool "${tool}" is not in the policy's allow list`;
  return null;
}

export function needsApproval(policy: ServerPolicy, tool: string): boolean {
  return matchesAny(policy.approve, tool);
}

/** Converts a path-like argument into an absolute, normalised, forward-slash path. */
export function normalizePath(value: string, cwd: string): string {
  let v = value.trim();
  if (v.startsWith("file://")) {
    try {
      v = decodeURIComponent(new URL(v).pathname);
    } catch {
      // keep as is
    }
  }
  if (v === "~" || v.startsWith("~/") || v.startsWith("~\\")) v = homedir() + v.slice(1);
  const abs = isAbsolute(v) ? resolve(v) : resolve(cwd, v);
  return abs.replace(/\\/g, "/");
}

/** Expands `~` and makes relative patterns (`./x`, `../x`, `src/**`) absolute; leaves `**`-prefixed patterns alone. */
export function normalizePattern(pattern: string, cwd: string): string {
  let p = pattern.trim();
  if (p.startsWith("**")) return p;
  if (p === "~" || p.startsWith("~/")) p = homedir() + p.slice(1);
  if (!isAbsolute(p)) p = `${resolve(cwd).replace(/\\/g, "/")}/${p.replace(/^\.\//, "")}`;
  return p.replace(/\\/g, "/");
}

/** Every string inside a value, with its dot path. Arrays use the index as the path segment. */
export function stringLeaves(value: unknown, path = ""): { path: string; value: string }[] {
  if (typeof value === "string") return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringLeaves(v, path ? `${path}.${i}` : String(i)));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => stringLeaves(v, path ? `${path}.${k}` : k));
  }
  return [];
}

function valuesFor(args: Record<string, unknown>, arg: string): { path: string; value: string }[] {
  if (arg === "*") return stringLeaves(args);
  let cur: unknown = args;
  for (const part of arg.split(".")) {
    if (!cur || typeof cur !== "object") return [];
    cur = (cur as Record<string, unknown>)[part];
  }
  return stringLeaves(cur, arg);
}

/** Checks one tool call's arguments against the policy's rules. Returns the first violation. */
export function checkArguments(
  policy: ServerPolicy,
  tool: string,
  args: Record<string, unknown> | undefined,
  cwd: string,
): Violation | null {
  if (!args) return null;
  for (const rule of policy.rules) {
    if (!matchesAny([rule.tool], tool)) continue;
    for (const { path, value } of valuesFor(args, rule.arg)) {
      if (rule.deny_regex) {
        const hit = rule.deny_regex.find((re) => new RegExp(re, "i").test(value));
        if (hit)
          return { rule, arg: path, value, reason: rule.message ?? `argument "${path}" matches a blocked pattern` };
      }
      if (rule.deny_paths || rule.allow_paths) {
        const abs = normalizePath(value, cwd);
        const opts = { dot: true };
        if (rule.deny_paths?.some((p) => picomatch(normalizePattern(p, cwd), opts)(abs))) {
          return { rule, arg: path, value, reason: rule.message ?? `argument "${path}" points to a blocked path` };
        }
        if (rule.allow_paths && !rule.allow_paths.some((p) => picomatch(normalizePattern(p, cwd), opts)(abs))) {
          return { rule, arg: path, value, reason: rule.message ?? `argument "${path}" is outside the allowed paths` };
        }
      }
    }
  }
  return null;
}
