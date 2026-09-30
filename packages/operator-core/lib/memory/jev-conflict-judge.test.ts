import { describe, expect, it, vi } from 'vitest';

import type { DecisionClient, DecisionOutcome, QuestionMap } from '@papercusp/decision-model';

import { checkConflicts } from './conflict-check';
import {
  CONFLICT_OPTIONS,
  JEV_CONFLICT_CONSUMER,
  JEV_CONFLICT_LABELS,
  JEV_CONFLICT_MIN_P,
  JEV_CONFLICT_TIMEOUT_MS,
  JevConflictInconclusiveError,
  buildConflictRequest,
  conflictSummary,
  conflictVerdicts,
  createJevConflictJudge,
  isConflictVerdict,
  judgeConflictsWithJev,
  type JevConflictLabel,
} from './jev-conflict-judge';

const NEW = 'We store new durable state in MySQL.';
const NEIGHBOURS = [
  { id: 'mem-pg', text: 'New durable state goes in Postgres unless a file is required.' },
  { id: 'mem-terse', text: 'Avi prefers terse status reports.' },
];

type Probs = Record<JevConflictLabel, number>;

function probs(p: Partial<Probs>): Probs {
  return { contradicts: 0, duplicates: 0, refines: 0, unrelated: 0, ...p };
}

function choice(p: Probs) {
  const top = (Object.entries(p) as [JevConflictLabel, number][]).sort((a, b) => b[1] - a[1])[0][0];
  return { type: 'choice', choice: top, probabilities: p, confidence: 0.5 };
}

function answered(answers: Record<string, unknown>, model = 'jev-1.13.0'): DecisionOutcome<QuestionMap> {
  return { kind: 'answered', model, answers, usage: { inputTokens: 90, outputTokens: 0 }, latencyMs: 120, attempts: 1 } as unknown as DecisionOutcome<QuestionMap>;
}

type DecideFn = (
  request: { readonly state: unknown; readonly questions: Readonly<Record<string, unknown>> },
  options?: { readonly consumer?: string; readonly timeoutMs?: number; readonly subjectIds?: readonly string[] },
) => Promise<DecisionOutcome<QuestionMap>>;

function fakeClient(decide: DecideFn) {
  const decideSpy = vi.fn(decide);
  const client = vi.fn(() => ({ decide: decideSpy }) as unknown as DecisionClient);
  return { client, decideSpy };
}

describe('buildConflictRequest', () => {
  it('puts only the new memory in state and one four-way choice per neighbour, carrying its text', () => {
    const { request, questionIds } = buildConflictRequest(NEW, NEIGHBOURS);
    expect(questionIds).toEqual(['n1', 'n2']);
    expect(request.state).toEqual({ new_memory: NEW });
    const q1 = request.questions.n1 as { type: string; instructions: string; options: Record<string, string> };
    expect(q1.type).toBe('choice');
    expect(q1.instructions).toContain(NEIGHBOURS[0].text);
    expect(q1.instructions).not.toContain(NEIGHBOURS[1].text);
    expect(Object.keys(q1.options)).toEqual([...JEV_CONFLICT_LABELS]);
    expect(q1.options).toBe(CONFLICT_OPTIONS);
  });

  it('refuses an empty neighbour list rather than sending an empty request', () => {
    expect(() => buildConflictRequest(NEW, [])).toThrow(/no neighbours/);
  });
});

describe('conflictVerdicts', () => {
  it('returns one verdict per question, index-aligned, with every label probability', () => {
    const r = conflictVerdicts(
      answered({ n1: choice(probs({ contradicts: 0.8, refines: 0.2 })), n2: choice(probs({ unrelated: 0.9, refines: 0.1 })) }),
      ['n1', 'n2'],
    );
    if ('failure' in r) throw new Error(r.failure);
    expect(r.model).toBe('jev-1.13.0');
    expect(r.verdicts.map((v) => v.label)).toEqual(['contradicts', 'unrelated']);
    expect(r.verdicts[0].pContradicts).toBe(0.8);
    expect(r.verdicts[1].p).toBe(0.9);
  });

  it('passes an inconclusive reason through', () => {
    const r = conflictVerdicts({ kind: 'inconclusive', reason: 'timeout', latencyMs: 3000, attempts: 1 }, ['n1']);
    expect(r).toEqual({ failure: 'timeout' });
  });

  it.each([
    ['a missing answer', {}],
    ['a yes/no answer', { n1: { type: 'yesNo', pYes: 0.9 } }],
    ['an unknown label', { n1: { type: 'choice', choice: 'conflicts', probabilities: probs({ contradicts: 1 }) } }],
    ['a missing label probability', { n1: { type: 'choice', choice: 'contradicts', probabilities: { contradicts: 1 } } }],
  ])('treats %s as malformed, never as a partial list', (_name, answers) => {
    expect(conflictVerdicts(answered(answers), ['n1'])).toEqual({ failure: 'malformed-response' });
  });
});

