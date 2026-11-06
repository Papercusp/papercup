import { describe, expect, it, vi } from 'vitest';

const behaviorContractResolver = vi.fn(async () => ({ groups: [], enforceable: [] }));

vi.mock('./plan-decisions-claim-port', () => ({
  getClaimTimePlanDecisions: vi.fn(async () => null),
  renderPlanDecisionsNote: vi.fn(),
}));
vi.mock('./prior-attempt-context', () => ({
  getClaimTimePriorAttemptBrief: vi.fn(async () => null),
}));
vi.mock('./premises-claim-port', () => ({
  getClaimTimePremises: vi.fn(async () => null),
}));
vi.mock('./agent-tools/work_items/retraction-advisory', () => ({
  getClaimTimeRetractionAdvisory: vi.fn(async () => null),
}));
vi.mock('./work-item-prior-work', () => ({
  getClaimTimeAuthorshipRevalidationHint: vi.fn(async () => null),
  authorshipRevalidationWarning: vi.fn(() => null),
}));
vi.mock('./work-item-plan-contradiction', () => ({
  getClaimTimePlanItemContradiction: vi.fn(async () => null),
  planItemContradictionWarning: vi.fn(() => null),
}));
vi.mock('./agent-tools/plans/behavior-contract-resolver', () => ({
  resolveWorkItemBehaviorContract: behaviorContractResolver,
}));
// EI-19418245218824265. Unlike the row-reading legs — which return null here because
// the fixture row is empty — this one reads the TREE, so it answers from repo content
// no fixture controls. Unmocked it runs a real `git grep` for the synthetic id, and
// `WI-1` is a SUBSTRING of every real `WI-1234`/`WI-19418…` in the tree, so it returns
// hundreds of chars of unrelated hits and the "every leg is empty" premise below is
// silently false. Mocked for the same reason as the seven above; the port's own
// behaviour is tested against injected deps in `source-citation-claim-port.test.ts`.
vi.mock('./source-citation-claim-port', () => ({
  getClaimTimeSourceCitation: vi.fn(async () => null),
  sourceCitationWarning: vi.fn(() => null),
}));
vi.mock('./stale-path-hints-claim-port', () => ({
  getClaimTimeStalePathAdvisory: vi.fn(async () => ({
    stalePathRefs: ['apps/operator/app/_components/LeftSidebar.tsx'],
    stalePathRefsNote: 'advisory stale path refs',
  })),
}));

import { buildClaimTimeEnrichment } from './claim-time-enrichment';

it('passes direct plan-item scope into governing-decision delivery before a work-item exists', async () => {
  const ports = await import('./plan-decisions-claim-port');
  await buildClaimTimeEnrichment({ planSlug: 'task-plan', planItemId: 'P-018' });
  expect(ports.getClaimTimePlanDecisions).toHaveBeenLastCalledWith(expect.objectContaining({
    planSlug: 'task-plan', planItemIds: ['P-018'],
  }));
});

describe('buildClaimTimeEnrichment behavior-contract leg', () => {
  it('does not call the resolver when a partial subject has no work-item id', async () => {
    const enrichment = await buildClaimTimeEnrichment({
      workItem: { harness: 'papercusp', payload: null },
    });

    // The CONTEXT is empty — unchanged, and still the point of this test.
    const { enrichmentDelivery, ...context } = enrichment;
    expect(context).toEqual({});

    expect(behaviorContractResolver).not.toHaveBeenCalled();

    // ...but "empty" is no longer indistinguishable from "broken" (P-013): the delivery
    // record states WHY nothing came back. Asserted here rather than in the new suite
    // below because this is the exact call that used to render as a bare `{}`.
    expect(enrichmentDelivery.delivered).toEqual([]);
    expect(enrichmentDelivery.failed).toEqual([]);
    expect(enrichmentDelivery.omitted.find((o) => o.leg === 'behaviorContract')?.reason).toBe('skipped-no-input');
  });
});

describe('buildClaimTimeEnrichment stalePathRefs leg (EI-20049758099997696)', () => {
  it('carries title/summary refs through the shared claim-time enrichment', async () => {
    const enrichment = await buildClaimTimeEnrichment({
      workItem: {
        id: 'WI-stale-ref',
        title: 'Remove the old sidebar',
        summary: 'The old path is apps/operator/app/_components/LeftSidebar.tsx',
        payload: null,
      },
    });
    expect(enrichment.stalePathRefs).toEqual(['apps/operator/app/_components/LeftSidebar.tsx']);
    expect(enrichment.stalePathRefsNote).toBe('advisory stale path refs');
    expect(enrichment.enrichmentDelivery.delivered).toContain('pathHints');
  });
});

