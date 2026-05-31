#!/usr/bin/env node
/**
 * check-no-restart-imports.mjs — fail-loud guard for the @restart retirement.
 *
 * The shared libs were migrated from the `@restart/*` npm scope to
 * `@papercusp/*` (org transfer + scope rename; see
 * papercusp-systems-abstraction-2026-05-29). The code was *renamed*, not
 * deleted — every lib lives under `@papercusp/*`. This guard keeps the
 * retirement permanent: if any `@restart/*` import or dependency reappears
 * in Papercup, CI fails with a clear "use @papercusp/<name>" message
 * instead of silently resolving (or silently breaking) at runtime.
 *
 *   node scripts/check-no-restart-imports.mjs
 *
 * Scope: tracked code (ts/tsx/mjs/cjs/js) + package.json files. Excludes
 * node_modules, dist, _retired, and historical docs/plans (prose mentions
 * of the old names are history, not live imports).
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;

const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f.startsWith('apps/operator/docs/plans/') ||
  f.startsWith('apps/operator/public/internal/docs/') ||
  f === 'scripts/check-no-restart-imports.mjs';

// Live-import patterns: `from '@restart/…'`, require/import('@restart/…'),
// and package.json dependency keys "@restart/…".
const IMPORT_RE = /\b(?:from|import|require)\s*\(?\s*['"]@restart\/[^'"]+['"]/;
const PKG_DEP_RE = /"@restart\/[^"]+"\s*:/;

const offenders = [];
for (const f of tracked) {
  if (isExcluded(f)) continue;
  const isCode = /\.(ts|tsx|mjs|cjs|js)$/.test(f);
  const isPkg = f.endsWith('package.json');
  if (!isCode && !isPkg) continue;
  let text;
  try {
    text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
  } catch {
    continue;
  }
  if (!text.includes('@restart/')) continue;
  const re = isPkg ? PKG_DEP_RE : IMPORT_RE;
  text.split('\n').forEach((line, i) => {
    if (re.test(line)) offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 100)}`);
  });
}

if (offenders.length === 0) {
  console.log('✓ no live @restart/* imports or deps — retirement intact (use @papercusp/* only).');
  process.exit(0);
}

console.error('✗ @restart/* is RETIRED — these were migrated to @papercusp/*.');
console.error('  Replace each `@restart/<name>` with `@papercusp/<name>` (the code is the same, renamed):\n');
for (const o of offenders) console.error('    ' + o);
console.error(`\n  ${offenders.length} live @restart/* reference(s) found. See plan papercusp-systems-abstraction-2026-05-29.`);
process.exit(1);
