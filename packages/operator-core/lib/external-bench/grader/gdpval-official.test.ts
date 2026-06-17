import { describe, expect, it } from 'vitest';
import { makeGdpvalGrader } from './gdpval-official';
import { deliverableSubmission, type ArmAttempt, type ArmSubmission, type BenchTask } from '../types';
import type { JudgeFn } from './gdpval';

const task = (id: string, refText: string): BenchTask => ({
  benchmark: 'gdpval',
  instanceId: id,
  problemStatement: `produce a deliverable for ${id}`,
  graderMeta: { occupation: 'Lawyers', sector: 'Legal', rubric: 'clarity', referenceDeliverableText: refText },
});

const sub = (id: string, deliverable: string): ArmSubmission => ({ modality: 'deliverable-bundle', instanceId: id, deliverable, prefix: 'seed-0' });

// Judge: prefers whichever side text contains 'GOOD'.
const judge: JudgeFn = async (req) => (req.deliverableA.includes('GOOD') ? 'WINNER: A' : req.deliverableB.includes('GOOD') ? 'WINNER: B' : 'WINNER: TIE');

describe('gdpval-official — makeGdpvalGrader', () => {
  const grader = makeGdpvalGrader({ version: 'gdpval-test', judge });

  it('is registered as family gdpval / modality deliverable-bundle', () => {
    expect(grader.family).toBe('gdpval');
    expect(grader.modality).toBe('deliverable-bundle');
  });

  it('resolved=true (win-or-tie) when the model deliverable beats the reference', async () => {
    const [g] = await grader.grade([sub('t1', 'GOOD model work')], [task('t1', 'weak reference')]);
    expect(g.resolved).toBe(true); // win
    expect(g.score).toBe(1);
    expect(g.graderFamily).toBe('gdpval');
  });

  it('resolved=false (loss) when the reference is better', async () => {
    const [g] = await grader.grade([sub('t2', 'weak model work')], [task('t2', 'GOOD reference')]);
    expect(g.resolved).toBe(false);
    expect(g.score).toBe(0);
  });

  it('resolved=true on a tie (win-or-tie)', async () => {
    const [g] = await grader.grade([sub('t3', 'plain model')], [task('t3', 'plain reference')]);
    expect(g.resolved).toBe(true); // tie counts as win-or-tie
    expect(g.score).toBe(0.5);
  });

  it('errors (not silent loss) when the reference deliverable text is unresolved', async () => {
    const t: BenchTask = { ...task('t4', ''), graderMeta: { occupation: 'x', sector: 'y', rubric: 'z' } };
    const [g] = await grader.grade([sub('t4', 'anything')], [t]);
    expect(g.resolved).toBe(false);
    expect(g.score).toBeNull();
    expect(g.graderError).toMatch(/reference deliverable/i);
  });

  it('ignores non-deliverable-bundle submissions', async () => {
    const qa: ArmSubmission = { modality: 'qa', instanceId: 't1', answer: 'x', prefix: 's' };
    expect(await grader.grade([qa], [task('t1', 'ref')])).toEqual([]);
  });

  it('deliverableSubmission builds a deliverable-bundle record from ArmAttempt.answer', () => {
    const attempt = { instanceId: 't1', seed: 'seed-2', answer: 'my deliverable', diff: '' } as ArmAttempt;
    expect(deliverableSubmission(attempt)).toEqual({ modality: 'deliverable-bundle', instanceId: 't1', deliverable: 'my deliverable', prefix: 'seed-2' });
  });
});
