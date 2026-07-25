#!/usr/bin/env node
/**
 * check-sql-guidance-justified.mjs — lint:sql-guidance-justified.
 *
 * The recurrence guard for
 * claimable-read-tool-and-sql-encapsulation-audit-2026-07-21 (P-006).
 *
 * The rule: a HOT read with a stable shape belongs behind a TOOL that wraps the
 * canonical SQL so it cannot drift. The audit's finding was that the drift kept
 * coming back through GUIDANCE, not through code — a doc or a tool's own
 * `guidance` told the next agent to hand-write the query, and the hand-written
 * version then disagreed with what the queue actually served (the 8-vs-2-vs-0
 * claimability incident). Fixing the tool without guarding the guidance just
 * re-arms the trap for whoever writes the next runbook.
 *
 * So: an agent-facing surface may not tell an agent to SELECT from a table that
 * a dedicated tool already covers, unless it says WHY that tool doesn't fit.
 *
 * COVERED TABLES (each has an authoritative tool):
 *   work_items / work_items_claimable → work_items:claimable (claim floors),
 *                                       work_items:list (filtered slice)
 *   harness_plans                     → plans:list (filters + groupBy aggregates),
 *                                       plans:items (pickable items)
 *   engineer_issues                   → work_items:list / improvements:capture
 *
 * WHERE it looks (agent-facing surfaces only):
 *   - a tool's own `description:` / `guidance:` text under **\/agent-tools\/**.ts
 *     (the SQL a tool RUNS is the point — only what it TELLS agents is linted);
 *   - agent-facing prose: docs MDX, the prompt sources, CLAUDE.md / AGENT-ENV.md.
 *
 * WHAT it deliberately does NOT flag:
 *   - implementation SQL anywhere outside those guidance regions (that IS the
 *     encapsulation working);
 *   - tests / fixtures;
 *   - a query over any other table — a genuinely one-off forensic read of
 *     tool_invocations, agent_sessions, dbos.*, … is exactly what dev:pg_query
 *     is FOR, and an insight doc showing one is not a violation.
 *
 * HOW to satisfy it: put the reason at the site, on the same line or within the
 * 3 lines above (any comment syntax — `//`, `--`, `#`, `<!-- -->`, or prose):
 *
 *     sql-snippet-justified: shown as the counter-example the doc is about
 *     sql-snippet-justified: no tool exposes this cross-table join
 *
 * A bare marker with no reason after the colon is rejected — "justify" is the
 * whole rule, so an empty marker is just a mute button.
 *
 *   node scripts/check-sql-guidance-justified.mjs           # report + exit 1
 *   node scripts/check-sql-guidance-justified.mjs --report  # report, exit 0
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_ONLY = process.argv.includes('--report');

/** Tables whose canonical read is already a tool. */
const COVERED_TABLES = [
  'work_items_claimable',
  'work_items',
  'harness_plans',
  'engineer_issues',
];

/** A SELECT … FROM <covered table> on one line — the "run this" shape. */
const SQL_RE = new RegExp(
  `\\bselect\\b[\\s\\S]{0,200}?\\bfrom\\s+(?:harness_shared\\.)?(${COVERED_TABLES.join('|')})\\b`,
  'i',
);

/** The justification marker; everything after the colon is the reason. The `m`
 *  flag matters: the marker is searched in a multi-LINE window, so `$` must mean
 *  end-of-line, not end-of-window (without it only a marker on the window's last
 *  line matched — every real justification read as unjustified). */
const MARKER_RE = /sql-snippet-justified:[ \t]*(\S.*)$/im;
/** How many lines above the hit may carry the marker. */
const MARKER_LOOKBACK = 3;

/** Which tool to point the author at, per covered table. */
const TOOL_FOR = {
  work_items: 'work_items:claimable (claim floors) / work_items:list (filtered slice)',
  work_items_claimable: 'work_items:claimable — the view is NOT the claim verdict',
  harness_plans: 'plans:list (filters, groupBy/aggregateOnly) / plans:items',
  engineer_issues: 'work_items:list / improvements:capture',
};

const PATHSPECS = [
  'packages/*/lib/agent-tools/**/*.ts',
  'packages/agent-mcp/src/**/*.ts',
  'apps/operator-docs/src/content/docs/**/*.mdx',
  'apps/operator/prompts/**/*.md',
  'libs/papercusp/packages/harness/prompts/**/*.md',
  'CLAUDE.md',
  'AGENT-ENV.md',
];

function isTestFile(file) {
  return (
    /\.test\.(ts|tsx|mjs)$/.test(file) ||
    file.includes('/__tests__/') ||
    file.includes('/test/') ||
    /fixture|-rig\.ts$/.test(file)
  );
}

