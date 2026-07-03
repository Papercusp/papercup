#!/usr/bin/env node
/**
 * endpoint-route-progress — R5 burndown gauge + R6 enforcement gate.
 *
 * Counts how many Next `route.ts` files remain under app/api/** vs how
 * many endpoints have moved to `defineRoute`. The endpoint route
 * migration (endpoint-route-migration-2026-05-20.md) is "done" when the
 * raw count reaches the floor (the [[...route]] catch-all only).
 *
 *   node apps/operator/scripts/endpoint-route-progress.mjs           # report
 *   node apps/operator/scripts/endpoint-route-progress.mjs --check   # CI gate
 *
 * --check exits non-zero while raw route.ts files remain. It is NOT in
 * CI yet — wiring it in is the R6 finish-line step, done once the
 * burndown hits the floor (a hard gate over 233 not-yet-migrated files
 * would be a wall of red). Until then it's a progress gauge.
 *
 * This replaces a custom ESLint `no-raw-route-handler` rule: a rule
 * would fire 233× today (noise) and the real signal — "are we done?" —
 * is a single number this script prints.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const API = join(REPO, 'apps/operator/app/api');

// route.ts files that are NOT per-endpoint handlers — they're the host
// seam itself and are removed by the Next-removal agent at cutover, not
// by this migration. They don't count against the burndown.
const FLOOR = new Set([
  'apps/operator/app/api/[[...route]]/route.ts', // the Hono catch-all
]);

const raw = execSync(`find "${API}" -name route.ts -not -path "*/.next*"`, { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((p) => p.replace(REPO + '/', ''))
  .filter((p) => !FLOOR.has(p));

// Migrated endpoints = entries in the defineRoute registry barrel.
// The barrel lives in packages/operator-core (it moved there from
// apps/operator/lib in the operator-core extraction). Resolve it from
// REPO so a future move fails loudly rather than silently reporting 0.
const BARREL = join(REPO, 'packages/operator-core/lib/endpoint-route/routes/index.ts');
let migratedCount = 0;
try {
  const barrel = readFileSync(BARREL, 'utf8');
  // Each `import X from './fam/name'` line is one migrated route MODULE
  // (a module may export multiple operations). Count the import lines.
  migratedCount = (barrel.match(/^import .+ from '\.\//gm) ?? []).length;
} catch (err) {
  // Don't swallow silently — a stale path here reports "0 migrated"
  // and masks the real state (this is exactly what happened when the
  // barrel moved to packages/operator-core). Warn loudly.
  console.warn(
    `  WARNING: could not read defineRoute barrel at ${BARREL} ` +
      `(${err.code ?? err.message}); migratedCount reported as 0.`,
  );
}

const remaining = raw.length;
const check = process.argv.includes('--check');

console.log('');
console.log('  endpoint route migration — burndown');
console.log('  ──────────────────────────────────');
console.log(`  raw route.ts remaining : ${remaining}`);
console.log(`  defineRoute modules    : ${migratedCount}`);
console.log(`  floor (host seam)      : ${FLOOR.size} (excluded)`);
console.log('');

if (check) {
  if (remaining > 0) {
    console.error(
      `  --check: ${remaining} raw route.ts files remain. ` +
        `Migration incomplete; not yet a passing CI gate.`,
    );
    process.exit(1);
  }
  console.log('  --check: PASS — zero raw route.ts files. Migration complete.');
}
