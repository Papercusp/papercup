/**
 * Guards for the frozen prose corpus + gold set
 * (prose-embedding-384-untrained-mrl-fix-2026-08-02 P-001).
 *
 * These fixtures are the measuring instrument for the whole plan: P-002's
 * verdict, and therefore whether a five-surface migration happens, is read off
 * them. A silently-rotted fixture does not fail loudly — it produces a
 * plausible number that is wrong, which is exactly the failure mode this plan
 * exists to correct. So the invariants are asserted, not assumed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { GOLD_QUERY_CLASSES } from '@papercusp/memory/bench';

import {
  PROSE_CORPUS_FIXTURE_VERSION,
  pickClusters,
  loadProseCorpusFixture,
  loadProseCorpusFixtureMeta,
  type ClusterCandidate,
} from './prose-corpus';
import { PROSE_GOLD_SET_VERSION, loadProseGoldSetFixture } from './prose-gold-set';

// The two fixtures are real session, doc and plan text, so the public source export
// omits them (open-source-release-2026-09-29 P-005). Where they are absent the fixture
// guards skip; the sampler tests below need no fixture and always run.
const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixturesPresent =
  fs.existsSync(path.join(FIXTURES_DIR, `prose-corpus.${PROSE_CORPUS_FIXTURE_VERSION}.json`)) &&
  fs.existsSync(path.join(FIXTURES_DIR, `prose-gold-set.${PROSE_GOLD_SET_VERSION}.json`));

const corpus = fixturesPresent ? loadProseCorpusFixture() : [];
const corpusMeta = fixturesPresent ? loadProseCorpusFixtureMeta() : (undefined as never);
const gold = fixturesPresent ? loadProseGoldSetFixture() : (undefined as never);

describe.skipIf(!fixturesPresent)('prose corpus fixture', () => {
  it('is present, non-trivial, and uniquely keyed', () => {
    expect(corpus.length).toBeGreaterThan(1500);
    const keys = new Set(corpus.map((e) => e.key));
    expect(keys.size).toBe(corpus.length);
    for (const e of corpus) expect(e.text.length).toBeGreaterThan(0);
  });

  it('covers all three prose surfaces named by the plan (docs, plans, session turns)', () => {
    const kinds = new Set(corpus.map((e) => e.kind));
    expect(kinds).toContain('doc');
    expect(kinds).toContain('plan');
    expect(kinds).toContain('turn');
  });

  it('PRESERVES SIBLING CLUSTERS — the property the whole corpus design rests on', () => {
    // A random row sample would scatter same-page sections and make retrieval
    // artificially easy, so every leg would saturate near R@1=1.0 and P-002
    // would read a CEILING ARTIFACT as "the 384 cut costs nothing". Most
    // sampled doc pages must therefore contribute MORE THAN ONE section.
    const byCluster = new Map<string, number>();
    for (const e of corpus) {
      if (e.kind !== 'doc') continue;
      const c = String(e.metadata?.cluster ?? '');
      byCluster.set(c, (byCluster.get(c) ?? 0) + 1);
    }
    const multi = [...byCluster.values()].filter((n) => n > 1).length;
    expect(byCluster.size).toBeGreaterThan(50);
    expect(multi / byCluster.size).toBeGreaterThan(0.8);
    // And at least one page must carry a deep run of siblings.
    expect(Math.max(...byCluster.values())).toBeGreaterThanOrEqual(10);
  });

  it('records the metadata a later regeneration can be diffed against', () => {
    expect(corpusMeta.version).toBe(PROSE_CORPUS_FIXTURE_VERSION);
    expect(corpusMeta.count).toBe(corpus.length);
    expect(corpusMeta.seed).toBeTruthy();
  });
});

describe.skipIf(!fixturesPresent)('prose gold set fixture', () => {
  it('binds to the frozen corpus version', () => {
    // Expected keys are meaningless against a different corpus revision.
    expect(gold.corpusVersion).toBe(PROSE_CORPUS_FIXTURE_VERSION);
    expect(gold.version).toBe(PROSE_GOLD_SET_VERSION);
  });

  it('has unique ids and only known query classes', () => {
    const ids = new Set(gold.queries.map((q) => q.id));
    expect(ids.size).toBe(gold.queries.length);
    for (const q of gold.queries) {
      expect(GOLD_QUERY_CLASSES).toContain(q.class);
      expect(q.query.trim().length).toBeGreaterThan(0);
    }
  });

  it('EVERY expected key resolves to a document in the corpus', () => {
    // The single most damaging silent failure: a query whose target is not in
    // the corpus is unanswerable, so it depresses recall for every leg equally
    // and looks like a hard task rather than a broken label.
    const corpusKeys = new Set(corpus.map((e) => e.key));
    const dangling = gold.queries.flatMap((q) => q.expected.filter((k) => !corpusKeys.has(k)).map((k) => `${q.id} -> ${k}`));
    expect(dangling).toEqual([]);
  });

  it('answerable queries have at least one expected doc; hard negatives have none', () => {
    for (const q of gold.queries) {
      if (q.class === 'hard-negative') expect(q.expected).toEqual([]);
      else expect(q.expected.length).toBeGreaterThan(0);
    }
  });

  it('hard negatives are STILL absent from the corpus (re-verified, not trusted)', () => {
    // The build grep-verifies absence at authoring time, but the corpus can be
    // regenerated later. If a "negative" topic has since appeared, expected=[]
    // becomes a wrong label that inflates the rejection margin for every leg.
    const haystack = corpus.map((e) => e.text.toLowerCase()).join('\n');
    const violations: string[] = [];
    for (const q of gold.queries) {
      if (q.class !== 'hard-negative') continue;
      const m = /anchors: ([^)]+)\)/.exec(q.note ?? '');
      expect(m, `hard negative ${q.id} lost its anchor record`).toBeTruthy();
      for (const anchor of (m?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
        const esc = anchor.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${esc}\\b`).test(haystack)) violations.push(`${q.id}: '${anchor}' now present`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('carries enough answerable queries, and enough of the DIAGNOSTIC class, to be worth running', () => {
    const answerable = gold.queries.filter((q) => q.class !== 'hard-negative');
    expect(answerable.length).toBeGreaterThanOrEqual(100);
    // lexical-gap is the class where MRL truncation damage actually shows up
    // (no lexical overlap to fall back on). An identifier-only gold set would
    // measure rare-token preservation and call it semantic quality.
    const lexicalGap = gold.queries.filter((q) => q.class === 'lexical-gap');
    expect(lexicalGap.length).toBeGreaterThanOrEqual(20);
    expect(gold.queries.filter((q) => q.class === 'hard-negative').length).toBeGreaterThanOrEqual(10);
  });

  it('excludes opaque numeric ids from exact-identifier probes', () => {
    // A bare EI-10103 / "migration 530" is unique and tempting, but no embedder
    // can place an arbitrary integer in semantic space, so every leg scores ~0:
    // a FLOOR artifact that adds N without adding discrimination.
    const bad = gold.queries.filter(
      (q) => q.class === 'exact-identifier' && /^(EI|WI)-\d+$|^migration \d+$/i.test(q.query.trim()),
    );
    expect(bad.map((q) => q.query)).toEqual([]);
  });
});

describe('pickClusters — the cluster-preserving sampler', () => {
  const candidates: ClusterCandidate[] = Array.from({ length: 60 }, (_, i) => ({
    key: `page-${i}`,
    size: (i % 7) + 1,
  }));

  it('is deterministic for a given seed and order-independent', () => {
    const a = pickClusters(candidates, 40, 10, 'seed-a');
    const b = pickClusters([...candidates].reverse(), 40, 10, 'seed-a');
    expect(a.keys).toEqual(b.keys);
  });

  it('produces a different sample for a different seed', () => {
    const a = pickClusters(candidates, 40, 10, 'seed-a');
    const b = pickClusters(candidates, 40, 10, 'seed-b');
    expect(a.keys).not.toEqual(b.keys);
  });

  it('reaches the budget without splitting a cluster', () => {
    const { keys, rows } = pickClusters(candidates, 40, 10, 'seed-a');
    expect(rows).toBeGreaterThanOrEqual(40);
    // Overshoot is bounded by one capped cluster — the price of never splitting.
    expect(rows).toBeLessThan(40 + 10);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('caps any single cluster so one huge page cannot swallow the budget', () => {
    const withGiant: ClusterCandidate[] = [{ key: 'giant', size: 100_000 }, ...candidates];
    const { rows } = pickClusters(withGiant, 50, 5, 'seed-a');
    expect(rows).toBeLessThan(50 + 5);
  });
});