/**
 * Char ranges of a TS file that are agent-FACING text: the `description:`
 * string literal and the whole `guidance: { … }` object. SQL outside these is
 * the tool's own implementation — the thing we WANT.
 */
function guidanceRegions(src) {
  const regions = [];
  // description: '<literal>' — walk the literal so escapes/newlines are handled.
  for (const m of src.matchAll(/\bdescription\s*:\s*/g)) {
    let i = m.index + m[0].length;
    const q = src[i];
    if (q !== "'" && q !== '"' && q !== '`') continue;
    let k = i + 1;
    while (k < src.length) {
      if (src[k] === '\\') { k += 2; continue; }
      if (src[k] === q) break;
      k++;
    }
    regions.push([i, k]);
  }
  // guidance: { … } — brace-matched (string-aware enough for our literals).
  for (const m of src.matchAll(/\bguidance\s*:\s*\{/g)) {
    let depth = 0;
    let k = m.index + m[0].length - 1;
    const start = k;
    let quote = null;
    for (; k < src.length; k++) {
      const c = src[k];
      if (quote) {
        if (c === '\\') { k++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    regions.push([start, k]);
  }
  return regions;
}

/** Byte offset of the START of 1-indexed `lineno` in `src`. */
function lineOffset(src, lineno) {
  let off = 0;
  for (let i = 1; i < lineno; i++) {
    const nl = src.indexOf('\n', off);
    if (nl < 0) return off;
    off = nl + 1;
  }
  return off;
}

let raw = '';
try {
  raw = execFileSync(
    'git',
    ['grep', '-nIEi', `from[[:space:]]+(harness_shared\\.)?(${COVERED_TABLES.join('|')})`, '--', ...PATHSPECS],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
} catch (e) {
  if (e.status === 1) raw = ''; // git grep exits 1 on no matches
  else throw e;
}

const fileCache = new Map();
function fileText(file) {
  if (!fileCache.has(file)) {
    try {
      fileCache.set(file, readFileSync(join(ROOT, file), 'utf8'));
    } catch {
      fileCache.set(file, '');
    }
  }
  return fileCache.get(file);
}

const hits = [];
for (const line of raw.split('\n')) {
  const m = line.match(/^([^:]+):(\d+):(.*)$/);
  if (!m) continue;
  const [, file, linenoStr, content] = m;
  const lineno = Number(linenoStr);
  if (isTestFile(file)) continue;

  const sqlMatch = content.match(SQL_RE);
  if (!sqlMatch) continue;

  const src = fileText(file);
  if (!src) continue;

  // TS: only the agent-facing description/guidance text counts.
  if (file.endsWith('.ts')) {
    const off = lineOffset(src, lineno) + (sqlMatch.index ?? 0);
    const inGuidance = guidanceRegions(src).some(([a, b]) => off >= a && off <= b);
    if (!inGuidance) continue;
  }

  // A justified site: the marker (WITH a reason) on this line or just above.
  const lines = src.split('\n');
  const window = lines.slice(Math.max(0, lineno - 1 - MARKER_LOOKBACK), lineno).join('\n');
  if (MARKER_RE.test(window)) continue;

  hits.push({ file, lineno, table: sqlMatch[1].toLowerCase(), content: content.trim() });
}

if (hits.length === 0) {
  console.log(
    'check-sql-guidance-justified: clean — no agent-facing "run this SQL" snippet over a ' +
      'tool-covered table without a justification.',
  );
  process.exit(0);
}

const byFile = new Map();
for (const h of hits) {
  if (!byFile.has(h.file)) byFile.set(h.file, []);
  byFile.get(h.file).push(h);
}

console.log(
  `\ncheck-sql-guidance-justified: ${hits.length} unjustified SQL snippet(s) over a tool-covered ` +
    `table in ${byFile.size} agent-facing file(s):\n`,
);
for (const [file, fhits] of [...byFile].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`  ${file}`);
  for (const h of fhits) {
    console.log(`    ${h.lineno}: ${h.content.slice(0, 110)}`);
    console.log(`        → ${h.table} is covered by ${TOOL_FOR[h.table]}`);
  }
}
console.log(
  `\nEach: point at the tool instead of the query — a hot read behind a tool cannot drift from\n` +
    `what the system actually does (that drift IS the claimability incident this guards).\n` +
    `If the snippet genuinely belongs (a counter-example the doc is about, a shape no tool\n` +
    `exposes), state WHY at the site, on the line or within ${MARKER_LOOKBACK} lines above:\n` +
    `    sql-snippet-justified: <reason>\n` +
    `A marker with no reason after the colon does not count.\n` +
    `Rule: claimable-read-tool-and-sql-encapsulation-audit-2026-07-21 P-006.\n`,
);
process.exit(REPORT_ONLY ? 0 : 1);
