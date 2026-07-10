#!/usr/bin/env node
/**
 * WI-3659 — final pass: purge h-project / h-feature / h-log now that
 * ControlPlaneLoading.tsx (their sole live-tree referrer) + its two
 * unreachable callers (app/loading.tsx, RouteProgressProvider.tsx) have
 * been deleted (proven dead: app/loading.tsx is a Next.js App Router
 * special file, and apps/operator's dev/build/start scripts never invoke
 * Next.js — see WI-3659 completion notes). Handles BOTH fully-dead rules
 * (whole-rule deletion) AND mixed rules (surgical comma-part removal) in
 * one pass, since this family set was never previously separated into
 * "fully dead" vs "split" buckets.
 *
 * Same safety-gate model as prune.mjs / apply-split.mjs:
 *   1. postcss can parse the result.
 *   2. Every rule that used to reference h-project/h-feature/h-log is
 *      either gone (fully dead) or has those parts stripped (mixed) —
 *      re-classification of the OUTPUT shows zero remaining references.
 *   3. No LIVE spot-check class (unrelated to these 3 families) loses its
 *      last occurrence.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import postcss from 'postcss';

const path = 'apps/operator/app/harness/harness.css';
const src = readFileSync(path, 'utf8');

const DEAD_FAMILIES = ['h-project', 'h-feature', 'h-log'];

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
      while (j < n && text[j] !== quote) { if (text[j] === '\\') j++; j++; }
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

let curDepth = 0, selectorStart = 0;
const atMediaStack = [];
const rules = [];
for (let i = 0; i < masked.length; i++) {
  const ch = masked[i];
  if (ch === '{') {
    const selTextM = masked.slice(selectorStart, i);
    if (curDepth === 0 || (curDepth === 1 && atMediaStack.length)) {
      if (/^\s*@/.test(selTextM)) atMediaStack.push(curDepth + 1);
      else rules.push({ selStart: selectorStart, openIdx: i, depth: curDepth });
    }
    curDepth++; selectorStart = i + 1;
  } else if (ch === '}') {
    curDepth--;
    if (atMediaStack.length && atMediaStack[atMediaStack.length - 1] === curDepth + 1) atMediaStack.pop();
    for (let r = rules.length - 1; r >= 0; r--) {
      if (rules[r].depth === curDepth && rules[r].closeIdx === undefined) { rules[r].closeIdx = i + 1; break; }
    }
    selectorStart = i + 1;
  }
}

function splitTopCommaOffsets(selStartAbs, openIdxAbs) {
  const selMasked = masked.slice(selStartAbs, openIdxAbs);
  const parts = [];
  let d = 0, curStart = 0;
  for (let idx = 0; idx < selMasked.length; idx++) {
    const c = selMasked[idx];
    if (c === '(') d++;
    if (c === ')') d--;
    if (c === ',' && d === 0) { parts.push({ start: selStartAbs + curStart, end: selStartAbs + idx }); curStart = idx + 1; }
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

const wholeRuleDeletes = []; // [start,end) spans to fully delete
const selectorEdits = [];    // {start,end,newSelText} for mixed rules
let fullyDeadCount = 0, mixedCount = 0;

for (const rule of rules) {
  if (rule.closeIdx === undefined) continue;
  const parts = splitTopCommaOffsets(rule.selStart, rule.openIdx);
  const verdicts = parts.map((p) => ({ ...p, dead: partIsDead(p.maskedText) }));
  const deadCount = verdicts.filter((v) => v.dead).length;
  if (deadCount === 0) continue;
  if (deadCount === parts.length) {
    const leading = masked.slice(rule.selStart, rule.openIdx).match(/^\s*/)[0].length;
    wholeRuleDeletes.push([rule.selStart + leading, rule.closeIdx]);
    fullyDeadCount++;
  } else {
    const keptParts = verdicts.filter((v) => !v.dead);
    let newSelText = keptParts.map((p) => p.rawText).join(',').replace(/^\s+/, '');
    if (!/\s$/.test(newSelText)) newSelText += ' ';
    selectorEdits.push({ start: rule.selStart, end: rule.openIdx, newSelText });
    mixedCount++;
  }
}

