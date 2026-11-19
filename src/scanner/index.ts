import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ModelClassifier, ModelVerdict } from "./model.js";
import { scanWithRules } from "./rules.js";
import type { Layer, ScanInput, ScanResult } from "./types.js";

export { apiKeyFromEnv, ClaudeClassifier, type ModelClassifier, type ModelVerdict } from "./model.js";
export { scanWithRules } from "./rules.js";
export * from "./types.js";

/**
 * - `off`: no scanning.
 * - `rules`: fast local rules only.
 * - `auto`: rules decide clear cases; Claude decides the ones rules find suspicious.
 * - `full`: Claude checks everything rules do not already block.
 */
export type ScanMode = "off" | "rules" | "auto" | "full";

/** Rules only look at this much text, so a huge file cannot slow every call down. */
const MAX_RULE_CHARS = 256_000;

export interface ScannerOptions {
  mode: ScanMode;
  /** Needed for `auto` and `full`. Without one those modes fall back to rules. */
  model?: ModelClassifier;
  /** Outputs shorter than this are not scanned. */
  minChars?: number;
  cacheSize?: number;
}

export class Scanner {
  private readonly cache = new Map<string, ScanResult>();

  constructor(private readonly opts: ScannerOptions) {}

  get mode(): ScanMode {
    return this.opts.mode;
  }

  /** True when Claude can be asked. */
  get usesModel(): boolean {
    return (this.opts.mode === "auto" || this.opts.mode === "full") && this.opts.model !== undefined;
  }

  async scan(input: ScanInput): Promise<ScanResult> {
    const started = performance.now();
    const done = (r: Omit<ScanResult, "ms">): ScanResult => ({
      ...r,
      ms: Math.round((performance.now() - started) * 100) / 100,
    });
    if (this.opts.mode === "off" || input.text.length < (this.opts.minChars ?? 1)) {
      return done({ verdict: "clean", score: 0, findings: [], layers: [], reason: "not scanned" });
    }

    const key = createHash("sha256").update(`${input.source}\0${input.text}`).digest("hex");
    const cached = this.cache.get(key);
    if (cached) {
      // Refresh its place in the LRU order.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return { ...cached, ms: 0 };
    }

    const text =
      input.text.length > MAX_RULE_CHARS
        ? `${input.text.slice(0, MAX_RULE_CHARS * 0.75)}\n${input.text.slice(-MAX_RULE_CHARS * 0.25)}`
        : input.text;
    const rules = scanWithRules(text);
    const layers: Layer[] = ["rules"];
    const ruleReason = describe(rules.findings.map((f) => f.rule));

    const askModel =
      this.usesModel && rules.verdict !== "injection" && (this.opts.mode === "full" || rules.verdict === "suspicious");

    let result: Omit<ScanResult, "ms">;
    if (!askModel) {
      result = { verdict: rules.verdict, score: rules.score, findings: rules.findings, layers, reason: ruleReason };
    } else {
      let mv: ModelVerdict | undefined;
      try {
        mv = await this.opts.model?.classify(
          input,
          rules.findings.map((f) => f.rule),
        );
      } catch (err) {
        // If Claude cannot be reached, the rules verdict stands. Never fail open to "clean" on an error
        // when the rules had a concern: keep it at least suspicious.
        result = {
          verdict: rules.verdict,
          score: rules.score,
          findings: rules.findings,
          layers,
          reason: `${ruleReason} (Claude check failed: ${(err as Error).message.slice(0, 120)})`,
        };
        return done(result);
      }
      if (!mv) throw new Error("unreachable");
      layers.push("haiku");
      if (mv.layer === "sonnet") layers.push("sonnet");
      result = {
        verdict: mv.verdict,
        score: rules.score,
        findings: [
          ...rules.findings,
          { layer: mv.layer, rule: `claude-${mv.verdict}`, weight: mv.confidence, evidence: mv.reason },
        ],
        layers,
        reason: mv.reason,
      };
    }

    const final = done(result);
    this.remember(key, final);
    return final;
  }

  private remember(key: string, r: ScanResult): void {
    this.cache.set(key, r);
    const max = this.opts.cacheSize ?? 500;
    while (this.cache.size > max) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

const RULE_TEXT: Record<string, string> = {
  "override-instructions": "tells the AI to ignore its instructions",
  "new-instructions": "gives the AI new instructions",
  "role-reassignment": "tries to change the AI's role",
  jailbreak: "uses jailbreak wording",
  secrecy: "asks the AI to hide something from the user",
  "system-prompt-probe": "asks for the AI's system prompt",
  "chat-template-token": "contains chat control tokens",
  "fake-system-tag": "contains a fake system message",
  "fake-turn": "contains a fake conversation turn",
  "addresses-the-ai": "speaks directly to the AI",
  imperative: "contains commands",
  "tool-steering": "tells the AI which tool to call",
  "output-hijack": "tells the AI how to write its answer",
  "exfiltrate-secrets": "asks to send secrets somewhere",
  "touch-secrets": "asks to read secrets",
  "exfiltration-host": "links to a known data-collection host",
  "markdown-image-exfiltration": "contains an image link that can leak data",
  "hidden-unicode-tags": "contains invisible characters",
  "zero-width-characters": "contains zero-width characters",
  "bidi-override": "contains text-direction tricks",
  "instruction-in-hidden-content": "hides instructions in invisible or encoded text",
};

function describe(rules: string[]): string {
  const real = rules.filter((r) => !r.endsWith("-mentioned"));
  if (real.length === 0) return "no warning signs";
  const parts = [...new Set(real.map((r) => RULE_TEXT[r] ?? r))];
  return `content ${parts.slice(0, 3).join(", ")}`;
}
