import { describe, expect, it } from 'vitest';

import type { DecisionOutcome, QuestionMap } from '@papercusp/decision-model';
import type { CandidateHit, GoldQueryClass, QueryOutcome } from '@papercusp/memory/bench';

import {
  ADDED_P95_BUDGET_MS,
  ADMISSION_THRESHOLDS,
  admissionRubricVersion,
  alternateEncoding,
  applyAdmission,
  binomialUpperTailHalf,
  buildAdmissionRequest,
  compareToBaseline,
  evaluateFilterArm,
  gradeDocId,
  JEV_LIST_USD_PER_MILLION_INPUT,
  parseAdmissionEncoding,
  readCachedScores,
  renderAdmissionMarkdown,
  scoresFromDecision,
  summarizeArm,
  withCandidates,
  writeCachedScores,
  type GradeCacheSql,
  type QueryScores,
} from './jev-admission';

const BOOT = { iterations: 2000, seed: 7 };

function cand(queryId: string, key: string, i: number): CandidateHit {
  return { id: `${queryId}-${i}`, key, text: `text of ${key}`, score: 0.9 - i * 0.01 };
}

function outcome(queryId: string, cls: GoldQueryClass, expected: string[], keys: string[]): QueryOutcome {
  return withCandidates(
    { queryId, class: cls, expected, rankedKeys: [], rawHits: 0, ms: 3 },
    keys.map((k, i) => cand(queryId, k, i)),
  );
}

/**
 * 30 hard negatives that each admit two noise candidates at the floor (FP@5 =
 * 100% in arm A), 20 lexical-gap positives and 6 exact-identifier positives
 * whose answer ranks first ahead of one noise candidate.
 */
function fixture(): QueryOutcome[] {
  const out: QueryOutcome[] = [];
  for (let i = 0; i < 30; i++) out.push(outcome(`hn${i}`, 'hard-negative', [], [`noise-${i}a`, `noise-${i}b`]));
  for (let i = 0; i < 20; i++) out.push(outcome(`lg${i}`, 'lexical-gap', [`ans-${i}`], [`ans-${i}`, `noise-lg${i}`]));
  for (let i = 0; i < 6; i++) out.push(outcome(`ex${i}`, 'exact-identifier', [`id-${i}`], [`id-${i}`, `noise-ex${i}`]));
  return out;
}

function live(scores: number[] | null, extra: Partial<QueryScores> = {}): QueryScores {
  return { scores, latencyMs: 120, cached: false, inputTokens: 400, costUsd: 400 * JEV_LIST_USD_PER_MILLION_INPUT / 1e6, ...extra };
}

/** A filter that knows the gold: yes for the expected key, no for everything else. */
function oracleScores(outcomes: readonly QueryOutcome[]): QueryScores[] {
  return outcomes.map((o) => live(o.candidates!.map((c) => (c.key !== null && o.expected.includes(c.key) ? 0.95 : 0.05))));
}

describe('parseAdmissionEncoding / alternateEncoding (P-015)', () => {
  it('defaults an absent flag to state and accepts both encodings', () => {
    expect(parseAdmissionEncoding(undefined)).toBe('state');
    expect(parseAdmissionEncoding('state')).toBe('state');
    expect(parseAdmissionEncoding('instructions')).toBe('instructions');
  });

  it('refuses an unknown value instead of silently running state', () => {
    expect(() => parseAdmissionEncoding('instruction')).toThrow(/--encoding must be state\|instructions, got instruction/);
    expect(() => parseAdmissionEncoding('')).toThrow(/--encoding/);
  });

  it('pairs each encoding with the other one', () => {
    expect(alternateEncoding('state')).toBe('instructions');
    expect(alternateEncoding('instructions')).toBe('state');
  });
});