console.log('Fully-dead rules to delete:', fullyDeadCount);
console.log('Mixed rules to surgically edit:', mixedCount);

const allEdits = [
  ...wholeRuleDeletes.map(([s, e]) => ({ start: s, end: e, replacement: '' })),
  ...selectorEdits.map((e) => ({ start: e.start, end: e.end, replacement: e.newSelText })),
].sort((a, b) => b.start - a.start);

let out = src;
for (const e of allEdits) {
  out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
}

function countRules(cssText) {
  const root = postcss.parse(cssText);
  let n = 0;
  root.walkRules(() => n++);
  return n;
}
let rulesBefore, rulesAfter;
try {
  rulesBefore = countRules(src);
  rulesAfter = countRules(out);
} catch (e) {
  console.error('POSTCSS PARSE FAILED — refusing to write.', e.message);
  process.exit(1);
}
if (rulesBefore - fullyDeadCount !== rulesAfter) {
  console.error(`RULE COUNT MISMATCH (before=${rulesBefore}, fullyDead=${fullyDeadCount}, expected after=${rulesBefore - fullyDeadCount}, actual after=${rulesAfter}) — refusing to write.`);
  process.exit(1);
}
console.log(`postcss rule count: ${rulesBefore} -> ${rulesAfter} (removed ${fullyDeadCount} whole rules, as expected)`);

const LIVE_SPOT_CHECK = ['h-root', 'h-panel', 'h-btn', 'h-tab', 'h-cmd', 'h-cmd-overlay', 'h-plugin-card', 'h-brainstorm-map', 'h-select-item', 'h-empty', 'h-md', 'h-drawer-title-card'];
for (const cls of LIVE_SPOT_CHECK) {
  const re = new RegExp('\\.' + cls + '(?![a-zA-Z0-9_-])', 'g');
  const before = (src.match(re) || []).length;
  const after = (out.match(re) || []).length;
  if (after === 0 && before > 0) {
    console.error(`LIVE CLASS "${cls}" COMPLETELY DISAPPEARED (${before} -> 0) — refusing to write.`);
    process.exit(1);
  }
  console.log(`  live-check ${cls}: ${before} -> ${after}`);
}

for (const f of DEAD_FAMILIES) {
  const re = new RegExp('\\.' + f + '(?![a-zA-Z0-9_])', 'g');
  const before = (src.match(re) || []).length;
  const after = (out.match(re) || []).length;
  console.log(`  family ${f}: ${before} -> ${after} bare-class occurrences`);
}

// Post-edit re-classification: zero rules should still reference these families.
{
  const maskedOut = maskCommentsAndStrings(out);
  let d2 = 0, s2 = 0;
  const am2 = [];
  const rulesOut = [];
  for (let i = 0; i < maskedOut.length; i++) {
    const ch = maskedOut[i];
    if (ch === '{') {
      const selTextM = maskedOut.slice(s2, i);
      if (d2 === 0 || (d2 === 1 && am2.length)) {
        if (/^\s*@/.test(selTextM)) am2.push(d2 + 1);
        else rulesOut.push({ selStart: s2, openIdx: i });
      }
      d2++; s2 = i + 1;
    } else if (ch === '}') {
      d2--;
      if (am2.length && am2[am2.length - 1] === d2 + 1) am2.pop();
      s2 = i + 1;
    }
  }
  let remainingDead = 0;
  for (const r of rulesOut) {
    const selM = maskedOut.slice(r.selStart, r.openIdx);
    const classes = selM.match(/\.[a-zA-Z0-9_-]+/g) || [];
    for (const c of classes) {
      const name = c.slice(1);
      if (DEAD_FAMILIES.some((f) => name === f || name.startsWith(f + '-') || name.startsWith(f + '--'))) { remainingDead++; break; }
    }
  }
  if (remainingDead > 0) {
    console.error(`${remainingDead} rules STILL reference h-project/h-feature/h-log after the edit — refusing to write.`);
    process.exit(1);
  }
  console.log('Post-edit re-classification: 0 rules reference h-project/h-feature/h-log. Clean.');
}

writeFileSync(path, out);
console.log(`\nWrote ${path} (${src.length} -> ${out.length} bytes, -${src.length - out.length})`);
