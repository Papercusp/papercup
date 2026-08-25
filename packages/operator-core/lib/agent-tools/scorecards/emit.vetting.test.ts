/**
 * emit.vetting.test.ts — the vetting stamp on scorecards:emit
 * (consult-min-max-and-rubric-vetting-2026-08-17 P-004).
 *
 * Unit-level, mirroring emit.provisional.test.ts: collaborators are mocked; the
 * subject is emitScorecard's vetting validation + stamping — a `vettingConsult`
 * arg must name a REAL consult and a REAL subject rubric before anything is
 * stamped (the acceptance gate trusts the stamp rather than re-querying, so a
 * dangling link refused here is a booby trap avoided there), and a re-emit that
 * only moves the vetting stamp is the re-vetting step, never an
 * 'unchanged-evidence' decline.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getRubric = vi.fn();
const getRubricPlanRevision = vi.fn();
const listScorecards = vi.fn();
const captureImprovement = vi.fn();
const readVettingConsultCritique = vi.fn();
const readVettingWorkItemCritique = vi.fn();

/** The critique verdict shape readVettingConsultCritique returns. */
const critique = (over: Record<string, unknown> = {}) => ({
  exists: true,
  state: 'active',
  critiquePosts: 2,
  declinePosts: 0,
  critics: ['su-reviewer'],
  ...over,
});

vi.mock('../../rubrics', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../rubrics')>();
  return {
    ...real,
    getRubric: (...a: unknown[]) => getRubric(...a),
    getRubricPlanRevision: (...a: unknown[]) => getRubricPlanRevision(...a),
  };
});
vi.mock('../../scorecards', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../scorecards')>();
  return { ...real, listScorecards: (...a: unknown[]) => listScorecards(...a) };
});
vi.mock('../../harness/improvements/capture-core', () => ({
  captureImprovement: (...a: unknown[]) => captureImprovement(...a),
}));
vi.mock('../../scout/generation-watermark', () => ({
  readRunningGeneration: async () => null,
}));
vi.mock('../../issues-engineer', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../issues-engineer')>();
  return { ...real, getIssue: async () => null };
});
vi.mock('../../consult/get-feedback-core', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../consult/get-feedback-core')>();
  return { ...real, readVettingConsultCritique: (...a: unknown[]) => readVettingConsultCritique(...a) };
});
vi.mock('../../work-items', () => ({
  readVettingWorkItemCritique: (...a: unknown[]) => readVettingWorkItemCritique(...a),
}));
vi.mock('../../workspace-registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../workspace-registry')>();
  return { ...real, activeWorkspaceId: () => 'ws-test' };
});
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const real = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...real, getOrgPg: () => ({ sql: {} }) };
});
// emit's push-on-write dynamic-imports sync-sse after a created card; the stub sql
// above cannot carry a real NOTIFY, so neutralize the bus rather than half-mock it.
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: () => {} }));

import { emitScorecard } from './emit';
import { scorecardEvidenceFingerprint } from '../../scorecards';
import type { ObservationRatings } from '../../harness/improvements/observation-types';

const META_RUBRIC = {
  rubricId: 'meta-acceptance-rubric',
  workspaceId: 'ws-test',
  kind: 'standard',
  characteristic: 'acceptance-rubric-quality',
  title: 'Meta: acceptance rubric quality',
  description: '',
  criteria: [
    { key: 'outcomes-not-diff-restatements', title: 'Outcomes', model: 'm', method: 'm', driftMarkers: 'd' },
    { key: 'falsifiable-with-evidence', title: 'Falsifiable', model: 'm', method: 'm', driftMarkers: 'd' },
  ],
  ratingScale: ['pass', 'weak', 'fail', 'not-applicable'],
  methodRef: null,
  // Deliberately 'proposed': the vetting flow must work BEFORE the owner ratifies
  // the meta-rubric's content (ratification governs content authority, not
  // mechanics) — a status filter sneaking in here would deadlock every ship on
  // the owner.
  status: 'proposed',
  createdBy: 'su-author',
  proposedBy: 'su-author',
  ratifiedBy: null,
  createdAt: '2026-08-17T00:00:00.000Z',
  updatedAt: '2026-08-17T00:00:00.000Z',
};

