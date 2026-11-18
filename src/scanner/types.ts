export type ScanSource = "tool_output" | "tool_description";
export type Verdict = "clean" | "suspicious" | "injection";
export type Layer = "rules" | "haiku" | "sonnet";

export interface Finding {
  layer: Layer;
  /** Short machine name, e.g. `hidden-unicode`, `override-instructions`. */
  rule: string;
  /** How much this finding adds to the rule score (0 to 1). */
  weight: number;
  /** The text that matched, shortened for logs. */
  evidence: string;
}

export interface ScanResult {
  verdict: Verdict;
  /** Rule score, 0 (nothing) to 1 or more (certain). */
  score: number;
  findings: Finding[];
  /** Layers that ran, in order. */
  layers: Layer[];
  /** One sentence for logs and for the message the agent sees. */
  reason: string;
  ms: number;
}

export interface ScanInput {
  text: string;
  source: ScanSource;
  tool: string;
  server: string;
}
