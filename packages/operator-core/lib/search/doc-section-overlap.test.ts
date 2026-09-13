import { describe, expect, it } from 'vitest';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';

import {
  DOC_OVERLAP_SOURCES,
  createDocSectionNeighbourProvider,
  decodeSectionId,
  describeAgainstNull,
  describeDocOverlapScan,
  encodeSectionId,
  loadDocSectionUnits,
  measureNullBaseline,
  pageGroupOf,
  runDocSectionOverlapScan,
  type DocOverlapDeps,
  type DocSectionRef,
  type NullPairSample,
} from './doc-section-overlap';

const MODE = 'gemma';

function stubDeps(over: Partial<DocOverlapDeps> = {}): DocOverlapDeps {
  return {
    loadUnits: async () => ({ units: [], unavailable: 0 }),
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

  it('rejects a blank SOURCE — an unattributable unit has no threshold to be judged by', () => {
    expect(decodeSectionId(encodeSectionId({ sourceKey: '', slug: 's', anchor: 'a' }))).toBeNull();
  });

  it('ACCEPTS a blank slug — it is the corpus root page, not a malformed id', () => {
    // This assertion was inverted until 2026-08-08, and the inversion is what
    // killed the scan's first live run. The original rationale was that a blank
    // slug "would silently group wrongly"; measured, it does not — the five real
    // root-page sections all map to the single group `papercusp-engineering::`,
    // which is exactly right, because they ARE one page.
    const root = { sourceKey: 'papercusp-engineering', slug: '', anchor: 'status' };
    expect(decodeSectionId(encodeSectionId(root))).toEqual(root);
    expect(pageGroupOf(root)).toBe('papercusp-engineering::');
  });
});