describe('isConflictVerdict — the D-015 threshold', () => {
  const v = (pContradicts: number) => ({ label: 'contradicts' as const, p: pContradicts, pContradicts, probabilities: probs({ contradicts: pContradicts }) });
  it('flags at exactly the threshold and above, not below', () => {
    expect(JEV_CONFLICT_MIN_P).toBe(0.5);
    expect(isConflictVerdict(v(0.5))).toBe(true);
    expect(isConflictVerdict(v(0.93))).toBe(true);
    expect(isConflictVerdict(v(0.49))).toBe(false);
  });
});

describe('conflictSummary', () => {
  it('is deterministic text built from label, probability and model', () => {
    expect(conflictSummary('contradicts', 0.834, 'jev-1.13.0')).toBe(
      'jev-1.13.0 judged that the new memory contradicts this memory (P=0.83).',
    );
    expect(conflictSummary('unrelated', 0.5, 'jev-1.14.0')).toBe('jev-1.14.0 judged that the new memory is unrelated to this memory (P=0.50).');
    expect(conflictSummary('contradicts', 0.834, 'jev-1.13.0')).toBe(conflictSummary('contradicts', 0.834, 'jev-1.13.0'));
  });
});

describe('judgeConflictsWithJev', () => {
  it('sends ONE request labelled memory-conflict with the write deadline and neighbour ids', async () => {
    const f = fakeClient(async () => answered({ n1: choice(probs({ contradicts: 0.7, refines: 0.3 })), n2: choice(probs({ unrelated: 1 })) }));
    const r = await judgeConflictsWithJev({ newText: NEW, neighbors: NEIGHBOURS }, { client: f.client });
    expect(f.decideSpy).toHaveBeenCalledTimes(1);
    expect(f.decideSpy.mock.calls[0][1]).toEqual({ consumer: JEV_CONFLICT_CONSUMER, timeoutMs: JEV_CONFLICT_TIMEOUT_MS, subjectIds: ['mem-pg', 'mem-terse'] });
    expect(r.verdicts.map((v) => v?.label)).toEqual(['contradicts', 'unrelated']);
  });

  it('skips empty-text neighbours but keeps the result aligned with the caller list', async () => {
    const f = fakeClient(async (req) => {
      expect(Object.keys(req.questions)).toEqual(['n1']);
      return answered({ n1: choice(probs({ duplicates: 1 })) });
    });
    const r = await judgeConflictsWithJev(
      { newText: NEW, neighbors: [{ id: 'blank', text: '  ' }, NEIGHBOURS[0]] },
      { client: f.client },
    );
    expect(r.verdicts[0]).toBeNull();
    expect(r.verdicts[1]?.label).toBe('duplicates');
    expect(f.decideSpy.mock.calls[0][1]?.subjectIds).toEqual(['mem-pg']);
  });

  it('makes no call when nothing is askable', async () => {
    const f = fakeClient(async () => answered({}));
    const r = await judgeConflictsWithJev({ newText: '   ', neighbors: NEIGHBOURS }, { client: f.client });
    expect(r.verdicts).toEqual([null, null]);
    expect(f.client).not.toHaveBeenCalled();
  });

  it('throws JevConflictInconclusiveError on an inconclusive outcome', async () => {
    const f = fakeClient(async () => ({ kind: 'inconclusive', reason: 'no-key', latencyMs: 0, attempts: 0 }));
    await expect(judgeConflictsWithJev({ newText: NEW, neighbors: NEIGHBOURS }, { client: f.client })).rejects.toBeInstanceOf(
      JevConflictInconclusiveError,
    );
  });
});

describe('createJevConflictJudge through checkConflicts', () => {
  it('reports only neighbours at or above P(contradicts) 0.5, with the deterministic summary', async () => {
    const f = fakeClient(async () =>
      answered({ n1: choice(probs({ contradicts: 0.86, refines: 0.14 })), n2: choice(probs({ contradicts: 0.45, unrelated: 0.55 })) }),
    );
    const report = await checkConflicts({ newText: NEW, neighbors: NEIGHBOURS, judge: createJevConflictJudge({ client: f.client }) });
    expect(report).toEqual({
      conflicts: [{ memory_id: 'mem-pg', summary: 'jev-1.13.0 judged that the new memory contradicts this memory (P=0.86).' }],
    });
  });

  it('never flags a duplicate or a refinement, however confident', async () => {
    const f = fakeClient(async () => answered({ n1: choice(probs({ duplicates: 0.99, contradicts: 0.01 })), n2: choice(probs({ refines: 0.97, contradicts: 0.03 })) }));
    const report = await checkConflicts({ newText: NEW, neighbors: NEIGHBOURS, judge: createJevConflictJudge({ client: f.client }) });
    expect(report).toEqual({ conflicts: [] });
  });

  it('fails open (no conflicts, write proceeds) when Jev is inconclusive', async () => {
    const f = fakeClient(async () => ({ kind: 'inconclusive', reason: 'timeout', latencyMs: 3000, attempts: 1 }));
    const report = await checkConflicts({ newText: NEW, neighbors: NEIGHBOURS, judge: createJevConflictJudge({ client: f.client }) });
    expect(report).toEqual({ conflicts: [] });
  });
});
