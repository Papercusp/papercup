import { describe, expect, it } from 'vitest';
import { makeGaiaGrader } from './gaia-official';
import { qaSubmission, type ArmAttempt, type ArmSubmission, type BenchTask } from '../types';

const task = (id: string, gold: string, level = 3): BenchTask => ({
  benchmark: 'gaia',
  instanceId: id,
  problemStatement: `question ${id}`,
  graderMeta: { finalAnswer: gold, level },
});

const qa = (id: string, answer: string): ArmSubmission => ({ modality: 'qa', instanceId: id, answer, prefix: 'seed-0' });

describe('gaia-official — makeGaiaGrader', () => {
  const grader = makeGaiaGrader({ version: 'gaia-test' });

  it('is registered as family gaia / modality qa', () => {
    expect(grader.family).toBe('gaia');
    expect(grader.modality).toBe('qa');
  });

  it('grades a bare answer with the quasi-exact-match scorer', async () => {
    const [g] = await grader.grade([qa('t1', 'Paris')], [task('t1', 'Paris')]);
    expect(g.resolved).toBe(true);
    expect(g.graderFamily).toBe('gaia');
  });

  it('extracts FINAL ANSWER from a full message answer.txt', async () => {
    const [g] = await grader.grade([qa('t1', 'reasoning...\nFINAL ANSWER: 42')], [task('t1', '42')]);
    expect(g.resolved).toBe(true);
  });

  it('marks a wrong answer unresolved', async () => {
    const [g] = await grader.grade([qa('t1', 'London')], [task('t1', 'Paris')]);
    expect(g.resolved).toBe(false);
  });

  it('errors (not silent fail) when the gold answer is missing', async () => {
    const [g] = await grader.grade([qa('t1', 'x')], [task('t1', '')]);
    expect(g.resolved).toBe(false);
    expect(g.graderError).toMatch(/gold answer/i);
  });

  it('ignores non-qa submissions (arm-agnostic filter)', async () => {
    const diff: ArmSubmission = { modality: 'diff', instanceId: 't1', patch: 'x', prefix: 's' };
    expect(await grader.grade([diff], [task('t1', 'Paris')])).toEqual([]);
  });

  it('qaSubmission builds a qa record from an ArmAttempt.answer', () => {
    const attempt = { instanceId: 't1', seed: 'seed-2', answer: 'Mercury', diff: '' } as ArmAttempt;
    expect(qaSubmission(attempt)).toEqual({ modality: 'qa', instanceId: 't1', answer: 'Mercury', prefix: 'seed-2' });
  });
});
