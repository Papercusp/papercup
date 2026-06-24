#!/usr/bin/env node
/**
 * check-workspace-default-sql.mjs — lint:no-workspace-default.
 *
 * The recurrence guard for the SQL/DDL side of silent workspace scoping
 * (data-scoping-audit-2026-06-22 P-007 / D-005, the sibling of lint:scope-defaults
 * which guards the TS-handler side `?? 'default'`).
 *
 * The rule (D-005): multi-tenancy IS a goal. A `workspace_id` (or legacy `workspace`)
 * column must NOT carry a `DEFAULT 'default'` — a column default silently routes an
 * unscoped INSERT into the shared `'default'` partition, the exact cross-workspace
 * data-mixing this brief removes. Workspace is a REQUIRED arg threaded from the caller
 * (the agent context carries workspaceId); the writer supplies it explicitly.
 *
 * What this flags: a line declaring a `workspace`/`workspace_id` column with
 * `DEFAULT 'default'` (incl. the `DEFAULT 'default'::text` cast form), in:
 *   - NEW SQL migrations under libs/papercusp/libs/db/sql/*.sql, and
 *   - production runtime DDL in packages/ apps/ libs/ `.ts` (D-010 source #2: the coord
 *     stores CREATE coord_* with workspace_id DEFAULT 'default' at runtime; the per-harness
 *     scaffolder; etc.).
 *
 * What it deliberately does NOT flag:
 *   - The 17 already-applied historical migration files (FILE_ALLOW). An applied migration
 *     is immutable ledgered history — you do not rewrite its bytes (the runner records a
 *     sha256). The live column default is removed by a NEW drop-default migration; the old
 *     CREATE TABLE text necessarily remains, so it is grandfathered here.
 *   - Test / test-support fixtures (*.test.ts, __tests__/, /test/, *-rig.ts) — they stand up
 *     throwaway local schemas, not production partitions (same skip as lint:scope-defaults).
 *
 * A genuinely-intended default (e.g. a single-tenant-by-design scaffold) is allowed — mark
 * it with an inline `allow-workspace-default` comment (reason at the site), same line or the
 * line above, or add an inherently-exempt file to FILE_ALLOW.
 *
 *   node scripts/check-workspace-default-sql.mjs           # report (advisory)
 *   node scripts/check-workspace-default-sql.mjs --strict  # exit 1 on any un-allowed default
 *
 * Advisory by default (mirrors lint:scope-defaults / lint:env-feature-gates). Flip the CI
 * wiring to --strict once P-007's drop-default migration + the coord runtime-DDL
 * reconciliation land clean.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STRICT = process.argv.includes('--strict');

// Inline marker (same line, or the line directly above) documenting an intentional default.
const ALLOW_MARKER = 'allow-workspace-default';

// Already-applied historical migrations: immutable ledgered history (a sha256 is recorded on
// apply — editing them breaks the ledger). The live column DEFAULT is removed by a NEW
// drop-default migration; the historical CREATE TABLE text necessarily stays. Grandfathered.
const FILE_ALLOW = new Set([
  'libs/papercusp/libs/db/sql/000-baseline.sql',
  'libs/papercusp/libs/db/sql/119-consolidate-supervisor-notes-directive-summaries.sql',
  'libs/papercusp/libs/db/sql/120-consolidate-messages-executed-actions.sql',
  'libs/papercusp/libs/db/sql/123-coordination-substrate.sql',
  'libs/papercusp/libs/db/sql/131-engineer-issues.sql',
  'libs/papercusp/libs/db/sql/132-coordination-conversations.sql',
  'libs/papercusp/libs/db/sql/163-await-event-subscriptions.sql',
  'libs/papercusp/libs/db/sql/170-cross-backend-usage-attribution.sql',
  'libs/papercusp/libs/db/sql/218-plan-revisions-workspace-scope.sql',
  'libs/papercusp/libs/db/sql/254-owner-interactions.sql',
  'libs/papercusp/libs/db/sql/259-autonomy-policy.sql',
  'libs/papercusp/libs/db/sql/266-autonomy-tripwires.sql',
  'libs/papercusp/libs/db/sql/322-session-briefs-ei1742.sql',
  'libs/papercusp/libs/db/sql/326-rubrics-store.sql',
  'libs/papercusp/libs/db/sql/367-work-item-deps.sql',
  'libs/papercusp/libs/db/sql/372-bee-claim-specs.sql',
  'libs/papercusp/libs/db/sql/379-maintained-ready-column.sql',
]);

// A `DEFAULT 'default'` (optionally cast ::text) — the smell.
const DEFAULT_DEFAULT_RE = /DEFAULT\s+'default'(?:::text)?/i;
// The line must declare a workspace scope column (workspace_id, or the legacy `workspace`).
const WORKSPACE_COL_RE = /\bworkspace(?:_id)?\b/i;

function isTestFile(file) {
  return (
    file.endsWith('.test.ts') ||
    file.endsWith('.test.tsx') ||
    file.includes('/__tests__/') ||
    file.includes('/test/') ||
    /testbed|_test|\.bench\.|-rig\.ts$/.test(file)
  );
}

// A match inside a `--` (SQL) or `//` (TS) line-comment, or a `*` doc-comment line, is prose.
function isCommentMatch(content, idx) {
  const trimmed = content.trimStart();
  if (trimmed.startsWith('--') || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
    return true;
  }
  const before = content.slice(0, idx);
  const sqlComment = before.indexOf('--');
  const tsComment = before.indexOf('//');
  return (sqlComment >= 0 && sqlComment < idx) || (tsComment >= 0 && tsComment < idx);
}

let raw = '';
try {
  raw = execFileSync(
    'git',
    [
      'grep',
      '-nE',
      `DEFAULT[[:space:]]+'default'`,
      '--',
      'libs/papercusp/libs/db/sql',
      'packages/',
      'apps/',
      'libs/',
    ],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
} catch (e) {
  if (e.status === 1) raw = ''; // git grep exits 1 on no matches
  else throw e;
}

const fileLinesCache = new Map();
function fileLines(file) {
  if (!fileLinesCache.has(file)) {
    try {
      fileLinesCache.set(file, readFileSync(join(ROOT, file), 'utf8').split('\n'));
    } catch {
      fileLinesCache.set(file, []);
    }
  }
  return fileLinesCache.get(file);
}

const hits = [];
for (const line of raw.split('\n')) {
  const m = line.match(/^([^:]+):(\d+):(.*)$/);
  if (!m) continue;
  const [, file, linenoStr, content] = m;
  const lineno = Number(linenoStr);
  if (!(file.endsWith('.sql') || file.endsWith('.ts'))) continue;
  if (isTestFile(file)) continue;
  if (FILE_ALLOW.has(file)) continue;

  const dm = content.match(DEFAULT_DEFAULT_RE);
  if (!dm) continue;
  if (!WORKSPACE_COL_RE.test(content)) continue; // a non-scope column defaulting to 'default'
  if (isCommentMatch(content, dm.index)) continue;

  const aboveLine = fileLines(file)[lineno - 2] ?? '';
  if (content.includes(ALLOW_MARKER) || aboveLine.includes(ALLOW_MARKER)) continue;

  hits.push({ file, lineno, content: content.trim() });
}

if (hits.length === 0) {
  console.log(
    "check-workspace-default-sql: clean — no workspace_id DEFAULT 'default' on a scope column " +
      'outside the allow-list.',
  );
  process.exit(0);
}

const byFileHits = new Map();
for (const h of hits) {
  if (!byFileHits.has(h.file)) byFileHits.set(h.file, []);
  byFileHits.get(h.file).push(h);
}

console.log(`\ncheck-workspace-default-sql: ${hits.length} workspace_id DEFAULT 'default'(s) in ${byFileHits.size} file(s):\n`);
for (const [file, fhits] of [...byFileHits].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`  ${file}`);
  for (const h of fhits) console.log(`    ${h.lineno}: ${h.content.slice(0, 110)}`);
}
console.log(
  `\nEach: drop the column default and thread workspace_id explicitly from the caller (the agent\n` +
    `context carries workspaceId). For runtime DDL, reconcile it with a numbered migration.\n` +
    `If a site genuinely means a single-tenant-by-design default, add an inline \`${ALLOW_MARKER}\`\n` +
    `marker comment (with the reason), or add an inherently-exempt file to FILE_ALLOW in this script.\n` +
    `Rule: data-scoping-audit-2026-06-22 P-007 / D-005.\n`,
);
process.exit(STRICT ? 1 : 0);