describe('buildAdmissionRequest', () => {
  const cands = [cand('q', 'a', 0), cand('q', 'b', 1), cand('q', 'c', 2)];

  it('state encoding: one yes/no question per candidate, memories keyed by the same ids', () => {
    const { request, questionIds } = buildAdmissionRequest('how do I deploy?', cands, 'state');
    expect(questionIds).toEqual(['m1', 'm2', 'm3']);
    expect(request.state).toEqual({
      message: 'how do I deploy?',
      memories: { m1: 'text of a', m2: 'text of b', m3: 'text of c' },
    });
    expect(Object.keys(request.questions)).toEqual(questionIds);
    for (const id of questionIds) {
      const q = request.questions[id];
      expect(q.type).toBe('yesNo');
      expect(String(q.instructions)).toContain(`memories.${id}`);
    }
  });

  it('instructions encoding: memory text travels in its own question, state holds only the message', () => {
    const { request, questionIds } = buildAdmissionRequest('how do I deploy?', cands, 'instructions');
    expect(request.state).toEqual({ message: 'how do I deploy?' });
    expect(String(request.questions[questionIds[1]].instructions)).toContain('text of b');
    expect(String(request.questions[questionIds[1]].instructions)).not.toContain('text of a');
  });

  it('refuses an empty candidate list (there is nothing to judge, so no call should be made)', () => {
    expect(() => buildAdmissionRequest('x', [])).toThrow(/no candidates/);
  });

  it('rubric version separates encodings and floors, and is stable for the same inputs', () => {
    expect(admissionRubricVersion('state', 0.58)).toBe(admissionRubricVersion('state', 0.58));
    expect(admissionRubricVersion('state', 0.58)).not.toBe(admissionRubricVersion('instructions', 0.58));
    expect(admissionRubricVersion('state', 0.58)).not.toBe(admissionRubricVersion('state', 0.52));
    expect(admissionRubricVersion('state', 0.58)).toMatch(/floor=0\.58$/);
  });
});

describe('scoresFromDecision', () => {
  const ids = ['m1', 'm2'];

  it('maps answers onto candidate order and prices input tokens at the list rate', () => {
    const outcome = {
      kind: 'answered',
      model: 'jev-1.13.0',
      answers: { m2: { type: 'yesNo', pYes: 0.2 }, m1: { type: 'yesNo', pYes: 0.9 } },
      usage: { inputTokens: 1_000_000, outputTokens: 2 },
      latencyMs: 210,
      attempts: 1,
    } as unknown as DecisionOutcome<QuestionMap>;
    const s = scoresFromDecision(outcome, ids);
    expect(s.scores).toEqual([0.9, 0.2]);
    expect(s.costUsd).toBeCloseTo(JEV_LIST_USD_PER_MILLION_INPUT);
    expect(s.latencyMs).toBe(210);
    expect(s.cached).toBe(false);
  });

  it('an inconclusive outcome yields null scores with its reason (fail open, counted)', () => {
    const s = scoresFromDecision({ kind: 'inconclusive', reason: 'timeout', latencyMs: 400, attempts: 1 }, ids);
    expect(s.scores).toBeNull();
    expect(s.failure).toBe('timeout');
  });

  it('a missing answer is malformed, never a silent zero', () => {
    const outcome = {
      kind: 'answered',
      model: 'jev-1.13.0',
      answers: { m1: { type: 'yesNo', pYes: 0.9 } },
      usage: { inputTokens: 10, outputTokens: 0 },
      latencyMs: 90,
      attempts: 1,
    } as unknown as DecisionOutcome<QuestionMap>;
    expect(scoresFromDecision(outcome, ids)).toMatchObject({ scores: null, failure: 'malformed-response' });
  });
});

describe('applyAdmission', () => {
  const base = outcome('q', 'lexical-gap', ['b'], ['a', 'b', 'b', 'c']);

  it('drops candidates below the threshold and keeps retrieval order', () => {
    const out = applyAdmission(base, [0.1, 0.8, 0.2, 0.9], 0.5);
    expect(out.rankedKeys).toEqual(['b', 'c']);
    expect(out.rawHits).toBe(2);
    expect(out.candidates!.map((c) => c.id)).toEqual(['q-1', 'q-3']);
    expect(out.topText).toBe('text of b');
  });

  it('fails open on null scores — today\'s admission unchanged', () => {
    expect(applyAdmission(base, null, 0.5)).toBe(base);
  });

  it('admitting nothing leaves an empty outcome (a hard negative becomes a true negative)', () => {
    const out = applyAdmission(base, [0, 0, 0, 0], 0.3);
    expect(out.rawHits).toBe(0);
    expect(out.rankedKeys).toEqual([]);
    expect(out.topText).toBeUndefined();
  });

  it('refuses an outcome replayed without captureCandidates, and misaligned scores', () => {
    const { candidates: _drop, ...bare } = base;
    expect(() => applyAdmission(bare, [1], 0.5)).toThrow(/captureCandidates/);
    expect(() => applyAdmission(base, [1, 1], 0.5)).toThrow(/4 candidates but 2 scores/);
  });
});

