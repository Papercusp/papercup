#!/usr/bin/env node
/**
 * WI-3647 — analyze harness.css: find top-level rule blocks (at nesting depth 1,
 * i.e. either bare top-level rules or rules nested one level inside an @media)
 * and classify each by whether ALL of its comma-separated selectors reference
 * ONLY classes from the DEAD family set below. Reports mixed rules (a dead-family
 * selector sharing a comma-list with something else) separately — those need
 * manual review, never blind deletion.
 *
 * Read-only. Prints a report; does not modify the file.
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2] || 'apps/operator/app/harness/harness.css';
const src = readFileSync(path, 'utf8');

// The confirmed ZERO-referrer-anywhere families (safe set, phase 1).
const DEAD_FAMILIES = [
  'h-dock-shell', 'h-projects', 'h-memory', 'h-prompts-tab', 'h-insights-gate',
  'h-prompt-budget', 'h-dashboard', 'h-git', 'h-issue', 'h-agent', 'h-overview',
  'h-harness-overview',
];

// Mask comments and string literals so brace-counting / selector text is clean,
// but PRESERVE exact character offsets (replace with spaces, not deletion).
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

// Walk the masked text tracking brace depth + line numbers, recording each
// top-level (depth 0->1) and @media-nested (depth 1->2) rule's selector text
// and its [startIdx, endIdx) span in the ORIGINAL source (braces included).
let depth = 0;
let lineNo = 1;
const lineStartIdx = [0];
for (let i = 0; i < masked.length; i++) {
  if (masked[i] === '\n') { lineNo++; lineStartIdx.push(i + 1); }
}

function idxToLine(idx) {
  // binary search
  let lo = 0, hi = lineStartIdx.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStartIdx[mid] <= idx) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

const rules = [];
let selectorStart = 0;
let curDepth = 0;
const atMediaStack = []; // depth at which an @media block opened

for (let i = 0; i < masked.length; i++) {
  const ch = masked[i];
  if (ch === '{') {
    const selectorText = masked.slice(selectorStart, i).trim();
    if (curDepth === 0 || (curDepth === 1 && atMediaStack.length && atMediaStack[atMediaStack.length - 1] === curDepth)) {
      // Could be an @media itself (selectorText starts with @) or a real rule.
      if (/^@/.test(selectorText)) {
        atMediaStack.push(curDepth + 1);
      } else {
        // record a candidate rule opening at this depth; find its matching close.
        rules.push({ selectorText, openIdx: i, depth: curDepth });
      }
    }
    curDepth++;
    selectorStart = i + 1;
  } else if (ch === '}') {
    curDepth--;
    if (atMediaStack.length && atMediaStack[atMediaStack.length - 1] === curDepth + 1) {
      atMediaStack.pop();
    }
    // close the most recent open rule at this depth without a close yet
    for (let r = rules.length - 1; r >= 0; r--) {
      if (rules[r].depth === curDepth && rules[r].closeIdx === undefined) {
        rules[r].closeIdx = i + 1; // include the closing brace
        break;
      }
    }
    selectorStart = i + 1;
  }
}

function classifySelector(selText) {
  // Split top-level commas (selectors here never contain commas inside parens
  // in this file's style, but guard for :is()/:not() anyway by depth tracking).
  const parts = [];
  let d = 0, cur = '';
  for (const c of selText) {
    if (c === '(') d++;
    if (c === ')') d--;
    if (c === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function selectorFamilies(sel) {
  // Extract every class token in this single selector, return the set of
  // DEAD_FAMILIES prefixes it matches (a class matches a family if it equals
  // the family or starts with `${family}-` or `${family}--`).
  const classes = sel.match(/\.[a-zA-Z0-9_-]+/g) || [];
  const fams = new Set();
  let hasNonDeadClass = false;
  let hasAnyClass = classes.length > 0;
  for (const c of classes) {
    const name = c.slice(1);
    const fam = DEAD_FAMILIES.find((f) => name === f || name.startsWith(f + '-') || name.startsWith(f + '--'));
    if (fam) fams.add(fam); else hasNonDeadClass = true;
  }
  return { fams: [...fams], hasNonDeadClass, hasAnyClass };
}

const report = { fullyDead: [], mixed: [], byFamily: {} };
for (const f of DEAD_FAMILIES) report.byFamily[f] = { ruleCount: 0, lineSpans: [] };

for (const rule of rules) {
  if (rule.closeIdx === undefined) continue; // unmatched, shouldn't happen
  const selParts = classifySelector(rule.selectorText);
  if (!selParts.length) continue;
  let allDead = true;
  let anyDead = false;
  const famsHit = new Set();
  for (const sel of selParts) {
    const { fams, hasNonDeadClass, hasAnyClass } = selectorFamilies(sel);
    if (!hasAnyClass) { allDead = false; continue; } // no class at all (e.g. an id/tag selector) - be safe, don't touch
    if (fams.length) { anyDead = true; fams.forEach((f) => famsHit.add(f)); }
    if (hasNonDeadClass) allDead = false;
    if (!fams.length) allDead = false;
  }
  if (anyDead && allDead) {
    const startLine = idxToLine(rule.openIdx - rule.selectorText.length) ;
    const endLine = idxToLine(rule.closeIdx);
    report.fullyDead.push({ sel: rule.selectorText.trim().slice(0, 120), startLine, endLine, fams: [...famsHit] });
    for (const f of famsHit) {
      report.byFamily[f].ruleCount++;
      report.byFamily[f].lineSpans.push([startLine, endLine]);
    }
  } else if (anyDead && !allDead) {
    const startLine = idxToLine(rule.openIdx - rule.selectorText.length);
    report.mixed.push({ sel: rule.selectorText.trim().slice(0, 200), startLine, fams: [...famsHit] });
  }
}

console.log('=== FULLY-DEAD rules (safe to delete):', report.fullyDead.length, '===');
console.log('=== MIXED rules (dead family shares a selector list with something else — MANUAL REVIEW):', report.mixed.length, '===');
for (const m of report.mixed) {
  console.log(`  L${m.startLine} [${m.fams.join(',')}] ${m.sel}`);
}
console.log('\n=== per-family rule counts (fully-dead only) ===');
for (const [f, v] of Object.entries(report.byFamily)) {
  console.log(`  ${f}: ${v.ruleCount} rules`);
}

// Dump full fullyDead list + line spans to JSON for the deletion pass.
import { writeFileSync } from 'node:fs';
writeFileSync('scratchpad/wi3647/fully-dead.json', JSON.stringify(report.fullyDead, null, 2));
console.log('\nWrote scratchpad/wi3647/fully-dead.json (', report.fullyDead.length, 'rules )');
