#!/usr/bin/env node
/**
 * check-no-raw-install-slug-filter.mjs — fail-loud guard against NEW read paths that
 * filter `harness_slug` by a routine's RAW `installSlug` (EI-19298972043721870).
 *
 * THE TRAP. Pot-membership enforcement canonicalizes the WRITE path: a row written
 * under a workspace-global label (`hive-canary`, `@singleton`, `*`, `operator`, `all`,
 * `operator:<ws>`, the bare workspace id — see WORKSPACE_GLOBAL_LABELS in
 * pot-membership.ts) is re-homed to the platform Pot. A READ that filters
 * `harness_slug = ${installSlug}` verbatim therefore matches ZERO ROWS, forever —
 * with no error and no warning.
 *
 * For a DETECTOR that is indistinguishable from "everything is healthy", which is why
 * it survived ~12 days unnoticed (EI-19298246923137692): six canaries sat open with
 * their reported-stamps NULL while the 15-minute SLA sweep reported success on every
 * single tick. A guard is the only thing that catches this class, because the failure
 * mode is silence.
 *
 * THE FIX at a flagged site is `routineStorageSlug(installSlug, workspaceId)`
 * (pot-membership.ts) — the SAME resolver the write path uses, so reads and writes
 * agree by construction, including for labels added to that set later.
 *
 *   node scripts/check-no-raw-install-slug-filter.mjs
 *
 * ⚠ A FLAGGED SITE IS NOT AUTOMATICALLY A BUG. Only relations subject to re-homing are
 * affected. A pot-scoped or install-scoped table is CORRECTLY read by the literal slug.
 * Resolve a hit by checking the RELATION, never by pattern-matching the call site — a
 * blind sweep would be wrong, which is exactly why the pre-existing sites are
 * grandfathered below rather than mass-rewritten.
 *
 * ⚠ `installSlug` stays correct for registry self-gating, pause resolution, log lines
 * and watchdogKeys (stable alarm identity). Only DB ROW ADDRESSING moves.
 *
 * The predicate (usesRawInstallSlugFilter) is exported + unit-tested
 * (packages/operator-core/lib/pot-membership-raw-slug-guard.test.ts) so the
 * "fails on a NEW raw filter" property is durably verified, not merely
 * green-on-a-clean-tree.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/** Permanently-allowed individual files. */
export const ALLOWLIST = new Set([
  // This guard itself: its prose contains the very pattern it bans (same reason
  // check-no-raw-setinterval allowlists its own definition site).
  'scripts/check-no-raw-install-slug-filter.mjs',
]);

/**
 * Pre-existing sites, grandfathered pending the per-relation audit (step 3 of
 * EI-19298972043721870). These are LATENT, not live: the bug only bites when the
 * routine's `install_slug` is a workspace-global label. Measured exposure in
 * `papercusp-workspace` when this guard landed: `hive-canary` (4 routines, 2 active)
 * was the only ACTIVE workspace-global install slug — and it is exactly the one that
 * broke. `@singleton` (15 routines) and `*` (1) were all INACTIVE: a loaded gun, since
 * activating any one of them whose action reads by raw `installSlug` reproduces the
 * silent blindness immediately.
 *
 * This set MUST shrink to empty. Each entry either moves to `routineStorageSlug` or
 * earns an ALLOWLIST entry stating WHY its relation is not subject to re-homing.
 * A NEW file here is a hard guard failure, not a BASELINE addition — that is the ratchet.
 */
export const BASELINE = new Set([
  'packages/operator-core/lib/release/green-stall-watchdog.ts',
  'packages/operator-core/lib/harness/routines/plan-run-action.ts',
  'packages/operator-core/lib/pr-host/poll-daemon.ts',
  'packages/operator-core/lib/release-deploy-staleness-watchdog.ts',
  'packages/operator-core/lib/system-health/liveness-alarm.ts',
  'packages/operator-core/lib/scout/ungraded-filings-watchdog.ts',
  'packages/operator-core/lib/scout/ready-plan-autostart.ts',
  'packages/operator-core/lib/scout/draft-review-watchdog.ts',
  'packages/operator-core/lib/overwatch/snapshot.ts',
]);

export const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f.includes('/.next/') ||
  f.includes('/build/') ||
  f.includes('/storybook-static/') ||
  f.includes('/code-server/') ||
  f.includes('/env-sidecars/') ||
  f.includes('/spa/assets/') ||
  f.includes('/holepunch-spike/') ||
  /\.(test|spec)\.[cm]?tsx?$/.test(f) ||
  !/\.(ts|mjs|cjs)$/.test(f);

/** Strip block + line comments so PROSE describing the trap isn't flagged as the trap. */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * The tell: a SQL filter comparing `harness_slug` to the raw `${installSlug}`
 * interpolation. Deliberately NARROW — it matches the un-resolved identifier only, so
 * `harness_slug = ${storageSlug}` / `${await routineStorageSlug(...)}` (the fix) does
 * NOT match. Comments are stripped first. Pure (text → boolean) so it unit-tests.
 */
export function usesRawInstallSlugFilter(text) {
  return /harness_slug\s*=\s*\$\{\s*installSlug\s*\}/.test(stripComments(text));
}

