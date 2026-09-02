/**
 * WI-4413 — scheduler:get_next's MISS must explain itself.
 *
 * The bug: `work_items:claim_next` has run diagnoseClaimNextMiss on a miss since EI-5803, but
 * `scheduler:get_next` — the path every fleet MEMBER self-pulls through, and the one a leader's
 * claim spec drives — returned a static, floor-blind string: "no claimable work-item matched
 * your spec within the floors". It named no id, no floor, no count.
 *
 * Live cost (bug-drain-nonp2p, 2026-07-12): a leader fed THREE consecutive claim-spec tranches
 * that every read surface called claimable and get_next silently refused — blocked by three
 * DIFFERENT floors (observation-lane, plan-lane reservation, _claimHold/owner-action). Three
 * members idled; three separate agents had to reverse-engineer the floors from raw payload
 * reads. Every one of those digs was one line of tool output away.
 *
 * These are the UNIT-level guards (the pure logic + the drift guard). The DB-backed behaviour
 * (a floored tranche actually reporting its floors) is exercised in the sibling integration
 * test, which owns a real PG.
 */
import { describe, it, expect } from 'vitest';
import { specNamedIds } from '../agent-tools/scheduler/get_next';

describe('WI-4413 — specNamedIds: pull the ids a leader tranche NAMES out of its spec', () => {
  it('extracts the id list from the canonical leader-tranche spec shape', () => {
    const spec = {
      specVersion: '1.0',
      specId: 'bug-drain-relaunch-0712b',
      view: {
        filter: {
          all: [
            { field: 'kind', op: 'in', value: ['bug', 'change'] },
            { field: 'id', op: 'in', value: ['WI-2749', 'WI-3065', 'EI-10375'] },
          ],
        },
      },
    };
    expect(specNamedIds(spec)).toEqual(['WI-2749', 'WI-3065', 'EI-10375']);
  });

  it('returns [] for a spec that names no ids — a broad kind-only spec is NOT a tranche', () => {
    const spec = { view: { filter: { all: [{ field: 'kind', op: 'in', value: ['bug'] }] } } };
    expect(specNamedIds(spec)).toEqual([]);
  });

  it('is total: never throws on a malformed / absent / hostile spec (the miss path must fail soft)', () => {
    // A diagnosis is an ANNOTATION on a miss. If it can throw, it becomes a new way for the
    // claim path itself to fail — strictly worse than the uninformative message it replaces.
    expect(specNamedIds(undefined)).toEqual([]);
    expect(specNamedIds(null)).toEqual([]);
    expect(specNamedIds({})).toEqual([]);
    expect(specNamedIds({ view: {} })).toEqual([]);
    expect(specNamedIds({ view: { filter: {} } })).toEqual([]);
    expect(specNamedIds({ view: { filter: { all: 'not-an-array' } } })).toEqual([]);
    expect(specNamedIds({ view: { filter: { all: [null, 7, 'x'] } } })).toEqual([]);
    // id clause present but value is not a string array ⇒ nothing usable, not a crash
    expect(specNamedIds({ view: { filter: { all: [{ field: 'id', op: 'in', value: [1, 2] }] } } })).toEqual([]);
    // wrong operator ⇒ not the tranche shape
    expect(specNamedIds({ view: { filter: { all: [{ field: 'id', op: 'eq', value: ['WI-1'] }] } } })).toEqual([]);
  });

  it('filters non-string entries out of a mixed id list rather than passing them to SQL', () => {
    const spec = { view: { filter: { all: [{ field: 'id', op: 'in', value: ['WI-1', 42, null, 'EI-2'] }] } } };
    expect(specNamedIds(spec)).toEqual(['WI-1', 'EI-2']);
  });
});

