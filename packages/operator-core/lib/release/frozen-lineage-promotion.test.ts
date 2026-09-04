import { describe, expect, it } from 'vitest';

import {
  assessFrozenLineagePromotion,
  type FrozenLineagePromotionInput,
} from './frozen-lineage-promotion';

/**
 * P-007 / D-004 falsifiers, written BEFORE the promotion path was changed.
 *
 * D-001 used to say: an isolated repair head is verification-only, so a green repair was
 * joined into the moving integration tip and the whole gate re-run at that joined sha —
 * discarding the proof it had just earned and re-importing every commit that had landed
 * since the freeze. D-004 (RATIFIED by the owner 2026-09-03 ~22:58Z) replaces it with:
 * `main` may fast-forward to a commit of the FROZEN LINEAGE that passed the full gate.
 *
 * This guard is the "of the frozen lineage" half, and it is deliberately FAIL-CLOSED:
 * every input that is not a positive proof of lineage membership refuses promotion. An
 * UNREADABLE git answer (null) must refuse exactly as loudly as a negative one — a
 * measurement that failed is never a verdict.
 */

const CANDIDATE = 'c'.repeat(40);
const REPAIR_HEAD = 'd'.repeat(40);
const STAGING_TIP = 'e'.repeat(40);

function input(overrides: Partial<FrozenLineagePromotionInput> = {}): FrozenLineagePromotionInput {
  return {
    candidate: CANDIDATE,
    repairHead: REPAIR_HEAD,
    judged: REPAIR_HEAD,
    judgedDescendsFromCandidate: true,
    judgedOnLineageRef: true,
    ...overrides,
  };
}

describe('main may only fast-forward to a frozen-lineage commit that passed the full gate (P-007/D-004)', () => {
  it('CALIBRATION: the repair head itself, descended from the candidate and on the lineage ref, is promotable', () => {
    const verdict = assessFrozenLineagePromotion(input());
    expect(verdict.promotable).toBe(true);
    expect(verdict.code).toBe('promotable');
    // The summary is what lands in the gate log and the broadcast; it must name the sha
    // being promoted and the candidate it descends from, not just say "ok".
    expect(verdict.summary).toContain(REPAIR_HEAD.slice(0, 8));
    expect(verdict.summary).toContain(CANDIDATE.slice(0, 8));
  });

  it('a candidate that froze and verified green with ZERO admissions promotes itself', () => {
    // repairHead === candidate is the legitimate no-admission case: a commit is its own
    // ancestor, so the lineage predicate holds without a special case.
    const verdict = assessFrozenLineagePromotion(
      input({ repairHead: CANDIDATE, judged: CANDIDATE }),
    );
    expect(verdict.promotable).toBe(true);
    expect(verdict.code).toBe('promotable');
  });

  it('refuses when the gate judged a sha that is NOT the repair head', () => {
    // This is the D-001 join in its exact old shape: the gate judged a commit that merged
    // the repair into the moving staging tip. That sha is green, and it is still not the
    // thing the freeze proved.
    const verdict = assessFrozenLineagePromotion(input({ judged: STAGING_TIP }));
    expect(verdict.promotable).toBe(false);
    expect(verdict.code).toBe('judged-sha-is-not-the-repair-head');
    expect(verdict.summary).toContain(STAGING_TIP.slice(0, 8));
  });

  it('refuses a sha that does not descend from the frozen candidate', () => {
    // A tip cut taken while a candidate is frozen (WI-2144110) reaches here looking like a
    // perfectly ordinary green. Ancestry is what tells it apart from the lineage.
    const verdict = assessFrozenLineagePromotion(input({ judgedDescendsFromCandidate: false }));
    expect(verdict.promotable).toBe(false);
    expect(verdict.code).toBe('repair-head-does-not-descend-from-candidate');
  });

  it('refuses a sha that descends from the candidate but is absent from the lineage ref', () => {
    // Descent alone is not membership: anything built on top of the candidate descends from
    // it, including a commit no admission ever produced. The CAS-advanced lineage ref is the
    // only record of what was actually admitted.
    const verdict = assessFrozenLineagePromotion(input({ judgedOnLineageRef: false }));
    expect(verdict.promotable).toBe(false);
    expect(verdict.code).toBe('repair-head-absent-from-lineage-ref');
  });

  it('refuses — and says so as UNREADABLE, not as a negative — when ancestry cannot be measured', () => {
    const verdict = assessFrozenLineagePromotion(input({ judgedDescendsFromCandidate: null }));
    expect(verdict.promotable).toBe(false);
    expect(verdict.code).toBe('lineage-unreadable');
    expect(verdict.summary).toMatch(/could not be (read|measured)/i);
  });

  it('refuses — as UNREADABLE — when the lineage ref cannot be resolved', () => {
    const verdict = assessFrozenLineagePromotion(input({ judgedOnLineageRef: null }));
    expect(verdict.promotable).toBe(false);
    expect(verdict.code).toBe('lineage-unreadable');
  });

  it('is fail-closed across EVERY combination: only all-positive proof promotes', () => {
    const tri: Array<boolean | null> = [true, false, null];
    const promoted: string[] = [];
    for (const descends of tri) {
      for (const onRef of tri) {
        for (const judged of [REPAIR_HEAD, STAGING_TIP]) {
          const verdict = assessFrozenLineagePromotion(
            input({ judged, judgedDescendsFromCandidate: descends, judgedOnLineageRef: onRef }),
          );
          if (verdict.promotable) promoted.push(`${judged.slice(0, 8)}/${descends}/${onRef}`);
        }
      }
    }
    // Exactly one of the eighteen combinations may promote.
    expect(promoted).toEqual([`${REPAIR_HEAD.slice(0, 8)}/true/true`]);
  });

  it('never reports promotable without a code, or a refusal without a reason', () => {
    const tri: Array<boolean | null> = [true, false, null];
    for (const descends of tri) {
      for (const onRef of tri) {
        const verdict = assessFrozenLineagePromotion(
          input({ judgedDescendsFromCandidate: descends, judgedOnLineageRef: onRef }),
        );
        expect(typeof verdict.code).toBe('string');
        expect(verdict.code.length).toBeGreaterThan(0);
        expect(verdict.summary.length).toBeGreaterThan(0);
        expect(verdict.promotable).toBe(verdict.code === 'promotable');
      }
    }
  });
});
