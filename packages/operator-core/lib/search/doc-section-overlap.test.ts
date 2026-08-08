import { describe, expect, it } from 'vitest';

import {
  DOC_OVERLAP_SOURCES,
  createDocSectionNeighbourProvider,
  decodeSectionId,
  describeAgainstNull,
  encodeSectionId,
  loadDocSectionUnits,
  measureNullBaseline,
  pageGroupOf,
  type DocOverlapDeps,
  type DocSectionRef,
  type NullPairSample,
} from './doc-section-overlap';

const MODE = 'gemma';

function stubDeps(over: Partial<DocOverlapDeps> = {}): DocOverlapDeps {
  return {
    loadUnits: async () => [],
    neighboursOf: async () => [],
    sampleNullPairs: async () => [],
    ...over,
  };
}

describe('section id encoding', () => {
  // The fields that actually appear in this corpus: slugs carry slashes and
  // dots, anchors carry hyphens, and a page preamble has an EMPTY anchor. Each
  // one is a delimiter a printable separator would have collided with.
  const cases: DocSectionRef[] = [
    { sourceKey: 'papercusp-guidance', slug: 'tool-guidance/work_items-claim_next', anchor: 'chaining' },
    { sourceKey: 'papercusp-engineering', slug: 'agent-insights/reading-pipeline-state', anchor: '' },
    { sourceKey: 'papercusp-guidance', slug: 'prompts/papercup.persona.novice-mode', anchor: 'tone-and-register' },
    { sourceKey: 'papercusp-guidance', slug: 'blueprints/base/prompts/worker', anchor: 'env-isolation' },
  ];

  it('round-trips every field shape the corpus actually contains', () => {
    for (const ref of cases) {
      expect(decodeSectionId(encodeSectionId(ref))).toEqual(ref);
    }
  });

  it('rejects ids it did not produce rather than guessing at them', () => {
    for (const junk of ['', 'no-separators-at-all', 'only::one::separator', 'a b']) {
      expect(decodeSectionId(junk)).toBeNull();
    }
  });

  it('rejects an id with a blank source or slug, which would silently group wrongly', () => {
    expect(decodeSectionId(encodeSectionId({ sourceKey: '', slug: 's', anchor: 'a' }))).toBeNull();
    expect(decodeSectionId(encodeSectionId({ sourceKey: 'k', slug: '', anchor: 'a' }))).toBeNull();
  });
});

describe('pageGroupOf', () => {
  it('puts two anchors of one page in the SAME group so crossGroupOnly drops the pair', () => {
    const a = pageGroupOf({ sourceKey: 'papercusp-guidance', slug: 'prompts/operator.tools', anchor: 'one' });
    const b = pageGroupOf({ sourceKey: 'papercusp-guidance', slug: 'prompts/operator.tools', anchor: 'two' });
    expect(a).toBe(b);
  });

  it('keeps two DIFFERENT pages in different groups even within one source', () => {
    // This is the finding class the scan exists for: two distinct guidance
    // documents that say the same thing. If same-source pages collapsed into
    // one group, crossGroupOnly would silently drop every one of them.
    const a = pageGroupOf({ sourceKey: 'papercusp-guidance', slug: 'prompts/operator.tools', anchor: '' });
    const b = pageGroupOf({ sourceKey: 'papercusp-guidance', slug: 'prompts/papercup.tools', anchor: '' });
    expect(a).not.toBe(b);
  });

  it('separates the same slug appearing in two sources', () => {
    const a = pageGroupOf({ sourceKey: 'papercusp-guidance', slug: 'memory', anchor: '' });
    const b = pageGroupOf({ sourceKey: 'papercusp-engineering', slug: 'memory', anchor: '' });
    expect(a).not.toBe(b);
  });
});

