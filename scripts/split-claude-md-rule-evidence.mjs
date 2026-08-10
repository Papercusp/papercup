#!/usr/bin/env node
/**
 * P-015 — separate each CLAUDE.md block into (rule, evidence).
 *
 * WHY A BYTE OFFSET AND NOT TWO STRINGS. P-017 has to verify that no rule was
 * dropped by this pass. If the artifact stored re-typed prose, that check would
 * be a judgement call on 118 blocks. Storing a single `splitOffset` into the
 * block's own text makes it arithmetic instead:
 *
 *     raw.slice(0, off) + raw.slice(off) === raw
 *
 * so a `split` pair is loss-free BY CONSTRUCTION and P-017 is a reconstruction
 * test, not a review. Only blocks that genuinely cannot be cut at a sentence
 * boundary fall through to `authored`, where a human/agent writes the pair and
 * the original `blockSha` travels with it so the diff stays auditable. Keeping
 * that population small is the whole point of the segmenter below.
 *
 * Blocks are addressed by partKey + blockSha and the text comes from
 * `extractParts` in gen-claude-md-manifest.mjs — IMPORTED, never re-implemented.
 * That module's own header warns that a second copy of the block splitter would
 * drift silently and every key it emitted would name a block that does not
 * exist here. This file is a consumer of that split, never a second definition.
 *
 * D-002 HOLDS: this WRITES AN ARTIFACT AND DELETES NOTHING from CLAUDE.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractParts } from './gen-claude-md-manifest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = process.env.PAPERCUSP_CLAUDE_MD ?? resolve(ROOT, 'CLAUDE.md');
const DEFAULT_OUT = resolve(ROOT, 'packages/operator-core/lib/doc-projection/claude-md-rule-evidence.json');

/**
 * An EVIDENCE TELL marks a specific past observation, as opposed to a standing rule.
 *
 * Four families, each a different way this file cites what actually happened:
 *   • observation verbs  — measured / observed / verified / confirmed / reproduced / traced / corroborated
 *   • artifact ids       — EI-<n> / WI-<n>
 *   • dates              — an ISO-ish calendar date
 *   • incident outcome   — what it cost when it fired
 *
 * ⚠ THE TELL-SET IS A PRIORITISATION SIGNAL, NOT A GATE. Every block is offered
 * to the segmenter regardless; a block with no tell simply yields no cut and is
 * recorded `clean`. That ordering matters: were the tell-set used as a filter, a
 * tell this list happens to miss would silently drop a block from the pass
 * entirely, and the miss would be invisible — the artifact would look complete.
 * As a signal, the worst a missed tell can do is leave a block `clean` with its
 * full text intact under `rule`, which loses nothing and is visible in the counts.
 */
export const TELLS = [
  ['measured', /\b[Mm]easured\b/],
  ['observed', /\b[Oo]bserved\b/],
  ['verified', /\b[Vv]erified\b/],
  ['confirmed', /\bconfirm(?:ed|s)\b/i],
  ['reproduced', /\breproduc(?:ed|es)\b/i],
  ['traced', /\btraced\b/i],
  ['corroborated', /\bcorroborat/i],
  ['artifact-id', /\b(?:EI|WI)-\d+/],
  ['date', /\b20\d\d-\d\d-\d\d\b/],
  ['incident-cost', /\b(?:cost|costs|burned)\b/i],
];

export const tellsIn = (text) => TELLS.filter(([, re]) => re.test(text)).map(([k]) => k);

/**
 * Mask spans a sentence segmenter must never cut inside, replacing each with an
 * equal-length run of a filler char so every offset in the masked string is
 * still a valid offset in the original. Length preservation is the property the
 * whole approach rests on — it is what lets the cut be reported as a byte offset
 * into untouched source text.
 *
 * Masked: fenced code, inline code spans, bold runs, links, and the abbreviation
 * /decimal/path shapes whose '.' is not a sentence end.
 */
