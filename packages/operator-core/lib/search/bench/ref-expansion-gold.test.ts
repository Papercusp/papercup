/**
 * Unit tests for the derived-gold construction (D-076, reused by P-038).
 *
 * `sampleSql` interpolates two caller-supplied strings into SQL rather than
 * binding them, so the grammar guards are load-bearing, not cosmetic — these
 * pin that they actually refuse. The rest pin the gold construction's
 * documented semantics, which two consumers now depend on.
 */
import { describe, expect, it } from 'vitest';

import {
  buildGoldQueries,
  buildPool,
  degradedQuery,
  sampleSql,
  type SampledRow,
} from './ref-expansion-gold';

describe('sampleSql', () => {
  it('draws randomly by default and reproducibly when seeded', () => {
    expect(sampleSql(10, 5, undefined)).toContain('ORDER BY random()');
    const seeded = sampleSql(10, 5, undefined, 'p038-pilot-v1');
    expect(seeded).toContain("ORDER BY md5(wi.feature_id || 'p038-pilot-v1')");
    expect(seeded).not.toContain('random()');
    // Same seed ⇒ byte-identical SQL ⇒ the same rows judged on a re-run.
    expect(seeded).toBe(sampleSql(10, 5, undefined, 'p038-pilot-v1'));
  });

  it('refuses a seed or harness that is not in the allowed grammar', () => {
    expect(() => sampleSql(10, 5, undefined, "x' OR '1'='1")).toThrow(/seed must be/);
    expect(() => sampleSql(10, 5, "papercusp'; DROP TABLE --")).toThrow(/must be a slug/);
    // The legitimate forms still pass.
    expect(() => sampleSql(10, 5, 'papercusp', 'p038-pilot-v1')).not.toThrow();
  });
});

describe('degradedQuery', () => {
  it('keeps roughly half the content words, in title order', () => {
    const title = 'replication liveness detector restart soak substrate logs booted';
    const out = degradedQuery(title, 'WI-1');
    const words = out.split(' ');
    expect(words.length).toBeGreaterThanOrEqual(3);
    expect(words.length).toBeLessThan(title.split(' ').length);
    // Order is preserved — it is a subset of the title, not a reshuffle.
    const positions = words.map((w) => title.split(' ').indexOf(w));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('is deterministic for a given seed and varies across seeds', () => {
    const title = 'replication liveness detector restart soak substrate logs booted';
    expect(degradedQuery(title, 'WI-1')).toBe(degradedQuery(title, 'WI-1'));
    expect(degradedQuery(title, 'WI-1')).not.toBe(degradedQuery(title, 'WI-99999'));
  });

  it('returns empty for a title with too few content words to degrade', () => {
    expect(degradedQuery('a of the', 'WI-1')).toBe('');
  });
});

describe('buildGoldQueries', () => {
  const rows: SampledRow[] = [
    {
      feature_id: 'D-a',
      v1_text: 'doc a',
      refs_block: '\n\n[refs] WI-9: something',
      refs: [{ ref: 'WI-9', title: 'a sufficiently long referenced item title here' }],
    },
    {
      feature_id: 'D-b',
      v1_text: 'doc b',
      refs_block: '\n\n[refs] WI-9: something',
      refs: [{ ref: 'WI-9', title: 'a sufficiently long referenced item title here' }],
    },
  ];

  it('marks EVERY row citing the ref as relevant, not just the sampled one', () => {
    const [q] = buildGoldQueries(rows, 10);
    expect(q!.ref).toBe('WI-9');
    expect(q!.relevantIds.sort()).toEqual(['D-a', 'D-b']);
  });

  it('strips ref tokens from the query text', () => {
    const withToken: SampledRow[] = [
      {
        ...rows[0]!,
        refs: [{ ref: 'WI-9', title: 'fixing WI-1234 in the replication liveness detector path' }],
      },
    ];
    const [q] = buildGoldQueries(withToken, 10);
    // Leaving the id in would hand the lexical arm a channel the treatment
    // never added — it already occurs verbatim in the referencing row.
    expect(q!.text).not.toMatch(/WI-1234/);
  });

  it('drops queries whose title is too short to be usable', () => {
    const short: SampledRow[] = [
      { ...rows[0]!, refs: [{ ref: 'WI-9', title: 'too short' }] },
    ];
    expect(buildGoldQueries(short, 10)).toEqual([]);
  });
});

describe('buildPool', () => {
  it('makes v2 a pure APPEND of the refs block onto v1', () => {
    const [doc] = buildPool([
      { feature_id: 'D-a', v1_text: 'body', refs_block: '\n\n[refs] WI-9: x', refs: [] },
    ]);
    // The whole A/B rests on v1 being reconstructible by removing the appendix.
    expect(doc!.v2Text).toBe('body\n\n[refs] WI-9: x');
    expect(doc!.v2Text.startsWith(doc!.v1Text)).toBe(true);
  });
});