describe('binomialUpperTailHalf', () => {
  it('matches hand-computed binomial(n, 1/2) tails', () => {
    expect(binomialUpperTailHalf(0, 5)).toBe(1);
    expect(binomialUpperTailHalf(5, 5)).toBeCloseTo(1 / 32, 12);
    expect(binomialUpperTailHalf(4, 5)).toBeCloseTo(6 / 32, 12);
    expect(binomialUpperTailHalf(3, 6)).toBeCloseTo(42 / 64, 12);
    expect(binomialUpperTailHalf(1, 0)).toBe(1);
    expect(binomialUpperTailHalf(7, 6)).toBe(0);
  });
});

describe('compareToBaseline', () => {
  it('counts hard negatives the candidate newly rejects, and pairs by query id not position', () => {
    const baseline = fixture();
    const filtered = baseline.map((o) => (o.class === 'hard-negative' && Number(o.queryId.slice(2)) < 10 ? applyAdmission(o, [0, 0], 0.5) : o));
    const cmp = compareToBaseline(baseline, [...filtered].reverse(), BOOT);
    expect(cmp.hardNeg.mcnemar.onlyB).toBe(10);
    expect(cmp.hardNeg.mcnemar.onlyA).toBe(0);
    expect(cmp.hardNeg.pOneSided).toBeCloseTo(2 ** -10, 12);
    expect(cmp.r10.delta.point).toBe(0);
    expect(cmp.exactIdMrr!.delta.point).toBe(0);
    expect(cmp.hardNeg.rejectRate.delta.point).toBeCloseTo(10 / 30);
  });

  it('refuses arms over different query sets', () => {
    const baseline = fixture();
    expect(() => compareToBaseline(baseline, baseline.slice(1), BOOT)).toThrow(/different query sets/);
  });
});

