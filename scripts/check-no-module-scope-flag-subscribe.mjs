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

/**
 * Files that MENTION `lazyFlagRefresh(` without calling it, so the declaration cross-check must skip
 * them: the module that DEFINES the helper, and THIS guard, whose own matcher holds the literal in a
 * string constant (`stripComments` removes comments, not string literals — the guard reported itself
 * twice on first run).
 */
const LAZY_SELF_REFERENTIAL = new Set([
  'packages/operator-core/lib/lazy-flag-refresh.ts',
  'scripts/check-no-module-scope-flag-subscribe.mjs',
]);

const VALID_KINDS = new Set([
  'gates-an-override-store',
  'seeded-from-flag-default',
  'not-flag-gated',
  'selects-behaviour',
]);

/** Floor on a `safeBecause`, so the required field cannot be satisfied with a token. */
const MIN_JUSTIFICATION_CHARS = 60;

/**
 * Extract the argument text of every `lazyFlagRefresh(...)` INVOCATION in a file.
 *
 * Brace-matched rather than regexed, because every real call spans many lines (the declarations are
 * deliberately prose-heavy). Comments are stripped first, so the helper's own doc-comment example is
 * not scanned as a call site.
 */
export function extractLazyFlagRefreshCalls(text) {
  const src = stripComments(text);
  const needle = 'lazyFlagRefresh(';
  const calls = [];
  let i = 0;
  for (;;) {
    const at = src.indexOf(needle, i);
    if (at === -1) break;
    i = at + needle.length;
    if (/\bfunction\s+$/.test(src.slice(Math.max(0, at - 20), at))) continue; // the definition
    let depth = 1;
    let j = i;
    for (; j < src.length && depth > 0; j++) {
      const c = src[j];
      if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    calls.push(src.slice(i, j - 1));
  }
  return calls;
}

/**
 * Cross-check ONE call's `unpopulated` declaration against its own arguments (EI-19448574704459898).
 *
 * ⚠ WHAT THIS CANNOT DO, deliberately: decide whether a `selects-behaviour` justification is TRUE.
 * That is a semantic question about what the flag's off-branch points at — the exact judgement that
 * `tsc`, the unit suites and this lint's own importability check are all structurally blind to, and
 * the reason issues-engineer.ts went all-green while being wrong. The declaration exists to FORCE
 * that judgement and make it greppable and reviewable; enforcing consistency is all a source lint
 * can honestly add on top.
 *
 * @returns a problem string, or null when the declaration is self-consistent.
 */
export function checkUnpopulatedDeclaration(callText) {
  const kindM = /kind\s*:\s*['"]([a-z-]+)['"]/.exec(callText);
  if (!kindM) return 'no `unpopulated.kind` declared';
  const kind = kindM[1];
  if (!VALID_KINDS.has(kind)) return `unknown \`unpopulated.kind\` '${kind}'`;

  const keysM = /keys\s*:\s*\[([\s\S]*?)\]/.exec(callText);
  const hasKeys = !!keysM && keysM[1].trim().length > 0;
  if (kind === 'not-flag-gated' && hasKeys) {
    return "kind 'not-flag-gated' contradicts the flag keys passed in the same call";
  }
  if (kind !== 'not-flag-gated' && !hasKeys) {
    return `kind '${kind}' requires at least one flag key (got none)`;
  }

  // A claim to be seeded is checkable: the same call has to actually pass a `seed`.
  if (kind === 'seeded-from-flag-default' && !/\bseed\s*:/.test(callText)) {
    return "kind 'seeded-from-flag-default' but the call passes no `seed`";
  }
  if (kind !== 'seeded-from-flag-default' && /\bseed\s*:/.test(callText)) {
    return `kind '${kind}' passes a \`seed\` — declare 'seeded-from-flag-default' instead`;
  }

  if (kind === 'selects-behaviour') {
    const sbAt = callText.indexOf('safeBecause');
    if (sbAt === -1) return "kind 'selects-behaviour' requires a `safeBecause`";
    const chars = callText
      .slice(sbAt + 'safeBecause'.length)
      .replace(/[^A-Za-z0-9 ]/g, '')
      .trim().length;
    if (chars < MIN_JUSTIFICATION_CHARS) {
      return `kind 'selects-behaviour' needs a substantive \`safeBecause\` (got ~${chars} chars, floor ${MIN_JUSTIFICATION_CHARS})`;
    }
  }
  return null;
}

// BASELINE seeded 2026-07-28 (WI-6650) with 14 files; now 5. Do NOT add new
// entries; each removal (lazy-init the site, per coordination/log.ts's
// ensureCoordFlagInit) shrinks this set.
//
// ⚠⚠ THIS LINT IS HALF-BLIND TO THE FILES IT LISTS — VERIFY THE PROPERTY BEFORE YOU
// DE-LIST, NEVER THIS LINT'S OWN VERDICT. It detects a column-0 `onFlagChange(`. It
// CANNOT see an eager `void refreshX()` whose body reaches `getFlag` — an async body
// runs synchronously to its first await, so that call touches the flags/server binding
// at module scope just as hard, and the file stays unimportable under a partial mock.
// Migrate only the visible half and this guard goes GREEN on a file that is still
// broken — a false green indistinguishable from a real one, made worse by the fact
// that the BASELINE would then positively certify the file as fixed.
// Both files migrated 2026-08-03 had BOTH accesses (work-item-redundancy.ts,
// work-item-claim-lease-wiring.ts), so treat the pair as the expected shape, not an
// oddity. Per-file checklist before de-listing:
//   grep -n '^void \|^onFlagChange(\|^const .* = .*(' <file>   # both module-scope forms
//   then add the file to lib/flags-partial-mock-importable.test.ts, which tests the
//   actual PROPERTY (does this import under an empty mock?) rather than this lint's
//   syntactic proxy for it.
//
// Removed 2026-08-03 (EI-19416650993725684), both migrated to a lazy arm called
// from their own readers: txn-timeouts-config.ts (ensureLiveRefreshArmed) and
// task-manager/enabled.ts (ensureFlagSubscriptionArmed). A stale entry here is
// not cosmetic — it is a standing EXEMPTION, so leaving a fixed file listed would
// silently re-permit the very regression the fix removed. De-list in the SAME
// change as the fix.
// Also removed 2026-08-03 (EI-19416650993725684), migrated onto the shared
// `lazy-flag-refresh.ts` helper: quota-overrides, capability-envelope-overrides,
// telemetry-buffer-config, capability-tier-overrides. Migrating a file means ALSO
// adding it to lib/flags-partial-mock-importable.test.ts, which tests the actual
// mechanism (importability under a partial mock) that this source lint only
// approximates.
// Also removed 2026-08-03 (EI-19416650993725684): work-item-claim-lease-wiring.ts,
// onto the same helper. It had FOUR readers of its cached boolean (the exported
// getter plus three internal `if (!claimLeaseOn)` guards) and no periodic refresh
// timer to bound a missed arm, so every one of the four arms.
// And events/cache-eca-rule.ts, same helper — ONE reader (cacheTagEcaEnabled, the rules
// engine's sync `when` predicate). Note the arm is on the READER, deliberately NOT in
// registerCacheTagEcaRule(): rules.ts calls that registrar at MODULE SCOPE, so arming
// there would touch the flag binding during rules.ts's import and just move the
// unimportability one file over. Safe to lazy-arm because the unpopulated `false` is the
// module's OWN documented fail-CLOSED state (no tag bump), costing at most one skipped
// invalidation per process — a briefly stale cache entry, never a wrong value.
//
// issues-engineer.ts was migrated the same way in that session and REVERTED — see the
// inline note at its BASELINE entry below. It is the reason work-item-redundancy.ts is
// still not listable in flags-partial-mock-importable.test.ts: redundancy →
// work-items.ts reaches BOTH claim-lease-wiring (now migrated) and issues-engineer
// (not), so the graph guard surfaces the blockers one hop at a time.
export const BASELINE = new Set([
  // ⚠ EXAMINED AND DEFERRED, NOT MISSED — do NOT pattern-match this one onto its
  // siblings above. It looks identical (same config-override family, same timer,
  // same registerOverrideConcern) and is not: (1) it has a HIDDEN reader —
  // `resolveTestingFullAccess`, installed at module scope via
  // setTestingFullAccessResolver, reads the module vars DIRECTLY rather than through
  // an exported getter, so arming the three exported getters alone would leave the
  // actual auth gate unarmed; and (2) its unpopulated state is the PERMISSIVE one
  // (testingFullAccessEnabled defaults true), so lazy arming widens the window in
  // which a kill-switch flipped OFF has not yet taken effect. Per lazy-flag-refresh's
  // "behaviour this DOES change" note, a cache like this needs an explicit warm on a
  // boot path, not lazy arming alone. Migrate it deliberately, with that warm.
  'packages/operator-core/lib/auth-config-overrides.ts',
  'packages/operator-core/lib/harness/routines/configure-per-workspace.ts',
  // ⚠ EXAMINED AND REVERTED, NOT MISSED — a migration onto lazy-flag-refresh was written,
  // measured and BACKED OUT 2026-08-03. It is mechanically easy (ONE reader,
  // resolveIssuesScopeWorkspace, and an existing 3s self-heal TTL) and semantically unsafe:
  // ISSUES_PER_WORKSPACE is deliberately held ON, and the unpopulated `false` resolves issue
  // scope to the legacy 'default' coord workspace — a DEAD partition (last write 2026-06-22)
  // while every live EI/WI is in the workspace partition. Lazy arming would put that value in
  // front of the FIRST reader call in every process. Needs a boot-path WARM first (see the
  // long note at the reverted site in issues-engineer.ts). Same posture as auth-config-overrides.
  'packages/operator-core/lib/issues-engineer.ts',
  'packages/operator-core/lib/lexicon/configure.ts',
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
  const declarationProblems = [];
  for (const f of tracked) {
    if (isExcluded(f)) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
    } catch {
      continue;
    }
    // The unpopulated-state cross-check applies to every caller, INCLUDING a BASELINE file (a
    // BASELINE entry exempts a module-scope subscribe, not a malformed declaration).
    if (!LAZY_SELF_REFERENTIAL.has(f) && text.includes('lazyFlagRefresh(')) {
      for (const call of extractLazyFlagRefreshCalls(text)) {
        const problem = checkUnpopulatedDeclaration(call);
        if (problem) declarationProblems.push({ file: f, problem });
      }
    }
    if (BASELINE.has(f)) continue;
    if (usesModuleScopeFlagSubscribe(text)) offenders.push(f);
  }
  return { offenders, declarationProblems, unscanned };
}

function main() {
  const { offenders, declarationProblems, unscanned } = findOffenders();

  if (declarationProblems.length > 0) {
    console.error('✗ malformed `lazyFlagRefresh` unpopulated-state declaration:');
    console.error('  Every call must declare what its SYNC readers serve BEFORE the first async refresh');
    console.error('  lands — the one property no routine signal in this repo measures (the source lint,');
    console.error('  the partial-mock test, tsc and the unit suites all check importability and types, and');
    console.error('  emit an identical green for a safe migration and an unsafe one). See the header of');
    console.error('  packages/operator-core/lib/lazy-flag-refresh.ts for the override-store vs');
    console.error('  behaviour-selector discriminator.\n');
    for (const d of declarationProblems) console.error(`    ${d.file}: ${d.problem}`);
    console.error(`\n  ${declarationProblems.length} problem(s). See EI-19448574704459898.`);
    process.exit(1);
  }

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
