/**
 * no-retired-style-guard.test.ts — the no-retired-style CI guard's detection
 * predicate + tree scan (deterministic-blueprints-migration-2026-06-13 P-132 / D-007).
 *
 * The guard (`scripts/check-no-retired-style.mjs`) forbids re-wiring a MIGRATED
 * work-loop back to its retired bespoke `system:<loop>` routine action (the
 * two-execution-model regression the migration collapsed). This suite pins BOTH
 * directions durably:
 *   - no FALSE POSITIVE — `findOffenders()` over the real tree is empty (green on
 *     the clean tree: the migrated seeds target `system:blueprint-run`).
 *   - no FALSE NEGATIVE — the predicate FLAGS a synthetic re-wire (TS + SQL), and
 *     does NOT flag the retired name's legitimate uses (a `createdBy:` provenance
 *     value, a doc mention, a non-migrated loop's own bespoke target).
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicate + scan.
import * as guard from '../../../../scripts/check-no-retired-style.mjs';

// Type the untyped .mjs surface (no .d.ts) so the suite stays noImplicitAny-clean.
type MigratedLoop = { loop: string; retiredTarget: string; blueprintId: string };
const isRetiredRoutineRewire = guard.isRetiredRoutineRewire as (text: string) => boolean;
const findOffenders = guard.findOffenders as () => string[];
const MIGRATED_LOOPS = guard.MIGRATED_LOOPS as MigratedLoop[];
const RETIRED_ROUTINE_TARGETS = guard.RETIRED_ROUTINE_TARGETS as Set<string>;

describe('no-retired-style guard predicate (P-132)', () => {
  it('FLAGS a TS routine re-pointed at a retired bespoke action (target: system:negative-space-mine)', () => {
    const rewire = [
      "const ROUTINE = { name: 'negative-space-mine', target: 'system:negative-space-mine', cron: '0 25 */6 * * *' };",
    ].join('\n');
    expect(isRetiredRoutineRewire(rewire)).toBe(true);
  });

  it('FLAGS a SQL routine re-wire (target_role = system:regret-mine)', () => {
    const sql = "UPDATE harness_shared.routines SET target_role = 'system:regret-mine' WHERE name = 'regret-mine';";
    expect(isRetiredRoutineRewire(sql)).toBe(true);
  });

  it.each(MIGRATED_LOOPS.map((m) => [m.loop, m.retiredTarget] as const))(
    'FLAGS a re-wire of every migrated loop (%s → %s)',
    (_loop, retiredTarget) => {
      expect(isRetiredRoutineRewire(`const ROUTINE = { target: '${retiredTarget}' };`)).toBe(true);
    },
  );

  it('does NOT flag the MIGRATED routing (target: system:blueprint-run + a blueprintId payload)', () => {
    const migrated = [
      "const ROUTINE = { name: 'negative-space-mine', target: 'system:blueprint-run', cron: '0 25 */6 * * *' };",
      "const BLUEPRINT_PAYLOAD = { blueprintId: 'negative-space' };",
    ].join('\n');
    expect(isRetiredRoutineRewire(migrated)).toBe(false);
  });

  it('does NOT flag a PROVENANCE value (createdBy: system:negative-space-mine) — an attribution tag, not a target', () => {
    const provenance = "const row = { createdBy: 'system:negative-space-mine', filedAt: now() };";
    expect(isRetiredRoutineRewire(provenance)).toBe(false);
  });

  it('does NOT flag a doc-comment MENTION of a retired action name (comments are stripped)', () => {
    const comment = [
      "// MIGRATED (P-110): fires the `negative-space` blueprint via system:blueprint-run",
      "// rather than the bespoke `system:negative-space-mine` action. Behavior-neutral.",
      "const ROUTINE = { target: 'system:blueprint-run' };",
    ].join('\n');
    expect(isRetiredRoutineRewire(comment)).toBe(false);
  });

  it('does NOT flag a NON-migrated loop targeting its own (still-live) bespoke action', () => {
    // bucket-B plumbing (git-sync stays a routine forever) legitimately targets its
    // own `system:*` action; only MIGRATED_LOOPS are forbidden as targets.
    const live = "const ROUTINE = { name: 'git-sync', target: 'system:git-sync', cron: '0 */5 * * * *' };";
    expect(isRetiredRoutineRewire(live)).toBe(false);
  });

  it('the migrated set is well-formed: 13 known loops, each retiredTarget = system:<loop>, each with a blueprintId', () => {
    expect(MIGRATED_LOOPS.map((m) => m.loop).sort()).toEqual(
      [
        'calibration-resolve',
        'change-ledger-scan',
        'deferral-interest-refit',
        'fleet-ekg-scan',
        'graduation-scan',
        'iq-battery-gen',
        'negative-space-mine',
        'neologism-mine',
        'prompt-ablation',
        'red-queen-drill',
        'regret-mine',
        'scout-cycle',
        'transfer-distill',
      ],
    );
    for (const m of MIGRATED_LOOPS) {
      expect(m.retiredTarget).toBe(`system:${m.loop}`);
      expect(RETIRED_ROUTINE_TARGETS.has(m.retiredTarget)).toBe(true);
      expect(typeof m.blueprintId).toBe('string');
      expect(m.blueprintId.length).toBeGreaterThan(0);
    }
  });

  it('the real tree is CLEAN: no migrated loop is currently re-wired bespoke (the gating direction)', () => {
    expect(findOffenders()).toEqual([]);
  });
});
