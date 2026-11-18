import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { type ModelClassifier, type ScanMode, Scanner } from "./scanner/index.js";

export interface BenchCase {
  id: string;
  label: "injection" | "benign";
  category?: string;
  carrier?: string;
  text: string;
}

export interface BenchReport {
  file: string;
  mode: ScanMode;
  attacks: number;
  benign: number;
  /** Attacks the gateway would block. */
  blocked: number;
  /** Attacks that would at least get a warning. */
  flagged: number;
  /** Normal outputs the gateway would block. */
  falseBlocks: number;
  /** Normal outputs that would get a warning. */
  falseWarnings: number;
  modelCalls: number;
  p50Ms: number;
  p95Ms: number;
  missed: string[];
  wronglyBlocked: string[];
}

export function loadCases(path: string): BenchCase[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      const c = JSON.parse(l) as BenchCase;
      if ((c.label !== "injection" && c.label !== "benign") || typeof c.text !== "string")
        throw new Error(`${path}:${i + 1}: each case needs label "injection" or "benign" and a text`);
      return c;
    });
}

export async function runBench(
  path: string,
  opts: { mode: ScanMode; model?: ModelClassifier; limit?: number; concurrency?: number },
): Promise<BenchReport> {
  let cases = loadCases(path);
  if (opts.limit) cases = cases.slice(0, opts.limit);
  // A fresh scanner per file: the cache must not hide the cost of a real run.
  const scanner = new Scanner({ mode: opts.mode, model: opts.model, cacheSize: 0 });
  const results = new Array<{ c: BenchCase; verdict: string; ms: number; model: boolean }>(cases.length);
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const i = next++;
      const c = cases[i] as BenchCase;
      const r = await scanner.scan({ text: c.text, source: "tool_output", tool: "bench", server: basename(path) });
      results[i] = { c, verdict: r.verdict, ms: r.ms, model: r.layers.length > 1 };
    }
  };
  // Rules are synchronous, so concurrency only matters when Claude is called.
  await Promise.all(Array.from({ length: scanner.usesModel ? (opts.concurrency ?? 4) : 1 }, worker));

  const attacks = results.filter((r) => r.c.label === "injection");
  const benign = results.filter((r) => r.c.label === "benign");
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] ?? 0;
  return {
    file: path,
    mode: opts.mode,
    attacks: attacks.length,
    benign: benign.length,
    blocked: attacks.filter((r) => r.verdict === "injection").length,
    flagged: attacks.filter((r) => r.verdict !== "clean").length,
    falseBlocks: benign.filter((r) => r.verdict === "injection").length,
    falseWarnings: benign.filter((r) => r.verdict === "suspicious").length,
    modelCalls: results.filter((r) => r.model).length,
    p50Ms: pct(0.5),
    p95Ms: pct(0.95),
    missed: attacks.filter((r) => r.verdict === "clean").map((r) => r.c.id),
    wronglyBlocked: benign.filter((r) => r.verdict === "injection").map((r) => r.c.id),
  };
}

const pctOf = (n: number, d: number) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`);

export function formatBench(r: BenchReport, verbose = false): string {
  const lines = [
    `${r.file}  (mode: ${r.mode}, ${r.attacks} attacks, ${r.benign} normal outputs)`,
    `  attacks blocked          ${pctOf(r.blocked, r.attacks).padStart(7)}  (${r.blocked}/${r.attacks})`,
    `  attacks blocked or warned ${pctOf(r.flagged, r.attacks).padStart(6)}  (${r.flagged}/${r.attacks})`,
    `  normal outputs blocked   ${pctOf(r.falseBlocks, r.benign).padStart(7)}  (${r.falseBlocks}/${r.benign})`,
    `  normal outputs warned    ${pctOf(r.falseWarnings, r.benign).padStart(7)}  (${r.falseWarnings}/${r.benign})`,
    `  added time per output    p50 ${r.p50Ms} ms, p95 ${r.p95Ms} ms${r.modelCalls ? `  (${r.modelCalls} Claude checks)` : ""}`,
  ];
  if (verbose) {
    if (r.missed.length) lines.push(`  missed: ${r.missed.join(", ")}`);
    if (r.wronglyBlocked.length) lines.push(`  wrongly blocked: ${r.wronglyBlocked.join(", ")}`);
  }
  return lines.join("\n");
}
