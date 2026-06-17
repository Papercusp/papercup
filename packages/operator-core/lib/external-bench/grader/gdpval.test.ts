import { describe, expect, it, vi } from 'vitest';
import {
  buildJudgeUserPrompt,
  combineDualOrder,
  gradeGdpval,
  gradeGdpvalTask,
  outcomeScore,
  parseJudgeVerdict,
  type GdpvalPrediction,
  type JudgeFn,
} from './gdpval';

describe('gdpval grader — parseJudgeVerdict', () => {
  it('parses WINNER: A/B/TIE case-insensitively', () => {
    expect(parseJudgeVerdict('reasoning...\nWINNER: A')).toBe('A');
    expect(parseJudgeVerdict('winner:b')).toBe('B');
    expect(parseJudgeVerdict('WINNER : Tie')).toBe('tie');
  });
  it('takes the last marker', () => {
    expect(parseJudgeVerdict('WINNER: A\n...actually\nWINNER: B')).toBe('B');
  });
  it('returns null when absent', () => {
    expect(parseJudgeVerdict('they are both fine')).toBeNull();
  });
});

describe('gdpval grader — combineDualOrder (position-bias mitigation)', () => {
  it('model wins in BOTH orders → win', () => {
    // order1 model=A → judge says A; order2 model=B → judge says B.
    expect(combineDualOrder('A', 'B')).toBe('win');
  });
  it('model loses in BOTH orders → loss', () => {
    expect(combineDualOrder('B', 'A')).toBe('loss');
  });
  it('tie in both → tie', () => {
    expect(combineDualOrder('tie', 'tie')).toBe('tie');
  });
  it('judge flips with position (always prefers A) → collapses to TIE, not a win', () => {
    // order1 model=A, judge says A (model win); order2 reference=A, judge says A (model loss). → tie.
    expect(combineDualOrder('A', 'A')).toBe('tie');
    expect(combineDualOrder('B', 'B')).toBe('tie');
  });
  it('a win + a tie → leans win; a loss + a tie → leans loss', () => {
    expect(combineDualOrder('A', 'tie')).toBe('win'); // 1 + 0.5 → 0.75
    expect(combineDualOrder('B', 'tie')).toBe('loss'); // 0 + 0.5 → 0.25
  });
});

describe('gdpval grader — outcomeScore', () => {
  it('win=1 tie=0.5 loss=0', () => {
    expect(outcomeScore('win')).toBe(1);
    expect(outcomeScore('tie')).toBe(0.5);
    expect(outcomeScore('loss')).toBe(0);
  });
});

describe('gdpval grader — buildJudgeUserPrompt', () => {
  it('includes prompt, rubric, and both deliverables', () => {
    const p = buildJudgeUserPrompt({ prompt: 'Write a memo', rubric: 'clarity', deliverableA: 'AAA', deliverableB: 'BBB' });
    expect(p).toContain('Write a memo');
    expect(p).toContain('clarity');
    expect(p).toContain('AAA');
    expect(p).toContain('BBB');
    expect(p).toMatch(/WINNER: A \| WINNER: B \| WINNER: TIE/);
  });
});

const pred = (id: string, occ: string, sec: string, extra: Partial<GdpvalPrediction> = {}): GdpvalPrediction => ({
  taskId: id,
  occupation: occ,
  sector: sec,
  prompt: `task ${id}`,
  rubric: 'rubric',
  modelDeliverable: 'model output',
  referenceDeliverable: 'expert reference',
  ...extra,
});

