/**
 * Gold-set fixture guards (memory-backend-benchmark P-005, D-003).
 * The gold set is the benchmark's measuring stick — these tests pin
 * its structural invariants: every expected key resolves into the
 * same-version corpus, hard negatives expect nothing, every positive
 * expects something, the four classes are all present in their frozen
 * proportions, and exact-identifier queries really carry a verbatim
 * token from their target memory.
 */
import { describe, it, expect } from 'vitest';

import { GOLD_QUERY_CLASSES } from '@papercusp/memory/bench';
import { loadCorpusFixture } from './corpus';
import { loadGoldSetFixture } from './gold-set';

const fixture = loadGoldSetFixture('v1');
const corpus = loadCorpusFixture(fixture.corpusVersion);
const corpusKeys = new Set(corpus.map((e) => e.key));

describe('gold-set.v1 fixture', () => {
  it('matches its frozen counts', () => {
    expect(fixture.count).toBe(fixture.queries.length);
    expect(fixture.count).toBe(150);
    expect(fixture.classes).toEqual({
      'lexical-gap': 40,
      'exact-identifier': 35,
      'hard-negative': 30,
      'session-start-intent': 45,
    });
  });

  it('every query is well-formed, unique, and class-valid', () => {
    const ids = new Set<string>();
    for (const q of fixture.queries) {
      expect(ids.has(q.id), `dup id ${q.id}`).toBe(false);
      ids.add(q.id);
      expect(GOLD_QUERY_CLASSES).toContain(q.class);
      expect(q.query.trim().length).toBeGreaterThan(5);
    }
  });

  it('every expected key exists in the bound corpus version', () => {
    for (const q of fixture.queries) {
      for (const key of q.expected) {
        expect(corpusKeys.has(key), `${q.id} expects missing corpus key ${key}`).toBe(true);
      }
    }
  });

  it('hard negatives expect nothing; positives expect something', () => {
    for (const q of fixture.queries) {
      if (q.class === 'hard-negative') {
        expect(q.expected, q.id).toEqual([]);
      } else {
        expect(q.expected.length, q.id).toBeGreaterThan(0);
      }
    }
  });

  it('exact-identifier queries carry a verbatim token from a target memory', () => {
    const textByKey = new Map(corpus.map((e) => [e.key, `${e.text} ${e.description ?? ''}`.toLowerCase()]));
    for (const q of fixture.queries.filter((q) => q.class === 'exact-identifier')) {
      const tokens = q.query.toLowerCase().match(/[a-z0-9_.:/-]{6,}/g) ?? [];
      const verbatim = q.expected.some((key) =>
        tokens.some((t) => (textByKey.get(key) ?? '').includes(t)),
      );
      expect(verbatim, `${q.id} has no verbatim ≥6-char token in its target`).toBe(true);
    }
  });

  it('lexical-gap queries do not leak distinctive tokens (≥9 chars) from their target', () => {
    // Generic domain anchors are allowed (see the fixture note); what the
    // class forbids is the memory's distinctive jargon. Long tokens are a
    // cheap proxy for distinctiveness.
    const textByKey = new Map(corpus.map((e) => [e.key, `${e.text} ${e.description ?? ''}`.toLowerCase()]));
    const offenders: string[] = [];
    for (const q of fixture.queries.filter((q) => q.class === 'lexical-gap')) {
      const tokens = (q.query.toLowerCase().match(/[a-z0-9][a-z0-9_-]{8,}/g) ?? []);
      for (const key of q.expected) {
        const text = textByKey.get(key) ?? '';
        const leaked = tokens.filter((t) => text.includes(t));
        if (leaked.length > 1) offenders.push(`${q.id}→${key}: ${leaked.join(',')}`);
      }
    }
    expect(offenders, offenders.join(' | ')).toEqual([]);
  });
});

describe('gold-set.v2 fixture (jev-performance-improvements P-002)', () => {
  const v2 = loadGoldSetFixture('v2');
  const v2Corpus = loadCorpusFixture(v2.corpusVersion);
  const corpusText = v2Corpus.map((e) => ({ key: e.key, text: `${e.text} ${e.description ?? ''}`.toLowerCase() }));

  it('inherits every v1 query verbatim, in order, as its first 150', () => {
    expect(v2.corpusVersion).toBe(fixture.corpusVersion);
    expect(v2.inheritedIds).toEqual(fixture.queries.map((q) => q.id));
    expect(v2.queries.slice(0, fixture.queries.length)).toEqual(fixture.queries);
  });

  it('has at least 90 hard negatives, keeping the v1 30 as a named subset', () => {
    const negatives = v2.queries.filter((q) => q.class === 'hard-negative');
    expect(negatives.length).toBeGreaterThanOrEqual(90);
    const v1Negatives = fixture.queries.filter((q) => q.class === 'hard-negative').map((q) => q.id);
    expect(v1Negatives).toHaveLength(30);
    expect(negatives.slice(0, 30).map((q) => q.id)).toEqual(v1Negatives);
    expect(v2.count).toBe(v2.queries.length);
    expect(v2.classes['hard-negative']).toBe(negatives.length);
  });

  it('every added query is a unique, well-formed hard negative that expects nothing', () => {
    const ids = new Set(fixture.queries.map((q) => q.id));
    const texts = new Set(fixture.queries.map((q) => q.query.toLowerCase()));
    for (const q of v2.queries.slice(fixture.queries.length)) {
      expect(q.class, q.id).toBe('hard-negative');
      expect(q.expected, q.id).toEqual([]);
      expect(ids.has(q.id), `dup id ${q.id}`).toBe(false);
      expect(texts.has(q.query.toLowerCase()), `dup query ${q.id}`).toBe(false);
      ids.add(q.id);
      texts.add(q.query.toLowerCase());
    }
  });

  it('every added negative names absent terms that occur in its query and in no corpus entry', () => {
    const offenders: string[] = [];
    for (const q of v2.queries.slice(fixture.queries.length)) {
      const terms = q.absentTerms ?? [];
      if (terms.length === 0) offenders.push(`${q.id}: no absentTerms`);
      for (const term of terms) {
        if (!q.query.toLowerCase().includes(term)) offenders.push(`${q.id}: "${term}" is not in its query`);
        const covering = corpusText.filter((e) => e.text.includes(term)).map((e) => e.key);
        if (covering.length > 0) offenders.push(`${q.id}: "${term}" appears in ${covering.join(',')}`);
      }
    }
    expect(offenders, offenders.join(' | ')).toEqual([]);
  });

  it('the absence check is falsifiable: a term the corpus does contain is caught', () => {
    // Positive control: without it, a broken corpusText (empty, wrong field)
    // would pass the absence test above vacuously.
    expect(corpusText.length).toBe(v2Corpus.length);
    expect(corpusText.some((e) => e.text.includes('kopia'))).toBe(true);
  });
});
