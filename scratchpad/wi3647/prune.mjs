#!/usr/bin/env node
/**
 * WI-3647 — phase 1 (safe subset): delete only FULLY-DEAD rules from
 * harness.css, where "fully dead" means every comma-separated selector-part
 * in the rule contains at least one class token from a CONFIRMED-DEAD family
 * (zero live TSX referrers anywhere in apps/operator + apps/operator-vite,
 * excluding _retired/dist/test/spec — verified by hand before this script
 * was written; see scratchpad/wi3647/ notes).
 *
 * Classification is done on COMMENT-AND-STRING-MASKED text (so a comment
 * mentioning e.g. "git" never leaks into the selector parse); deletion spans
 * are computed on that same masked text (which is index-aligned with the
 * raw source — masking replaces chars with spaces, never removes them) so
 * indices transfer directly to the raw file. Each deleted rule's span starts
 * at the first non-whitespace character of its selector (so a leading
 * comment block immediately before a dead rule is LEFT IN PLACE, not eaten —
 * conservative: a few orphaned comments before deleted rules is a harmless
 * cosmetic follow-up, not a functional risk).
 *
 * Safety gates before writing:
 *   1. Brace balance of the whole file is unchanged (open count == close count,
 *      and equal to the pre-edit count minus 0 — deleting a whole rule removes
 *      one matched { and one matched }, so balance is preserved by construction,
 *      but we verify anyway).
 *   2. Every DEAD_FAMILIES class byte-string that appears in the file BEFORE
 *      the edit does NOT appear anywhere in the file AFTER the edit (full
 *      family removal) OR, if it does remain, it must be inside a rule we
 *      deliberately kept (split-needed rules, out of scope this pass) — we
 *      just report counts, don't hard-fail on this since split-rules keep
 *      some dead-class mentions on purpose (documented, phase 2).
 *   3. No LIVE class selector (spot sample) disappears from the output.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const path = 'apps/operator/app/harness/harness.css';
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

// Parse rules (top-level + one level inside @media) from MASKED text.
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

function splitTopComma(selText) {
  const parts = [];
  let d = 0, cur = '', startOffset = 0, offs = [];
  let curStart = 0;
  for (let idx = 0; idx < selText.length; idx++) {
    const c = selText[idx];
    if (c === '(') d++;
    if (c === ')') d--;
    if (c === ',' && d === 0) {
      parts.push({ text: cur, start: curStart, end: idx });
      cur = '';
      curStart = idx + 1;
    } else cur += c;
  }
  parts.push({ text: cur, start: curStart, end: selText.length });
  return parts;
}

function partIsDead(text) {
  const classes = text.match(/\.[a-zA-Z0-9_-]+/g) || [];
  if (!classes.length) return false;
  for (const c of classes) {
    const name = c.slice(1);
    if (DEAD_FAMILIES.some((f) => name === f || name.startsWith(f + '-') || name.startsWith(f + '--'))) return true;
  }
  return false;
}

const toDelete = []; // [start,end) spans in RAW/masked-aligned coords, descending order later
let fullyDeadCount = 0;
let splitCount = 0;

for (const rule of rules) {
  if (rule.closeIdx === undefined) continue;
  const parts = splitTopComma(rule.selectorTextMasked);
  const verdicts = parts.map((p) => ({ ...p, dead: partIsDead(p.text) }));
  const deadCount = verdicts.filter((v) => v.dead).length;
  if (deadCount === 0) continue;
  if (deadCount === parts.length) {
    // Fully dead: delete from the first non-whitespace char of the selector
    // through the rule's closing brace (inclusive).
    const leading = rule.selectorTextMasked.match(/^\s*/)[0].length;
    const deleteStart = rule.selStart + leading;
    const deleteEnd = rule.closeIdx;
    toDelete.push([deleteStart, deleteEnd]);
    fullyDeadCount++;
  } else {
    splitCount++; // out of scope this pass — left untouched, tracked for the follow-up
  }
}

console.log('Fully-dead rules to delete:', fullyDeadCount);
console.log('Split-needed rules left untouched (phase 2 follow-up):', splitCount);

// Apply deletions in descending order so earlier offsets stay valid.
toDelete.sort((a, b) => b[0] - a[0]);
let out = src;
for (const [s, e] of toDelete) {
  out = out.slice(0, s) + out.slice(e);
}

// Safety gate 1: brace balance preserved.
const countChar = (s, ch) => (s.match(new RegExp('\\' + ch, 'g')) || []).length;
const openBefore = countChar(src, '{'), closeBefore = countChar(src, '}');
const openAfter = countChar(out, '{'), closeAfter = countChar(out, '}');
if (openBefore - fullyDeadCount !== openAfter || closeBefore - fullyDeadCount !== closeAfter) {
  console.error('BRACE BALANCE MISMATCH — refusing to write.', { openBefore, closeBefore, openAfter, closeAfter, fullyDeadCount });
  process.exit(1);
}
if (openAfter !== closeAfter) {
  console.error('UNBALANCED OUTPUT — refusing to write.', { openAfter, closeAfter });
  process.exit(1);
}

// Safety gate 2: each LIVE spot-check class still has its OWN standalone rule
// after the edit (a `SELECTOR {` — not just a substring anywhere, since a dead
// rule legitimately mentioning e.g. ".h-root .h-git-panel {" in its selector
// correctly disappears with that dead rule; that must not be confused with
// losing .h-root's OWN base rule). Assert >=1 remaining occurrence of the
// class immediately followed by whitespace/comma/dot/{ (a real selector use),
// never that the count doesn't move at all.
const LIVE_SPOT_CHECK = ['h-root', 'h-panel', 'h-btn', 'h-tab', 'h-project', 'h-project-card', 'h-feature-row', 'h-log-line', 'h-md', 'h-drawer-title-card'];
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

// Safety gate 3: every DEAD_FAMILIES class byte-string count should DROP
// (report, not hard-fail — split-rules intentionally retain some).
for (const f of DEAD_FAMILIES) {
  const re = new RegExp('\\.' + f + '(?![a-zA-Z0-9_])', 'g');
  const before = (src.match(re) || []).length;
  const after = (out.match(re) || []).length;
  console.log(`  family ${f}: ${before} -> ${after} bare-class occurrences`);
}

writeFileSync(path, out);
console.log('\nWrote', path, `(${src.length} -> ${out.length} bytes, -${src.length - out.length})`);
