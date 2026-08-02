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
 * Scope: tracked code (ts/tsx/mjs/cjs/js) + json (package.json deps, tsconfig
 * path maps, build-config arrays like next transpilePackages / astro noExternal,
 * command tables). Excludes node_modules, dist, _retired, the auto-generated
 * package-lock.json, and historical docs/plans (prose mentions of the old names
 * are history, not live references).
 *
 * Matches ANY @restart/<pkg> reference, not just import syntax — bare config
 * strings are a real miss-class (they pass a running dev server, which cached
 * the old config, but break a fresh build). Learned migrating Restart's sibling
 * libs (Restart scripts/check-migrated-scope.mjs caught exactly these).
 */
import { readFileSync } from 'node:fs';
import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

// WI-6730: enumerate via the shared helper, which recurses into submodules. A bare
// `git ls-files` does not — it emits one gitlink entry per submodule — so this
// retirement guard never checked a single file inside any of the 39, which is
// exactly where a revived @restart/* import would be least likely to be noticed.
const { files: tracked, unscanned } = listTrackedFiles(ROOT);

const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f.startsWith('apps/operator/docs/plans/') ||
  f.startsWith('apps/operator/public/internal/docs/') ||
  f === 'package-lock.json' ||
  f.endsWith('/package-lock.json') ||
  f === 'scripts/check-no-restart-imports.mjs' ||
  // WI-6730: PROSE fixtures, not code. corpus.v1.json is the memory-benchmark text
  // corpus — its documents legitimately *discuss* the Restart codebase ("In the shared
  // Restart checkout…"), and rewriting a benchmark corpus to satisfy an import guard
  // would corrupt the benchmark. Same rationale as the docs/plans + internal/docs
  // exclusions above: this guard polices IMPORTS, and these files contain none.
  /\/(fixtures|__fixtures__)\//.test(f);

// Any @restart/<pkg> reference (imports, deps, tsconfig paths, config strings).
const RE = /@restart\/[a-z0-9-]+/;

const offenders = [];
for (const f of tracked) {
  if (isExcluded(f)) continue;
  if (!/\.(ts|tsx|mjs|cjs|js|json)$/.test(f)) continue;
  let text;
  try {
    text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
  } catch {
    continue;
  }
  if (!text.includes('@restart/')) continue;
  text.split('\n').forEach((line, i) => {
    if (RE.test(line)) offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 100)}`);
  });
}

if (offenders.length === 0) {
  console.log(
    `✓ no live @restart/* imports or deps — retirement intact (use @papercusp/* only).${describeUnscanned(unscanned)}`,
  );
  process.exit(0);
}

console.error('✗ @restart/* is RETIRED — these were migrated to @papercusp/*.');
console.error('  Replace each `@restart/<name>` with `@papercusp/<name>` (the code is the same, renamed):\n');
for (const o of offenders) console.error('    ' + o);
console.error(`\n  ${offenders.length} live @restart/* reference(s) found. See plan papercusp-systems-abstraction-2026-05-29.`);
process.exit(1);
