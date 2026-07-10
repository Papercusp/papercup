#!/usr/bin/env node
/**
 * WI-3647 — refined analysis: per-selector-part classification.
 * A comma-separated selector LIST is N independent selectors. A single
 * selector (chained classes on one element, or a combinator chain across
 * ancestor/descendant) can NEVER match the live DOM if ANY class token in it
 * belongs to a CONFIRMED-DEAD family (zero live TSX referrers anywhere,
 * including dead-code files) — because CSS requires ALL parts of that one
 * selector to co-occur; if one required class is never rendered, the whole
 * selector is unmatchable, regardless of whether OTHER classes in the chain
 * are used elsewhere in a different context.
 *
 * A rule's selector-part is classified provablyDead only if it has >=1 class
 * token AND that token is from DEAD_FAMILIES. Parts with ZERO class tokens
 * (bare tag/id/attr/pseudo selectors) are left alone (too generic to reason
 * about here).
 *
 * Whole-rule verdict:
 *  - allPartsDead   -> delete the whole rule block
 *  - somePartsDead  -> SPLIT: keep the rule but drop only the dead comma-parts
 *  - noPartsDead    -> untouched
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
const lineStartIdx = [0];
for (let i = 0; i < masked.length; i++) if (masked[i] === '\n') lineStartIdx.push(i + 1);
function idxToLine(idx) {
  let lo = 0, hi = lineStartIdx.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStartIdx[mid] <= idx) lo = mid; else hi = mid - 1; }
  return lo + 1;
}

let curDepth = 0;
let selectorStart = 0;
const atMediaStack = [];
const rules = [];
for (let i = 0; i < masked.length; i++) {
  const ch = masked[i];
  if (ch === '{') {
    const selectorText = masked.slice(selectorStart, i);
    if (curDepth === 0 || (curDepth === 1 && atMediaStack.length)) {
      if (/^\s*@/.test(selectorText)) {
        atMediaStack.push(curDepth + 1);
      } else {
        rules.push({ selectorText, selStart: selectorStart, openIdx: i, depth: curDepth });
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

function splitTopComma(selText) {
  const parts = [];
  let d = 0, cur = '';
  for (const c of selText) {
    if (c === '(') d++;
    if (c === ')') d--;
    if (c === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  return parts;
}

function partIsDead(part) {
  const classes = part.match(/\.[a-zA-Z0-9_-]+/g) || [];
  if (!classes.length) return { dead: false, reason: 'no-class' };
  for (const c of classes) {
    const name = c.slice(1);
    if (DEAD_FAMILIES.some((f) => name === f || name.startsWith(f + '-') || name.startsWith(f + '--'))) {
      return { dead: true, matchedClass: name };
    }
  }
  return { dead: false, reason: 'live-or-undetermined' };
}

const fullyDead = [];
const splitRules = [];
const untouched = [];

for (const rule of rules) {
  if (rule.closeIdx === undefined) continue;
  const rawSel = src.slice(rule.selStart, rule.openIdx);
  const parts = splitTopComma(rawSel);
  const verdicts = parts.map((p) => ({ part: p, ...partIsDead(p) }));
  const deadCount = verdicts.filter((v) => v.dead).length;
  const startLine = idxToLine(rule.selStart);
  const endLine = idxToLine(rule.closeIdx);
  if (deadCount === 0) {
    untouched.push({ startLine });
  } else if (deadCount === parts.length) {
    fullyDead.push({ startLine, endLine, sel: rawSel.trim().replace(/\s+/g, ' ').slice(0, 150) });
  } else {
    splitRules.push({
      startLine, endLine,
      keepParts: verdicts.filter((v) => !v.dead).map((v) => v.part.trim()),
      dropParts: verdicts.filter((v) => v.dead).map((v) => v.part.trim()),
    });
  }
}

console.log('Total rules scanned:', rules.length);
console.log('Fully dead (delete whole rule):', fullyDead.length);
console.log('Split needed (drop some comma-parts, keep others):', splitRules.length);
console.log('Untouched (no dead class):', untouched.length);

console.log('\n=== SPLIT rules (manual-safe list, first 40) ===');
for (const s of splitRules.slice(0, 40)) {
  console.log(`L${s.startLine}-${s.endLine}: DROP [${s.dropParts.join(' | ')}]  KEEP [${s.keepParts.join(' | ')}]`);
}

writeFileSync('scratchpad/wi3647/fully-dead2.json', JSON.stringify(fullyDead, null, 2));
writeFileSync('scratchpad/wi3647/split-rules.json', JSON.stringify(splitRules, null, 2));
console.log('\nWrote fully-dead2.json (', fullyDead.length, ') and split-rules.json (', splitRules.length, ')');
