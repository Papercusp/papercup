#!/usr/bin/env node
/**
 * check-no-module-scope-flag-subscribe.mjs — fail-loud guard against a NEW
 * MODULE-SCOPE touch of a `@papercusp/flags` named export (WI-6650, residual of
 * EI-18825928993608425).
 *
 * The landmine: a test file that narrowly factory-mocks the flags surface for its
 * OWN assertions — `vi.mock('@papercusp/flags/server', () => ({ getFlag }))`, or
 * `vi.mock('@papercusp/flags', () => ({ FLAGS }))` — can be reached, via an
 * arbitrarily long transitive import chain, by a module that touches
 * `onFlagChange` / `FLAG_DEFAULTS` at the TOP LEVEL. Vitest's mock proxy throws on
 * the missing export:
 *
 *   Error: [vitest] No "onFlagChange" export is defined on the
 *          "@papercusp/flags/server" mock.
 *
 * That throw lands at COLLECTION time, so it fails the WHOLE test file (zero tests
 * run) — and the error names the MOCK, not the importer, so it reads as unrelated
 * to whoever's change actually grew the import edge. It reds the fleet's green
 * gate, not one suite.
 *
 * This is the same class as `lint:no-eager-execfile-promisify` (EI-10161), with
 * the flags surface in place of node:child_process.
 *
 * CONFIRMED LIVE TWICE, both on the same file
 * (packages/operator-core/lib/agent-tools/coordination/log.ts):
 *   - WI-6449  — `onFlagChange` at module scope, via scheduler/idle-loop-recipe-pin.
 *   - WI-6588  — a `FLAG_DEFAULTS` deref added at module scope; 2 suites went red at
 *                collection (scout/cycle-deps, scheduler/idle-loop-recipe-pin).
 * That file was root-fixed under EI-18825928993608425 and is NOT in the BASELINE.
 *
 * FIX: give the module ZERO flag side effects at load — move the subscribe + any
 * defaults deref into an idempotent init reached on FIRST USE, exactly as
 * coordination/log.ts now does (see its `ensureCoordFlagInit()`):
 *
 *   let inited = false;
 *   let cached;
 *   function ensureFlagInit() {
 *     if (inited) return;
 *     inited = true;                       // set FIRST — terminates re-entrancy
 *     cached ??= DEFAULT_FOR(FLAGS.X);     // see the ??= warning below
 *     onFlagChange((key) => { if (key === null || key === FLAGS.X) refresh(); });
 *   }
 *
 * ⚠ SEED A LAZY CACHE WITH `??=`, NEVER `=`. Several of these modules export their
 * own `refreshX()` which tests (and real callers) invoke BEFORE the first read that
 * triggers init — a plain assign in the later init clobbers the resolved value back
 * to the default. That exact bug red coordination/log.test.ts's "flag OFF" case and
 * was caught only because a test pinned both flag directions.
 *
 * Detection is deliberately narrow — a column-0 (module-scope) occurrence, since a
 * call inside a function/block is always indented in this codebase's style:
 *   1. `onFlagChange(` / `void onFlagChange(` starting at column 0.
 *   2. `const`/`let` at column 0 whose RHS EAGERLY derefs `FLAG_DEFAULTS[...]`.
 *      The lazy form `const X = (): boolean => FLAG_DEFAULTS[FLAGS.Y]` is CORRECT
 *      (the deref happens on call) and is deliberately NOT flagged.
 *
 *   node scripts/check-no-module-scope-flag-subscribe.mjs
 *
 * BASELINE (TEMPORARY — must shrink to EMPTY): the 14 pre-existing subscribers this
 * guard was seeded with (WI-6650). They were left alone deliberately — their import
 * graphs are far narrower than the coord graph's, and rewriting 14 load-bearing
 * modules at once carries more regression risk than the latent trap does. NEW files
 * may NOT be added here — a fresh module-scope flag touch is a hard guard failure,
 * not a BASELINE addition. Removing one (lazy-wrap it, per the pattern above)
 * shrinks the set.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

export const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f.includes('/dist-sidecar/') ||
  f.includes('/.next/') ||
  f.includes('/build/') ||
  f.includes('/spa/assets/') ||
  f.includes('/env-sidecars/') ||
  /\.(test|spec)\.[cm]?[tj]sx?$/.test(f) ||
  !/\.(ts|mjs|cjs)$/.test(f);

/** Strip block + line comments so a prose mention isn't flagged. */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * The tell: a column-0 (module-scope) `onFlagChange(...)` subscription, or a
 * column-0 `const`/`let` that EAGERLY derefs `FLAG_DEFAULTS[...]`. Both crash a
 * partial-mock importer at collection time; a lazy (function-body / arrow-RHS)
 * form of either is fine and is not flagged.
 */
