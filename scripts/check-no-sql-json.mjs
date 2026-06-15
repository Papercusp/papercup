#!/usr/bin/env node
/**
 * check-no-sql-json.mjs — ban postgres-js `sql.json(obj)` in operator code that
 * may run against the getOrgPg client.
 *
 * `sql.json(object)` THROWS `The "string" argument must be of type string ...
 * Received an instance of Object` on the getOrgPg pg client — a postgres-js
 * dual-package module-instance mismatch in @papercusp/db (NOT config; a fresh
 * `postgres(url)` client tolerates it). It silently broke the experiment ledger
 * (D-018) and EVERY replay-harness cell's persistence (EI-607), and integration
 * tests are structurally BLIND to it (they use the tolerant root-postgres client).
 *
 * The portable, UNIVERSALLY-correct jsonb bind is `${JSON.stringify(x)}::jsonb`
 * — the `::jsonb` cast runs server-side, so it yields a real jsonb OBJECT
 * (verified jsonb_typeof = 'object') on every client, getOrgPg included.
 *
 * Runbook: agent-insight `sql-json-throws-on-getorgpg-client`. EI-607.
 *
 *   node scripts/check-no-sql-json.mjs
 *
 * The ALLOW set grandfathers files that deliberately use sql.json on a FRESH
 * `postgres(getHarnessAdminUrl()|gymUri, {prepare:false})` pool, where it is
 * tolerated. New jsonb writes should use `${JSON.stringify(x)}::jsonb` regardless.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;

// Dirs where the getOrgPg / buildClient client dominates.
const SCAN_PREFIXES = [
  'packages/operator-core/lib/',
  'apps/operator/lib/',
  'libs/papercusp/packages/orchestrator/src/',
  'libs/papercusp/packages/cli/src/',
];

// Files that deliberately use sql.json on a FRESH postgres() client (tolerant) —
// NOT getOrgPg. Each must keep building its own `postgres(url, {prepare:false})` pool.
const ALLOW = new Set([
  'packages/operator-core/lib/dock-layouts.ts',          // db() = fresh getHarnessAdminUrl pool
  'packages/operator-core/lib/gym/blueprint-cycle.ts',   // gymSql = fresh gym-operator pool
  'packages/operator-core/lib/llm-testing/storage.ts',   // fresh getHarnessAdminUrl pool
  'packages/operator-core/lib/llm-testing/ledger.ts',    // fresh getHarnessAdminUrl pool
  'packages/operator-core/lib/llm-testing/telemetry.ts', // fresh getHarnessAdminUrl pool
]);

const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  .split('\n')
  .filter(Boolean);

const inScope = (f) =>
  SCAN_PREFIXES.some((p) => f.startsWith(p)) &&
  /\.(ts|tsx)$/.test(f) &&
  !/\.(test|spec)\.(ts|tsx)$/.test(f) &&
  !/\.integration\.test\.(ts|tsx)$/.test(f) &&
  !f.endsWith('.d.ts') &&
  !ALLOW.has(f);

// A `sql.json(` / `gymSql.json(` / `this.sql.json(` CALL — not a comment mention.
const SQL_JSON = /\b\w*[Ss]ql\.json\s*\(/;

const offenders = [];
for (const f of tracked) {
  if (!inScope(f)) continue;
  let text;
  try {
    text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
  } catch {
    continue;
  }
  if (!/[Ss]ql\.json/.test(text)) continue;
  text.split('\n').forEach((line, i) => {
    const m = SQL_JSON.exec(line);
    if (!m) return;
    // Skip comment lines + inline mentions after `//` (the codebase has many `// NOT sql.json()` notes).
    const t = line.trimStart();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('--')) return;
    const slash = line.indexOf('//');
    if (slash !== -1 && slash < m.index) return;
    offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 100)}`);
  });
}

if (offenders.length === 0) {
  console.log('✓ no sql.json( on a getOrgPg-class client (jsonb is bound as ${JSON.stringify(x)}::jsonb).');
  process.exit(0);
}

console.error('✗ sql.json( in getOrgPg-class code — it THROWS on the getOrgPg client (EI-607):');
console.error('  Bind jsonb as `${JSON.stringify(x)}::jsonb` — universally correct (jsonb_typeof=object), server-side cast.');
console.error('  If this file uses a FRESH postgres() pool where sql.json is tolerated, add it to ALLOW in this script with a note.');
console.error('  Runbook: /internal/docs/agent-insights/sql-json-throws-on-getorgpg-client\n');
for (const o of offenders) console.error('    ' + o);
console.error(`\n  ${offenders.length} offender(s).`);
process.exit(1);