describe('evaluateFilterArm (D-007)', () => {
  const baseline = fixture();
  const input = (scores: (QueryScores | undefined)[], thresholds?: number[]) => ({
    arm: 'B',
    label: 'A + Jev',
    floor: 0.58,
    outcomes: baseline,
    scores,
    ...(thresholds ? { thresholds } : {}),
  });

  it('baseline summary reports the hard-negative admit count behind FP@5', () => {
    const b = summarizeArm('A', 0.58, null, baseline);
    expect(b).toMatchObject({ hardNegN: 30, hardNegAdmitted: 30, fpAt5: 1, r10: 1, exactIdMrr: 1, positivesEmptied: 0 });
  });

  it('a filter that rejects every hard negative and keeps every answer MEETS the measured bar', () => {
    const v = evaluateFilterArm(baseline, input(oracleScores(baseline)), BOOT);
    expect(v.status).toBe('meets-measured-bar');
    // Ties on hard-negative admits resolve to the LOWEST threshold (more recall).
    expect(v.selectedThreshold).toBe(ADMISSION_THRESHOLDS[0]);
    const sel = v.thresholds.find((t) => t.threshold === v.selectedThreshold)!;
    expect(sel.point.hardNegAdmitted).toBe(0);
    expect(sel.pAdjusted).toBeCloseTo(Math.min(1, 2 ** -30 * ADMISSION_THRESHOLDS.length), 20);
    expect(v.pendingP005.length).toBeGreaterThan(0);
  });

  it('a filter that admits everything is INCONCLUSIVE and quotes the MDE its null could have seen', () => {
    const v = evaluateFilterArm(baseline, input(baseline.map((o) => live(o.candidates!.map(() => 0.99)))), BOOT);
    expect(v.status).toBe('inconclusive');
    expect(v.reasons.join(' ')).toMatch(/MDE80/);
  });

  it('a filter that also drops the answers FAILS on the detected recall regression', () => {
    const v = evaluateFilterArm(baseline, input(baseline.map((o) => live(o.candidates!.map(() => 0)))), BOOT);
    expect(v.status).toBe('fails');
    expect(v.reasons.join(' ')).toMatch(/no swept threshold was non-inferior/);
    expect(v.reasons.join(' ')).toMatch(/regression detected/);
  });

  it('an arm where every call failed open is VOID, never a clean null', () => {
    const v = evaluateFilterArm(
      baseline,
      input(baseline.map(() => live(null, { failure: 'unauthorized', inputTokens: null, costUsd: null }))),
      BOOT,
    );
    expect(v.status).toBe('void');
    expect(v.reasons[0]).toMatch(/unauthorized/);
  });

  it('a replay that admitted nothing is VOID — never an INCONCLUSIVE "served from cache" null', () => {
    // Measured 2026-09-30: a bench store whose seeding silently failed returned
    // zero hits for all 150 queries, and the first version of this verdict
    // published INCONCLUSIVE with a latency excuse. An unexercised filter is an
    // instrument failure.
    const empty = baseline.map((o) => withCandidates(o, []));
    const v = evaluateFilterArm(empty, { arm: 'B', label: 'x', floor: 0.58, outcomes: empty, scores: empty.map(() => undefined) }, BOOT);
    expect(v.status).toBe('void');
    expect(v.reasons[0]).toMatch(/never exercised/);
  });

  it('partial fail-open is counted in the reasons even when the arm otherwise passes', () => {
    const scores = oracleScores(baseline);
    scores[40] = live(null, { failure: 'rate-limited' });
    const v = evaluateFilterArm(baseline, input(scores), BOOT);
    expect(v.operational.failOpen).toBe(1);
    expect(v.reasons.join(' ')).toMatch(/1\/56 judged queries failed open/);
  });

  it('a p95 latency over budget FAILS regardless of accuracy', () => {
    const scores = oracleScores(baseline).map((s) => ({ ...s, latencyMs: ADDED_P95_BUDGET_MS + 150 }));
    const v = evaluateFilterArm(baseline, input(scores), BOOT);
    expect(v.status).toBe('fails');
    expect(v.reasons.join(' ')).toMatch(/p95 latency/);
  });

  it('a timeout rate over 2% FAILS', () => {
    const scores = oracleScores(baseline);
    for (const i of [0, 1]) scores[i] = live(null, { failure: 'timeout', latencyMs: 400 });
    const v = evaluateFilterArm(baseline, input(scores), BOOT);
    expect(v.operational.timeoutRate).toBeCloseTo(2 / 56);
    expect(v.status).toBe('fails');
  });

  it('an all-cached run cannot claim the latency budget and stays INCONCLUSIVE', () => {
    const scores = oracleScores(baseline).map((s) => ({ ...s, cached: true, latencyMs: null }));
    const v = evaluateFilterArm(baseline, input(scores), BOOT);
    expect(v.status).toBe('inconclusive');
    expect(v.reasons.join(' ')).toMatch(/--fresh/);
  });

  it('queries with no candidates need no verdict and are not counted as judged', () => {
    const withEmpty = [...baseline, outcome('hn-empty', 'hard-negative', [], [])];
    const scores: (QueryScores | undefined)[] = [...oracleScores(baseline), undefined];
    const v = evaluateFilterArm(withEmpty, { arm: 'B', label: 'x', floor: 0.58, outcomes: withEmpty, scores }, BOOT);
    expect(v.operational.queries).toBe(56);
    expect(v.status).toBe('meets-measured-bar');
  });

  it('renders the verdict, the Bonferroni caveat and the fail-open rule', () => {
    const v = evaluateFilterArm(baseline, input(oracleScores(baseline), [0.3, 0.5]), BOOT);
    const md = renderAdmissionMarkdown({
      generatedAt: '2026-09-30T00:00:00Z',
      params: { gold: 56 },
      baseline: summarizeArm('A', 0.58, null, baseline),
      arms: [v],
    });
    expect(md).toContain('**Verdict: MEETS-MEASURED-BAR** (selected t=0.3)');
    expect(md).toContain('Bonferroni');
    expect(md).toContain('fails open to arm A');
    expect(md).toContain('| 0.30 ⭐ | 0/30 |');
  });
});

