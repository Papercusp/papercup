/**
 * push-floor-guard.test.ts — the pure half of the P-002 recurrence guard.
 *
 * These run everywhere (no PG, no embedder): they pin the VIOLATION LOGIC and
 * the anti-vacuity rules. The live verdict against the real corpus is
 * `push-floor-guard.integration.test.ts` — D-041's method rule keeps the
 * RELEVANCE claim on the real corpus, but the logic that decides what counts as
 * a violation is decidable here, and a bug in it would silently disarm the live
 * guard.
 */
import { describe, expect, it } from 'vitest';
import type { MemoryBackend, MemoryEntry } from '@papercusp/memory';

import {
  assertProbeScales,
  cosineScoreMap,
  evaluateFloorViolations,
  positiveControlFailure,
  probePushFloor,
  summarizeProbe,
  type AdmittedEntry,
  type FloorProbeQuery,
  type PushFloorProbeResult,
} from './push-floor-guard';

function admitted(id: string, text: string): AdmittedEntry {
  return { id, text, fusedScore: 0.0164 };
}

function entry(id: string, text: string, score: number): MemoryEntry {
  return { id, text, score } as MemoryEntry;
}

/** A minimal backend stub: fixed results, declared scale. */
function stubBackend(
  name: string,
  scoreScale: 'cosine' | 'rrf' | 'lexical' | 'unknown',
  results: Record<string, MemoryEntry[]>,
  seen?: Array<{ query: string; opts: Record<string, unknown> }>,
): MemoryBackend {
  return {
    name,
    scoreScale,
    search: async (query: string, opts: Record<string, unknown>) => {
      seen?.push({ query, opts });
      return results[query] ?? [];
    },
  } as unknown as MemoryBackend;
}

describe('evaluateFloorViolations — assertion (b)', () => {
  const floor = 0.45;

  it('admits an entry whose cosine score clears the floor', () => {
    const scores = new Map([['m1', 0.58]]);
    expect(evaluateFloorViolations('q1', [admitted('m1', 'a fact')], scores, floor)).toEqual([]);
  });

  it('flags an entry scoring BELOW the floor', () => {
    const scores = new Map([['m1', 0.31]]);
    const v = evaluateFloorViolations('q1', [admitted('m1', 'a fact')], scores, floor);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: 'below-cosine-floor', cosineScore: 0.31, floor, entryId: 'm1' });
  });

  it('treats a score EXACTLY at the floor as admitted (>=, matching applyScoreFloor)', () => {
    expect(evaluateFloorViolations('q1', [admitted('m1', 'a')], new Map([['m1', 0.45]]), floor)).toEqual([]);
  });

  it('flags a lexical-ONLY admission as no-cosine-score — the floored-union signature', () => {
    // The entry never appears in the unfloored cosine result: the cosine leg did
    // not return it at any depth, so it was admitted by the lexical leg alone.
    const v = evaluateFloorViolations('q1', [admitted('lex-1', 'WI-6857')], new Map(), floor);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: 'no-cosine-score', cosineScore: null });
  });

  /**
   * The cross-leg identity rule. Matching by id ALONE would report every
   * lexical-origin entry as a violation — a false positive that reads exactly
   * like the real bug, which is the worst possible failure for a guard.
   */
  it('resolves an entry carrying the LEXICAL leg id via its normalized text', () => {
    const scores = cosineScoreMap([entry('cos-1', 'the  same   fact', 0.61)]);
    const v = evaluateFloorViolations('q1', [admitted('lex-99', 'the same fact')], scores, floor);
    expect(v).toEqual([]);
  });

  it('is inapplicable (not passing) when no floor is configured', () => {
    expect(evaluateFloorViolations('q1', [admitted('m1', 'a')], new Map(), undefined)).toEqual([]);
  });

  it('reports every violating entry, not just the first', () => {
    const scores = new Map([
      ['m1', 0.1],
      ['m2', 0.2],
    ]);
    const v = evaluateFloorViolations('q1', [admitted('m1', 'a'), admitted('m2', 'b')], scores, floor);
    expect(v.map((x) => x.entryId)).toEqual(['m1', 'm2']);
  });
});

describe('cosineScoreMap', () => {
  it('keys on both id and normalized text, best rank first', () => {
    const map = cosineScoreMap([entry('a', 'fact  one', 0.7), entry('b', 'fact two', 0.5)]);
    expect(map.get('a')).toBe(0.7);
    expect(map.get('fact one')).toBe(0.7);
    expect(map.get('b')).toBe(0.5);
  });

  it('skips unscored entries rather than defaulting them to 0', () => {
    // A 0 default would manufacture a below-floor violation out of missing data.
    const map = cosineScoreMap([{ id: 'a', text: 'x' } as MemoryEntry]);
    expect(map.has('a')).toBe(false);
  });
});

describe('assertProbeScales — TRAP 1, structurally', () => {
  const push = stubBackend('hybrid-pg', 'rrf', {});

  it('accepts a cosine ground-truth leg under a fused push backend', () => {
    expect(() => assertProbeScales(push, stubBackend('mem0', 'cosine', {}))).not.toThrow();
  });

  it('REFUSES an rrf backend as the ground-truth leg', () => {
    // The exact D-001 conflation: rrf tops out ~0.0164, so every entry would
    // read as below a 0.45 cosine floor and the guard would report a fake breach.
    expect(() => assertProbeScales(push, stubBackend('hybrid-pg', 'rrf', {}))).toThrow(/must be on the 'cosine' scale/);
  });

  it('REFUSES a lexical backend as the ground-truth leg', () => {
    expect(() => assertProbeScales(push, stubBackend('lex', 'lexical', {}))).toThrow(/'cosine' scale/);
  });

  it('REFUSES a cosine-scale backend as the push path (the probe would be circular)', () => {
    const cos = stubBackend('mem0', 'cosine', {});
    expect(() => assertProbeScales(cos, cos)).toThrow(/not a fused path/);
  });
});

