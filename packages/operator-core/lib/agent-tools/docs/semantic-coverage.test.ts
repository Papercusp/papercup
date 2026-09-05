import { describe, expect, it } from 'vitest';

import type { CoverageSnapshot, SourceCoverageAssessment } from '../../search/coverage-gate';
import {
  assessDocsCoverage,
  DOC_SECTIONS_SURFACE,
  DOCS_COVERAGE_LABEL,
  docsCoverageNote,
  type DocsCoverageDeps,
} from './semantic-coverage';

/**
 * EI-20031763618968912. `docs:search` was the one cosine consumer with no coverage
 * awareness after WI-9393 / D-018 wired the others. These tests pin the properties that
 * make wiring it worth anything:
 *
 *   1. it stays SILENT on the paths where it would only duplicate a better signal
 *      (`legs` already reports a leg that did not run) or say nothing (healthy), and
 *   2. `unknown` — absence of evidence — is SURFACED, never quietly treated as healthy.
 *      That is the binding D-018 constraint and the whole reason to wire a consumer.
 */

function assessment(over: Partial<SourceCoverageAssessment> = {}): SourceCoverageAssessment {
  return {
    source: DOCS_COVERAGE_LABEL,
    verdict: 'degraded',
    coverage: 0.82,
    recentCoverage: null,
    surfaces: [],
    unknownSurfaces: [],
    note: 'doc_sections is 82.0% embedded — hits may be missing.',
    ...over,
  };
}

const RAN = { status: 'ran' } as const;

describe('docsCoverageNote — when the corpus is worth mentioning', () => {
  describe('guard 1: the semantic leg must have actually run', () => {
    // A leg that did not run is already `legs.degraded` + `legs.warning`'s story, and a
    // dead embedder says nothing about which corpus holds the answer. Annotating it with
    // corpus coverage forks one honesty signal into two.
    for (const status of ['not-run', 'errored'] as const) {
      it(`stays silent when the semantic leg status is '${status}', even on a degraded corpus`, () => {
        expect(docsCoverageNote(assessment(), { status })).toBeUndefined();
      });
    }

    it('stays silent when there is no semantic leg at all', () => {
      expect(docsCoverageNote(assessment(), undefined)).toBeUndefined();
    });
  });

  describe('guard 2: only verdicts that mean "your hits may be missing pages"', () => {
    it('stays silent on the healthy path (the overwhelmingly common case)', () => {
      expect(docsCoverageNote(assessment({ verdict: 'healthy', coverage: 0.9972 }), RAN)).toBeUndefined();
    });

    it("stays silent on 'not-semantic'", () => {
      expect(docsCoverageNote(assessment({ verdict: 'not-semantic' }), RAN)).toBeUndefined();
    });
  });

  it('says nothing when the assessment could not be obtained (fail-soft)', () => {
    expect(docsCoverageNote(null, RAN)).toBeUndefined();
    expect(docsCoverageNote(undefined, RAN)).toBeUndefined();
  });

  it('surfaces a degraded corpus with its coverage and the gate’s own note', () => {
    const note = docsCoverageNote(assessment(), RAN);
    expect(note).toEqual({
      verdict: 'degraded',
      coverage: 0.82,
      note: 'doc_sections is 82.0% embedded — hits may be missing.',
    });
  });

  // D-018: this is the case a naive implementation drops, and dropping it is exactly the
  // silent failure the wiring exists to prevent — no sample must not read as "fine".
  it('surfaces UNKNOWN (no fresh sample) rather than treating absence of evidence as healthy', () => {
    const note = docsCoverageNote(assessment({ verdict: 'unknown', coverage: null }), RAN);
    expect(note?.verdict).toBe('unknown');
    expect(note?.coverage).toBeNull();
  });
});

describe('assessDocsCoverage', () => {
  it('is inert under vitest when no seam is injected (no live org-PG read)', async () => {
    expect(process.env.VITEST).toBeTruthy();
    await expect(assessDocsCoverage()).resolves.toBeNull();
  });

  it('assesses exactly the doc_sections surface, under the docs:search label', async () => {
    const seen: { source?: string; surfaces?: readonly string[] } = {};
    const deps: DocsCoverageDeps = {
      loadSnapshot: async () => new Map() as CoverageSnapshot,
      assess: (source, surfaces) => {
        seen.source = source;
        seen.surfaces = surfaces;
        return assessment();
      },
    };

    await expect(assessDocsCoverage(deps)).resolves.toMatchObject({ verdict: 'degraded' });
    expect(seen.source).toBe(DOCS_COVERAGE_LABEL);
    expect(seen.surfaces).toEqual([DOC_SECTIONS_SURFACE]);
  });

  // A coverage probe must never be able to fail a search: the point is to make a weak
  // result legible, and a throw would instead make a working result disappear.
  it('returns null instead of throwing when the snapshot load fails', async () => {
    const deps: DocsCoverageDeps = {
      loadSnapshot: async () => {
        throw new Error('org-pg unavailable');
      },
      assess: () => assessment(),
    };
    await expect(assessDocsCoverage(deps)).resolves.toBeNull();
  });

  it('returns null instead of throwing when the assessment itself throws', async () => {
    const deps: DocsCoverageDeps = {
      loadSnapshot: async () => new Map() as CoverageSnapshot,
      assess: () => {
        throw new Error('gate exploded');
      },
    };
    await expect(assessDocsCoverage(deps)).resolves.toBeNull();
  });
});
