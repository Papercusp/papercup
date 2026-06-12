/**
 * miner-core.test.ts — the neologism miner's pure core (self-learning-frontier
 * P-011 / FB-05). No PG, no fs, no clock: sanitization, term extraction,
 * namespace coverage, the emergence math, fire-bar selection, the proposal
 * shape, and payload parsing.
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateNeologisms,
  buildNamespaceIndex,
  extractTerms,
  isCoveredByNamespace,
  neologismCaptureTitle,
  neologismOptionsFromPayload,
  neologismProposal,
  neologismWatchdogKey,
  sanitizeCoordText,
  selectNeologismCandidates,
  type CoordTextRow,
  type NeologismEntry,
} from './miner-core';

const AS_OF = '2026-06-12T00:00:00.000Z';
/** d days before AS_OF, ISO. */
const daysAgo = (d: number) => new Date(Date.parse(AS_OF) - d * 86_400_000).toISOString();

const row = (speaker: string, text: string, d: number): CoordTextRow => ({ speaker, text, at: daysAgo(d) });

describe('sanitizeCoordText', () => {
  it('strips code spans, urls, paths, file tokens, fleet ids, and dated slugs', () => {
    const out = sanitizeCoordText(
      'fixed `getOrgPg()` in lib/foo/bar.ts and miner-core.ts per EI-334 / FB-05 (su-0ae393ab) — ' +
        'see https://example.com/x and plan self-learning-frontier-2026-06-12',
    );
    expect(out).not.toContain('getOrgPg');
    expect(out).not.toContain('bar.ts');
    expect(out).not.toContain('miner-core');
    expect(out).not.toContain('EI-334');
    expect(out).not.toContain('su-0ae393ab');
    expect(out).not.toContain('example.com');
    expect(out).not.toContain('2026-06-12');
    expect(out).toContain('fixed');
  });
});

describe('extractTerms', () => {
  it('extracts hyphenated compounds, normalized to space-joined words', () => {
    expect(extractTerms('a wake-storm hit the fleet')).toContain('wake storm');
  });

  it('extracts content bigrams and drops stopword pairs', () => {
    const terms = extractTerms('the arming gate is closed because of the review');
    expect(terms).toContain('arming gate');
    // "the arming" / "is closed" never form (stopword halves)
    expect([...terms].some((t) => t.includes('the '))).toBe(false);
  });

  it('dedupes per text — one chatty row counts a term once', () => {
    const terms = extractTerms('wake-storm wake-storm wake-storm');
    expect([...terms].filter((t) => t === 'wake storm')).toHaveLength(1);
  });

  it('does not form bigrams across punctuation boundaries', () => {
    expect(extractTerms('deploy train. arrived early')).not.toContain('train arrived');
  });

  it('never emits digit-bearing or short-word terms', () => {
    const terms = extractTerms('v2 rollout x9 ab cd arming gate');
    for (const t of terms) expect(t).toMatch(/^[a-z]+( [a-z]+){0,3}$/);
    expect([...terms].some((t) => t.split(' ').some((w) => w.length < 3))).toBe(false);
  });
});

describe('namespace coverage', () => {
  const index = buildNamespaceIndex([
    'memory:search',
    'negative_space_demand',
    'system:negative-space-mine',
    'papercusp-learning-governor',
  ]);

  it('covers tool/table/flag vocabulary in every separator spelling', () => {
    expect(isCoveredByNamespace('memory search', index)).toBe(true);
    expect(isCoveredByNamespace('negative space', index)).toBe(true);
    expect(isCoveredByNamespace('space demand', index)).toBe(true);
    expect(isCoveredByNamespace('learning governor', index)).toBe(true);
  });

  it('does not cover genuinely unnamed vocabulary', () => {
    expect(isCoveredByNamespace('wake storm', index)).toBe(false);
    expect(isCoveredByNamespace('deploy train', index)).toBe(false);
  });
});

