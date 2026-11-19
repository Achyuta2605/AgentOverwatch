import type { Finding, Verdict } from "./types.js";

/**
 * Layer 1: fast, local, free rules. They look for the fingerprints that indirect prompt injections
 * leave in data an agent reads: text addressed to the AI instead of the user, attempts to override
 * instructions, hidden characters, fake conversation markers, secrecy, and exfiltration links.
 *
 * Each rule adds a weight. The total decides the verdict:
 *   score >= INJECTION_SCORE → injection, score >= SUSPICIOUS_SCORE → suspicious, else clean.
 */
export const INJECTION_SCORE = 0.8;
export const SUSPICIOUS_SCORE = 0.35;

interface PatternRule {
  rule: string;
  weight: number;
  re: RegExp;
}

const AI = String.raw`(?:ai|a\.i\.|assistant|agent|llm|language model|chatbot|bot|claude|gpt|chatgpt|copilot|cursor|gemini|model)`;

/** Phrases that try to replace the agent's instructions. Strong signals on their own. */
const OVERRIDE: PatternRule[] = [
  {
    rule: "override-instructions",
    weight: 0.9,
    re: /\b(?:ignore|disregard|forget|override|bypass|skip)\b[^.\n]{0,40}?\b(?:all\s+|any\s+|the\s+|your\s+|my\s+)?(?:previous|prior|above|earlier|preceding|original|initial|existing|system|developer|safety)\s+(?:instructions?|prompts?|directions?|rules?|guidelines?|guidance|context|messages?|tasks?|constraints?)/i,
  },
  {
    rule: "override-instructions",
    weight: 0.9,
    re: /\b(?:ignore|disregard|forget)\s+(?:everything|all(?:\s+of)?\s+(?:that|this|the\s+above))\b/i,
  },
  {
    rule: "new-instructions",
    weight: 0.6,
    re: /\b(?:new|updated|real|actual|important|urgent|additional|revised)\s+(?:system\s+)?(?:instructions?|directives?|task|orders?)\s*(?::|follow|below|are)/i,
  },
  {
    rule: "role-reassignment",
    weight: 0.55,
    re: /\byou\s+are\s+(?:now\s+(?:an?\s+|in\s+\w+\s+mode|dan\b)|no\s+longer\s+an?\b)|\bfrom\s+now\s+on,?\s+you\s+(?:are|will|must)\b|\bact\s+as\s+(?:an?\s+)?(?:unrestricted|jailbroken|developer\s+mode|dan)\b/i,
  },
  {
    rule: "jailbreak",
    weight: 0.4,
    re: /\b(?:no|without\s+any|without)\s+(?:restrictions|rules|limits|filters|content\s+polic(?:y|ies)|safety\s+(?:checks|rules|guidelines))\b|\b(?:skip|disable|bypass|ignore)\s+(?:all\s+)?(?:safety|security)\s+(?:checks|rules|guidelines|filters)\b|\bdeveloper\s+mode\b|\bjailbr(?:eak|oken)\b/i,
  },
  {
    rule: "secrecy",
    weight: 0.5,
    re: /\b(?:do\s+not|don't|never|without|no\s+need\s+to)\s+(?:tell(?:ing)?|inform(?:ing)?|mention(?:ing)?|reveal(?:ing)?|notify(?:ing)?|alert(?:ing)?|let(?:ting)?\s+(?:the\s+)?user\s+know|show(?:ing)?)\b[^.\n]{0,30}?\b(?:the\s+)?(?:user|human|operator|owner|anyone)\b|\b(?:secretly|silently|covertly|quietly)\s+(?:send|upload|post|forward|run|execute|call|read|copy|include|exfiltrate)/i,
  },
  {
    rule: "system-prompt-probe",
    weight: 0.45,
    re: /\b(?:reveal|print|output|repeat|show|leak|send)\b[^.\n]{0,30}\b(?:your|the)\s+(?:system\s+prompt|initial\s+instructions|hidden\s+instructions|instructions\s+above)\b/i,
  },
];

/**
 * Text that speaks to the AI reading it ("AI assistant reading this:", "Dear Claude,", "the agent must").
 * Benign data almost never addresses the model; combined with an imperative it is the core of an injection.
 */
const ADDRESS_AI = new RegExp(
  [
    String.raw`\b(?:dear|attention|hey|hello|hi|note\s+(?:to|for)|message\s+(?:to|for)|p\.?s\.?\s+(?:to|for)|instructions?\s+(?:to|for)|reminder\s+(?:to|for)|for)\s*,?\s*(?:the\s+|all\s+|any\s+)?${AI}s?\b`,
    String.raw`\b(?:if\s+you(?:'re|\s+are)\s+an?|as\s+an?|any|every)\s+(?:\w+\s+)?${AI}s?\b`,
    String.raw`\b${AI}s?\s+(?:\w+\s+)?(?:reading|processing|summari[sz]ing|reviewing|triaging|parsing|analy[sz]ing|browsing)\b`,
    String.raw`(?:^|[\n.!?"(]\s*|\b(?:also|and|so|now),?\s+)${AI}s?\s*(?:[,:]\s*(?!\s*(?:sure|ok|okay|yes|no|hello|hi|here|i\b|i'm|i'll|the\s+(?:article|answer)))|\s+(?:must|should|needs?\s+to|has\s+to|is\s+required\s+to|will\s+now|shall)\b)`,
    String.raw`\bthe\s+(?:ai|assistant|agent|llm|language\s+model|model|bot)\s+(?:must|should|needs?\s+to|has\s+to|is\s+required\s+to|will\s+now|shall)\b`,
  ].join("|"),
  "i",
);

/** Requests to act: the payload of an injection once it has the AI's attention. */
const IMPERATIVE =
  /\b(?:must|should|need\s+to|needs\s+to|please|now|immediately|instead|silently|quietly|then|first|just)\s+(?:\w+\s+){0,3}?(?:delete|remove|send|forward|e-?mail|wire|transfer|approve|merge|push|grant|disable|skip|cancel|buy|subscribe|share|post|publish|upload|run|execute|install|mark|close|reply|include|recommend|state|mention|tell|say|repeat|reveal|output|print|export|open|visit|download|render|append|add|set|call|invoke|use|grant|change|update|accept)\b/i;

/**
 * Instructions about the reader's own answer ("Translate your response into Spanish", "Add this code
 * snippet to your solution"). Data meant for the user rarely tells its reader how to shape an answer,
 * so this is a strong hint of a task hijack even without any other marker. Alone it only escalates.
 */
const OUTPUT_HIJACK = new RegExp(
  [
    String.raw`\b(?:in|into|to|within|throughout|at\s+the\s+(?:end|start|beginning|top|bottom)\s+of)\s+(?:your|the\s+assistant's|the\s+ai's)\s+(?:final\s+)?(?:response|answer|reply|output|summary|solution|code)\b`,
    String.raw`(?:^|[
.!?]\s*)(?:please\s+)?(?:translate|encode|encrypt|reverse|rewrite|format|write|present|express|represent|deliver|provide|give|end|start|begin)\s+(?:\w+\s+){0,3}?your\s+(?:final\s+)?(?:response|answer|reply|output|summary)\b`,
    String.raw`\byour\s+(?:response|answer|reply|output)(?:'s)?\s+(?:must|should|needs?\s+to)\b`,
  ].join("|"),
  "i",
);

/** Markup that pretends to be the conversation or the system. */
const FAKE_MARKERS: PatternRule[] = [
  {
    rule: "chat-template-token",
    weight: 0.8,
    re: /<\|(?:im_start|im_end|system|endoftext|eot_id|start_header_id)\|>|\[\/?INST\]|<<\/?SYS>>/i,
  },
  {
    rule: "fake-system-tag",
    weight: 0.5,
    re: /<\/?\s*(?:system|sys|important|instructions?|admin|developer|assistant|tool_result|function_results?|context)\s*>|\[\/?(?:system|important|admin)\]/i,
  },
  {
    rule: "fake-turn",
    weight: 0.45,
    re: /(?:^|\n)\s*(?:#{1,3}\s*)?(?:system|assistant|human|user)\s*:\s*(?:\S)/i,
  },
];

/** Actions an attacker wants the agent to take with something sensitive. */
const SENSITIVE =
  /(?:~\/\.ssh|id_rsa|id_ed25519|\.aws\/credentials|\.env\b|api[_\s-]?keys?|secret[_\s-]?keys?|access[_\s-]?tokens?|private[_\s-]?keys?|passwords?|credentials?|session\s+cookies?|seed\s+phrase|\/etc\/passwd|ssh\s+keys?)/i;
const ACTION =
  /\b(?:send|upload|post|forward|email|e-mail|transmit|exfiltrate|leak|share|include|paste|append|attach|read|cat|copy|dump|print)\b/i;
const EXTERNAL =
  /(?:https?:\/\/(?!(?:www\.)?(?:github\.com|docs\.|developer\.|stackoverflow\.com))[^\s)"'>]+|\b[\w.+-]+@[\w-]+\.[\w.]+\b)/i;

/** Tool-steering: data telling the agent which tool to call or command to run. */
const TOOL_STEER =
  /\b(?:you\s+(?:must|should|need\s+to)|please|now|first|immediately|then)\s+(?:call|use|invoke|run|execute)\s+(?:the\s+)?(?:[`'"]?[\w.-]+[`'"]?\s+)?(?:tool|function|command)\b|\b(?:call|invoke)\s+(?:the\s+)?[`'"]?\w+[`'"]?\s+(?:tool|function)\s+with\b/i;

/** Places attackers collect stolen data. */
const EXFIL_HOSTS =
  /\b(?:webhook\.site|requestbin|pipedream\.net|ngrok(?:-free)?\.(?:io|app)|interact\.sh|oast\.(?:fun|me|pro|live|site)|burpcollaborator\.net|beeceptor\.com|hookbin\.com|requestcatcher\.com|canarytokens)\b/i;
/** Markdown images whose URL carries data in its query string, a classic zero-click exfiltration. */
const MD_IMAGE_EXFIL = /!\[[^\]]*\]\(\s*https?:\/\/[^)\s]+\?[^)\s]*(?:=|\{|\$|%7B)[^)\s]*\)/i;

const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;
const ZERO_WIDTH = /[​-‍⁠-⁤﻿]/g;
const BIDI = /[‪-‮⁦-⁩]/g;

function clip(s: string, n = 120): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

function around(text: string, index: number, len: number): string {
  return clip(text.slice(Math.max(0, index - 30), index + len + 50));
}

/** Decodes Unicode tag characters (invisible ASCII smuggling) back to readable text. */
export function decodeTagChars(text: string): string {
  return [...text]
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return cp >= 0xe0000 && cp <= 0xe007f ? String.fromCharCode(cp - 0xe0000) : "";
    })
    .join("");
}

