/**
 * work-item-terminal-predicate-drift.test.ts — D-068 recurrence guard.
 *
 * THE BUG CLASS. A SQL predicate that decides "is this work-item finished?" by
 * SPELLING the terminal states by hand — `status NOT IN ('done','resolved',
 * 'deprecated','closed')` — is a second copy of a truth
 * `work-item-dispatch-states.ts` owns, and it drifts. Every consumer reads
 * "not in the set => still active", so a missing token silently reclassifies
 * SETTLED work as LIVE.
 *
 * It has already happened twice, and both are documented in the constants
 * themselves:
 *   - EI-18653071581558556 — placement-watchdog's hand-copy never learned
 *     `done`/`dropped`; measured live 2026-07-25, 15 of 17 units reported
 *     stranded were already terminal (~88% phantoms), and the drifted copy
 *     matched just ~18% of terminal rows.
 *   - EI-21921121818266895 — `ISSUE_TERMINAL_STATES` itself omitted `dropped`
 *     for over a month after work-item-status-full-unify made it the issue
 *     family's terminal spelling.
 *
 * D-068 found the THIRD round: the pre-fix literal was still hand-copied in
 * five non-test sources (carry-brief, turn-start-orientation x2,
 * recipe-authority, rebind-identity), every one of them omitting `dropped` —
 * 12,958 such rows existed when measured on 2026-09-22. Those five now DERIVE,
 * and {@link FIXED_BY_D068} pins that so they cannot quietly regress.
 *
 * WHY AN ALLOWLIST RATHER THAN A CLEAN SWEEP. Measured 2026-09-22, this
 * detector finds 39 predicates across 23 files. Most are complete today, some
 * are genuinely partial (`derive-awaiting.ts` carries 3 of the 6 tokens;
 * `papercup-context.ts` omits `done` and `dropped`), and several positive-form
 * `IN (...)` predicates select a deliberate SUBSET rather than "all terminals",
 * so each needs its own semantic judgement. Auditing 23 call sites is a
 * separate program, tracked on its own work-item. A guard that red-pinned all
 * 23 would simply be deleted by whoever hit it next, so the baseline is
 * SHRINK-ONLY: nothing new may join, and a file that gets fixed must leave.
 *
 * WHY THE DETECTOR DOES NOT STRIP STRING LITERALS. The subject of this guard is
 * SQL, and SQL lives inside template literals here — stripping them (the usual
 * defence against a source-scanning guard matching its own fixture) would blank
 * exactly the text being hunted and turn every true positive into a silent
 * false NEGATIVE. This file is excluded BY PATH instead, and a positive control
 * asserts the detector still fires on a known-bad fixture so the exclusion can
 * never quietly become "the detector stopped working".
 *
 * Run: cd packages/operator-core && npx vitest run lib/work-item-terminal-predicate-drift.test.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Repo root, derived from this file's own location (no hardcoded absolute path). */
const REPO_ROOT = resolve(__dirname, '../../..');
const SCAN_ROOT = join(REPO_ROOT, 'packages/operator-core/lib');
const SELF = relative(REPO_ROOT, __filename).replace(/\\/g, '/');

/**
 * A status/state SQL predicate whose members are spelled out inline. Narrow ON
 * PURPOSE: the broad form (any comma-separated run of terminal tokens) matched
 * 126 sites across 90 files, nearly all legitimate test fixtures and writer
 * vocabularies. The defect is the PREDICATE, not the word list.
 */