export function maskUncuttable(raw) {
  let m = raw;
  const blank = (s) => ' '.repeat(s.length);
  // Order matters: fences first (they can contain every other shape).
  m = m.replace(/```[\s\S]*?```/g, blank);
  m = m.replace(/`[^`\n]*`/g, blank);
  // Bold runs — the known mis-cut was a bold lede containing '?', which a naive
  // segmenter cut in half, producing a "rule" that ended mid-clause.
  m = m.replace(/\*\*[\s\S]*?\*\*/g, blank);
  m = m.replace(/\[[^\]\n]*\]\([^)\n]*\)/g, blank);
  // '.' that is not a sentence end.
  m = m.replace(/\b(?:e\.g|i\.e|etc|vs|cf|approx|Dr|Mr|Ms|St|no|No)\./gi, blank);
  m = m.replace(/\d+\.\d+/g, blank);            // decimals: 0.15s, 6.3.6
  m = m.replace(/\b\w+\.(?:ts|tsx|js|mjs|cjs|json|md|sh|sql|yml|yaml|toml|rs)\b/gi, blank); // paths
  m = m.replace(/\b[a-z0-9_-]+(?:\.[a-z0-9_-]+)+\b/gi, blank); // dotted idents / hostnames
  if (m.length !== raw.length) throw new Error(`mask changed length ${raw.length} -> ${m.length}`);
  return m;
}

/**
 * Offsets at which a sentence ends: '.', '!', '?' or ':' followed by whitespace
 * and something that can begin a sentence. Computed on the MASKED text, applied
 * to the original.
 */
export function sentenceBoundaries(raw) {
  const m = maskUncuttable(raw);
  const out = [];
  const re = /([.!?:])(\s+)(?=[A-Z⚠🚫✅⛔🚨ℹ(“"'\-–—•])/g;
  let match;
  while ((match = re.exec(m))) out.push(match.index + match[0].length);
  return out;
}

/**
 * Cut a block into (rule, evidence) at the first sentence boundary such that the
 * evidence side opens with an evidence tell and the rule side is non-trivial.
 *
 * Returns `null` when no such cut exists — either the block has no tell at all
 * (`clean`), or its very first sentence already carries one, meaning rule and
 * evidence share a clause and only re-authoring can separate them.
 */
export function splitRuleEvidence(raw) {
  if (!tellsIn(raw).length) return null;
  const bounds = sentenceBoundaries(raw);
  for (const off of bounds) {
    const rule = raw.slice(0, off);
    const evidence = raw.slice(off);
    if (!rule.trim() || !evidence.trim()) continue;
    // The cut earns its place only if the tell is on the evidence side and the
    // rule side is left free of one: otherwise we have merely moved the seam.
    if (!tellsIn(evidence).length) continue;
    if (tellsIn(rule).length) continue;
    // A rule shorter than this is a fragment, not a stated rule.
    if (rule.trim().length < 40) continue;
    return { splitOffset: off, rule, evidence };
  }
  return null;
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

export function buildRuleEvidence(text) {
  const parts = extractParts(text);
  const pairs = [];
  const summary = { total: parts.length, clean: 0, split: 0, needsAuthoring: 0 };

  for (const p of parts) {
    const tells = tellsIn(p.raw);
    const base = { partKey: p.partKey, ordinal: p.ordinal, blockSha: p.blockSha, chars: p.chars, tells };
    if (!tells.length) {
      summary.clean += 1;
      pairs.push({ ...base, mode: 'clean', splitOffset: null });
      continue;
    }
    const cut = splitRuleEvidence(p.raw);
    if (cut) {
      summary.split += 1;
      pairs.push({ ...base, mode: 'split', splitOffset: cut.splitOffset });
    } else {
      summary.needsAuthoring += 1;
      pairs.push({ ...base, mode: 'needs-authoring', splitOffset: null });
    }
  }

  return {
    generator: 'scripts/split-claude-md-rule-evidence.mjs',
    source: { sha256: sha256(text), chars: text.length, lines: text.split('\n').length },
    tellSet: TELLS.map(([k]) => k),
    summary,
    pairs,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const out = outIdx >= 0 ? resolve(argv[outIdx + 1]) : DEFAULT_OUT;
  const text = readFileSync(SOURCE, 'utf8');
  const artifact = buildRuleEvidence(text);
  const { total, clean, split, needsAuthoring } = artifact.summary;
  const entangled = split + needsAuthoring;

  console.log(`split-claude-md-rule-evidence: ${total} blocks from ${SOURCE}`);
  console.log(`  sha256        ${artifact.source.sha256.slice(0, 16)}  (${artifact.source.chars} chars / ${artifact.source.lines} lines)`);
  console.log(`  clean         ${String(clean).padStart(3)}  (no evidence tell — rule stands alone)`);
  console.log(`  split         ${String(split).padStart(3)}  (cut losslessly at a sentence boundary)`);
  console.log(`  needsAuthoring${String(needsAuthoring).padStart(3)}  (rule and evidence share a clause)`);
  console.log(`  entangled     ${String(entangled).padStart(3)}  = split + needsAuthoring`);

  if (argv.includes('--check')) {
    console.log('\n✓ --check: nothing written');
  } else {
    writeFileSync(out, `${JSON.stringify(artifact, null, 1)}\n`);
    console.log(`\n✓ wrote ${out}`);
  }
}