const ACCEPTANCE_RUBRIC = {
  ...META_RUBRIC,
  rubricId: 'ar-some-plan',
  kind: 'acceptance',
  subjectPlan: 'some-plan-2026-08-17',
  title: 'Acceptance: some plan',
  status: 'active',
};

const META_RATINGS: ObservationRatings = {
  'outcomes-not-diff-restatements': { rating: 'pass', evidence: 'every criterion names an outcome' },
  'falsifiable-with-evidence': { rating: 'pass', evidence: 'each check has a concrete probe' },
};

const EMIT_INPUT = { createdBy: 'su-author', ctxHarness: 'papercusp' };

/** The canonical vetting emit args — subject = the acceptance rubric. */
const vettingArgs = (over: Record<string, unknown> = {}) => ({
  rubricRef: 'meta-acceptance-rubric',
  ratings: META_RATINGS,
  subject: { kind: 'rubric' as const, ref: 'ar-some-plan' },
  vettingConsult: 'conv-vet-1',
  ...over,
});

const workItemVettingArgs = (over: Record<string, unknown> = {}) =>
  vettingArgs({ vettingConsult: undefined, vettingWorkItem: 'WI-review-1', ...over });

beforeEach(() => {
  getRubric.mockReset().mockImplementation(async (id: unknown) => {
    if (id === 'meta-acceptance-rubric') return META_RUBRIC;
    if (id === 'ar-some-plan') return ACCEPTANCE_RUBRIC;
    return null;
  });
  getRubricPlanRevision.mockReset().mockResolvedValue(7);
  listScorecards.mockReset().mockResolvedValue([]);
  captureImprovement.mockReset().mockResolvedValue({ created: true, issue: { id: 'EI-1' } });
  readVettingConsultCritique.mockReset().mockResolvedValue(critique());
  readVettingWorkItemCritique.mockReset().mockResolvedValue({
    exists: true,
    critiquePosts: 2,
    critics: ['su-reviewer'],
  });
});