/**
 * P-013 instrumentation — the claim-context delivery record.
 *
 * These tests exist because the three situations below used to be ONE value (`null`),
 * and the middle one — a leg that THREW — is the only one that means something is
 * broken. A claimant handed less context than the system believes it hands out had no
 * way to know, and neither did anyone else.
 */
describe('buildClaimTimeEnrichment — delivery record (P-013)', () => {
  it('distinguishes a leg that THREW from one that was skipped and one that found nothing', async () => {
    const ports = await import('./plan-decisions-claim-port');
    // A leg that breaks — the case that was previously indistinguishable from silence.
    vi.mocked(ports.getClaimTimePlanDecisions).mockRejectedValueOnce(new Error('read failed'));

    const enrichment = await buildClaimTimeEnrichment({
      workItem: { id: 'WI-1', harness: 'papercusp', payload: null },
      planSlug: 'some-plan',
    });

    // FAILED: ran against real inputs and threw.
    expect(enrichment.enrichmentDelivery.failed).toEqual(['planDecisions']);
    expect(enrichment.enrichmentDelivery.omitted.find((o) => o.leg === 'planDecisions')?.reason).toBe('failed');

    // EMPTY: ran against real inputs and legitimately found nothing. Same null, and it
    // must NOT be reported as a failure — over-reporting would make the signal useless.
    expect(enrichment.enrichmentDelivery.omitted.find((o) => o.leg === 'premises')?.reason).toBe('empty');

    // SKIPPED: this surface had no payload for the leg to read.
    expect(enrichment.enrichmentDelivery.omitted.find((o) => o.leg === 'pathHints')?.reason).toBe('skipped-no-input');
  });

  it('a broken leg still degrades the claim rather than failing it', async () => {
    const ports = await import('./plan-decisions-claim-port');
    vi.mocked(ports.getClaimTimePlanDecisions).mockRejectedValueOnce(new Error('read failed'));

    // The pre-existing resilience contract, re-asserted because the refactor moved every
    // catch. One broken guard must never take down a claim — recording the reason is an
    // addition to that behaviour, never a relaxation of it.
    await expect(
      buildClaimTimeEnrichment({ workItem: { id: 'WI-1', harness: 'papercusp', payload: null }, planSlug: 'p' }),
    ).resolves.toBeTruthy();
  });

  it('carries an actionable recovery pointer ONLY when a leg actually failed', async () => {
    const healthy = await buildClaimTimeEnrichment({
      workItem: { id: 'WI-1', harness: 'papercusp', payload: null },
    });
    // No failures ⇒ no pointer. A permanently-present pointer is noise that trains
    // readers to skip the field on the one claim where it matters.
    expect(healthy.enrichmentDelivery.recover).toBeUndefined();

    const ports = await import('./plan-decisions-claim-port');
    vi.mocked(ports.getClaimTimePlanDecisions).mockRejectedValueOnce(new Error('read failed'));
    const degraded = await buildClaimTimeEnrichment({
      workItem: { id: 'WI-1', harness: 'papercusp', payload: null },
      planSlug: 'p',
    });
    expect(degraded.enrichmentDelivery.recover).toContain('planDecisions');
    // It must say the context is MISSING, not absent — the distinction a claimant acts on.
    expect(degraded.enrichmentDelivery.recover).toMatch(/UNVERIFIED/);
  });

  it('accounts for EVERY registered leg, so a registered-but-unattached leg cannot vanish', async () => {
    const { CLAIM_TIME_ENRICHMENT_LEGS } = await import('./claim-time-enrichment');
    const enrichment = await buildClaimTimeEnrichment({
      workItem: { id: 'WI-1', harness: 'papercusp', payload: null },
    });

    const seen = [
      ...enrichment.enrichmentDelivery.delivered,
      ...enrichment.enrichmentDelivery.omitted.map((o) => o.leg),
    ].sort();
    // The census iterates the REGISTRY, not the outcomes it happened to collect — a leg
    // added to the registry but never wired would otherwise be missing from both lists,
    // and a delivery record that cannot report a missing leg has no purpose.
    expect(seen).toEqual([...CLAIM_TIME_ENRICHMENT_LEGS].sort());
  });

  it('measures the context size WITHOUT counting the delivery record itself', async () => {
    const enrichment = await buildClaimTimeEnrichment({
      workItem: { id: 'WI-1', harness: 'papercusp', payload: null },
    });

    // Every leg is empty here, so the context is `{}` — two characters. Counting the
    // record itself would report a size no consumer of the context actually pays, and
    // would drift whenever this record's own shape changed.
    expect(enrichment.enrichmentDelivery.serializedChars).toBe(2);
  });
});