const TERMINAL_PREDICATE_RE =
  /\b(?:status|state)\s*(?:NOT\s+IN|IN|<>\s*ALL|=\s*ANY)\s*\(\s*(?:ARRAY\s*\[\s*)?'[a-z_-]+'(?:\s*,\s*'[a-z_-]+')*/gi;

const TERMINAL_TOKENS = new Set(['done', 'resolved', 'deprecated', 'closed', 'dropped', 'passed']);

/** A hit only counts when EVERY spelled member is a terminal token — that is what
 *  makes it a terminal-set copy rather than an ordinary state filter. */
function findHandSpelledTerminalPredicates(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(TERMINAL_PREDICATE_RE)) {
    const members = [...m[0].matchAll(/'([a-z_-]+)'/g)].map((x) => x[1]!);
    if (members.length < 3) continue;
    if (!members.every((t) => TERMINAL_TOKENS.has(t))) continue;
    out.push(m[0].replace(/\s+/g, ' '));
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'coverage' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function scan(): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const abs of walk(SCAN_ROOT)) {
    const rel = relative(REPO_ROOT, abs).replace(/\\/g, '/');
    if (rel === SELF) continue; // excluded by path — see the header note
    const hits = findHandSpelledTerminalPredicates(readFileSync(abs, 'utf8'));
    if (hits.length) byFile.set(rel, hits);
  }
  return byFile;
}

/**
 * MEASURED BASELINE — 23 files, captured 2026-09-22 by scanning the tree, never
 * hand-listed. SHRINK-ONLY: adding an entry requires fixing a call site instead.
 */
const BASELINE: readonly string[] = [
  'packages/operator-core/lib/agent-tools/coordination/derive-awaiting.ts',
  'packages/operator-core/lib/agent-tools/improvements/filing-classes.ts',
  'packages/operator-core/lib/agent-tools/plans/runs.ts',
  'packages/operator-core/lib/bash-substitution/pairs/sql-reads-helpers.test.ts',
  'packages/operator-core/lib/dbos/notify-parent-done.ts',
  'packages/operator-core/lib/external-triggers/admin.ts',
  'packages/operator-core/lib/goal-launch-settings.ts',
  'packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts',
  'packages/operator-core/lib/papercup/papercup-context.ts',
  'packages/operator-core/lib/personal-vault/ambient.ts',
  'packages/operator-core/lib/pilot-materialization-core.ts',
  'packages/operator-core/lib/plan-items/reflect-orphaned-plan-items.ts',
  'packages/operator-core/lib/rubrics.ts',
  'packages/operator-core/lib/scheduler/dependency-soak.integration.test.ts',
  'packages/operator-core/lib/scout/signal-accumulator.ts',
  'packages/operator-core/lib/shared-pot-loop/fleet-monitors-orphan-sweep.integration.test.ts',
  'packages/operator-core/lib/sync/hyperbee/projections/engineer-issues.integration.test.ts',
  'packages/operator-core/lib/sync/hyperbee/projections/engineer-issues.ts',
  'packages/operator-core/lib/system-health/agent-productivity-watchdog.ts',
  'packages/operator-core/lib/system-health/unservable-critical-watchdog.ts',
  'packages/operator-core/lib/testing/dependency-fixture.ts',
  'packages/operator-core/lib/work-item-claims.ts',
  'packages/operator-core/lib/work-items.ts',
];

/** The five sites D-068 converted from hand-spelled to derived. */
const FIXED_BY_D068: readonly string[] = [
  'packages/operator-core/lib/carry-brief.ts',
  'packages/operator-core/lib/turn-start-orientation.ts',
  'packages/operator-core/lib/recipe-authority.ts',
  'packages/operator-core/lib/agent-tools/coordination/rebind-identity.ts',
  'packages/operator-core/lib/agent-tools/coordination/rebind-identity.test.ts',
];

describe('D-068: terminal-state SQL predicates must derive, not be spelled by hand', () => {
  it('THE FALSIFIABILITY CONTROL: the detector fires on a known-bad predicate', () => {
    // A pre-fix carry-brief predicate, verbatim. If a future refactor breaks the
    // detector, THIS fails — so a green suite can never mean "the scan found
    // nothing because the scan stopped working".
    const known_bad = `AND (item_kind IN ('bug', 'change', 'task') AND status NOT IN ('done', 'resolved', 'deprecated', 'closed'))`;
    expect(findHandSpelledTerminalPredicates(known_bad)).toHaveLength(1);
  });

  it('the detector does NOT fire on the derived form, or on an ordinary state filter', () => {
    const derived = `AND NOT (status = ANY(\${[...ISSUE_TERMINAL_STATES]}::text[]))`;
    expect(findHandSpelledTerminalPredicates(derived)).toEqual([]);
    // A genuine non-terminal state filter must stay allowed.
    const ordinary = `WHERE status IN ('open', 'wip', 'blocked')`;
    expect(findHandSpelledTerminalPredicates(ordinary)).toEqual([]);
    // A mixed list is a real filter, not a terminal-set copy.
    const mixed = `WHERE status NOT IN ('done', 'open', 'wip')`;
    expect(findHandSpelledTerminalPredicates(mixed)).toEqual([]);
  });

  it('this guard excludes itself by path, and would otherwise match its own fixture', () => {
    // Proves the exclusion is load-bearing rather than incidental: the fixture
    // above IS detector-shaped, so without the SELF check the scan would report
    // a violation that does not exist.
    const selfSrc = readFileSync(__filename, 'utf8');
    expect(findHandSpelledTerminalPredicates(selfSrc).length).toBeGreaterThan(0);
    expect([...scan().keys()]).not.toContain(SELF);
  });

  it('no NEW file spells a terminal-state predicate by hand (baseline is shrink-only)', () => {
    const offenders = [...scan().keys()].sort();
    const added = offenders.filter((f) => !BASELINE.includes(f));
    expect(
      added,
      'A terminal-state SQL predicate was spelled by hand in a file that did not have one.\n' +
        'Derive it instead — ISSUE_TERMINAL_STATES / FEATURE_TERMINAL_STATES /\n' +
        'ANY_FAMILY_TERMINAL_STATES from work-item-dispatch-states.ts — e.g.\n' +
        '  AND NOT (status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))\n' +
        'Use ANY_FAMILY when the query has no item_kind filter (D-068).',
    ).toEqual([]);
  });

  it('the baseline shrinks: a fixed file must be removed from it', () => {
    const offenders = new Set(scan().keys());
    const stale = BASELINE.filter((f) => !offenders.has(f));
    expect(
      stale,
      'These files no longer spell a terminal predicate by hand — delete them from\n' +
        'BASELINE in this file so the allowlist keeps shrinking.',
    ).toEqual([]);
  });

  it('the five sites D-068 fixed stay derived', () => {
    const offenders = scan();
    for (const f of FIXED_BY_D068) {
      expect(offenders.get(f) ?? [], `${f} regressed to a hand-spelled terminal predicate`).toEqual([]);
    }
  });
});
