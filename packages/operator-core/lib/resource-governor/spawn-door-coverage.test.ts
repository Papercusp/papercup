import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RESOURCE_GOVERNOR_INVENTORY } from '../../../../scripts/check-resource-governor-enforcement.mjs';
import { listTrackedFiles } from '../../../../scripts/lib/tracked-files.mjs';

/**
 * P-002 of plan `spawn-door-governor-migration-2026-08-31`.
 *
 * WHAT BROKE, AND WHY A TEST: the agent-spawn lane's inventory prefixes covered
 * every spawn DOOR but neither file holding the actual child-start primitive, so
 * a raw `spawn()` could be added to `console-spawn.ts` and the enforcement scan
 * would stay green while reporting "8/8 lanes ENFORCED". Nothing failed. P-001
 * widened the prefixes; this test is the recurrence guard, because the thing
 * that reopens the blind spot is not a bad edit to the scanner — it is an
 * ORDINARY FILE MOVE somewhere else in the tree, which no reviewer would connect
 * to governor coverage.
 *
 * Coverage is a CROSS-LANE property: measured 2026-08-31, the two recovery-path
 * callers resolve through `background-routines-watchdogs` and
 * `p2p-sync-index-cache-compaction`, not through `agent-process-memory`. A guard
 * that checked one lane would report false gaps here.
 */

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const B = 'packages/operator-core/lib/';

/** Every file that starts, or routes, an agent child process. */
const SPAWN_DOOR_FILES = [
  [`${B}fleet/operator-spawn.ts`, 'the chokepoint itself (P-012)'],
  [`${B}agent-tools/operator/converse.ts`, 'caller (P-005)'],
  [`${B}agent-tools/fleet/place_batch.ts`, 'caller (P-006)'],
  [`${B}papercup/papercup-deep-delegate-deps.ts`, 'caller (P-007)'],
  [`${B}fleet/spawn-relaunch.ts`, 'caller, recovery path (P-009)'],
  [`${B}fleet/supervision.ts`, 'caller, recovery path (P-010)'],
  [`${B}events/await/wake-executor-fresh-context.ts`, 'caller, recovery path (P-011)'],
  [`${B}iq-battery/bee-instance.ts`, 'caller, the EIGHTH door (D-012 census, P-040)'],
  [`${B}console-spawn.ts`, 'child-start primitive, adopted by P-001'],
  [`${B}dbos/orchestrator-runner.ts`, 'child-start primitive, adopted by P-001'],
] as const satisfies ReadonlyArray<readonly [string, string]>;

/**
 * SHRINK-ONLY RATCHET (plan D-007). Doors that are knowingly not yet inside any
 * active lane. This list may only ever be DELETED FROM.
 *
 * Adding an entry to silence a new failure is the parking-lot abuse this guard
 * exists to prevent — a newly uncovered door is a coverage bug to fix, not a
 * line to append. The assertion below is an EXACT set equality, so this also
 * fails when a gap is CLOSED: that is deliberate, and deleting the entry is part
 * of the closing item's acceptance.
 *
 * `papercup-deep-delegate-deps.ts` is in no active lane and its child start is
 * genuinely outside admission until P-007 migrates it. Covering it earlier would
 * force a bypass row whose only honest reason is "not migrated yet" — the weak
 * ground D-006 rejected. Coverage lands WITH the P-007 migration; that item's
 * acceptance includes deleting this entry.
 *
 * `bee-instance.ts` is the EIGHTH door. Until D-012 it was named by NO plan item
 * and by NO entry here, so it was invisible to this guard entirely — and an
 * invisible door is strictly worse than a declared gap, because the exact-set
 * assertion below can only ever police doors it NAMES. Measured 2026-08-31:
 * `lanesCovering()` returns [] for it and no inventory row carries any prefix
 * containing `iq-battery`. Its coverage lands WITH the P-040 migration, on the
 * same terms as P-007 above; that item's acceptance includes deleting this entry.
 */
const EXPECTED_COVERAGE_GAPS: readonly string[] = [
  `${B}papercup/papercup-deep-delegate-deps.ts`,
  `${B}iq-battery/bee-instance.ts`,
];

// Row shapes are INFERRED from scripts/check-resource-governor-enforcement.d.mts
// (emitted by `gen:declarations`), never restated here. Restating them is what
// broke: a hand-written `(row: { paths: string[] })` stopped matching the
// declaration's `paths: readonly string[]` and failed as TS2769, because a
// `readonly string[]` is not assignable to a mutable `string[]`. The annotations
// were only ever needed while the .mjs had no declaration; it has one now, so
// inference is both correct and drift-proof. Do not re-add them.
const activeLanes = RESOURCE_GOVERNOR_INVENTORY.filter(
  (row) => row.enforcement === 'active',
);

/** Every active lane whose prefixes claim `path`. Cross-lane by construction. */
function lanesCovering(path: string): string[] {
  return activeLanes
    .filter((row) => row.paths.some((prefix) => path.startsWith(prefix)))
    .map((row) => row.id);
}

describe('spawn-door governor coverage (P-002 recurrence guard)', () => {
  const tracked = new Set(listTrackedFiles(ROOT).files);

  it('every spawn-door file still exists at the path this guard names', () => {
    // A rename that silently drops a door out of the guard is the same class of
    // failure as a prefix that stops matching it, so it fails here rather than
    // letting the coverage assertion pass over a path nothing resolves to.
    const absent = SPAWN_DOOR_FILES.filter(([path]) => !tracked.has(path)).map(
      ([path, why]) => `${path} (${why})`,
    );
    expect(absent).toEqual([]);
  });

  it('the set of uncovered spawn doors is EXACTLY the declared ratchet', () => {
    const uncovered = SPAWN_DOOR_FILES.filter(
      ([path]) => lanesCovering(path).length === 0,
    ).map(([path]) => path);
    // Exact equality, both directions: a NEW uncovered door fails (the blind
    // spot reopened), and a CLOSED gap fails until its ratchet entry is deleted.
    expect([...uncovered].sort()).toEqual([...EXPECTED_COVERAGE_GAPS].sort());
  });

  it('the ratchet only ever names real, tracked spawn doors', () => {
    for (const gap of EXPECTED_COVERAGE_GAPS) {
      expect(tracked.has(gap)).toBe(true);
      expect(SPAWN_DOOR_FILES.some(([path]) => path === gap)).toBe(true);
    }
  });

  it('CALIBRATION: lane resolution discriminates, so the assertions above are not vacuous', () => {
    // Without this, a lanesCovering() that returned a lane for everything would
    // make the coverage assertion pass while measuring nothing at all.
    expect(lanesCovering('packages/operator-core/lib/fleet/anything.ts')).toContain(
      'agent-process-memory',
    );
    expect(lanesCovering('docs/not-source-at-all.md')).toEqual([]);
  });

  it('the P-001 primitives are adopted as EXACT files, not by a directory sweep', () => {
    // D-006 chose exact-file entries so an unrelated future file under lib/dbos/
    // is not silently pulled into an ACTIVE lane. Pin that choice: if someone
    // "simplifies" the entry to a lib/dbos/ prefix, this fails.
    expect(lanesCovering(`${B}console-spawn.ts`)).toContain('agent-process-memory');
    expect(lanesCovering(`${B}dbos/orchestrator-runner.ts`)).toContain(
      'agent-process-memory',
    );
    expect(lanesCovering(`${B}dbos/zzz-unrelated-future-file.ts`)).toEqual([]);
  });
});
