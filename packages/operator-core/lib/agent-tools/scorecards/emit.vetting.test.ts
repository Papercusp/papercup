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
const consultStateExists = vi.fn();

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
  return { ...real, consultStateExists: (...a: unknown[]) => consultStateExists(...a) };
});
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

beforeEach(() => {
  getRubric.mockReset().mockImplementation(async (id: unknown) => {
    if (id === 'meta-acceptance-rubric') return META_RUBRIC;
    if (id === 'ar-some-plan') return ACCEPTANCE_RUBRIC;
    return null;
  });
  getRubricPlanRevision.mockReset().mockResolvedValue(7);
  listScorecards.mockReset().mockResolvedValue([]);
  captureImprovement.mockReset().mockResolvedValue({ created: true, issue: { id: 'EI-1' } });
  consultStateExists.mockReset().mockResolvedValue(true);
});

describe('scorecards:emit vetting stamp (P-004)', () => {
  it('stamps observation.vetting { consultId, rubricRevision } + subject when consult and rubric both exist', async () => {
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(true);
    expect(consultStateExists).toHaveBeenCalledWith({}, 'ws-test', 'conv-vet-1');
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: Record<string, unknown> };
    };
    expect(payload.payloadExtra.observation.vetting).toEqual({ consultId: 'conv-vet-1', rubricRevision: 7 });
    expect(payload.payloadExtra.observation.subject).toEqual({ kind: 'rubric', ref: 'ar-some-plan' });
  });

  it('refuses vettingConsult without a subject naming the vetted rubric', async () => {
    const res = await emitScorecard(vettingArgs({ subject: undefined }) as never, EMIT_INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('subject');
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
    consultStateExists.mockResolvedValue(false);
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('conv-vet-1');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('omits rubricRevision (never fabricates one) when the version read fails', async () => {
    getRubricPlanRevision.mockResolvedValue(null);
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(true);
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { vetting?: Record<string, unknown> } };
    };
    expect(payload.payloadExtra.observation.vetting).toEqual({ consultId: 'conv-vet-1' });
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
