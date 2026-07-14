/** P-015 (deterministic-context-carry) — mechanical pivot detection between
 *  consecutive declared intents (D-006: extractive embedding use only). */
import { describe, expect, it } from 'vitest';
import {
  PIVOT_EMBED_MAX_SIM,
  cosineSimilarity,
  detectIntentPivot,
  intentTokens,
  lexicalIntentSimilarity,
  pivotHint,
} from './intent-pivot';

describe('lexical similarity', () => {
  it('tokenizes content words, keeps plan/WI ids, drops stopwords', () => {
    const t = intentTokens('Resume plan deterministic-context-carry at P-015 for the typed slots');
    expect(t.has('p-015')).toBe(true);
    expect(t.has('deterministic-context-carry')).toBe(true);
    expect(t.has('the')).toBe(false);
    expect(t.has('plan')).toBe(false);
  });

  it('same-plan progression scores similar; unrelated intents score near zero', () => {
    const a = 'deterministic-context-carry P-014 provenance stamping on carry surfaces';
    const b = 'deterministic-context-carry P-015 typed slots on carry surfaces';
    const c = 'debug the mac VM loginwindow SPICE handshake';
    expect(lexicalIntentSimilarity(a, b)).toBeGreaterThan(0.3);
    expect(lexicalIntentSimilarity(a, c)).toBeLessThan(0.05);
  });
});

describe('cosineSimilarity', () => {
  it('1 for parallel, 0 for orthogonal / mismatched lengths', () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 0], [1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe('detectIntentPivot', () => {
  it('null when previous intent is missing/short or identical', async () => {
    expect(await detectIntentPivot(null, 'a long enough next intent')).toBeNull();
    expect(await detectIntentPivot('short', 'a long enough next intent')).toBeNull();
    expect(await detectIntentPivot('the same intent text here', 'the same intent text here')).toBeNull();
  });

  it('embedding method when an embedder answers: pivot iff cosine below threshold', async () => {
    const orthogonal = new Map<string, number[]>([
      ['fix the filesystem watcher leak', [1, 0]],
      ['rewrite ingestion around polling', [0, 1]],
    ]);
    const r = await detectIntentPivot('fix the filesystem watcher leak', 'rewrite ingestion around polling', {
      embed: async (t) => orthogonal.get(t)!,
    });
    expect(r?.method).toBe('embedding');
    expect(r?.pivot).toBe(true);
    expect(r?.similarity).toBeLessThan(PIVOT_EMBED_MAX_SIM);

    const parallel = await detectIntentPivot('fix the filesystem watcher leak', 'rewrite ingestion around polling', {
      embed: async () => [1, 1, 1],
    });
    expect(parallel?.pivot).toBe(false);
  });

  it('degrades to lexical when the embedder throws or times out', async () => {
    const r = await detectIntentPivot(
      'debug the mac VM loginwindow SPICE handshake',
      'ship the beta release-history analytics page',
      { embed: async () => { throw new Error('sidecar down'); } },
    );
    expect(r?.method).toBe('lexical');
    expect(r?.pivot).toBe(true);

    const slow = await detectIntentPivot(
      'debug the mac VM loginwindow SPICE handshake',
      'ship the beta release-history analytics page',
      { embed: () => new Promise(() => {}), timeoutMs: 50 },
    );
    expect(slow?.method).toBe('lexical');
  });

  it('lexical method: same-plan progression is NOT a pivot', async () => {
    const r = await detectIntentPivot(
      'deterministic-context-carry P-014 provenance stamping on carry surfaces',
      'deterministic-context-carry P-015 typed slots on carry surfaces',
    );
    expect(r?.method).toBe('lexical');
    expect(r?.pivot).toBe(false);
  });
});

describe('pivotHint', () => {
  it('names the typed slot and quotes the previous intent', () => {
    const hint = pivotHint({ pivot: true, method: 'lexical', similarity: 0.02, prevIntent: 'fix the watcher' });
    expect(hint).toContain("facts:assert { slot: 'dead-end'");
    expect(hint).toContain('fix the watcher');
    expect(hint).toContain('0.02');
  });
});
