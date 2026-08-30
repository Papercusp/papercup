import { describe, expect, it } from 'vitest';
import {
  admissionPairKey,
  buildPromoterPrompt,
  decideWorkItemAdmissionProducerPressure,
  evaluatePromoterLiveness,
  parsePromoterJudgements,
  planPromoterDispositions,
  responsePayload,
  type PromoterItem,
  type PromoterJudgement,
  type PromoterLlmResult,
  type PromoterPair,
} from './work-items-admission-promoter';

const queueHealth = (pending: number, sampleSize = 0, p95Ms: number | null = null) => ({
  pending,
  unreviewed: 0,
  promotedToFirstClaim: { sampleSize, p50Ms: p95Ms, p95Ms },
});

describe('decideWorkItemAdmissionProducerPressure', () => {
  it('preserves the configured Scout budget for a drained/normal queue and treats missing latency as neutral', () => {
    expect(decideWorkItemAdmissionProducerPressure(queueHealth(0))).toMatchObject({
      level: 'normal',
      pending: 0,
      latencySampleSize: 0,
      p95Ms: null,
      maxIdeators: null,
    });
    expect(decideWorkItemAdmissionProducerPressure(queueHealth(20, 4, 90 * 60_000))).toMatchObject({
      level: 'normal',
      maxIdeators: null,
    });
  });

  it('caps at three ideators above one promoter batch or one liveness window', () => {
    expect(decideWorkItemAdmissionProducerPressure(queueHealth(21))).toMatchObject({
      level: 'elevated',
      maxIdeators: 3,
    });
    expect(decideWorkItemAdmissionProducerPressure(queueHealth(0, 10, 90 * 60_000 + 1))).toMatchObject({
      level: 'elevated',
      maxIdeators: 3,
    });
  });

  it('caps at one ideator above two promoter batches or two liveness windows', () => {
    expect(decideWorkItemAdmissionProducerPressure(queueHealth(41))).toMatchObject({
      level: 'deep',
      maxIdeators: 1,
    });
    expect(decideWorkItemAdmissionProducerPressure(queueHealth(0, 10, 180 * 60_000 + 1))).toMatchObject({
      level: 'deep',
      maxIdeators: 1,
    });
  });
});

const item = (id: string, overrides: Partial<PromoterItem> = {}): PromoterItem => ({
  id,
  title: 'vitest duplicate failure',
  summary: 'The same test failure with the same retry remedy.',
  state: 'open',
  kind: 'bug',
  admission: 'pending',
  conditionKey: null,
  createdAtMs: Number(id.replace(/\D/g, '')) || 1,
  ...overrides,
});

const pair = (a: PromoterItem, b: PromoterItem, pendingIds = [a.id, b.id]): PromoterPair => ({
  pairKey: admissionPairKey(a.id, b.id),
  a: a.id < b.id ? a : b,
  b: a.id < b.id ? b : a,
  pendingIds,
  signals: ['title-key', 'cosine'],
  cosine: 0.99,
});

const judgement = (p: PromoterPair, verdict: PromoterJudgement['verdict']): PromoterJudgement => ({
  pairKey: p.pairKey,
  verdict,
  reason: `test ${verdict}`,
});