describe('scorecards:emit vetting stamp (P-004)', () => {
  it('stamps observation.vetting { consultId, rubricRevision, critiquePosts, critics } + subject when the consult carries critique', async () => {
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(true);
    // The emitter is passed through so the core can exclude the emitter's OWN posts.
    expect(readVettingConsultCritique).toHaveBeenCalledWith({}, 'ws-test', 'conv-vet-1', 'su-author');
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: Record<string, unknown> };
    };
    expect(payload.payloadExtra.observation.vetting).toEqual({
      consultId: 'conv-vet-1',
      rubricRevision: 7,
      critiquePosts: 2,
      critics: ['su-reviewer'],
    });
    expect(payload.payloadExtra.observation.subject).toEqual({ kind: 'rubric', ref: 'ar-some-plan' });
  });

  it('stamps observation.vetting { workItemId, rubricRevision, critiquePosts, critics } when a work-item carries critique', async () => {
    const res = await emitScorecard(workItemVettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(true);
    expect(readVettingWorkItemCritique).toHaveBeenCalledWith('WI-review-1', ['su-author', 'su-author', 'su-author']);
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: Record<string, unknown> };
    };
    expect(payload.payloadExtra.observation.vetting).toEqual({
      workItemId: 'WI-review-1',
      rubricRevision: 7,
      critiquePosts: 2,
      critics: ['su-reviewer'],
    });
  });

  it('refuses a work-item link that does not resolve', async () => {
    readVettingWorkItemCritique.mockResolvedValue({ exists: false, critiquePosts: 0, critics: [] });
    const res = await emitScorecard(workItemVettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('WI-review-1');
    expect(res.error).toContain('not found');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses a work-item with no third-party critique rather than accepting an empty review', async () => {
    readVettingWorkItemCritique.mockResolvedValue({ exists: true, critiquePosts: 0, critics: [] });
    const res = await emitScorecard(workItemVettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('NO third-party critique');
    expect(res.error).toContain('vettingConsult + vettingUnanswered');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses passing both alternate vetting channels and refuses a work-item waiver', async () => {
    const both = await emitScorecard(workItemVettingArgs({ vettingConsult: 'conv-vet-1' }) as never, EMIT_INPUT);
    expect(both.ok).toBe(false);
    if (both.ok) throw new Error('expected refusal');
    expect(both.error).toContain('EXACTLY ONE');

    const waiver = await emitScorecard(workItemVettingArgs({ vettingUnanswered: true }) as never, EMIT_INPUT);
    expect(waiver.ok).toBe(false);
    if (waiver.ok) throw new Error('expected refusal');
    expect(waiver.error).toContain('consult-only');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses vettingConsult without a subject naming the vetted rubric', async () => {
    const res = await emitScorecard(vettingArgs({ subject: undefined }) as never, EMIT_INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('subject');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('teaches plan-subject acceptance authors to omit vetting linkage and cite the meta-scorecard', async () => {
    const res = await emitScorecard(
      vettingArgs({ subject: { kind: 'plan', ref: 'some-plan-2026-08-17' } }) as never,
      EMIT_INPUT,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('only valid on the META-RUBRIC scorecard');
    expect(res.error).toContain("subject:{ kind:'rubric'");
    expect(res.error).toContain('omit vettingConsult/vettingWorkItem');
    expect(res.error).toContain('cite the separately emitted meta-rubric scorecard');
    expect(getRubric).not.toHaveBeenCalledWith('some-plan-2026-08-17');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses a subject that does not resolve to a rubric (dangling link)', async () => {
    const res = await emitScorecard(
      vettingArgs({ subject: { kind: 'rubric', ref: 'no-such-rubric' } }) as never,
      EMIT_INPUT,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('no-such-rubric');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses a consult that has no consult_state row (dangling link)', async () => {
    readVettingConsultCritique.mockResolvedValue(
      critique({ exists: false, state: null, critiquePosts: 0, critics: [] }),
    );
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('conv-vet-1');
    expect(res.error).toContain('not found in consult_state');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('omits rubricRevision (never fabricates one) when the version read fails', async () => {
    getRubricPlanRevision.mockResolvedValue(null);
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(true);
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { vetting?: Record<string, unknown> } };
    };
    expect(payload.payloadExtra.observation.vetting).toEqual({
      consultId: 'conv-vet-1',
      critiquePosts: 2,
      critics: ['su-reviewer'],
    });
  });

  // ── EI-20821478338037350: the gate must require CRITIQUE, not a consult ROW ──

  it('REFUSES an existing consult that nobody has replied to — the vacuous-green hole', async () => {
    readVettingConsultCritique.mockResolvedValue(
      critique({ state: 'awaiting_responder', critiquePosts: 0, critics: [] }),
    );
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('NO critique');
    expect(res.error).toContain('nobody has replied yet');
    expect(res.error).toContain('awaiting_responder');
    // The refusal must name the waiver, or an author with no reviewer has no legal move.
    expect(res.error).toContain('vettingUnanswered');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('distinguishes "everyone declined" from "nobody replied" — the remedies differ', async () => {
    readVettingConsultCritique.mockResolvedValue(
      critique({ state: 'declined', critiquePosts: 0, declinePosts: 3, critics: [] }),
    );
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('DECLINED');
    expect(res.error).toContain('re-route');
    expect(res.error).not.toContain('nobody has replied yet');
  });

  it('accepts an EXPLICIT waiver and stamps it visibly (unanswered + reason) rather than passing silently', async () => {
    readVettingConsultCritique.mockResolvedValue(
      critique({ state: 'expired', critiquePosts: 0, critics: [] }),
    );
    const res = await emitScorecard(
      vettingArgs({
        vettingUnanswered: true,
        vettingUnansweredReason: 'all 3 routed reviewers ended; consult expired 19:54Z with 0 posts',
      }) as never,
      EMIT_INPUT,
    );
    expect(res.ok).toBe(true);
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { vetting?: Record<string, unknown> } };
    };
    expect(payload.payloadExtra.observation.vetting).toEqual({
      consultId: 'conv-vet-1',
      rubricRevision: 7,
      critiquePosts: 0,
      unanswered: true,
      unansweredReason: 'all 3 routed reviewers ended; consult expired 19:54Z with 0 posts',
    });
  });

  it('refuses a waiver with no reason — an unexplained waiver is the silent pass again', async () => {
    readVettingConsultCritique.mockResolvedValue(critique({ critiquePosts: 0, critics: [] }));
    const res = await emitScorecard(vettingArgs({ vettingUnanswered: true }) as never, EMIT_INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('vettingUnansweredReason');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses a waiver when the consult DID receive critique — it cannot be passed reflexively', async () => {
    const res = await emitScorecard(
      vettingArgs({
        vettingUnanswered: true,
        vettingUnansweredReason: 'claiming nobody replied even though two reviewers did',
      }) as never,
      EMIT_INPUT,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('DID receive critique');
    expect(res.error).toContain('su-reviewer');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('CONTROL (falsifiability): a consult with critique is NOT refused — the guard rejects absence, not everything', async () => {
    // Pins that the four refusals above fire on the no-critique condition itself.
    // Without this, a predicate hard-wired to `false` would pass every one of them.
    readVettingConsultCritique.mockResolvedValue(critique({ critiquePosts: 1, critics: ['su-x'] }));
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(true);
    expect(captureImprovement).toHaveBeenCalledTimes(1);
  });

  it('a re-emit that upgrades a WAIVED stamp to a real critiqued one is a vetting change, not unchanged-evidence', async () => {
    // Identical rubricRef + ratings + consult + revision: only `unanswered` moves.
    // Without unanswered in vettingChanged, the recorded waiver would be stuck forever.
    const fingerprint = scorecardEvidenceFingerprint({
      rubricRef: 'meta-acceptance-rubric',
      ratings: META_RATINGS,
    });
    listScorecards.mockResolvedValue([
      {
        issueId: 'EI-prior',
        createdAt: '2026-08-17T01:00:00Z',
        createdBy: 'su-author',
        rubricRef: 'meta-acceptance-rubric',
        ratings: META_RATINGS,
        nKeys: 2,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        evidenceFingerprint: fingerprint,
        synthesized: false,
        score10: 10,
        linkedItems: [],
        vetting: { consultId: 'conv-vet-1', rubricRevision: 7, critiquePosts: 0, unanswered: true },
      },
    ]);
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect((res as { reason?: string }).reason).not.toBe('unchanged-evidence');
    expect(captureImprovement).toHaveBeenCalledTimes(1);
  });

  it('a re-emit that only moves the vetting stamp to a NEW revision is the re-vetting step, not unchanged-evidence', async () => {
    // Same rubricRef + ratings ⇒ identical fingerprint; the ONLY difference is the
    // stamped revision (the author improved the rubric after the prior vetting).
    const fingerprint = scorecardEvidenceFingerprint({
      rubricRef: 'meta-acceptance-rubric',
      ratings: META_RATINGS,
    });
    listScorecards.mockResolvedValue([
      {
        issueId: 'EI-prior',
        createdAt: '2026-08-17T01:00:00Z',
        createdBy: 'su-author',
        rubricRef: 'meta-acceptance-rubric',
        ratings: META_RATINGS,
        nKeys: 2,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        evidenceFingerprint: fingerprint,
        synthesized: false,
        score10: 10,
        linkedItems: [],
        vetting: { consultId: 'conv-vet-1', rubricRevision: 6 },
      },
    ]);
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT); // revision now 7
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect('reason' in res && (res as { reason?: string }).reason).not.toBe('unchanged-evidence');
    expect(captureImprovement).toHaveBeenCalledTimes(1);
  });

  it('CONTROL (falsifiability): the identical re-emit WITHOUT a vetting delta is still declined by fingerprint', async () => {
    // The inverse of the case above — proving the vettingChanged escape hatch did not
    // silently disable the unchanged-evidence dedupe for ordinary re-emits.
    const fingerprint = scorecardEvidenceFingerprint({
      rubricRef: 'meta-acceptance-rubric',
      ratings: META_RATINGS,
    });
    listScorecards.mockResolvedValue([
      {
        issueId: 'EI-prior',
        createdAt: '2026-08-17T01:00:00Z',
        createdBy: 'su-author',
        rubricRef: 'meta-acceptance-rubric',
        ratings: META_RATINGS,
        nKeys: 2,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        evidenceFingerprint: fingerprint,
        synthesized: false,
        score10: 10,
        linkedItems: [],
        vetting: { consultId: 'conv-vet-1', rubricRevision: 7 }, // SAME consult + revision
      },
    ]);
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect((res as { reason?: string }).reason).toBe('unchanged-evidence');
    expect(captureImprovement).not.toHaveBeenCalled();
  });
});