describe('createDocSectionNeighbourProvider', () => {
  it('decodes the unit and forwards the ref, sources and limit unchanged', async () => {
    const seen: Array<{ ref: DocSectionRef; sources: readonly string[]; mode: string; limit: number }> = [];
    const provider = createDocSectionNeighbourProvider({
      mode: MODE,
      deps: stubDeps({
        neighboursOf: async (ref, sources, mode, limit) => {
          seen.push({ ref, sources, mode, limit });
          return [{ id: 'x', similarity: 0.9 }];
        },
      }),
    });
    const ref: DocSectionRef = { sourceKey: 'papercusp-guidance', slug: 'a/b', anchor: 'c' };
    const hits = await provider({ id: encodeSectionId(ref), group: pageGroupOf(ref) }, 7);

    expect(hits).toEqual([{ id: 'x', similarity: 0.9 }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.ref).toEqual(ref);
    expect(seen[0]!.limit).toBe(7);
    expect(seen[0]!.mode).toBe(MODE);
    expect(seen[0]!.sources).toEqual(DOC_OVERLAP_SOURCES);
  });

  it('FAILS CLOSED on an id it cannot decode instead of reporting zero neighbours', async () => {
    // Returning [] here is indistinguishable from "this section resembles
    // nothing" — a clean result produced by a broken input. The census one
    // layer up cannot see the difference, so this layer must throw.
    let called = false;
    const provider = createDocSectionNeighbourProvider({
      mode: MODE,
      deps: stubDeps({
        neighboursOf: async () => {
          called = true;
          return [];
        },
      }),
    });
    await expect(provider({ id: 'not-an-encoded-id', group: 'g' }, 5)).rejects.toThrow(/encodeSectionId/);
    expect(called).toBe(false);
  });

  it('honours an explicit source list', async () => {
    let got: readonly string[] = [];
    const provider = createDocSectionNeighbourProvider({
      mode: MODE,
      sources: ['papercusp-guidance'],
      deps: stubDeps({
        neighboursOf: async (_ref, sources) => {
          got = sources;
          return [];
        },
      }),
    });
    const ref: DocSectionRef = { sourceKey: 'papercusp-guidance', slug: 's', anchor: '' };
    await provider({ id: encodeSectionId(ref), group: pageGroupOf(ref) }, 3);
    expect(got).toEqual(['papercusp-guidance']);
  });
});

describe('loadDocSectionUnits', () => {
  it('scans both corpora in the active space by default', async () => {
    let got: { sources: readonly string[]; mode: string } | null = null;
    await loadDocSectionUnits({
      mode: MODE,
      deps: stubDeps({
        loadUnits: async (sources, mode) => {
          got = { sources, mode };
          return [];
        },
      }),
    });
    expect(got).toEqual({ sources: DOC_OVERLAP_SOURCES, mode: MODE });
  });
});

describe('measureNullBaseline', () => {
  it('defaults to a sample large enough to have a p99.9 at all', async () => {
    let size = -1;
    await measureNullBaseline({
      mode: MODE,
      deps: stubDeps({
        sampleNullPairs: async (_s, _m, n) => {
          size = n;
          return [];
        },
      }),
    });
    // 300 x 300 draws ~90k pairs per run, so the p99.9 rests on ~90 observations
    // rather than one. A sample too small to populate its own top percentile
    // would produce a threshold argued from a single outlier.
    expect(size).toBe(300);
  });

  it('refuses a sample size that cannot produce a distribution', () => {
    // Thrown SYNCHRONOUSLY, not rejected: a bad sample size is a programmer
    // error at the call site, and surfacing it before any query runs keeps it
    // from arriving later as an empty baseline that reads like a clean corpus.
    for (const bad of [0, 1, -5, 2.5]) {
      expect(() => measureNullBaseline({ mode: MODE, sampleSize: bad, deps: stubDeps() })).toThrow(
        /sampleSize/,
      );
    }
  });
});

describe('describeAgainstNull', () => {
  // The measured gemma null for guidance-vs-guidance, 2026-08-08 (n=11230).
  const sample: NullPairSample = {
    sourceA: 'papercusp-guidance',
    sourceB: 'papercusp-guidance',
    n: 11230,
    p50: 0.6237,
    p95: 0.7127,
    p99: 0.79,
    p999: 0.8461,
    max: 0.9725,
  };

  it('places a real measured duplicate above the null max', () => {
    // prompts/papercup.persona.novice-mode vs prompts/operator.persona.novice-mode,
    // a copy-pasted Tone block measured at 0.991.
    expect(describeAgainstNull(0.991, sample)).toMatch(/above the sampled null max/);
  });

  it('reports the DENOMINATOR in every band, so a verdict cannot be quoted bare', () => {
    for (const v of [0.99, 0.9, 0.85, 0.75, 0.65, 0.3]) {
      expect(describeAgainstNull(v, sample)).toContain('n=11230');
    }
  });

  it('calls out 0.80 as an unremarkable value rather than a duplicate', () => {
    // The headline calibration result: 0.80 is a plausible-looking threshold
    // that sits between p99 and p99.9 of the NULL. Anything that reads it as a
    // strong signal is what this whole function exists to prevent.
    const verdict = describeAgainstNull(0.8, sample);
    expect(verdict).toMatch(/p99-p99\.9 of the null/);
    expect(verdict).not.toMatch(/above the sampled null max/);
  });

  it('flags a value below the null median as less alike than two random sections', () => {
    expect(describeAgainstNull(0.5, sample)).toMatch(/BELOW the null median/);
  });

  it('marks the median-to-p95 band WEAK', () => {
    expect(describeAgainstNull(0.65, sample)).toMatch(/WEAK/);
  });
});
