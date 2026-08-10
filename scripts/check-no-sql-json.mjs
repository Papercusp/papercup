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
import { readFileSync } from 'node:fs';

import { stripCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';
import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';

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
  // WI-7092 / EI-607, verified 2026-08-02 — each below is genuinely a FRESH
  // postgres()/getLongLivedAdminPool() pool built via a plain top-level
  // `import postgres from 'postgres'` (never through @papercusp/db's getOrgPg/
  // buildClient), so it resolves the tolerant build and sql.json is safe here.
  'apps/operator/lib/release/release-registry.ts',       // recordRelease's `sql` param is only ever called (record-release-cli.ts) with a fresh `postgres(getHarnessAdminUrl(), {max:1})` pool
  'packages/operator-core/lib/gym/runner-ports.ts',      // ensureGymPipelinePrincipals is only called with cfg.gymSql (fresh gym-operator pool); its own comment notes `${JSON.stringify}::jsonb` would ALSO reintroduce a real double-encode bug on this column (array caps read back empty)
  'packages/operator-core/lib/system-health/desktop-perf-runs.ts', // db() = getLongLivedAdminPool (fresh postgres() pool, same class as the llm-testing/* entries above)
]);

// WI-6666: SCAN_PREFIXES above explicitly names two `libs/papercusp/**` dirs, but a
// bare `git ls-files` (the original enumerator here) STOPS AT THE SUPERPROJECT
// BOUNDARY — libs/papercusp is a submodule, so those two prefixes matched ZERO files
// no matter what they contained. `listTrackedFiles` recurses into submodules, so this
// guard can finally see the two dirs it always claimed to scan.
const { files: tracked, unscanned } = listTrackedFiles(ROOT);

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
  // Match against the MASKED text, report the RAW line. The mask is length-preserving,
  // so line numbers and columns are identical in both — never re-split the masked text
  // for display, or the offender prints as blanks.
  //
  // This replaced a per-line heuristic (`t.startsWith('//') || t.startsWith('*') || …`
  // plus an indexOf('//') position test) that covered exactly one of the three ways this
  // token appears without being a call. It missed a `/* … */` block whose continuation
  // line is not `*`-prefixed, and — measured, WI-37717 — it missed STRING literals
  // entirely: this guard's own `console.error('✗ sql.json( in getOrgPg-class code…')`
  // is the shape, and any error message or doc string in the scanned dirs that names the
  // banned call would red CI while being no call at all.
  const masked = stripCommentsAndStrings(text, f).split('\n');
  text.split('\n').forEach((line, i) => {
    if (!SQL_JSON.test(masked[i] ?? '')) return;
    offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 100)}`);
  });
}

if (offenders.length === 0) {
  console.log(
    '✓ no sql.json( on a getOrgPg-class client (jsonb is bound as ${JSON.stringify(x)}::jsonb).' +
      describeUnscanned(unscanned),
  );
  process.exit(0);
}

console.error('✗ sql.json( in getOrgPg-class code — it THROWS on the getOrgPg client (EI-607):');
console.error('  Bind jsonb as `${JSON.stringify(x)}::jsonb` — universally correct (jsonb_typeof=object), server-side cast.');
console.error('  If this file uses a FRESH postgres() pool where sql.json is tolerated, add it to ALLOW in this script with a note.');
console.error('  Runbook: /internal/docs/agent-insights/sql-json-throws-on-getorgpg-client\n');
for (const o of offenders) console.error('    ' + o);
console.error(`\n  ${offenders.length} offender(s).`);
process.exit(1);
