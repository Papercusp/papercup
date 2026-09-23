import { describe, expect, it, vi } from 'vitest';

import type { AcceptanceRubricVettingStatus } from '../../acceptance-rubric-vetting';
import type { Rubric } from '../../rubrics';
import {
  barClauseSpecIds,
  unvettedRubricBindAdvisory,
  VET_BEFORE_PROOF_ORDER,
  type UnvettedRubricBindAdvisoryDeps,
} from './bind-vetting-advisory';

/**
 * P-004 of review-system-rework-reduction-2026-09-23 — `plans:bind-spec-evidence`
 * warns when BAR proof lands on an acceptance-rubric revision nobody has vetted.
 * Advisory only: these tests pin WHEN it fires (and when it must stay silent, so it
 * does not become noise), never a refusal.
 */

const RUBRIC = { rubricId: 'acceptance-demo-plan', kind: 'acceptance', criteria: [{ key: 'R-1' }] } as unknown as Rubric;

function status(over: Partial<AcceptanceRubricVettingStatus> = {}): AcceptanceRubricVettingStatus {
  return {
    required: true,
    satisfied: false,
    state: 'unvetted',
    reason: 'missing-attestation',
    gateEnabled: true,
    metaRubricRef: 'meta-acceptance-rubric',
    currentRevision: 4,
    attestedRevision: null,
    attestedRevisions: [],
    attestationIssueId: null,
    consultId: null,
    workItemId: null,
    candidates: [],
    diagnosis: null,
    ...over,
  };
}

function deps(over: {
  rubrics?: Rubric[];
  vetting?: AcceptanceRubricVettingStatus;
  throws?: boolean;
} = {}): UnvettedRubricBindAdvisoryDeps & {
  getAcceptanceRubricsForPlan: ReturnType<typeof vi.fn>;
  readVettingStatus: ReturnType<typeof vi.fn>;
} {
  return {
    getAcceptanceRubricsForPlan: vi.fn(async () => {
      if (over.throws) throw new Error('pg unavailable');
      return over.rubrics ?? [RUBRIC];
    }),
    readVettingStatus: vi.fn(async () => over.vetting ?? status()),
  };
}

const BAR_SPECS = ['AUTO-BAR-R-1-P-001', 'AUTO-BAR-R-2-P-003'];

describe('barClauseSpecIds', () => {
  it('keeps only projected BAR clauses, de-duplicated in first-seen order', () => {
    expect(barClauseSpecIds(['P-001-spec', 'AUTO-BAR-R-2-P-003', undefined, 'AUTO-BAR-R-1-P-001', 'AUTO-BAR-R-2-P-003']))
      .toEqual(['AUTO-BAR-R-2-P-003', 'AUTO-BAR-R-1-P-001']);
  });
});

describe('unvettedRubricBindAdvisory (P-004: vet before proof)', () => {
  it('fires when BAR proof is bound to an unvetted rubric revision', async () => {
    const d = deps();
    const advisory = await unvettedRubricBindAdvisory(
      { planSlug: 'demo-plan', harnessSlug: 'papercusp', specIds: BAR_SPECS },
      d,
    );
    expect(advisory).toMatchObject({
      code: 'acceptance_rubric_unvetted_before_proof',
      rubricRef: 'acceptance-demo-plan',
      currentRevision: 4,
      vettingReason: 'missing-attestation',
      barSpecIds: BAR_SPECS,
      nextVerb: { name: 'rubrics:get', args: { rubricRef: 'acceptance-demo-plan' } },
    });
    // The message must say the binding WAS recorded (advisory, not a refusal), teach the
    // order, and name the vetting route with the policy key rather than a typed count.
    expect(advisory!.message).toMatch(/Proof was recorded/);
    expect(advisory!.message).toContain(VET_BEFORE_PROOF_ORDER);
    expect(advisory!.message).toContain("policy:'rubric-vetting'");
    expect(advisory!.message).toContain('meta-acceptance-rubric');
    expect(d.getAcceptanceRubricsForPlan).toHaveBeenCalledWith('demo-plan', { harnessSlug: 'papercusp' });
  });

  it('also fires on a STALE attestation (the rubric changed since it was vetted)', async () => {
    const advisory = await unvettedRubricBindAdvisory(
      { planSlug: 'demo-plan', specIds: BAR_SPECS },
      deps({ vetting: status({ reason: 'stale-attestation', attestedRevision: 3, attestedRevisions: [3] }) }),
    );
    expect(advisory?.vettingReason).toBe('stale-attestation');
  });

  it('is silent when the current revision is vetted', async () => {
    const vetted = status({ satisfied: true, state: 'vetted', reason: 'current', attestedRevision: 4 });
    expect(await unvettedRubricBindAdvisory({ planSlug: 'demo-plan', specIds: BAR_SPECS }, deps({ vetting: vetted })))
      .toBeNull();
  });

  it('is silent when vetting is not required (gate off, empty rubric, meta-rubric)', async () => {
    const off = status({ required: false, satisfied: true, state: 'disabled', reason: 'gate-disabled' });
    expect(await unvettedRubricBindAdvisory({ planSlug: 'demo-plan', specIds: BAR_SPECS }, deps({ vetting: off })))
      .toBeNull();
  });

  it('never reads the rubric store for non-BAR proof or an ad-hoc (plan-less) binding', async () => {
    const d = deps();
    expect(await unvettedRubricBindAdvisory({ planSlug: 'demo-plan', specIds: ['P-001-behaviour', undefined] }, d))
      .toBeNull();
    expect(await unvettedRubricBindAdvisory({ planSlug: undefined, specIds: BAR_SPECS }, d)).toBeNull();
    expect(d.getAcceptanceRubricsForPlan).not.toHaveBeenCalled();
  });

  it('is silent with zero or several live rubrics — ambiguity is the gate’s refusal, not this advisory’s', async () => {
    expect(await unvettedRubricBindAdvisory({ planSlug: 'p', specIds: BAR_SPECS }, deps({ rubrics: [] }))).toBeNull();
    expect(await unvettedRubricBindAdvisory({ planSlug: 'p', specIds: BAR_SPECS }, deps({ rubrics: [RUBRIC, RUBRIC] })))
      .toBeNull();
  });

  it('never throws — an unreadable store must not turn a written binding into an error', async () => {
    await expect(
      unvettedRubricBindAdvisory({ planSlug: 'p', specIds: BAR_SPECS }, deps({ throws: true })),
    ).resolves.toBeNull();
  });
});