describe('grade cache (search_judge_grades)', () => {
  const scope = { workspaceId: 'ws', judgeModel: 'typesafe/jev-1.13.0', rubricVersion: 'r1' };
  const cands = [cand('q', 'a', 0), { ...cand('q', 'b', 1), key: null }];

  /** An in-memory stand-in keyed exactly like the table's primary key. */
  function fakeSql(): GradeCacheSql & { rows: Map<string, unknown[]>; inserts: unknown[][] } {
    const rows = new Map<string, unknown[]>();
    const inserts: unknown[][] = [];
    return {
      rows,
      inserts,
      async unsafe<T>(query: string, params: unknown[] = []): Promise<T[]> {
        if (query.includes('INSERT')) {
          inserts.push(params);
          const [ws, model, rubric, qh, doc, th] = params;
          const k = [ws, model, rubric, qh, doc, th].join('|');
          if (!rows.has(k)) rows.set(k, params);
          return [];
        }
        const [ws, model, rubric, qh, docs] = params as [string, string, string, string, string[]];
        const out = [...rows.values()]
          .filter((p) => p[0] === ws && p[1] === model && p[2] === rubric && p[3] === qh && docs.includes(p[4] as string))
          .map((p) => ({ doc_id: p[4], doc_text_hash: p[5], relevance: String(p[6]), judge_cost_usd: String(p[8]) }));
        return out as T[];
      },
    };
  }

  it('round-trips a query: write live grades, then read them back aligned and marked cached', async () => {
    const sql = fakeSql();
    expect(await readCachedScores(sql, scope, 'the query', cands)).toBeNull();
    const n = await writeCachedScores(sql, scope, 'the query', cands, live([0.7, 0.2], { costUsd: 0.0002 }), {
      pairId: 'q',
      runId: 'run-1',
    });
    expect(n).toBe(2);
    expect(sql.inserts[1][4]).toBe('id:q-1'); // a keyless hit falls back to its backend id
    expect(sql.inserts[0][7]).toBe(true); // judged_relevant = score ≥ 0.5
    const hit = await readCachedScores(sql, scope, 'the query', cands);
    expect(hit).toMatchObject({ scores: [0.7, 0.2], cached: true, latencyMs: null });
    expect(hit!.costUsd).toBeCloseTo(0.0002);
  });

  it('is all-or-nothing: a changed candidate text or a new co-candidate is a miss', async () => {
    const sql = fakeSql();
    await writeCachedScores(sql, scope, 'the query', cands, live([0.7, 0.2]), { pairId: 'q', runId: 'r' });
    expect(await readCachedScores(sql, scope, 'the query', [cands[0], { ...cands[1], text: 'edited' }])).toBeNull();
    expect(await readCachedScores(sql, scope, 'the query', [...cands, cand('q', 'z', 2)])).toBeNull();
    expect(await readCachedScores(sql, { ...scope, rubricVersion: 'r2' }, 'the query', cands)).toBeNull();
  });

  it('never caches a fail-open or an already-cached result', async () => {
    const sql = fakeSql();
    expect(await writeCachedScores(sql, scope, 'q', cands, live(null, { failure: 'timeout' }), { pairId: 'q', runId: 'r' })).toBe(0);
    expect(await writeCachedScores(sql, scope, 'q', cands, live([1, 1], { cached: true }), { pairId: 'q', runId: 'r' })).toBe(0);
    expect(sql.inserts).toHaveLength(0);
  });

  it('gradeDocId prefers the stable corpus key', () => {
    expect(gradeDocId({ id: 'x', key: 'k' })).toBe('k');
    expect(gradeDocId({ id: 'x', key: null })).toBe('id:x');
  });
});
