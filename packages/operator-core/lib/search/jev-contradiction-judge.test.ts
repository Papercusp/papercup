import { describe, expect, it, vi } from 'vitest';

import type { DecisionClient, DecisionOutcome, QuestionMap } from '@papercusp/decision-model';

import { judgeContradictions, type JudgeCandidate, type JudgeSection } from './doc-contradiction-judge';
import {
  CONTENT_CONTRADICTION_INSTRUCTIONS,
  CONTENT_CONTRADICTION_OPTIONS,
  CONTRADICTION_INSTRUCTIONS,
  CONTRADICTION_OPTIONS,
  CONTRADICTION_QUESTION_ID,
  JEV_CONTRADICTION_WORDING,
  parseContradictionWording,
  JEV_CONTRADICTION_CONSUMER,
  JEV_CONTRADICTION_LABELS,
  JEV_CONTRADICTION_MIN_P,
  JEV_CONTRADICTION_TIMEOUT_MS,
  JevContradictionInconclusiveError,
  buildContradictionRequest,
  contradictionJudgement,
  contradictionReason,
  createJevContradictionJudge,
  isContradictionJudgement,
  judgeContradictionWithJev,
  type JevContradictionLabel,
} from './jev-contradiction-judge';

const A: JudgeSection = { id: 'doc-a#commit', title: 'Commit discipline', content: 'Do not commit; git-sync does it.' };
const B: JudgeSection = { id: 'doc-b#finish', title: 'Finishing a change', content: 'Commit and push your change yourself.' };

type Probs = Record<JevContradictionLabel, number>;

function probs(p: Partial<Probs>): Probs {
  return { 'opposite-instructions': 0, compatible: 0, unrelated: 0, ...p };
}

