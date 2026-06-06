#!/usr/bin/env node
/**
 * check-no-retired-imports.mjs — fail-loud guard for `_retired/` code.
 *
 * Code under `_retired/` (superproject) and `libs/papercusp/_retired/`
 * (submodule) is preserved-not-active: dropped from the workspace globs,
 * not built/tested, not to be imported. This guard keeps that boundary
 * permanent — if live code starts importing a `_retired/` module, or
 * re-introduces the retired `POST /api/plugins/orchestrator/spawn` fetch
 * (the dead orchestrator-spawn plugin endpoint, replaced by `fleet:spawn`),
 * CI fails with a clear message instead of the dead path silently re-accruing.
 *
 *   node scripts/check-no-retired-imports.mjs
 *
 * Anchored on import/fetch CONTEXTS (not bare mentions), so prose comments
 * that reference a `_retired/` path or explain the retired endpoint don't
 * trip it. Scope: tracked ts/tsx/mjs/cjs/js. Excludes `_retired/` itself,
 * node_modules, dist, generated docs, and this script.
 *
 * See plan archive-legacy-orchestrator-deadcode-2026-06-06 (P-013). The
 * companion "no NEW raw agent-CLI spawn" guard lives with the spawn
 * chokepoint work (unify-agent-spawn-chokepoint-2026-06-06 P-008).
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;

const tracked = execSync('git ls-files', {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
})
  .split('\n')
  .filter(Boolean);

const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.startsWith('libs/papercusp/_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f.startsWith('apps/operator/docs/plans/') ||
  f.startsWith('apps/operator/public/internal/docs/') ||
  f.endsWith('.d.ts') ||
  f === 'scripts/check-no-retired-imports.mjs';

// An import/require/from whose module string contains a `_retired/` segment.
const RETIRED_IMPORT =
  /(?:\bfrom\b|\bimport\b|\brequire\b)\s*\(?\s*['"`][^'"`]*_retired\//;
// A fetch() to the dead orchestrator-spawn plugin endpoint (404; use fleet:spawn).
const DEAD_SPAWN_FETCH = /fetch\s*\(\s*['"`][^'"`]*plugins\/orchestrator\/spawn/;

const offenders = [];
for (const f of tracked) {
  if (isExcluded(f)) continue;
  if (!/\.(ts|tsx|mjs|cjs|js)$/.test(f)) continue;
  let text;
  try {
    text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
  } catch {
    continue;
  }
  if (!text.includes('_retired/') && !text.includes('plugins/orchestrator/spawn')) {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    if (RETIRED_IMPORT.test(line)) {
      offenders.push(`${f}:${i + 1}  [imports a _retired/ module]  ${line.trim().slice(0, 100)}`);
    }
    if (DEAD_SPAWN_FETCH.test(line)) {
      offenders.push(`${f}:${i + 1}  [retired /api/plugins/orchestrator/spawn fetch]  ${line.trim().slice(0, 100)}`);
    }
  });
}

if (offenders.length === 0) {
  console.log('✓ no live imports of _retired/ modules and no retired orchestrator-spawn fetch.');
  process.exit(0);
}

console.error('✗ live code is reaching into RETIRED surfaces:');
console.error('  - Importing a `_retired/` module: restore it properly (git mv back + re-wire per its RESTORE.md), do not import across the boundary.');
console.error('  - `POST /api/plugins/orchestrator/spawn` is dead (404); spawn via `fleet:spawn` / spawnAgentInHarness instead.\n');
for (const o of offenders) console.error('    ' + o);
console.error(`\n  ${offenders.length} offender(s). See plan archive-legacy-orchestrator-deadcode-2026-06-06 (P-013).`);
process.exit(1);
