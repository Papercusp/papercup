import { describe, expect, it } from 'vitest';
import {
  claimHumanMarketJob, gradeHumanMarketJob, humanAssignee, publicHumanMarketOffer,
  readHumanMarketJob, recordHumanMarketPayment, submitHumanMarketJob,
  type HumanMarketJob,
} from './work-items-human-market';

const owner = '00000000-0000-4000-8000-000000000001';
const stranger = '00000000-0000-4000-8000-000000000002';
const other = '00000000-0000-4000-8000-000000000003';
const at = '2026-10-01T02:00:00Z';
const offer = (): HumanMarketJob => ({
  route: 'market', version: 0, brief: 'Review the public onboarding instructions.',
  ownerUserId: owner, rubricRef: 'onboarding-review@1', amountCents: 500, currency: 'USD',
});
const item = (job: unknown = offer(), state = 'needs-human', assignee: string | null = null) => ({
  id: 'WI-pilot', state, assignee, payload: { humanWork: job, internalSecret: 'never publish', needsOwnerAction: true },
});
const claimed = () => item(claimHumanMarketJob(item(), stranger, at), 'wip', humanAssignee(stranger));
const submitted = () => item(submitHumanMarketJob(claimed(), stranger, 'Reviewed instructions.', at), 'wip', humanAssignee(stranger));
const grade = (job: HumanMarketJob, passed = true) => ({
  scorecardRef: 'scorecard-1', rubricRef: job.rubricRef, graderId: 'unrelated-reviewer',
  submissionSha256: job.submission!.sha256, passed,
});
const payment = () => ({ receiptRef: 'manual-receipt-1', paidBy: owner, paidAt: at, amountCents: 500, currency: 'USD' });

describe('human market pilot work-item contract', () => {
  it('requires explicit complete opt-in and returns only the publishable brief and terms', () => {
    expect(readHumanMarketJob({ ...item(), payload: { needsHuman: true } })).toBeNull();
    expect(publicHumanMarketOffer(item({ route: 'market' }))).toBeNull();
    expect(publicHumanMarketOffer(item())).toEqual({
      id: 'WI-pilot', brief: offer().brief, rubricRef: offer().rubricRef,
      amountCents: 500, currency: 'USD', status: 'available',
    });
    for (const state of ['done', 'blocked', 'open']) expect(publicHumanMarketOffer(item(offer(), state))).toBeNull();
    expect(publicHumanMarketOffer(item(offer(), 'needs-human', 'su-worker'))).toBeNull();
  });

  it('rejects an owner, agent identity, competing claim and ordinary open work', () => {
    expect(() => claimHumanMarketJob(item(), owner, at)).toThrow('external_human_required');
    expect(() => claimHumanMarketJob(item(), 'su-agent', at)).toThrow();
    expect(() => claimHumanMarketJob(item(offer(), 'needs-human', 'su-worker'), stranger, at)).toThrow('claim_conflict');
    expect(() => claimHumanMarketJob(item(offer(), 'open'), stranger, at)).toThrow('needs_human_required');
    expect(() => claimHumanMarketJob(claimed(), other, at)).toThrow('human_claim_required');
    expect(claimHumanMarketJob(claimed(), stranger, at).version).toBe(1);
  });

  it('binds an immutable result to its claimant and hash', () => {
    expect(() => submitHumanMarketJob(item(), stranger, 'result', at)).toThrow('human_claim_required');
    expect(() => submitHumanMarketJob(claimed(), other, 'result', at)).toThrow('human_claim_required');
    expect(() => submitHumanMarketJob(claimed(), stranger, '   ', at)).toThrow();
    const row = submitted();
    expect(readHumanMarketJob(row)?.version).toBe(2);
    expect(submitHumanMarketJob(row, stranger, 'Reviewed instructions.', at).version).toBe(2);
    expect(() => submitHumanMarketJob(row, stranger, 'Changed after grading.', at)).toThrow('submission_already_recorded');
    const job = readHumanMarketJob(row)!;
    expect(readHumanMarketJob(item({ ...job, submission: { ...job.submission, result: 'tampered' } }))).toBeNull();
    const { claim: _claim, ...withoutClaim } = job;
    expect(readHumanMarketJob(item({ ...withoutClaim, grade: grade(job) }))).toBeNull();
  });

  it('requires an independent exact-submission rubric receipt', () => {
    const row = submitted();
    const receipt = grade(readHumanMarketJob(row)!);
    expect(() => gradeHumanMarketJob(claimed(), receipt)).toThrow('submission_required');
    for (const graderId of [stranger, humanAssignee(stranger)]) {
      expect(() => gradeHumanMarketJob(row, { ...receipt, graderId })).toThrow();
    }
    expect(() => gradeHumanMarketJob(row, { ...receipt, rubricRef: 'other-rubric' })).toThrow();
    expect(() => gradeHumanMarketJob(row, { ...receipt, submissionSha256: '0'.repeat(64) })).toThrow();
  });

  it('refuses payout before passing review, changed terms and duplicate receipt recording', () => {
    const row = submitted();
    const job = readHumanMarketJob(row)!;
    expect(() => recordHumanMarketPayment(row, payment())).toThrow('passing_grade_required');
    const rejected = item(gradeHumanMarketJob(row, grade(job, false)), 'wip', humanAssignee(stranger));
    expect(() => recordHumanMarketPayment(rejected, payment())).toThrow('passing_grade_required');
    const accepted = item(gradeHumanMarketJob(row, grade(job)), 'wip', humanAssignee(stranger));
    expect(() => recordHumanMarketPayment(accepted, { ...payment(), amountCents: 1 })).toThrow();
    expect(() => recordHumanMarketPayment(accepted, { ...payment(), currency: 'EUR' })).toThrow();
    expect(() => recordHumanMarketPayment(accepted, { ...payment(), paidBy: stranger })).toThrow();
    expect(() => recordHumanMarketPayment({ ...accepted, state: 'done' }, payment())).toThrow('market_job_not_active');
    const paid = item(recordHumanMarketPayment(accepted, payment()), 'wip', humanAssignee(stranger));
    expect(publicHumanMarketOffer(paid)?.status).toBe('paid');
    expect(() => recordHumanMarketPayment(paid, payment())).toThrow('payment_already_recorded');
    expect(() => gradeHumanMarketJob(accepted, grade(job))).toThrow('grade_already_recorded');
  });
});