function choice(p: Probs) {
  const top = (Object.entries(p) as [JevContradictionLabel, number][]).sort((x, y) => y[1] - x[1])[0][0];
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

const answerWith = (p: Partial<Probs>) => async () => answered({ [CONTRADICTION_QUESTION_ID]: choice(probs(p)) });

describe('buildContradictionRequest', () => {
  it('puts only passage A in state and one three-way choice carrying passage B', () => {
    const request = buildContradictionRequest(A, B);
    expect(request.state).toEqual({ passage_a: { title: A.title, content: A.content } });
    expect(Object.keys(request.questions)).toEqual([CONTRADICTION_QUESTION_ID]);
    const q = request.questions[CONTRADICTION_QUESTION_ID] as { type: string; instructions: string; options: Record<string, string> };
    expect(q.type).toBe('choice');
    expect(q.instructions).toContain(B.content);
    expect(q.instructions).toContain(B.title);
    expect(q.instructions).not.toContain(A.content);
    expect(Object.keys(q.options)).toEqual([...JEV_CONTRADICTION_LABELS]);
    expect(q.options).toEqual(CONTRADICTION_OPTIONS);
  });
});

describe('contradictionJudgement', () => {
  it('reads the chosen label and every probability', () => {
    const j = contradictionJudgement(answered({ relation: choice(probs({ 'opposite-instructions': 0.7, compatible: 0.2, unrelated: 0.1 })) }));
    expect(j).toEqual({
      label: 'opposite-instructions',
      p: 0.7,
      pOpposite: 0.7,
      probabilities: { 'opposite-instructions': 0.7, compatible: 0.2, unrelated: 0.1 },
      model: 'jev-1.13.0',
    });
  });

  it('turns an inconclusive outcome into its reason', () => {
    const outcome = { kind: 'inconclusive', reason: 'timeout', latencyMs: 10_000, attempts: 1 } as DecisionOutcome<QuestionMap>;
    expect(contradictionJudgement(outcome)).toEqual({ failure: 'timeout' });
  });

  it.each([
    ['a missing answer', {}],
    ['a non-choice answer', { relation: { type: 'yesNo', pYes: 0.9 } }],
    ['a label outside the vocabulary', { relation: { type: 'choice', choice: 'contradicts', probabilities: probs({}), confidence: 1 } }],
    [
      'a missing probability',
      { relation: { type: 'choice', choice: 'compatible', probabilities: { compatible: 0.9, unrelated: 0.1 }, confidence: 1 } },
    ],
    [
      'a non-finite probability',
      { relation: { type: 'choice', choice: 'compatible', probabilities: probs({ compatible: Number.NaN }), confidence: 1 } },
    ],
  ])('treats %s as malformed', (_name, answers) => {
    expect(contradictionJudgement(answered(answers))).toEqual({ failure: 'malformed-response' });
  });
});

describe('isContradictionJudgement', () => {
  const at = (pOpposite: number) =>
    contradictionJudgement(answered({ relation: choice(probs({ 'opposite-instructions': pOpposite, compatible: 1 - pOpposite })) }));

  it('flags at exactly the D-017 threshold and not just below it', () => {
    expect(JEV_CONTRADICTION_MIN_P).toBe(0.5);
    const atBar = at(0.5);
    const below = at(0.49);
    expect('failure' in atBar || 'failure' in below).toBe(false);
    expect(isContradictionJudgement(atBar as Exclude<typeof atBar, { failure: string }>)).toBe(true);
    expect(isContradictionJudgement(below as Exclude<typeof below, { failure: string }>)).toBe(false);
  });
});

describe('judgeContradictionWithJev', () => {
  it('sends one request with the scan consumer, deadline and both section ids', async () => {
    const { client, decideSpy } = fakeClient(answerWith({ compatible: 0.8, unrelated: 0.2 }));
    const j = await judgeContradictionWithJev({ a: A, b: B }, { client });
    expect(j.label).toBe('compatible');
    expect(decideSpy).toHaveBeenCalledTimes(1);
    expect(decideSpy.mock.calls[0][1]).toEqual({
      consumer: JEV_CONTRADICTION_CONSUMER,
      timeoutMs: JEV_CONTRADICTION_TIMEOUT_MS,
      subjectIds: [A.id, B.id],
    });
  });

  it('throws an inconclusive error without calling Jev when a passage is empty', async () => {
    const { client, decideSpy } = fakeClient(answerWith({ compatible: 1 }));
    await expect(judgeContradictionWithJev({ a: A, b: { ...B, content: '  ' } }, { client })).rejects.toBeInstanceOf(
      JevContradictionInconclusiveError,
    );
    expect(decideSpy).not.toHaveBeenCalled();
  });
});

describe('createJevContradictionJudge', () => {
  it('reports a contradiction with a deterministic reason naming the model and P', async () => {
    const { client } = fakeClient(answerWith({ 'opposite-instructions': 0.83, compatible: 0.17 }));
    const verdict = await createJevContradictionJudge({ client })({ a: A, b: B });
    expect(verdict).toEqual({ contradicts: true, reason: contradictionReason(0.83, 'jev-1.13.0') });
    expect(verdict?.reason).toContain('P=0.83');
  });

  it('answers "no" with an empty reason below the threshold', async () => {
    const { client } = fakeClient(answerWith({ 'opposite-instructions': 0.3, compatible: 0.7 }));
    expect(await createJevContradictionJudge({ client })({ a: A, b: B })).toEqual({ contradicts: false, reason: '' });
  });

  it.each([
    ['an inconclusive outcome', async () => ({ kind: 'inconclusive', reason: 'rate-limited', latencyMs: 1, attempts: 3 }) as DecisionOutcome<QuestionMap>],
    ['a malformed answer', async () => answered({})],
    [
      'a thrown error',
      async (): Promise<DecisionOutcome<QuestionMap>> => {
        throw new Error('socket hang up');
      },
    ],
  ])('returns null, never a false verdict, for %s', async (_name, decide) => {
    const { client } = fakeClient(decide);
    expect(await createJevContradictionJudge({ client })({ a: A, b: B })).toBeNull();
  });

  it('makes an all-inconclusive scan inconclusive rather than clean', async () => {
    const { client } = fakeClient(async () => ({ kind: 'inconclusive', reason: 'no-key', latencyMs: 0, attempts: 0 }) as DecisionOutcome<QuestionMap>);
    const candidates: JudgeCandidate[] = [{ a: A.id, b: B.id, similarity: 0.9, kind: 'cross-kind' }];
    const report = await judgeContradictions({
      candidates,
      judgeThreshold: 0.8,
      maxJudged: 10,
      enabled: true,
      judgeAvailable: true,
      loadSections: async () => new Map([[A.id, A], [B.id, B]]),
      judge: createJevContradictionJudge({ client }),
    });
    expect(report.contradictions).toEqual([]);
    expect(report.census.judgeErrors).toBe(1);
    expect(report.inconclusive).not.toBeNull();
  });
});

describe('contradiction wording seam (plan jev-performance-improvements-2026-09-30, P-009, bar D-007)', () => {
  type Structured = { means: string; not_when: string };

  it('the scan asks the shipped v1 wording, byte-identical to an explicit v1 request', () => {
    expect(JEV_CONTRADICTION_WORDING).toBe('v1');
    expect(JSON.stringify(buildContradictionRequest(A, B))).toBe(JSON.stringify(buildContradictionRequest(A, B, 'v1')));
    const q = buildContradictionRequest(A, B).questions[CONTRADICTION_QUESTION_ID] as { instructions: string; options: unknown };
    expect(q.instructions).toBe(`${CONTRADICTION_INSTRUCTIONS}\n\nPassage B (${B.title}):\n${B.content}`);
    expect(q.options).toBe(CONTRADICTION_OPTIONS);
  });

  it('v2-content asks the content-not-self-claims wording with a structured means/not_when criterion per label', () => {
    const request = buildContradictionRequest(A, B, 'v2-content');
    expect(request.state).toEqual({ passage_a: { title: A.title, content: A.content } });
    const q = request.questions[CONTRADICTION_QUESTION_ID] as { type: string; instructions: string; options: Record<string, Structured> };
    expect(q.type).toBe('choice');
    expect(q.instructions).toBe(`${CONTENT_CONTRADICTION_INSTRUCTIONS}\n\nPassage B (${B.title}):\n${B.content}`);
    expect(q.instructions).not.toContain(A.content);
    expect(CONTENT_CONTRADICTION_INSTRUCTIONS).toMatch(/ignore/i);
    expect(Object.keys(q.options)).toEqual([...JEV_CONTRADICTION_LABELS]);
    for (const label of JEV_CONTRADICTION_LABELS) {
      expect(q.options[label].means.length).toBeGreaterThan(20);
      expect(q.options[label].not_when.length).toBeGreaterThan(20);
    }
    expect(q.options).toBe(CONTENT_CONTRADICTION_OPTIONS);
  });

  it('judgeContradictionWithJev sends the wording named in deps, and v1 when unset', async () => {
    const v2 = fakeClient(answerWith({ compatible: 0.9, unrelated: 0.1 }));
    await judgeContradictionWithJev({ a: A, b: B }, { client: v2.client, wording: 'v2-content' });
    expect(v2.decideSpy.mock.calls[0][0]).toEqual(buildContradictionRequest(A, B, 'v2-content'));
    const unset = fakeClient(answerWith({ compatible: 0.9, unrelated: 0.1 }));
    await judgeContradictionWithJev({ a: A, b: B }, { client: unset.client });
    expect(unset.decideSpy.mock.calls[0][0]).toEqual(buildContradictionRequest(A, B, 'v1'));
  });

  it('parseContradictionWording defaults to production and refuses an unknown wording', () => {
    expect(parseContradictionWording(undefined)).toBe(JEV_CONTRADICTION_WORDING);
    expect(parseContradictionWording('v2-content')).toBe('v2-content');
    expect(() => parseContradictionWording('v3')).toThrow(/--wording must be v1\|v2-content/);
  });
});
