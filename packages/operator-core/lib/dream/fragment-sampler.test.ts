import { describe, expect, it } from 'vitest';
import { indexDreamFragments, sampleDreamPair, type DreamFragment } from './fragment-sampler';

const NOW = '2026-08-20T12:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1_000;

function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * DAY_MS).toISOString();
}

function fragment(overrides: Partial<DreamFragment> = {}): DreamFragment {
  return {
    id: 'fragment-1',
    kind: 'observation',
    ref: 'EI-1',
    text: 'A high-signal observation',
    createdAt: daysAgo(1),
    harness: 'papercusp',
    salience: 1,
    embedding: [1, 0],
    ...overrides,
  };
}

function sequenceRng(values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error(`rng exhausted at draw ${index}`);
    index += 1;
    return value;
  };
}

describe('indexDreamFragments', () => {
  it('builds recent and remote per-kind strata with quotas and a measurable census', () => {
    const longText = `  ${'x'.repeat(1_300)}  `;
    const index = indexDreamFragments(
      [
        fragment({ id: 'recent-low', salience: 1 }),
        fragment({ id: 'recent-high', salience: 9, text: longText }),
        fragment({ id: 'remote-memory', kind: 'memory', createdAt: daysAgo(30) }),
        fragment({ id: 'gap', kind: 'stat', createdAt: daysAgo(4) }),
        fragment({ id: 'wrong-harness', harness: 'elsewhere' }),
        fragment({ id: 'blank', text: '   ' }),
      ],
      { harness: 'papercusp', now: NOW, config: { maxFragmentsPerKind: 1 } },
    );

    expect(index.recent.observation.map((item) => item.id)).toEqual(['recent-high']);
    expect(index.recent.observation[0]?.text).toHaveLength(1_200);
    expect(index.remote.memory.map((item) => item.id)).toEqual(['remote-memory']);
    expect(index.census).toEqual({
      input: 6,
      recent: 1,
      remote: 1,
      excludedHarness: 1,
      excludedInvalid: 1,
      excludedAgeGap: 1,
      droppedByQuota: 1,
    });
  });
});

describe('sampleDreamPair', () => {
  it('draws the recent anchor by salience and chooses the best remote cross-type partner in-band', () => {
    const pair = sampleDreamPair(
      [
        fragment({ id: 'recent-high', salience: 9 }),
        fragment({ id: 'recent-low', salience: 1 }),
        fragment({ id: 'same-kind', createdAt: daysAgo(30), embedding: [0.7, Math.sqrt(0.51)] }),
        fragment({ id: 'too-close', kind: 'memory', createdAt: daysAgo(30), embedding: [1, 0] }),
        fragment({ id: 'too-far', kind: 'stat', createdAt: daysAgo(30), embedding: [-1, 0] }),
        fragment({ id: 'in-band-low', kind: 'memory', createdAt: daysAgo(30), embedding: [0.5, Math.sqrt(0.75)] }),
        fragment({ id: 'in-band-best', kind: 'work_item', createdAt: daysAgo(30), embedding: [0.7, Math.sqrt(0.51)] }),
      ],
      {
        harness: 'papercusp',
        now: NOW,
        rng: sequenceRng([0, 0.89, 0.9]),
      },
    );

    expect(pair).toMatchObject({
      anchor: { id: 'recent-high', kind: 'observation' },
      partner: { id: 'in-band-best', kind: 'work_item' },
      pairing: 'banded',
    });
    expect(pair?.similarity).toBeCloseTo(0.7);
  });

  it('uses the epsilon control arm to draw a remote cross-type fragment without the band filter', () => {
    const pair = sampleDreamPair(
      [
        fragment({ id: 'recent' }),
        fragment({ id: 'too-close', kind: 'work_item', createdAt: daysAgo(30), embedding: [1, 0] }),
        fragment({ id: 'too-far', kind: 'memory', createdAt: daysAgo(30), embedding: [-1, 0] }),
      ],
      {
        harness: 'papercusp',
        now: NOW,
        rng: sequenceRng([0, 0, 0.1, 0.75]),
      },
    );

    expect(pair).toMatchObject({
      anchor: { id: 'recent', kind: 'observation' },
      partner: { id: 'too-far', kind: 'memory' },
      pairing: 'random',
    });
    expect(pair?.similarity).toBeCloseTo(-1);
  });

  it('returns no banded pair when embeddings are missing, mismatched, or outside the band', () => {
    const pair = sampleDreamPair(
      [
        fragment({ id: 'recent' }),
        fragment({ id: 'missing', kind: 'work_item', createdAt: daysAgo(30), embedding: undefined }),
        fragment({ id: 'mismatch', kind: 'memory', createdAt: daysAgo(30), embedding: [1, 0, 0] }),
        fragment({ id: 'close', kind: 'stat', createdAt: daysAgo(30), embedding: [1, 0] }),
      ],
      {
        harness: 'papercusp',
        now: NOW,
        config: { randomPartnerRate: 0 },
        rng: sequenceRng([0, 0, 0.5]),
      },
    );

    expect(pair).toBeNull();
  });

  it('requires a remote fragment from another substrate type', () => {
    const pair = sampleDreamPair(
      [fragment({ id: 'recent' }), fragment({ id: 'remote-same-kind', createdAt: daysAgo(30), embedding: [0.6, 0.8] })],
      { harness: 'papercusp', now: NOW, rng: sequenceRng([]) },
    );

    expect(pair).toBeNull();
  });

  it('rejects an invalid RNG result instead of biasing a draw', () => {
    expect(() =>
      sampleDreamPair(
        [fragment({ id: 'recent' }), fragment({ id: 'remote', kind: 'memory', createdAt: daysAgo(30) })],
        { harness: 'papercusp', now: NOW, rng: () => 1 },
      ),
    ).toThrow('rng must return');
  });
});