describe('aggregateNeologisms', () => {
  const emptyIndex = new Set<string>();

  it('counts row-mentions, distinct speakers, and recent/prior window split', () => {
    const rows = [
      row('a', 'the wake-storm again', 1),
      row('b', 'another wake-storm here', 2),
      row('c', 'wake-storm wake-storm', 3),
      row('a', 'early wake-storm sighting', 20),
    ];
    const [e] = aggregateNeologisms(rows, [], emptyIndex, AS_OF).filter((x) => x.term === 'wake storm');
    expect(e.recentMentions).toBe(3);
    expect(e.priorMentions).toBe(1);
    expect(e.distinctSpeakers).toBe(3);
    expect(e.firstSeenAt).toBe(daysAgo(20));
    expect(e.lastSeenAt).toBe(daysAgo(1));
  });

  it('a burst with no prior history scores high growth; steady usage scores ≈1', () => {
    const burst = Array.from({ length: 4 }, (_, i) => row(`s${i}`, 'a wake-storm', i + 1));
    const steady = [
      ...Array.from({ length: 7 }, (_, i) => row(`s${i}`, 'the deploy train', i + 0.5)),
      ...Array.from({ length: 20 }, (_, i) => row(`s${i}`, 'the deploy train', 8 + i)),
    ];
    const entries = aggregateNeologisms([...burst, ...steady], [], emptyIndex, AS_OF);
    const ws = entries.find((e) => e.term === 'wake storm')!;
    const dt = entries.find((e) => e.term === 'deploy train')!;
    expect(ws.growth).toBeGreaterThan(10);
    expect(dt.growth).toBeLessThan(1.5);
  });

  it('drops namespace-covered terms and rows after asOf', () => {
    const index = buildNamespaceIndex(['wake-storm-monitor']);
    const entries = aggregateNeologisms(
      [row('a', 'wake-storm', 1), { speaker: 'b', text: 'future-term here', at: daysAgo(-1) }],
      [],
      index,
      AS_OF,
    );
    expect(entries.find((e) => e.term === 'wake storm')).toBeUndefined();
    expect(entries.find((e) => e.term === 'future term')).toBeUndefined();
  });

  it('matches insight corroboration in both spaced and hyphenated spellings', () => {
    const entries = aggregateNeologisms(
      [row('a', 'a wake-storm', 1)],
      [
        { slug: 'wake-storm-runbook', text: 'When a wake-storm hits…' },
        { slug: 'unrelated', text: 'nothing here' },
      ],
      emptyIndex,
      AS_OF,
    );
    const e = entries.find((x) => x.term === 'wake storm')!;
    expect(e.insightSlugs).toEqual(['wake-storm-runbook']);
  });
});

const entry = (over: Partial<NeologismEntry> = {}): NeologismEntry => ({
  term: 'wake storm',
  recentMentions: 5,
  priorMentions: 0,
  distinctSpeakers: 4,
  growth: 12,
  insightSlugs: [],
  firstSeenAt: daysAgo(6),
  lastSeenAt: daysAgo(1),
  exampleText: 'a wake-storm hit the fleet',
  ...over,
});

describe('selectNeologismCandidates', () => {
  it('gates on recent mentions, speakers, AND growth; caps at maxPerTick', () => {
    const entries = [
      entry(),
      entry({ term: 'low traffic', recentMentions: 2 }),
      entry({ term: 'one voice', distinctSpeakers: 1 }),
      entry({ term: 'old saw', growth: 1.1 }),
      entry({ term: 'second hot', recentMentions: 9 }),
      entry({ term: 'third hot', recentMentions: 8 }),
    ];
    const picked = selectNeologismCandidates(entries, { maxPerTick: 2 });
    expect(picked.map((e) => e.term)).toEqual(['wake storm', 'second hot']);
  });

  it('maxPerTick 0 is mine-only (no candidates)', () => {
    expect(selectNeologismCandidates([entry()], { maxPerTick: 0 })).toEqual([]);
  });
});

describe('the abstraction proposal (Scout rail shape)', () => {
  it('builds a deterministic Proposal with the D-006 cheap experiment filled', () => {
    const p = neologismProposal(entry({ insightSlugs: ['wake-storm-runbook'] }), 30);
    expect(p.id).toBe('neologism:wake-storm');
    expect(p.framing).toContain('"wake storm"');
    expect(p.whyNew).toContain('5');
    expect(p.whyNew).toContain('wake-storm-runbook');
    expect(p.cheapExperiment.hypothesis).toBeTruthy();
    expect(p.cheapExperiment.method).toBeTruthy();
    expect(p.cheapExperiment.falsifiableSignal).toBeTruthy();
    expect(p.routeHint).toBe('improvement');
    expect(p.sourceIdeaIds).toEqual(['neologism:wake-storm']);
  });

  it('capture title is STABLE (no counts/timestamps) and the watchdogKey is term-keyed', () => {
    expect(neologismCaptureTitle('wake storm')).toBe(
      'Abstraction proposal: name the recurring fleet term "wake storm"',
    );
    expect(neologismCaptureTitle('wake storm')).not.toMatch(/\d/);
    expect(neologismWatchdogKey('wake storm')).toBe('neologism:wake-storm');
  });
});

describe('neologismOptionsFromPayload', () => {
  it('parses valid knobs and ignores junk', () => {
    expect(
      neologismOptionsFromPayload({
        windowDays: 14,
        recentDays: 3,
        minRecentMentions: 6,
        minSpeakers: 2,
        growthFactor: 2.5,
        maxPerTick: 0,
        bogus: 'x',
        minSpeakersTypo: -1,
      }),
    ).toEqual({ windowDays: 14, recentDays: 3, minRecentMentions: 6, minSpeakers: 2, growthFactor: 2.5, maxPerTick: 0 });
    expect(neologismOptionsFromPayload({ windowDays: -5, growthFactor: 'high' })).toEqual({});
    expect(neologismOptionsFromPayload(null)).toEqual({});
  });
});