describe('encode/decode round-trip against shapes the LIVE corpus actually contains', () => {
  // These are not invented edge cases. Each is a measured property of
  // harness_shared.doc_sections (2026-08-08, 10,056 embedded gemma sections),
  // and the first one KILLED the scan's first live run: decodeSectionId
  // rejected an empty slug, so the encoder emitted ids from real rows that the
  // decoder refused, and the neighbour provider's fail-closed guard threw. All
  // 17 unit tests were green at the time because every fixture supplied a
  // hand-written slug.
  const measured: Array<[string, DocSectionRef]> = [
    // 5 real sections: the engineering corpus ROOT page, slug ''.
    ['root page — empty slug', { sourceKey: 'papercusp-engineering', slug: '', anchor: 'what-this-is' }],
    ['root page preamble — empty slug AND empty anchor', { sourceKey: 'papercusp-engineering', slug: '', anchor: '' }],
    // 417 real sections: a page preamble, empty anchor. Already accepted — it
    // is the CONTROL that shows the two empty-field cases were treated
    // asymmetrically for no reason.
    ['page preamble — empty anchor', { sourceKey: 'papercusp-guidance', slug: 'guide/a', anchor: '' }],
    ['ordinary section', { sourceKey: 'papercusp-guidance', slug: 'guide/a', anchor: 's1' }],
  ];

  for (const [label, ref] of measured) {
    it(`round-trips: ${label}`, () => {
      expect(decodeSectionId(encodeSectionId(ref))).toEqual(ref);
    });
  }

  it('still rejects an empty sourceKey — an unattributable unit has no threshold', () => {
    // Not merely "invalid input": every threshold in this scan is chosen per
    // source PAIR, so a unit with no source cannot be judged at all.
    expect(decodeSectionId(encodeSectionId({ sourceKey: '', slug: 'guide/a', anchor: 's1' }))).toBeNull();
  });

  it('still rejects a string it did not produce', () => {
    for (const notAnId of ['', 'plain', 'a::b::c', 'one\\u001ftwo']) {
      expect(decodeSectionId(notAnId)).toBeNull();
    }
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
          return { units: [], unavailable: 0 };
        },
      }),
    });
    expect(got).toEqual({ sources: DOC_OVERLAP_SOURCES, mode: MODE });
  });

  it('passes the mode\'s exact current profile to the storage query', async () => {
    let profileId: string | null = null;
    await loadDocSectionUnits({
      mode: MODE,
      deps: stubDeps({
        loadUnits: async (_sources, _mode, selection) => {
          profileId = selection.profileId;
          return { units: [], unavailable: 0 };
        },
      }),
    });
    expect(profileId).toBe(EMBEDDER_DIM_SPECS.gemma.profileId);
  });

  it('fails closed for an unknown mode instead of issuing a mode-only scan', async () => {
    expect(() =>
      loadDocSectionUnits({ mode: 'future-mode', deps: stubDeps() }),
    ).toThrow(/no accepted prose profile/);
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

/* --------------------------------------------------------------------- *
 * runDocSectionOverlapScan — the per-source-pair threshold rule
 * --------------------------------------------------------------------- */

const G = 'papercusp-guidance';
const E = 'papercusp-engineering';

/**
 * A miniature corpus whose pairs sit in the band where the two thresholds
 * DISAGREE (0.88 <= s < 0.92). That band is the whole reason D-003 split them,
 * so it is the only band where a test can tell a correct implementation from
 * one that applied a single global threshold and passed anyway.
 */
function miniCorpus(): DocOverlapDeps {
  const refs = {
    gA: { sourceKey: G, slug: 'guide/a', anchor: 's1' },
    gB: { sourceKey: G, slug: 'guide/b', anchor: 's1' },
    eX: { sourceKey: E, slug: 'eng/x', anchor: 's1' },
  } satisfies Record<string, DocSectionRef>;
  type Key = keyof typeof refs;
  // Both pairs score 0.90 — identical similarity, different source pairing.
  const sims: Array<[Key, Key, number]> = [
    ['gA', 'gB', 0.9], // same-source: must be REJECTED at 0.92
    ['gA', 'eX', 0.9], // cross-source: must be KEPT at 0.88
  ];
  return {
    loadUnits: async () => ({
      units: Object.values(refs).map((r) => ({ id: encodeSectionId(r), group: pageGroupOf(r) })),
      unavailable: 0,
    }),
    neighboursOf: async (ref) => {
      const selfKey = (Object.keys(refs) as Key[]).find(
        (k) => encodeSectionId(refs[k]) === encodeSectionId(ref),
      );
      if (!selfKey) return [];
      return sims
        .filter(([a, b]) => a === selfKey || b === selfKey)
        .map(([a, b, s]) => ({ id: encodeSectionId(refs[a === selfKey ? b : a]), similarity: s }));
    },
    sampleNullPairs: async () => [],
  };
}

describe('runDocSectionOverlapScan', () => {
  const THRESHOLDS = { sameSource: 0.92, crossSource: 0.88 };

  it('applies a DIFFERENT threshold per source pair, so an identical similarity lands differently', async () => {
    const report = await runDocSectionOverlapScan({ mode: MODE, deps: miniCorpus(), thresholds: THRESHOLDS });

    expect(report.inconclusive).toBeNull();
    expect(report.findings).toHaveLength(1);
    const only = report.findings[0]!;
    expect(only.sameSource).toBe(false);
    expect(only.appliedThreshold).toBe(0.88);
    expect([only.refA.sourceKey, only.refB.sourceKey].sort()).toEqual([E, G]);

    // CONTROL: the rejected pair scored EXACTLY the same 0.90. If a future
    // change collapses to one global threshold, this expectation is what fails —
    // the kept-pair assertion above would still pass at any threshold <= 0.90.
    const sameLeg = report.bySourcePair.find((y) => y.sameSource);
    expect(sameLeg).toMatchObject({ threshold: 0.92, kept: 0, rejected: 1 });
  });

  it('runs the base scan at the LOWER threshold — the union of both legs, not either one', async () => {
    const report = await runDocSectionOverlapScan({ mode: MODE, deps: miniCorpus(), thresholds: THRESHOLDS });
    expect(report.scanThreshold).toBe(0.88);
    // Both pairs reached the filter; only the per-source-pair rule removed one.
    expect(report.base.census.pairsAboveThreshold).toBe(2);
  });

  it('reports every source-pair leg it saw, including one that yielded nothing', async () => {
    const report = await runDocSectionOverlapScan({ mode: MODE, deps: miniCorpus(), thresholds: THRESHOLDS });
    expect(report.bySourcePair).toHaveLength(2);
    const rendered = describeDocOverlapScan(report);
    // A zero-yield leg must be VISIBLE in the prose, not absent from it: an
    // omitted leg reads as "no such comparison was attempted".
    expect(rendered).toContain('same-source');
    expect(rendered).toContain('CROSS-source');
    expect(rendered).toContain('0 kept');
  });

  it('marks the cross-source leg\'s zero-rejected as STRUCTURAL, not as a measurement', async () => {
    // The base scan runs at the LOWER threshold, which IS the cross-source one,
    // so that leg can never reject anything — its `rejected: 0` is guaranteed by
    // construction. Reported bare it reads as "this leg was clean", which is a
    // claim the run did not make. The first live run rendered exactly that.
    const report = await runDocSectionOverlapScan({ mode: MODE, deps: miniCorpus(), thresholds: THRESHOLDS });

    const cross = report.bySourcePair.find((y) => !y.sameSource)!;
    expect(cross.threshold).toBe(report.scanThreshold);
    expect(cross.rejected).toBe(0);
    expect(cross.rejectedIsStructuralZero).toBe(true);

    // The same-source leg's threshold sits ABOVE the base, so ITS count is real.
    const same = report.bySourcePair.find((y) => y.sameSource)!;
    expect(same.rejectedIsStructuralZero).toBe(false);

    const rendered = describeDocOverlapScan(report);
    expect(rendered).toContain('rejected n/a');
    expect(rendered).toContain('1 below its threshold');
  });

  it('is INCONCLUSIVE when the base scan was truncated, because truncation drops the cross-source band', async () => {
    const report = await runDocSectionOverlapScan({
      mode: MODE,
      deps: miniCorpus(),
      thresholds: THRESHOLDS,
      maxPairs: 1, // keeps only the highest-scoring pair
    });
    expect(report.base.census.pairsDropped).toBeGreaterThan(0);
    expect(report.inconclusive).toMatch(/maxPairs cap/);
    expect(describeDocOverlapScan(report)).toContain('INCONCLUSIVE');
  });

  it('refuses to guess a threshold for an id it did not produce', async () => {
    const encoded = encodeSectionId({ sourceKey: G, slug: 'guide/a', anchor: 's1' });
    await expect(
      runDocSectionOverlapScan({
        mode: MODE,
        thresholds: THRESHOLDS,
        deps: {
          ...miniCorpus(),
          loadUnits: async () => ({
            units: [
              { id: encoded, group: pageGroupOf({ sourceKey: G, slug: 'guide/a', anchor: 's1' }) },
              { id: 'not-an-encoded-id', group: 'some-other-page' },
            ],
            unavailable: 0,
          }),
          // The neighbour PROVIDER decodes the probe, so the undecodable id has
          // to arrive as a HIT — which is exactly how a real corrupted row would
          // reach the pair path, past the provider's own guard.
          neighboursOf: async () => [{ id: 'not-an-encoded-id', similarity: 0.99 }],
        },
      }),
    ).rejects.toThrow(/not produced by encodeSectionId/);
  });

  it('throws on a missing threshold rather than defaulting one', async () => {
    for (const thresholds of [{ sameSource: 0.92 }, { crossSource: 0.88 }, {}]) {
      await expect(
        runDocSectionOverlapScan({
          mode: MODE,
          deps: miniCorpus(),
          thresholds: thresholds as never,
        }),
      ).rejects.toThrow(/must be a finite number/);
    }
  });
});