describe('WI-4413 — floor-attribution DRIFT GUARD', () => {
  /**
   * The whole design rests on one property: `explainIssueClaimFloors` evaluates the SAME
   * exported sql predicates the claim path ANDs in — as boolean columns instead of WHERE
   * clauses. That is what makes the explanation incapable of disagreeing with the claim.
   *
   * The failure mode this guards: someone adds a NEW floor to the issue claim path and does
   * not add it to the attribution. The explanation then reports an id as `admissible: true`
   * that still will not claim — a diagnosis that LIES, which is worse than none, and is
   * exactly the silent-success class this whole work-item exists to kill.
   *
   * So: pin the floor list. Adding a floor to the claim path without adding it here fails
   * HERE, loudly, at the point of the change — instead of at 2am in front of an idle fleet.
   */
  it('the attributed floor set matches the issue-family claim floors, one for one', async () => {
    const workItems = await import('../work-items');

    // Every exported issue-family floor predicate the claim path applies.
    const CLAIM_PATH_FLOORS = [
      'observationLaneExclusionSql',
      'needsOwnerActionExclusionSql',
      'externalBlockersExclusionSql',
      'claimHoldExclusionSql',
      'reservedPlanLaneExclusionSql',
      'federationDetectorExclusionSql',
      'loopIterationNoiseExclusionSql',
      'alreadyTerminallyCompletedExclusionSql',
      'crossMachineRigExclusionSql',
    ] as const;

    for (const floor of CLAIM_PATH_FLOORS) {
      expect(
        typeof (workItems as unknown as Record<string, unknown>)[floor],
        `${floor} is a claim-path floor — it must stay exported so explainIssueClaimFloors ` +
          `can evaluate the SAME predicate rather than re-implementing it (drift = a lying diagnosis)`,
      ).toBe('function');
    }

    // explainIssueClaimFloors must attribute a reason for each of them. The reason strings are
    // the operator-facing contract, so pin them too.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../work-items.ts', import.meta.url), 'utf8'),
    );
    const attribution = src.slice(src.indexOf('const ISSUE_FLOOR_EXPLANATIONS'));
    for (const reason of [
      'observation-lane',
      'needs-owner-action',
      'external-blocker',
      'claim-hold',
      'plan-lane-reserved',
      'federation-detector',
      'loop-noise',
      'already-completed',
      'cross-machine-rig',
      'not-claimable-status',
      'already-taken',
      'not-found',
    ]) {
      expect(attribution, `floor "${reason}" must have an operator-facing explanation`).toContain(reason);
    }

    // And each floor predicate must actually be EVALUATED on the diagnosis path — an
    // explanation string with no predicate behind it is decoration, not a diagnosis.
    //
    // ⚠ THIS IS A TWO-HOP CHECK ON PURPOSE, and the second hop is the load-bearing one.
    // It used to slice explainIssueClaimFloors' own body and grep it for each floor name.
    // WI-37356 then extracted the floor column set into issueClaimBarFloorColumnsSql —
    // precisely so the SET could not be hand-maintained in two places — and the slice went
    // red on a refactor that made the code STRICTER, because the names now live one
    // indirection away. A guard that fails when its subject improves teaches agents to
    // route around it, so it follows the indirection instead: assert the delegation, then
    // assert the delegate is complete. Re-inlining the fragments would fail the first leg.
    const explainBody = src.slice(
      src.indexOf('export async function explainIssueClaimFloors'),
      src.indexOf('The ISSUE-family half of self-selection'),
    );
    expect(
      explainBody,
      'explainIssueClaimFloors must build its floor columns from the SHARED ' +
        'issueClaimBarFloorColumnsSql helper, so the diagnosis and the claim path cannot drift apart',
    ).toContain('issueClaimBarFloorColumnsSql(');

    const floorColumnsBody = src.slice(
      src.indexOf('export function issueClaimBarFloorColumnsSql'),
      src.indexOf('export async function explainIssueClaimFloors'),
    );
    for (const floor of CLAIM_PATH_FLOORS) {
      expect(
        floorColumnsBody,
        `issueClaimBarFloorColumnsSql must EVALUATE ${floor} (the same fragment the claim ANDs in), ` +
          `not re-implement or omit it — explainIssueClaimFloors reads its floors from here`,
      ).toContain(floor);
    }
  });
});
