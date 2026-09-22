/**
 * EI-20270994401737114 — instrument-snapshot PROVENANCE.
 *
 * The defect this pins: `check:{kind:'instrument'}` is one of six criterion-check
 * arms, and it is the ONLY one the platform does not execute. The other five
 * (tests/cargo/probe/coverage/requirements) run at grading time and write their
 * verdicts to `observation.checkRuns`. The instrument arm reads `instrumentSnapshots`,
 * which is caller-supplied on BOTH scorecard verbs — so the contract's verdict-mismatch
 * check compares the grader's rating to the grader's OWN number. Internal consistency,
 * never measurement. A grader who derives the wrong count files `fail` beside a `fail`
 * snapshot and passes cleanly; that is the retracted grade in EI-20266169712430445.
 *
 * FALSIFIABLE IN BOTH DIRECTIONS. The subject assertions catch a regression that
 * removes/weakens the reporting; the CONTROLS catch the opposite drift — a default
 * that flatters the record, a push moved after an early `continue`, a provenance
 * default written into the hashed snapshot, or the wire schema falling behind the type.
 * Without the controls a test suite here goes quietly vacuous the moment the field
 * stops discriminating.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  evaluateScorecardInstrumentContract,
  scorecardEvidenceFingerprint,
  scorecardInstrumentProvenance,
  type ScorecardInstrumentSnapshot,
} from './scorecards';
// `Rubric` is imported BY scorecards.ts, not re-exported from it — take it from the
// declaring module, the same way scorecards.test.ts does.
import type { Rubric } from './rubrics';

const NOW = Date.parse('2026-07-15T00:01:00Z');
const FRESH = '2026-07-15T00:00:30Z';

const rubric = (over: Partial<Rubric> = {}): Rubric => ({
  gradingAuthority: 'independent',
  rubricId: 'release-r',
  workspaceId: 'default',
  kind: 'standard',
  characteristic: 'release',
  title: 'Release',
  description: '',
  criteria: [
    {
      key: 'cycle',
      title: 'Cycle',
      model: 'm',
      method: 'method',
      driftMarkers: 'bad',
      instrumentKey: 'metrics.cycle',
      window: { kind: 'rolling', ms: 60_000 },
    },
  ],
  ratingScale: ['PASS', 'FAIL', 'UNKNOWN'],
  methodRef: 'runbook',
  releaseGating: true,
  status: 'active',
  createdBy: 'su-1',
  proposedBy: 'su-1',
  ratifiedBy: 'su-2',
  createdAt: '2026-07-15T00:00:00Z',
  updatedAt: '2026-07-15T00:00:00Z',
  ...over,
});

const passRating = { cycle: { rating: 'PASS', evidence: '0/10 errors' } };

describe('scorecardInstrumentProvenance — absent means self-reported, never unknown', () => {
  it('reads an ABSENT provenance as self-reported (the honest default)', () => {
    // Every snapshot ever stored predates any computed path, so absent==self-reported
    // is the true reading. This is the assertion that a "default it to platform-computed
    // / unknown so nothing looks bad" change has to break.
    expect(scorecardInstrumentProvenance({ verdict: 'pass', measuredAt: FRESH })).toBe('self-reported');
  });

  it('reads an explicit self-reported snapshot as self-reported', () => {
    expect(
      scorecardInstrumentProvenance({ verdict: 'pass', measuredAt: FRESH, provenance: 'self-reported' }),
    ).toBe('self-reported');
  });

  it('CONTROL — reads platform-computed as platform-computed, so the reader is not a constant', () => {
    // Without this, every assertion above is satisfied by `() => 'self-reported'`.
    expect(
      scorecardInstrumentProvenance({ verdict: 'pass', measuredAt: FRESH, provenance: 'platform-computed' }),
    ).toBe('platform-computed');
  });

  it('CONTROL — an unrecognized provenance value degrades to self-reported, never to trusted', () => {
    const rogue = { verdict: 'pass', measuredAt: FRESH, provenance: 'trusted' } as unknown as
      ScorecardInstrumentSnapshot;
    expect(scorecardInstrumentProvenance(rogue)).toBe('self-reported');
  });
});

describe('the contract reports which instruments are only self-reported', () => {
  it('flags a bound snapshot carrying no provenance — the entire pre-fix population', () => {
    const out = evaluateScorecardInstrumentContract({
      rubric: rubric(),
      ratings: passRating,
      instrumentSnapshots: { 'metrics.cycle': { verdict: 'pass', measuredAt: FRESH } },
      nowMs: NOW,
    });
    expect(out.selfReportedInstruments).toEqual(['metrics.cycle']);
  });

  it('CONTROL — does NOT flag a platform-computed snapshot', () => {
    // Proves the previous test is discrimination, not a list of every bound key.
    const out = evaluateScorecardInstrumentContract({
      rubric: rubric(),
      ratings: passRating,
      instrumentSnapshots: {
        'metrics.cycle': { verdict: 'pass', measuredAt: FRESH, provenance: 'platform-computed' },
      },
      nowMs: NOW,
    });
    expect(out.selfReportedInstruments).toEqual([]);
  });

  it('does NOT fail `valid` on a self-reported snapshot — deliberate, and pinned so it stays a decision', () => {
    // Today every stored snapshot is self-reported; failing on it would refuse every
    // existing grading path. Making this array gate `valid` must break a test and be
    // argued, not slipped in.
    const out = evaluateScorecardInstrumentContract({
      rubric: rubric(),
      ratings: passRating,
      instrumentSnapshots: { 'metrics.cycle': { verdict: 'pass', measuredAt: FRESH } },
      nowMs: NOW,
    });
    expect(out.selfReportedInstruments).toEqual(['metrics.cycle']);
    expect(out.valid).toBe(true);
  });

  it('still flags a STALE self-reported snapshot (the class is recorded before the freshness continue)', () => {
    // Falsifier: move the push below the staleness `continue` and this goes empty.
    // Stale is exactly when a reader most needs to know the number came from the grader.
    const out = evaluateScorecardInstrumentContract({
      rubric: rubric(),
      ratings: passRating,
      instrumentSnapshots: { 'metrics.cycle': { verdict: 'pass', measuredAt: '2026-07-14T00:00:00Z' } },
      nowMs: NOW,
    });
    expect(out.staleSnapshots).toEqual(['metrics.cycle']);
    expect(out.selfReportedInstruments).toEqual(['metrics.cycle']);
  });

  it('still flags a WINDOW-MISMATCHED self-reported snapshot', () => {
    const out = evaluateScorecardInstrumentContract({
      rubric: rubric({
        criteria: [
          {
            key: 'cycle',
            title: 'Cycle',
            model: 'm',
            method: 'method',
            driftMarkers: 'bad',
            instrumentKey: 'metrics.cycle',
            window: { kind: 'post-watermark', watermarkRef: 'gen-9' },
          },
        ],
      }),
      ratings: passRating,
      instrumentSnapshots: {
        'metrics.cycle': { verdict: 'pass', measuredAt: FRESH, window: { watermarkRef: 'gen-8' } },
      },
      nowMs: NOW,
    });
    expect(out.windowMismatches).toEqual(['metrics.cycle']);
    expect(out.selfReportedInstruments).toEqual(['metrics.cycle']);
  });

  it('CONTROL — reports nothing for an unbound criterion or an explicit `none` binding', () => {
    const out = evaluateScorecardInstrumentContract({
      rubric: rubric({
        criteria: [
          { key: 'cycle', title: 'Cycle', model: 'm', method: 'method', driftMarkers: 'bad', instrumentKey: 'none' },
        ],
      }),
      ratings: passRating,
      instrumentSnapshots: {},
      nowMs: NOW,
    });
    expect(out.selfReportedInstruments).toEqual([]);
  });

  it('CONTROL — a missing snapshot is reported as missing, not as self-reported', () => {
    // An absent measurement is a different failure from an un-independent one;
    // collapsing them would let "nobody measured" hide inside "the grader measured".
    const out = evaluateScorecardInstrumentContract({
      rubric: rubric(),
      ratings: passRating,
      nowMs: NOW,
    });
    expect(out.missingSnapshots).toEqual(['metrics.cycle']);
    expect(out.selfReportedInstruments).toEqual([]);
  });
});

describe('the evidence fingerprint must not shift under this feature', () => {
  it('CALIBRATION — provenance IS part of the hashed snapshot, which is why the default may not be written in', () => {
    // If this ever stops being true the non-mutation test below becomes vacuous
    // rather than false, so it is asserted explicitly.
    const withOut = scorecardEvidenceFingerprint({
      rubricRef: 'release-r',
      ratings: passRating,
      instrumentSnapshots: { 'metrics.cycle': { verdict: 'pass', measuredAt: FRESH } },
    });
    const withIn = scorecardEvidenceFingerprint({
      rubricRef: 'release-r',
      ratings: passRating,
      instrumentSnapshots: {
        'metrics.cycle': { verdict: 'pass', measuredAt: FRESH, provenance: 'self-reported' },
      },
    });
    expect(withOut).not.toBe(withIn);
  });

  it('does not mutate the caller snapshot, so historical fingerprints are unchanged', () => {
    // The failure this prevents: materializing the self-reported default onto the
    // object would rewrite every historical evidence hash (same constraint as
    // testedSha, EI-18706603928993591).
    const snapshot: ScorecardInstrumentSnapshot = { verdict: 'pass', measuredAt: FRESH };
    const before = scorecardEvidenceFingerprint({
      rubricRef: 'release-r',
      ratings: passRating,
      instrumentSnapshots: { 'metrics.cycle': snapshot },
    });

    evaluateScorecardInstrumentContract({
      rubric: rubric(),
      ratings: passRating,
      instrumentSnapshots: { 'metrics.cycle': snapshot },
      nowMs: NOW,
    });

    expect(Object.hasOwn(snapshot, 'provenance')).toBe(false);
    expect(
      scorecardEvidenceFingerprint({
        rubricRef: 'release-r',
        ratings: passRating,
        instrumentSnapshots: { 'metrics.cycle': snapshot },
      }),
    ).toBe(before);
  });
});

describe('the wire schema keeps pace with the type', () => {
  // The snapshot schema is .strict(), so a field that exists on the TS interface but
  // not in the zod object is REJECTED at the wire — the type would be a promise the
  // tool refuses to honour. Asserted against source text because importing evaluate.ts
  // pulls the whole agent-tools graph into a unit test.
  const evaluateSrc = readFileSync(new URL('./agent-tools/scorecards/evaluate.ts', import.meta.url), 'utf8');
  const start = evaluateSrc.indexOf('export const scorecardInstrumentSnapshotSchema');
  const block = start >= 0 ? evaluateSrc.slice(start, evaluateSrc.indexOf('.strict();', start)) : '';

  it('CALIBRATION — the snapshot schema block is actually located and read', () => {
    // Guards every assertion below from passing on an empty string after a refactor.
    expect(start).toBeGreaterThanOrEqual(0);
    expect(block).toContain('evidenceRef');
  });

  it('declares provenance in the strict snapshot schema', () => {
    expect(block).toContain('provenance');
    expect(block).toContain('self-reported');
    expect(block).toContain('platform-computed');
  });
});

describe('the criterion-check executor documents the asymmetry honestly', () => {
  const checksSrc = readFileSync(new URL('./rubrics-criterion-checks.ts', import.meta.url), 'utf8');
  const header = checksSrc.slice(0, checksSrc.indexOf('import '));

  it('CALIBRATION — the header is located and still documents the instrument arm', () => {
    expect(header).toContain("kind:'instrument'");
    expect(header.length).toBeGreaterThan(400);
  });

  it('no longer excuses the missing check by citing the contract as though it measured something', () => {
    // The exact sentence that stopped this from being built: "nothing to enforce
    // against the tree (the scorecard instrument contract already governs it)". It
    // reads as diligence — it names a governing mechanism — and the mechanism it names
    // checks the grader against themselves.
    expect(header).not.toContain('the scorecard instrument contract already governs it');
  });

  it('says who measures, and names the field that exposes the gap', () => {
    expect(header).toContain('selfReportedInstruments');
    expect(header.toLowerCase()).toContain('caller-supplied');
  });
});