describe('planPromoterDispositions', () => {
  it('replays six vitest clones as one promoted canonical plus five merges without cycles', () => {
    const pending = Array.from({ length: 6 }, (_, i) => item(`WI-${i + 1}`));
    const pairs = pending.slice(1).map((candidate) => pair(pending[0]!, candidate));
    const plan = planPromoterDispositions(
      pending,
      pairs,
      pairs.map((p) => judgement(p, 'r-finding-merge')),
    );

    expect(plan.dispositions).toContainEqual({ itemId: 'WI-1', action: 'promote' });
    expect(plan.dispositions.filter((d) => d.action === 'merge')).toHaveLength(5);
    expect(plan.dispositions.filter((d) => d.action === 'merge')).toEqual(
      expect.arrayContaining(pending.slice(1).map((p) => ({ itemId: p.id, action: 'merge', canonicalId: 'WI-1' }))),
    );
    expect(new Set(plan.adjudications.map((a) => a.canonical))).toEqual(new Set(['WI-1']));
  });

  it('preserves and links an R-remedy pair while admitting both items', () => {
    const a = item('WI-1', { summary: 'Fix with an intake lease.' });
    const b = item('WI-2', { summary: 'Fix with a refractory window.' });
    const p = pair(a, b);
    const plan = planPromoterDispositions([a, b], [p], [judgement(p, 'r-remedy-keep')]);

    expect(plan.dispositions).toEqual([
      { itemId: 'WI-1', action: 'promote' },
      { itemId: 'WI-2', action: 'promote' },
    ]);
    expect(plan.relatedPairs).toEqual([{ a: 'WI-1', b: 'WI-2' }]);
    expect(plan.adjudications[0]).toMatchObject({ verdict: 'r-remedy-keep', canonical: null });
  });

  it('holds every pending endpoint when the model omits its pair', () => {
    const a = item('WI-1');
    const b = item('WI-2');
    const p = pair(a, b);
    const plan = planPromoterDispositions([a, b], [p], []);
    expect(plan.dispositions).toEqual([
      { itemId: 'WI-1', action: 'hold', reason: `model omitted ${p.pairKey}` },
      { itemId: 'WI-2', action: 'hold', reason: `model omitted ${p.pairKey}` },
    ]);
  });
});

describe('model contract', () => {
  it('states the duplication-only charter and the remedy/template traps', () => {
    const p = pair(item('WI-1'), item('WI-2'));
    const prompt = buildPromoterPrompt([p]);
    expect(prompt.system).toContain('DUPLICATION ONLY');
    expect(prompt.system).toContain('never an automatic merge licence');
    expect(prompt.system).toContain('r-remedy-keep');
    expect(prompt.user).toContain(p.pairKey);
  });

  it('accepts strict complete-shaped judgements and rejects duplicate pair keys', () => {
    expect(
      parsePromoterJudgements({ judgements: [{ pairKey: 'a::b', verdict: 'distinct', reason: 'different' }] }),
    ).toEqual([{ pairKey: 'a::b', verdict: 'distinct', reason: 'different' }]);
    expect(() =>
      parsePromoterJudgements({
        judgements: [
          { pairKey: 'a::b', verdict: 'distinct', reason: 'one' },
          { pairKey: 'a::b', verdict: 'r-related', reason: 'two' },
        ],
      }),
    ).toThrow(/duplicate judgement/);
  });
});

describe('evaluatePromoterLiveness', () => {
  const now = Date.parse('2026-08-26T12:00:00Z');

  it('alarms on a missing or inactive routine', () => {
    expect(
      evaluatePromoterLiveness({
        routineExists: false,
        active: null,
        createdAtMs: null,
        lastSuccessAtMs: null,
        nowMs: now,
      }),
    ).toMatchObject({ stale: true, reason: 'promoter routine row is missing' });
    expect(
      evaluatePromoterLiveness({
        routineExists: true,
        active: false,
        createdAtMs: now,
        lastSuccessAtMs: now,
        nowMs: now,
      }),
    ).toMatchObject({ stale: true, reason: 'promoter routine is inactive' });
  });

  it('holds the 90-minute successful-run boundary from both sides', () => {
    expect(
      evaluatePromoterLiveness({
        routineExists: true,
        active: true,
        createdAtMs: now - 200 * 60_000,
        lastSuccessAtMs: now - 90 * 60_000,
        nowMs: now,
      }).stale,
    ).toBe(false);
    expect(
      evaluatePromoterLiveness({
        routineExists: true,
        active: true,
        createdAtMs: now - 200 * 60_000,
        lastSuccessAtMs: now - 90 * 60_000 - 1,
        nowMs: now,
      }).stale,
    ).toBe(true);
  });
});