/**
 * The CLEAN-path verdict line. Pure (counts → string) so the property that matters —
 * an incomplete corpus NEVER renders as a clean bill of health — is unit-testable
 * rather than green-on-a-clean-tree only.
 *
 * EI-19298378364087215. This guard establishes a NEGATIVE ("no file filters
 * harness_slug by a raw installSlug"), and an incomplete enumeration cannot establish
 * a negative at all. In an archive-extracted release/checkpoint checkout,
 * `git ls-files --recurse-submodules` cannot descend into ANY submodule (no `.git` to
 * descend into) — measured 2026-08-02: `git -C papercup-checkpoint submodule status`
 * prints the uninitialised `-` prefix for every one of the 39. The scan then silently
 * covers the superproject alone and a "✓ no NEW offenders" line would be asserting a
 * repo-wide absence from ~79% of the repo.
 *
 * Keyed on `unscannedPresent`, NOT on bare `unscanned`, for the reason
 * check-vacuous-negative-assertions.mjs documents at its own call site: this repo
 * permanently carries one deliberately-absent submodule (libs/zero-harness, retired
 * and uninitialised on purpose), so an alarm keyed on `unscanned` fires on every run
 * in a perfectly healthy tree and is trained away — worthless exactly when it matters.
 *
 * Deliberately does NOT change the exit code. An archive-extracted checkout is BY
 * DESIGN, so failing there would red the gate permanently and get this guard
 * allowlisted out of existence. What is wrong in that tree is the CLAIM, not the
 * build: so the verdict is downgraded and the reader is told it is not a pass.
 */
export function formatCleanVerdict({ scanned, grandfathered, unscannedPresent }) {
  if (unscannedPresent > 0) {
    return (
      `⚠ INCOMPLETE — cannot establish "no NEW raw-installSlug harness_slug filters". ` +
      `${scanned} file(s) read, but ${unscannedPresent} submodule(s) whose files are ON DISK ` +
      `were never enumerated, so an offender inside them is reported exactly like an absent one. ` +
      `Treat this as UNKNOWN, not as a pass; re-run where the enumeration is whole ` +
      `(${grandfathered} grandfathered pending per-relation audit).`
    );
  }
  return (
    `✓ no NEW raw-installSlug harness_slug filters (${scanned} files scanned; ` +
    `${grandfathered} grandfathered pending per-relation audit).`
  );
}

function main() {
  const scan = listTrackedFiles(ROOT);
  const { files: tracked, unscannedPresent } = scan;
  const files = tracked.filter((f) => !isExcluded(f) && !ALLOWLIST.has(f));
  const offenders = [];
  const baselineStillDirty = new Set();
  /** Files this run actually READ — the only ones it can conclude anything about. */
  const evaluated = new Set();

  for (const f of files) {
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
    } catch {
      continue; // deleted between enumeration and read
    }
    evaluated.add(f);
    if (!usesRawInstallSlugFilter(text)) continue;
    if (BASELINE.has(f)) baselineStillDirty.add(f);
    else offenders.push(f);
  }

  // A BASELINE entry that is now CLEAN should be removed, or the ratchet silently
  // loosens: a stale grandfather keeps protecting a file that no longer needs it, so a
  // regression in that same file would be admitted without failing.
  //
  // ⚠ Gated on `evaluated`, not on mere absence from baselineStillDirty. A file this run
  // never READ is UNKNOWN, not clean — and an absence-ratchet that treats the two alike
  // demands you delete a grandfather that is still dirty, which ADMITS the very
  // regression the entry exists to catch. That is not hypothetical: it is the same
  // defect that made child-output-guard's ratchet emit `fixed — DELETE this key` against
  // an archive-extracted checkout (EI-19298378364087215). Every BASELINE path is in the
  // superproject today, so no submodule blindness reaches this line yet; keying it on
  // what was actually read means a future entry under libs/* cannot reintroduce it.
  const staleBaseline = [...BASELINE].filter((f) => evaluated.has(f) && !baselineStillDirty.has(f));
  const unverifiableBaseline = [...BASELINE].filter((f) => !evaluated.has(f));

  if (unverifiableBaseline.length) {
    console.error(
      `\n  ⚠ ${unverifiableBaseline.length} BASELINE entr(ies) were never read this run — ` +
        `NOT judged clean, and deliberately not reported as stale:\n` +
        unverifiableBaseline.map((f) => '    ' + f).join('\n'),
    );
  }

  if (!offenders.length && !staleBaseline.length) {
    console.log(
      formatCleanVerdict({
        scanned: evaluated.size,
        grandfathered: baselineStillDirty.size,
        unscannedPresent: unscannedPresent.length,
      }) + describeUnscanned(scan),
    );
    return;
  }

  if (staleBaseline.length) {
    console.error('\n  BASELINE entries that are now CLEAN — remove them from');
    console.error('  scripts/check-no-raw-install-slug-filter.mjs so the ratchet keeps its teeth:\n');
    for (const f of staleBaseline) console.error('    ' + f);
  }

  if (offenders.length) {
    console.error('\n  NEW read path(s) filtering harness_slug by a RAW installSlug.\n');
    console.error('  A row written under a workspace-global label is RE-HOMED to the platform Pot,');
    console.error('  so this filter can match ZERO rows forever — silently, which for a detector is');
    console.error('  indistinguishable from "everything is healthy" (EI-19298246923137692).\n');
    console.error('  Use routineStorageSlug(installSlug, workspaceId) from pot-membership.ts, which');
    console.error('  resolves through the SAME path the WRITE side uses.\n');
    console.error('  If this relation is genuinely NOT re-homed (pot-scoped / install-scoped table),');
    console.error('  add it to ALLOWLIST with the reason — check the RELATION, not the call site.\n');
    for (const o of offenders) console.error('    ' + o);
    console.error(`\n  ${offenders.length} offender(s). See EI-19298972043721870.`);
  }
  process.exit(1);
}

// Run the scan only when invoked as a CLI — importing the module (for the unit test)
// must NOT exec git / exit the process. Symlink-robust (WI-1443).
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