describe('positiveControlFailure — TRAP 2, the anti-vacuity rule', () => {
  function result(over: Partial<PushFloorProbeResult> = {}): PushFloorProbeResult {
    return {
      backend: 'hybrid-pg',
      floors: { minScore: 0.45, minLexScore: 0.4, fusionMode: 'cosine-gated' },
      corpusSeeded: 114,
      offTopic: [],
      violations: [],
      positiveControl: { queries: 120, withHits: 100, meanAdmitted: 6.2 },
      totalAdmitted: 620,
      ...over,
    };
  }

  it('passes a run where the path demonstrably retrieves', () => {
    expect(positiveControlFailure(result())).toBeNull();
  });

  it('FAILS an empty corpus — the EI-10793 all-zero run', () => {
    // Every off-topic query returns zero here, so assertion (a) "passes"
    // perfectly while measuring nothing at all.
    expect(positiveControlFailure(result({ corpusSeeded: 0 }))).toMatch(/vacuously/);
  });

  it('FAILS when the push path retrieves nothing on-topic either', () => {
    const r = result({ positiveControl: { queries: 120, withHits: 0, meanAdmitted: 0 } });
    expect(positiveControlFailure(r)).toMatch(/positive control FAILED/);
  });

  it('FAILS when there are no on-topic queries to control with', () => {
    const r = result({ positiveControl: { queries: 0, withHits: 0, meanAdmitted: 0 } });
    expect(positiveControlFailure(r)).toMatch(/no on-topic queries/);
  });
});

describe('probePushFloor — wiring', () => {
  const queries: FloorProbeQuery[] = [
    { id: 'hn-1', query: 'kubernetes ingress', className: 'hard-negative', expectEmpty: true },
    { id: 'ok-1', query: 'memory floor', className: 'lexical-gap', expectEmpty: false },
  ];

  it('passes the LIVE floors through to the push search verbatim', async () => {
    const seen: Array<{ query: string; opts: Record<string, unknown> }> = [];
    const push = stubBackend('hybrid-pg', 'rrf', { 'memory floor': [entry('m1', 'the floor', 0.02)] }, seen);
    const cosine = stubBackend('mem0', 'cosine', { 'memory floor': [entry('m1', 'the floor', 0.62)] });

    const res = await probePushFloor({
      backend: push,
      cosineLeg: cosine,
      scope: 'bench',
      queries,
      floors: { minScore: 0.45, minLexScore: 0.4, fusionMode: 'cosine-gated' },
      limit: 12,
      cosineProbeLimit: 200,
      corpusSeeded: 114,
    });

    // The guard must ask the push path the question production asks it.
    expect(seen[0]?.opts).toMatchObject({
      minScore: 0.45,
      minLexScore: 0.4,
      fusionMode: 'cosine-gated',
      limit: 12,
    });
    expect(res.offTopic).toHaveLength(1);
    expect(res.offTopic[0]?.admitted).toBe(0);
    expect(res.positiveControl).toEqual({ queries: 1, withHits: 1, meanAdmitted: 1 });
    expect(res.violations).toEqual([]);
  });

  it('does not floor the ground-truth probe (it must be UNFLOORED)', async () => {
    const seen: Array<{ query: string; opts: Record<string, unknown> }> = [];
    const push = stubBackend('hybrid-pg', 'rrf', { 'memory floor': [entry('m1', 'x', 0.02)] });
    const cosine = stubBackend('mem0', 'cosine', { 'memory floor': [entry('m1', 'x', 0.62)] }, seen);
    await probePushFloor({
      backend: push,
      cosineLeg: cosine,
      scope: 'bench',
      queries,
      floors: { minScore: 0.45, minLexScore: 0.4, fusionMode: 'cosine-gated' },
      limit: 12,
      cosineProbeLimit: 200,
      corpusSeeded: 114,
    });
    // A floored ground truth could never observe a below-floor admission — it
    // would filter away the very evidence the guard exists to find.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.opts).not.toHaveProperty('minScore');
    expect(seen[0]?.opts).toMatchObject({ limit: 200 });
  });

  it('records an off-topic admission as evidence rather than throwing', async () => {
    const push = stubBackend('hybrid-pg', 'rrf', {
      'kubernetes ingress': [entry('noise', 'unrelated fact', 0.0164)],
    });
    const cosine = stubBackend('mem0', 'cosine', {});
    const res = await probePushFloor({
      backend: push,
      cosineLeg: cosine,
      scope: 'bench',
      queries,
      floors: { minScore: 0.45, minLexScore: 0.4, fusionMode: 'floored-union' },
      limit: 12,
      cosineProbeLimit: 200,
      corpusSeeded: 114,
    });
    expect(res.offTopic[0]?.admitted).toBe(1);
    expect(res.offTopic[0]?.entries[0]?.id).toBe('noise');
    // …and the same entry is a (b) violation: admitted with no cosine score.
    expect(res.violations[0]).toMatchObject({ kind: 'no-cosine-score', queryId: 'hn-1' });
    expect(summarizeProbe(res)).toContain('violations=1');
  });
});
