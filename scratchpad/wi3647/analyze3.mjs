#!/usr/bin/env node
/**
 * WI-3659 — phase 2 analysis (fixed): recompute split-needed rules against
 * the CURRENT harness.css (post phase-1 deletion; old split-rules.json line
 * numbers + text are stale). Fixes a real bug in analyze2.mjs: it split the
 * RAW (unmasked) selector text on commas, so a comment sitting between two
 * rules (included in the "selector text" span before the first real
 * selector char) could inject garbage comma-separated "parts" containing
 * comment prose. This version splits STRICTLY on MASKED text (comments/
 * strings already blanked to spaces, same length/offsets as raw), so a
 * comma inside a comment or string can never be mistaken for a selector
 * separator. Raw text is used only to extract the final literal text of
 * each part for reconstruction — never for finding split points or for
 * classifying a part as dead/live.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2] || 'apps/operator/app/harness/harness.css';
const src = readFileSync(path, 'utf8');

const DEAD_FAMILIES = [
  'h-dock-shell', 'h-projects', 'h-memory', 'h-prompts-tab', 'h-insights-gate',
  'h-prompt-budget', 'h-dashboard', 'h-git', 'h-issue', 'h-agent', 'h-overview',
  'h-harness-overview',
];

function maskCommentsAndStrings(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i];
      let j = i + 1;
      while (j < n && text[j] !== quote) {
        if (text[j] === '\\') j++;
        j++;
      }
      const stop = Math.min(j + 1, n);
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

const masked = maskCommentsAndStrings(src);
if (masked.length !== src.length) throw new Error('masking changed length — bug');

const lineStartIdx = [0];
for (let i = 0; i < masked.length; i++) if (masked[i] === '\n') lineStartIdx.push(i + 1);
function idxToLine(idx) {
  let lo = 0, hi = lineStartIdx.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStartIdx[mid] <= idx) lo = mid; else hi = mid - 1; }
  return lo + 1;
}

// Walk MASKED text tracking brace depth; collect rules at depth 0, or depth 1
// nested directly inside an @media (matches prune.mjs's model).
let curDepth = 0;
let selectorStart = 0;
const atMediaStack = [];
const rules = [];
for (let i = 0; i < masked.length; i++) {
  const ch = masked[i];
  if (ch === '{') {
    const selectorTextMasked = masked.slice(selectorStart, i);
    if (curDepth === 0 || (curDepth === 1 && atMediaStack.length)) {
      if (/^\s*@/.test(selectorTextMasked)) {
        atMediaStack.push(curDepth + 1);
      } else {
        rules.push({ selStart: selectorStart, openIdx: i, depth: curDepth, selectorTextMasked });
      }
    }
    curDepth++;
    selectorStart = i + 1;
  } else if (ch === '}') {
    curDepth--;
    if (atMediaStack.length && atMediaStack[atMediaStack.length - 1] === curDepth + 1) atMediaStack.pop();
    for (let r = rules.length - 1; r >= 0; r--) {
      if (rules[r].depth === curDepth && rules[r].closeIdx === undefined) { rules[r].closeIdx = i + 1; break; }
    }
    selectorStart = i + 1;
  }
}

// Split a rule's [selStart, openIdx) span on TOP-LEVEL commas found in the
// MASKED text; return parts as {start,end} RAW-aligned offsets (no comma
// inside either boundary) plus the literal raw text for that span.
function splitTopCommaOffsets(selStartAbs, openIdxAbs) {
  const selMasked = masked.slice(selStartAbs, openIdxAbs);
  const parts = [];
  let d = 0;
  let curStart = 0;
  for (let idx = 0; idx < selMasked.length; idx++) {
    const c = selMasked[idx];
    if (c === '(') d++;
    if (c === ')') d--;
    if (c === ',' && d === 0) {
      parts.push({ start: selStartAbs + curStart, end: selStartAbs + idx });
      curStart = idx + 1;
    }
  }
  parts.push({ start: selStartAbs + curStart, end: openIdxAbs });
  return parts.map((p) => ({ ...p, rawText: src.slice(p.start, p.end), maskedText: masked.slice(p.start, p.end) }));
}

function partIsDead(maskedPartText) {
  const classes = maskedPartText.match(/\.[a-zA-Z0-9_-]+/g) || [];
  if (!classes.length) return false;
  for (const c of classes) {
    const name = c.slice(1);
    if (DEAD_FAMILIES.some((f) => name === f || name.startsWith(f + '-') || name.startsWith(f + '--'))) return true;
  }
  return false;
}

const fullyDead = [];
const splitRules = [];
const untouched = [];

for (const rule of rules) {
  if (rule.closeIdx === undefined) continue;
  const parts = splitTopCommaOffsets(rule.selStart, rule.openIdx);
  const verdicts = parts.map((p) => ({ ...p, dead: partIsDead(p.maskedText) }));
  const deadCount = verdicts.filter((v) => v.dead).length;
  const startLine = idxToLine(rule.selStart);
  const endLine = idxToLine(rule.closeIdx);
  if (deadCount === 0) {
    untouched.push({ startLine });
  } else if (deadCount === parts.length) {
    fullyDead.push({ startLine, endLine, selStart: rule.selStart, openIdx: rule.openIdx, closeIdx: rule.closeIdx });
  } else {
    splitRules.push({
      startLine, endLine,
      selStart: rule.selStart, openIdx: rule.openIdx,
      keep: verdicts.filter((v) => !v.dead).map((v) => v.rawText),
      drop: verdicts.filter((v) => v.dead).map((v) => v.rawText.trim().replace(/\s+/g, ' ').slice(0, 80)),
    });
  }
}

console.log('Total rules scanned:', rules.length);
console.log('Fully dead (should be ~0 — phase 1 already removed these):', fullyDead.length);
console.log('Split needed (mixed dead/live comma-parts):', splitRules.length);
console.log('Untouched (no dead class):', untouched.length);

if (fullyDead.length) {
  console.log('\n⚠ UNEXPECTED fully-dead rules found post-phase-1 (first 10):');
  for (const r of fullyDead.slice(0, 10)) console.log(`  L${r.startLine}-${r.endLine}`);
}

console.log('\n=== SPLIT rules sample (first 15) ===');
for (const s of splitRules.slice(0, 15)) {
  console.log(`L${s.startLine}-${s.endLine}: DROP [${s.drop.join(' | ')}]  KEEP [${s.keep.map((k) => k.trim().replace(/\s+/g, ' ').slice(0, 60)).join(' | ')}]`);
}

writeFileSync('scratchpad/wi3647/fully-dead3.json', JSON.stringify(fullyDead, null, 2));
writeFileSync('scratchpad/wi3647/split-rules3.json', JSON.stringify(splitRules, null, 2));
console.log('\nWrote fully-dead3.json (', fullyDead.length, ') and split-rules3.json (', splitRules.length, ')');