describe('gdpval grader — gradeGdpvalTask (dual-order judging)', () => {
  it('calls the judge TWICE with swapped order and combines', async () => {
    // Judge: prefers whichever deliverable text === 'model output' (so model wins in both orders).
    const judge = vi.fn<JudgeFn>(async (req) => (req.deliverableA === 'model output' ? 'WINNER: A' : 'WINNER: B'));
    const g = await gradeGdpvalTask(pred('t1', 'lawyer', 'legal'), { judge });
    expect(judge).toHaveBeenCalledTimes(2);
    expect(g.outcome).toBe('win');
    expect(g.score).toBe(1);
    expect(g.verdicts).toEqual({ modelFirst: 'A', referenceFirst: 'B' });
  });

  it('a position-biased judge (always says A) yields a tie', async () => {
    const judge: JudgeFn = async () => 'WINNER: A';
    const g = await gradeGdpvalTask(pred('t2', 'nurse', 'health'), { judge });
    expect(g.outcome).toBe('tie');
  });

  it('unparseable judge output defaults that order to a tie (no over-credit)', async () => {
    const judge: JudgeFn = async () => 'I cannot decide';
    const g = await gradeGdpvalTask(pred('t3', 'eng', 'manuf'), { judge });
    expect(g.outcome).toBe('tie');
  });

  it('excluded prediction is not judged (surfaced, score 0)', async () => {
    const judge = vi.fn<JudgeFn>(async () => 'WINNER: A');
    const g = await gradeGdpvalTask(pred('t4', 'cad', 'manuf', { excludeReason: 'binary CAD — autograder cannot read' }), { judge });
    expect(judge).not.toHaveBeenCalled();
    expect(g.excludeReason).toMatch(/CAD/);
  });
});

describe('gdpval grader — gradeGdpval aggregation', () => {
  it('computes overall + per-occupation + per-sector win-rate and win-or-tie rate', async () => {
    // Judge prefers the model on lawyer tasks, the reference on nurse tasks, ties on eng.
    const judge: JudgeFn = async (req) => {
      const text = req.deliverableA + req.deliverableB;
      if (text.includes('LAWYER')) return req.deliverableA.includes('model') ? 'WINNER: A' : 'WINNER: B'; // model wins
      if (text.includes('NURSE')) return req.deliverableA.includes('model') ? 'WINNER: B' : 'WINNER: A'; // model loses
      return 'WINNER: TIE';
    };
    const preds: GdpvalPrediction[] = [
      pred('l1', 'lawyer', 'legal', { modelDeliverable: 'model LAWYER', referenceDeliverable: 'ref LAWYER' }),
      pred('l2', 'lawyer', 'legal', { modelDeliverable: 'model LAWYER', referenceDeliverable: 'ref LAWYER' }),
      pred('n1', 'nurse', 'health', { modelDeliverable: 'model NURSE', referenceDeliverable: 'ref NURSE' }),
      pred('e1', 'engineer', 'manuf', { modelDeliverable: 'model ENG', referenceDeliverable: 'ref ENG' }),
      pred('x1', 'cad', 'manuf', { excludeReason: 'binary' }),
    ];
    const r = await gradeGdpval(preds, { judge });
    // scored = 4 (one excluded). wins: l1,l2 (2); losses: n1 (1); ties: e1 (1).
    expect(r.overall.scored).toBe(4);
    expect(r.overall.wins).toBe(2);
    expect(r.overall.ties).toBe(1);
    expect(r.overall.losses).toBe(1);
    expect(r.overall.winRate).toBeCloseTo((2 + 0.5) / 4); // 0.625
    expect(r.overall.winOrTieRate).toBeCloseTo((2 + 1) / 4); // 0.75
    expect(r.excluded).toBe(1);

    const lawyer = r.byOccupation.find((g) => g.group === 'lawyer')!;
    expect(lawyer).toMatchObject({ scored: 2, wins: 2, winRate: 1 });
    const nurse = r.byOccupation.find((g) => g.group === 'nurse')!;
    expect(nurse).toMatchObject({ scored: 1, losses: 1, winRate: 0 });
    const manuf = r.bySector.find((g) => g.group === 'manuf')!;
    expect(manuf.scored).toBe(1); // e1 scored; x1 excluded
  });
});
