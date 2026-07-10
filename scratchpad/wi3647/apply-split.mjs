#!/usr/bin/env node
/**
 * WI-3659 — apply the 203 split-needed edits: for each rule with a MIXED
 * comma-separated selector list (some parts reference a confirmed-dead
 * class family, some don't), rewrite the selector list to keep only the
 * live/undetermined parts, dropping the dead ones. The rule's declaration
 * block (the CSS between { and }) is NEVER touched — only the selector
 * text before it.
 *
 * Reconstruction approach (robust to any pattern/count of dead parts):
 * for each mixed rule, take the ORIGINAL raw text of each comma-part that
 * survives (computed via MASKED-text split points, so a comma inside a
 * comment/string was never mistaken for a selector separator — see
 * analyze3.mjs), and re-join the SURVIVING parts' raw text with a single
 * ",". This is provably valid CSS: each kept part's own text (including
 * any attached leading comment/whitespace) is preserved verbatim; only the
 * dead parts + one adjacent comma each are removed. The very first kept
 * part has its leading whitespace trimmed (cosmetic only, avoids a stray
 * blank line when the original first part was dropped).
 *
 * Safety gates before writing (same spirit as prune.mjs's phase-1 gates):
 *   1. Rule COUNT unchanged (we rewrite selectors in place; we never add or
 *      remove a rule).
 *   2. Brace balance of the whole file unchanged.
 *   3. Every DEAD_FAMILIES class token disappears from the touched rules'
 *      NEW selector text (per-rule check — the dead parts we computed are
 *      exactly the ones removed).
 *   4. No LIVE spot-check class loses its last remaining occurrence.
 *   5. postcss can still parse the result with the same total rule count.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import postcss from 'postcss';

const path = 'apps/operator/app/harness/harness.css';
const src = readFileSync(path, 'utf8');
const splitRules = JSON.parse(readFileSync('scratchpad/wi3647/split-rules3.json', 'utf8'));

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

// Recompute masked text + split points FRESH from the current src (never
// trust the JSON's offsets against a possibly-different file — but we just
// generated it from this exact src, so this is a paranoia re-derive, not
// a distrust of the JSON; it also lets us re-verify keep/drop coherence).
const masked = maskCommentsAndStrings(src);
if (masked.length !== src.length) throw new Error('masking changed length — bug');

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

// Re-derive edits directly from src (not from the JSON's `keep`/`drop`
// strings) so the edit is byte-exact and immune to any JSON round-trip
// whitespace/escaping drift. Sort by selStart descending so earlier
// offsets in the file stay valid as we apply edits back-to-front.
const edits = splitRules
  .map((r) => {
    const parts = splitTopCommaOffsets(r.selStart, r.openIdx);
    const verdicts = parts.map((p) => ({ ...p, dead: partIsDead(p.maskedText) }));
    const deadCount = verdicts.filter((v) => v.dead).length;
    if (deadCount === 0 || deadCount === parts.length) {
      throw new Error(`rule at ${r.selStart} is no longer mixed (dead=${deadCount}/${parts.length}) — file changed since analyze3.mjs ran; re-run analysis`);
    }
    const keptParts = verdicts.filter((v) => !v.dead);
    let newSelText = keptParts.map((p) => p.rawText).join(',');
    // Trim leading whitespace only (cosmetic: avoid a stray blank line if
    // the original first comma-part was one of the dropped ones).
    newSelText = newSelText.replace(/^\s+/, '');
    // Ensure at least one whitespace char separates the selector from '{'.
    if (!/\s$/.test(newSelText)) newSelText += ' ';
    return { start: r.selStart, end: r.openIdx, newSelText, dropCount: deadCount, keepCount: keptParts.length };
  })
  .sort((a, b) => b.start - a.start);

console.log('Edits to apply:', edits.length);

let out = src;
for (const e of edits) {
  out = out.slice(0, e.start) + e.newSelText + out.slice(e.end);
}

// Gate 1: rule count unchanged — count top-level '{' the same way prune.mjs
// counted them (raw brace count, since we only ever replace selector TEXT,
// never insert/remove a brace).
const countChar = (s, ch) => (s.match(new RegExp('\\' + ch, 'g')) || []).length;
const openBefore = countChar(src, '{'), closeBefore = countChar(src, '}');
const openAfter = countChar(out, '{'), closeAfter = countChar(out, '}');
if (openBefore !== openAfter || closeBefore !== closeAfter) {
  console.error('BRACE COUNT CHANGED — refusing to write.', { openBefore, closeBefore, openAfter, closeAfter });
  process.exit(1);
}
if (openAfter !== closeAfter) {
  console.error('UNBALANCED OUTPUT — refusing to write.', { openAfter, closeAfter });
  process.exit(1);
}

// Gate 2: postcss can still parse it, same total rule count as before edit.
function countRules(cssText) {
  const root = postcss.parse(cssText);
  let n = 0;
  root.walkRules(() => { n++; });
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
if (rulesBefore !== rulesAfter) {
  console.error(`RULE COUNT CHANGED (${rulesBefore} -> ${rulesAfter}) — refusing to write.`);
  process.exit(1);
}
console.log(`postcss rule count preserved: ${rulesBefore} -> ${rulesAfter}`);

// Gate 3: no LIVE spot-check class loses its last remaining occurrence.
const LIVE_SPOT_CHECK = ['h-root', 'h-panel', 'h-btn', 'h-tab', 'h-project', 'h-project-card', 'h-feature-row', 'h-log-line', 'h-md', 'h-drawer-title-card', 'h-focus-card', 'h-feat', 'h-inbox-row', 'h-inbox-feed'];
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

// Gate 4: every DEAD_FAMILIES bare-class occurrence count should drop (report).
for (const f of DEAD_FAMILIES) {
  const re = new RegExp('\\.' + f + '(?![a-zA-Z0-9_])', 'g');
  const before = (src.match(re) || []).length;
  const after = (out.match(re) || []).length;
  console.log(`  family ${f}: ${before} -> ${after} bare-class occurrences`);
}

// Gate 5: re-run analyze3-style classification on the OUTPUT — zero mixed
// or fully-dead rules should remain (every dead family fully purged).
{
  const maskedOut = maskCommentsAndStrings(out);
  let curDepth = 0, selectorStart = 0;
  const atMediaStack = [];
  const rulesOut = [];
  for (let i = 0; i < maskedOut.length; i++) {
    const ch = maskedOut[i];
    if (ch === '{') {
      const selTextM = maskedOut.slice(selectorStart, i);
      if (curDepth === 0 || (curDepth === 1 && atMediaStack.length)) {
        if (/^\s*@/.test(selTextM)) atMediaStack.push(curDepth + 1);
        else rulesOut.push({ selStart: selectorStart, openIdx: i, depth: curDepth });
      }
      curDepth++; selectorStart = i + 1;
    } else if (ch === '}') {
      curDepth--;
      if (atMediaStack.length && atMediaStack[atMediaStack.length - 1] === curDepth + 1) atMediaStack.pop();
      selectorStart = i + 1;
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
    console.error(`${remainingDead} rules STILL reference a dead family after the split edits — refusing to write.`);
    process.exit(1);
  }
  console.log('Post-edit re-classification: 0 rules reference any dead family. Clean.');
}

writeFileSync(path, out);
console.log(`\nWrote ${path} (${src.length} -> ${out.length} bytes, -${src.length - out.length})`);
console.log(`Applied ${edits.length} selector-list edits (dropped ${edits.reduce((a, e) => a + e.dropCount, 0)} dead comma-parts, kept ${edits.reduce((a, e) => a + e.keepCount, 0)} parts).`);