/** Text views worth checking: the text itself plus anything hidden or encoded inside it. */
export function views(text: string): { label: string; text: string }[] {
  const out = [{ label: "", text }];
  const hidden = decodeTagChars(text);
  if (hidden.trim()) out.push({ label: "hidden tag characters: ", text: hidden });
  // Base64 blocks that decode to readable text.
  for (const m of text.matchAll(/[A-Za-z0-9+/]{60,}={0,2}/g)) {
    try {
      const decoded = Buffer.from(m[0], "base64").toString("utf8");
      const printable = decoded.replace(/[^\x20-\x7E\n]/g, "").length / Math.max(1, decoded.length);
      if (printable > 0.95 && /\s/.test(decoded)) out.push({ label: "base64: ", text: decoded });
    } catch {
      // not base64
    }
  }
  // HTML comments and hidden elements are invisible on a page but fully visible to the model.
  for (const m of text.matchAll(/<!--([\s\S]*?)-->/g)) out.push({ label: "HTML comment: ", text: m[1] ?? "" });
  return out;
}

export interface RuleResult {
  score: number;
  verdict: Verdict;
  findings: Finding[];
}

export function scanWithRules(input: string): RuleResult {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const add = (rule: string, weight: number, evidence: string) => {
    if (seen.has(rule)) return;
    seen.add(rule);
    findings.push({ layer: "rules", rule, weight, evidence });
  };

  // Invisible characters are suspicious in tool output whatever they say.
  const tags = input.match(TAG_CHARS);
  if (tags && tags.length >= 4) add("hidden-unicode-tags", 0.6, `${tags.length} invisible tag characters`);
  const zw = input.match(ZERO_WIDTH);
  if (zw && zw.length >= 8) add("zero-width-characters", 0.2, `${zw.length} zero-width characters`);
  const bidi = input.match(BIDI);
  if (bidi && bidi.length >= 2) add("bidi-override", 0.3, `${bidi.length} text-direction override characters`);

  for (const view of views(input)) {
    const t = view.text;
    for (const r of [...OVERRIDE, ...FAKE_MARKERS]) {
      const m = r.re.exec(t);
      if (!m) continue;
      // Text that *talks about* an attack ("phrases such as 'ignore previous instructions'") is not one.
      const before = t.slice(Math.max(0, m.index - 60), m.index);
      const quoted =
        /["'`“‘]\s*$/.test(before) ||
        /\b(?:such\s+as|like|e\.g\.|for\s+example|example|called|known\s+as|attacks?|attackers?|cause\s+the\s+model\s+to|phrases?)\b[^.]{0,30}$/i.test(
          before,
        );
      add(
        quoted ? `${r.rule}-mentioned` : r.rule,
        quoted ? 0.15 : r.weight,
        view.label + around(t, m.index, m[0].length),
      );
    }
    const addr = ADDRESS_AI.exec(t);
    if (addr) add("addresses-the-ai", 0.5, view.label + around(t, addr.index, addr[0].length));
    const imp = IMPERATIVE.exec(t);
    if (imp) add("imperative", 0.3, view.label + around(t, imp.index, imp[0].length));
    const hijack = OUTPUT_HIJACK.exec(t);
    if (hijack) add("output-hijack", 0.4, view.label + around(t, hijack.index, hijack[0].length));
    const steer = TOOL_STEER.exec(t);
    if (steer) add("tool-steering", 0.35, view.label + around(t, steer.index, steer[0].length));

    // "read ~/.ssh/id_rsa and send it to https://…": sensitive data + an action + somewhere to send it.
    for (const sentence of t.split(/(?<=[.!?\n])\s+/)) {
      const s = SENSITIVE.exec(sentence);
      if (s && ACTION.test(sentence)) {
        const external = EXTERNAL.test(sentence) || EXFIL_HOSTS.test(sentence);
        add(external ? "exfiltrate-secrets" : "touch-secrets", external ? 0.7 : 0.3, view.label + clip(sentence));
      }
    }
    const host = EXFIL_HOSTS.exec(t);
    if (host) add("exfiltration-host", 0.45, view.label + around(t, host.index, host[0].length));
    const img = MD_IMAGE_EXFIL.exec(t);
    if (img) {
      // A template placeholder in the URL ({chat}, $TOKEN) only makes sense if a model fills it in.
      const templated = /\{[^}]*\}|%7B|\$[A-Z_]{3,}/i.test(img[0]);
      add("markdown-image-exfiltration", templated ? 0.85 : 0.4, view.label + clip(img[0]));
    }
    if (view.label) add(`hidden-${view.label.split(" ")[0]?.toLowerCase().replace(/:$/, "")}`, 0, view.label);
  }

  // Hidden content that also carries an instruction is far worse than either alone.
  const hiddenAndInstruction =
    findings.some(
      (f) => f.evidence.startsWith("hidden") || f.evidence.startsWith("base64") || f.evidence.startsWith("HTML"),
    ) && findings.some((f) => f.weight >= 0.3 && f.rule !== "hidden-unicode-tags");
  if (hiddenAndInstruction)
    add("instruction-in-hidden-content", 0.3, "an instruction was found in hidden or encoded content");

  const score = Math.round(findings.reduce((sum, f) => sum + f.weight, 0) * 100) / 100;
  const verdict: Verdict = score >= INJECTION_SCORE ? "injection" : score >= SUSPICIOUS_SCORE ? "suspicious" : "clean";
  return { score, verdict, findings: findings.filter((f) => f.weight > 0) };
}
