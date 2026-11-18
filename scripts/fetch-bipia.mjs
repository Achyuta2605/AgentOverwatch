#!/usr/bin/env node
// Builds a held-out benchmark from Microsoft's BIPIA dataset (MIT licence, https://github.com/microsoft/BIPIA).
// The rules were never tuned on it, so it is an honest outside check.
//
//   node scripts/fetch-bipia.mjs            # downloads from GitHub
//   node scripts/fetch-bipia.mjs --from DIR # uses files you already downloaded
//
// Writes bench/external/bipia.jsonl (not committed). Each email, table and StackOverflow answer appears
// once as is (benign) and once with an attack inserted at the start, middle or end (injection).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://raw.githubusercontent.com/microsoft/BIPIA/main/benchmark";
const FILES = {
  email: { path: "email/test.jsonl", local: "benchmark_email_test.jsonl", sha256: "217b403faaa1d0cb12c24892bea39f4a0b9e2819919ac7e2b902006e28278cdb" },
  table: { path: "table/test.jsonl", local: "benchmark_table_test.jsonl", sha256: "3d5eaab192b80bada762e3cd7655583a14e5888ba8b845a01f0434e4ccc4291e" },
  code: { path: "code/test.jsonl", local: "benchmark_code_test.jsonl", sha256: "ed40b84f541352fb45753032a80750922de8d5e0b70997924df3d04cf942e058" },
  textAttacks: { path: "text_attack_test.json", local: "benchmark_text_attack_test.json", sha256: "75750e7b4e8b34e8f9d88d89b357aeaaf02bd07f9e493ccd37eda74a0cd7c7f8" },
  codeAttacks: { path: "code_attack_test.json", local: "benchmark_code_attack_test.json", sha256: "892545c5aaec0645b1ded65dc7816b3d70e9ef4eadcba2301a7a3db93676b6e0" },
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fromIdx = process.argv.indexOf("--from");
const fromDir = fromIdx > 0 ? process.argv[fromIdx + 1] : undefined;

async function load(f) {
  const text = fromDir ? readFileSync(join(fromDir, f.local), "utf8") : await (await fetch(`${BASE}/${f.path}`)).text();
  const sha = createHash("sha256").update(text).digest("hex");
  if (sha !== f.sha256) {
    console.error(`warning: ${f.path} differs from the version this benchmark was built on (sha256 ${sha.slice(0, 12)})`);
  }
  return text;
}

const jsonl = (t) => t.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const asText = (c) => (Array.isArray(c) ? c.join("\n") : String(c));
const flatten = (byCategory) =>
  Object.entries(byCategory).flatMap(([category, list]) => list.map((text) => ({ category, text })));

const contexts = {
  email: jsonl(await load(FILES.email)).map((r) => asText(r.context)),
  table: jsonl(await load(FILES.table)).map((r) => asText(r.context)),
  code: jsonl(await load(FILES.code)).map((r) => asText(r.context)),
};
const textAttacks = flatten(JSON.parse(await load(FILES.textAttacks)));
const codeAttacks = flatten(JSON.parse(await load(FILES.codeAttacks)));

/** Inserts the attack at a line break: start, middle or end. */
function insert(context, attack, where) {
  if (where === "start") return `${attack}\n${context}`;
  if (where === "end") return `${context}\n${attack}`;
  const mid = Math.floor(context.length / 2);
  const nl = context.indexOf("\n", mid);
  const at = nl === -1 ? mid : nl;
  return `${context.slice(0, at)}\n${attack}\n${context.slice(at)}`;
}

const out = [];
for (const [carrier, list] of Object.entries(contexts)) {
  const attacks = carrier === "code" ? codeAttacks : textAttacks;
  list.forEach((context, i) => {
    out.push({ id: `bipia-${carrier}-${i}-benign`, label: "benign", category: "none", carrier, text: context });
    const attack = attacks[(i * 37 + carrier.length) % attacks.length];
    const where = ["start", "middle", "end"][i % 3];
    out.push({
      id: `bipia-${carrier}-${i}-${where}`,
      label: "injection",
      category: attack.category,
      carrier,
      text: insert(context, attack.text, where),
    });
  });
}

const dest = join(root, "bench", "external", "bipia.jsonl");
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, `${out.map((c) => JSON.stringify(c)).join("\n")}\n`);
console.log(`wrote ${out.length} cases to ${dest}`);
