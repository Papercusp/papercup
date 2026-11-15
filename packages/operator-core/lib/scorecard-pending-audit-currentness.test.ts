import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// EI-28807501130212029: listScorecards rows carry no read-time auditTarget, so the
// pending-audit gate's evidence-binding half must come from the recipe-header read.
const readScorecardRecipeHeader = vi.fn();
vi.mock('./scorecards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./scorecards')>()),
  readScorecardRecipeHeader: (...args: unknown[]) => readScorecardRecipeHeader(...args),
}));

import {
  isListedPendingSubjectBlocker,
  scorecardCitesSpecEvidenceBindings,
  withoutStaleAuditTargetPendingCards,
} from './scorecard-pending-audit-currentness';
import type { ScorecardRow } from './scorecards';

const SUBJECT = { kind: 'plan', ref: 'spec-test-adequacy:demo-plan:SPEC-1:r1' };

function card(issueId: string, overrides: Record<string, unknown> = {}): ScorecardRow {
  return {
    issueId,
    rubricRef: 'spec-test-adequacy',
    subject: SUBJECT,
    gradingAudit: { state: 'pending', metaRubricRef: 'grading-integrity' },
    supersededBy: undefined,
    ...overrides,
  } as unknown as ScorecardRow;
}

const citingBindings = (issueId: string, selection: Record<string, unknown> = { bindingIds: [11, 12] }, args = {}) =>
  card(issueId, { rerunRecipe: { evaluator: 'plans:evaluate-spec-test-adequacy', selection, args } });

const header = (issueId: string, current: boolean | null) => ({
  kind: 'found' as const,
  scorecard: { issueId, auditTarget: { current, superseded: false, supersededBy: null, retracted: false, subjectRubricCurrentness: null } },
});

beforeEach(() => {
  readScorecardRecipeHeader.mockReset();
  readScorecardRecipeHeader.mockResolvedValue({ kind: 'not_found' });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('scorecardCitesSpecEvidenceBindings', () => {
  it('is true only for a spec-test-adequacy recipe that pins binding ids or legacy args.current tuples', () => {
    expect(scorecardCitesSpecEvidenceBindings(citingBindings('A'))).toBe(true);
    expect(scorecardCitesSpecEvidenceBindings(citingBindings('B', {}, { current: [{ id: 1 }] }))).toBe(true);
    expect(scorecardCitesSpecEvidenceBindings(citingBindings('C', { bindingIds: [] }, { current: [] }))).toBe(false);
    expect(scorecardCitesSpecEvidenceBindings(card('D', {
      rerunRecipe: { evaluator: 'something-else', selection: { bindingIds: [1] }, args: {} },
    }))).toBe(false);
    expect(scorecardCitesSpecEvidenceBindings(card('E'))).toBe(false);
  });
});

describe('isListedPendingSubjectBlocker', () => {
  it('accepts a pending, current, unretracted, unsuperseded card for exactly this subject', () => {
    expect(isListedPendingSubjectBlocker(card('A'), SUBJECT)).toBe(true);
  });

  it.each([
    ['a settled audit', { gradingAudit: { state: 'passed' } }],
    ['no audit stamp', { gradingAudit: undefined }],
    ['a stale graded rubric', { rubricCurrentness: { state: 'stale' } }],
    ['a stale subject rubric', { subjectRubricCurrentness: { state: 'stale' } }],
    ['a retraction', { retracted: { at: '2026-11-15T00:00:00Z' } }],
    ['a superseder', { supersededBy: 'EI-newer' }],
    ['another subject ref', { subject: { kind: 'plan', ref: 'other' } }],
    ['another subject kind', { subject: { kind: 'rubric', ref: SUBJECT.ref } }],
  ])('rejects a card with %s', (_label, overrides) => {
    expect(isListedPendingSubjectBlocker(card('A', overrides), SUBJECT)).toBe(false);
  });

  it('treats an absent subject kind as matching only an absent kind', () => {
    const bare = { ref: SUBJECT.ref };
    expect(isListedPendingSubjectBlocker(card('A', { subject: bare }), bare)).toBe(true);
    expect(isListedPendingSubjectBlocker(card('A', { subject: bare }), SUBJECT)).toBe(false);
  });
});

describe('withoutStaleAuditTargetPendingCards', () => {
  it('drops a binding-citing card only when its header reports auditTarget.current === false', async () => {
    readScorecardRecipeHeader.mockImplementation(async (issueId: string) => header(issueId, false));

    await expect(withoutStaleAuditTargetPendingCards([citingBindings('EI-stale')])).resolves.toEqual([]);
    expect(readScorecardRecipeHeader).toHaveBeenCalledWith('EI-stale');
  });

  it('never reads, and always keeps, a card that cites no evidence bindings', async () => {
    const plain = card('EI-plain');
    await expect(withoutStaleAuditTargetPendingCards([plain])).resolves.toEqual([plain]);
    expect(readScorecardRecipeHeader).not.toHaveBeenCalled();
  });

  it.each([
    ['current', async (id: string) => header(id, true)],
    ['unknown (null) currentness', async (id: string) => header(id, null)],
    ['a missing card', async () => ({ kind: 'not_found' })],
    ['a non-scorecard row', async () => ({ kind: 'not_scorecard' })],
    ['a header for a different issue', async () => header('EI-someone-else', false)],
  ])('fails closed and keeps the card for %s', async (_label, impl) => {
    readScorecardRecipeHeader.mockImplementation(impl);
    const pending = citingBindings('EI-pending');
    await expect(withoutStaleAuditTargetPendingCards([pending])).resolves.toEqual([pending]);
  });

  it('keeps the card and warns when the header read throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readScorecardRecipeHeader.mockRejectedValue(new Error('statement timeout'));
    const pending = citingBindings('EI-pending');

    await expect(withoutStaleAuditTargetPendingCards([pending])).resolves.toEqual([pending]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EI-pending'), 'statement timeout');
  });

  it('preserves input order across more cards than the read concurrency width', async () => {
    const stale = new Set(['EI-1', 'EI-4', 'EI-8']);
    readScorecardRecipeHeader.mockImplementation(async (issueId: string) => {
      await new Promise((resolve) => setTimeout(resolve, issueId === 'EI-1' ? 5 : 0));
      return header(issueId, stale.has(issueId) ? false : true);
    });
    const cards = Array.from({ length: 9 }, (_, i) => (i % 3 === 2 ? card(`EI-${i}`) : citingBindings(`EI-${i}`)));

    const kept = await withoutStaleAuditTargetPendingCards(cards);

    // EI-8 is in the stale set but cites no bindings, so it is never read and stays.
    expect(kept.map((c) => c.issueId)).toEqual(['EI-0', 'EI-2', 'EI-3', 'EI-5', 'EI-6', 'EI-7', 'EI-8']);
    expect(readScorecardRecipeHeader).toHaveBeenCalledTimes(6);
  });
});