export function usesModuleScopeFlagSubscribe(text) {
  const src = stripComments(text);
  if (/^(void\s+)?onFlagChange\s*\(/m.test(src)) return true;
  if (/^(export\s+)?(const|let)\s+\w+\s*=\s*FLAG_DEFAULTS\s*\[/m.test(src)) return true;
  return false;
}

// BASELINE seeded 2026-07-28 (WI-6650) with 14 files; now 12. Do NOT add new
// entries; each removal (lazy-init the site, per coordination/log.ts's
// ensureCoordFlagInit) shrinks this set.
//
// Removed 2026-08-03 (EI-19416650993725684), both migrated to a lazy arm called
// from their own readers: txn-timeouts-config.ts (ensureLiveRefreshArmed) and
// task-manager/enabled.ts (ensureFlagSubscriptionArmed). A stale entry here is
// not cosmetic — it is a standing EXEMPTION, so leaving a fixed file listed would
// silently re-permit the very regression the fix removed. De-list in the SAME
// change as the fix.
export const BASELINE = new Set([
  'packages/operator-core/lib/auth-config-overrides.ts',
  'packages/operator-core/lib/capability-tier-overrides.ts',
  'packages/operator-core/lib/events/cache-eca-rule.ts',
  'packages/operator-core/lib/harness/routines/configure-per-workspace.ts',
  'packages/operator-core/lib/issues-engineer.ts',
  'packages/operator-core/lib/lexicon/configure.ts',
  'packages/operator-core/lib/work-item-claim-lease-wiring.ts',
  'packages/operator-core/lib/work-item-redundancy.ts',
  'packages/operator-core/lib/workspace-brain-scope.ts',
]);

/**
 * Scan the tracked tree for offenders (excludes vendored/tests/non-source + BASELINE).
 *
 * WI-6666: enumerates via the shared `listTrackedFiles` helper, which recurses into
 * submodules. A bare `git ls-files` does NOT — it emits one gitlink entry per
 * submodule — so this guard previously never opened libs/generic/**, libs/papercusp/**,
 * or papercusp-desktop/**. Returns the coverage report so `main` can state what it
 * could not check.
 */
export function findOffenders() {
  const { files: tracked, unscanned } = listTrackedFiles(ROOT);

  const offenders = [];
  for (const f of tracked) {
    if (isExcluded(f)) continue;
    if (BASELINE.has(f)) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
    } catch {
      continue;
    }
    if (usesModuleScopeFlagSubscribe(text)) offenders.push(f);
  }
  return { offenders, unscanned };
}

function main() {
  const { offenders, unscanned } = findOffenders();
  if (offenders.length === 0) {
    const note =
      BASELINE.size > 0 ? ` (${BASELINE.size} file(s) still in the shrink-to-empty BASELINE — WI-6650)` : '';
    console.log(`✓ no NEW module-scope @papercusp/flags subscribe/defaults touch${note}.` + describeUnscanned(unscanned));
    process.exit(0);
  }
  console.error('✗ NEW module-scope @papercusp/flags touch (onFlagChange / FLAG_DEFAULTS):');
  console.error('  A test that factory-mocks the flags surface without this export, and reaches this');
  console.error('  module transitively, throws at COLLECTION — failing the WHOLE test file (0 tests run)');
  console.error('  and reding the fleet gate. The error names the MOCK, not this file, so it reads as');
  console.error('  someone else\'s bug. Move the subscribe + any FLAG_DEFAULTS deref into an idempotent');
  console.error('  first-use init — see packages/operator-core/lib/agent-tools/coordination/log.ts\'s');
  console.error('  ensureCoordFlagInit(). Seed the cache with `??=`, never `=`.\n');
  for (const o of offenders) console.error('    ' + o);
  console.error(`\n  ${offenders.length} offender(s). See WI-6650 / EI-18825928993608425.`);
  process.exit(1);
}

const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  main();
}
