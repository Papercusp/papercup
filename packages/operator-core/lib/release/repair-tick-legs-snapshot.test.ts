/**
 * WI-2143253 — `parseRepairTickLegs` / `repairTickLegsCurrent`.
 *
 * These are the read-side half of the gap: `gate_health.repairTickLegs` (release-actions.ts
 * writes it on every awaiting-fixer hold tick) carried real per-leg lint/perf/desktop/delta
 * status all along; nothing ever parsed it back out. Malformed input must degrade to `null`
 * (or a filtered leg list), never throw — this parses an externally-controlled JSONB blob.
 */
import { describe, it, expect } from 'vitest';
import {
  parseRepairTickLegs,
  partitionSameHeadContradictions,
  releaseFixerTargetsAfterSameHeadContradictions,
  repairTickClearedQueueSignature,
  repairTickLegsCurrent,
  type StoredRepairTickLegs,
} from './repair-tick-legs-snapshot';

describe('parseRepairTickLegs', () => {
  it('parses a well-formed measurement, including a mix of pass/fail/errored legs', () => {
    const parsed = parseRepairTickLegs({
      head: 'abc123def456',
      atMs: 1_000,
      ok: false,
      failingSignatures: ['lint:design-primitives', 'lint:plane-integrity'],
      legs: [
        { id: 'lint:design-primitives', status: 'fail', durationMs: 420 },
        { id: 'lint:plane-integrity', status: 'errored', durationMs: 10 },
        { id: 'lint:tsc', status: 'pass', durationMs: 5000 },
      ],
    });
    expect(parsed).toEqual({
      populationEvidence: { status: 'unknown' },
      head: 'abc123def456',
      atMs: 1_000,
      ok: false,
      failingSignatures: ['lint:design-primitives', 'lint:plane-integrity'],
      legs: [
        { id: 'lint:design-primitives', status: 'fail', durationMs: 420 },
        { id: 'lint:plane-integrity', status: 'errored', durationMs: 10 },
        { id: 'lint:tsc', status: 'pass', durationMs: 5000 },
      ],
    });
  });

  it.each([19, 20, 21, 31, 32, 33])('preserves a complete %i-leg population and decisive late pass across restart', (count) => {
    const ids = Array.from({ length: count }, (_, index) => `lint:population-${index}`);
    for (const ordered of [ids, [...ids].reverse()]) {
      const head = 'a'.repeat(40);
      let snapshot = parseRepairTickLegs({ head, atMs: 1, ok: true, failingSignatures: [],
        legs: ordered.map((id) => ({ id, status: 'pass', durationMs: 1 })),
        populationEvidence: { status: 'complete', measuredLegCount: count, failingSignatureCount: 0 },
      })!;
      for (let restart = 0; restart < 4; restart += 1) {
        snapshot = parseRepairTickLegs(JSON.parse(JSON.stringify(snapshot)))!;
        expect(snapshot.legs.map((leg) => leg.id)).toEqual(ordered);
        expect(snapshot.populationEvidence?.status).toBe('complete');
        expect(repairTickClearedQueueSignature(snapshot, { repairHead: head, failingTests: [ordered.at(-1)!] })).toBe(true);
      }
    }
  });

  it.each(['legacy', 'empty', 'clipped', 'duplicate', 'malformed', 'signature-mismatch'] as const)
    ('keeps %s population unknown until a complete remeasurement replaces it', (kind) => {
      const head = 'a'.repeat(40);
      const id = 'lint:decisive';
      const raw = { head, atMs: 1, ok: true, failingSignatures: [] as unknown[],
        legs: [{ id, status: 'pass', durationMs: 1 }] as unknown[],
        populationEvidence: { status: 'complete', measuredLegCount: 1, failingSignatureCount: 0 } as unknown,
      };
      const complete = JSON.parse(JSON.stringify(raw));
      if (kind === 'legacy') delete (raw as { populationEvidence?: unknown }).populationEvidence;
      if (kind === 'empty' || kind === 'clipped') raw.legs = [];
      if (kind === 'duplicate') raw.legs = [raw.legs[0], raw.legs[0]];
      if (kind === 'malformed') raw.legs.push({ id: 'lint:bad', status: 'unknown', durationMs: 1 });
      if (kind === 'signature-mismatch') raw.failingSignatures = [id];
      let snapshot = parseRepairTickLegs(raw)!;
      for (let restart = 0; restart < 3; restart += 1) {
        snapshot = parseRepairTickLegs(JSON.parse(JSON.stringify(snapshot)))!;
        expect(snapshot.populationEvidence?.status).toBe('unknown');
        expect(repairTickClearedQueueSignature(snapshot, { repairHead: head, failingTests: [id] })).toBe(false);
        expect(partitionSameHeadContradictions([id], snapshot, head)).toEqual({ contradicted: [], actionable: [id] });
      }
      if (kind === 'malformed') expect(snapshot.populationEvidence?.unreadableEntries)
        .toContainEqual({ id: 'lint:bad', status: 'unknown', durationMs: 1 });
      const recovered = parseRepairTickLegs(complete)!;
      expect(recovered.populationEvidence?.status).toBe('complete');
      expect(repairTickClearedQueueSignature(recovered, { repairHead: head, failingTests: [id] })).toBe(true);
    });

  it('distinguishes a complete empty population from a legacy empty snapshot', () => {
    const raw = { head: 'a'.repeat(40), atMs: 1, ok: true, failingSignatures: [], legs: [] };
    expect(parseRepairTickLegs(raw)?.populationEvidence?.status).toBe('unknown');
    expect(parseRepairTickLegs({ ...raw, populationEvidence: { status: 'complete', measuredLegCount: 0, failingSignatureCount: 0 } })
      ?.populationEvidence?.status).toBe('complete');
  });

  it('returns null for a missing/blank head — the field the currency check depends on', () => {
    expect(parseRepairTickLegs({ atMs: 1, ok: true, failingSignatures: [], legs: [] })).toBeNull();
    expect(parseRepairTickLegs({ head: '', atMs: 1, ok: true, failingSignatures: [], legs: [] })).toBeNull();
  });

  it('returns null for a missing/non-numeric atMs', () => {
    expect(parseRepairTickLegs({ head: 'abc', ok: true, failingSignatures: [], legs: [] })).toBeNull();
    expect(parseRepairTickLegs({ head: 'abc', atMs: 'nope', ok: true, failingSignatures: [], legs: [] })).toBeNull();
  });

  it('returns null for non-object / null / array input, never throws', () => {
    expect(parseRepairTickLegs(null)).toBeNull();
    expect(parseRepairTickLegs(undefined)).toBeNull();
    expect(parseRepairTickLegs('a string')).toBeNull();
    expect(parseRepairTickLegs(42)).toBeNull();
    expect(parseRepairTickLegs([])).toBeNull();
  });

  it('drops individual malformed leg entries rather than failing the whole parse', () => {
    const parsed = parseRepairTickLegs({
      head: 'abc123def456',
      atMs: 1_000,
      ok: false,
      failingSignatures: ['lint:tsc'],
      legs: [
        { id: 'lint:tsc', status: 'fail', durationMs: 12 }, // valid
        { id: '', status: 'fail', durationMs: 1 }, // blank id — dropped
        { status: 'fail', durationMs: 1 }, // missing id — dropped
        { id: 'lint:x', status: 'unknown-status', durationMs: 1 }, // bad status enum — dropped
        'not-an-object', // dropped
        null, // dropped
      ],
    });
    expect(parsed?.legs).toEqual([{ id: 'lint:tsc', status: 'fail', durationMs: 12 }]);
  });

  it('defaults durationMs to null when absent or non-numeric, without dropping the leg', () => {
    const parsed = parseRepairTickLegs({
      head: 'abc123def456',
      atMs: 1_000,
      ok: true,
      failingSignatures: [],
      legs: [{ id: 'lint:tsc', status: 'pass' }],
    });
    expect(parsed?.legs).toEqual([{ id: 'lint:tsc', status: 'pass', durationMs: null }]);
  });

  it('filters non-string entries out of failingSignatures and tolerates a non-array value', () => {
    const parsed = parseRepairTickLegs({
      head: 'abc123def456',
      atMs: 1_000,
      ok: false,
      failingSignatures: ['lint:tsc', 42, null, 'lint:x'],
      legs: [],
    });
    expect(parsed?.failingSignatures).toEqual(['lint:tsc', 'lint:x']);

    const parsedNoSigs = parseRepairTickLegs({ head: 'abc', atMs: 1, ok: true, legs: [] });
    expect(parsedNoSigs?.failingSignatures).toEqual([]);
  });

  it('normalizes ok to a strict boolean rather than passing through a truthy value', () => {
    const parsed = parseRepairTickLegs({ head: 'abc', atMs: 1, ok: 'yes', failingSignatures: [], legs: [] });
    expect(parsed?.ok).toBe(false);
  });
});

describe('repairTickLegsCurrent', () => {
  it('is true when the live repairHead sha starts with the (short, persisted) leg-measurement head', () => {
    expect(
      repairTickLegsCurrent({ head: 'abc123def456' }, 'abc123def4567890000000000000000000000000'),
    ).toBe(true);
  });

  it('is false when the live repairHead has moved past the measured head', () => {
    expect(repairTickLegsCurrent({ head: 'abc123def456' }, 'fff000000000000000000000000000000000000')).toBe(false);
  });

  it('is null (unknown, not false) when there is no live repairHead to compare against', () => {
    expect(repairTickLegsCurrent({ head: 'abc123def456' }, null)).toBeNull();
  });
});

describe('repairTickClearedQueueSignature', () => {
  const HEAD = 'aa9487596d5406cc49d424a4162d99634b214cdf';
  const LANE = '@papercusp/operator-core :: test:lane-stateful';
  const tick = (over: Partial<StoredRepairTickLegs> = {}): StoredRepairTickLegs => ({
    populationEvidence: { status: 'complete' },
    head: HEAD.slice(0, 12),
    atMs: 1_000,
    ok: true,
    failingSignatures: [],
    legs: [
      { id: 'lint:tsc', status: 'pass', durationMs: 1 },
      { id: LANE, status: 'pass', durationMs: 1_159_339 },
    ],
    ...over,
  });

  it('is true when the tick at the current head re-ran and passed every queue signature', () => {
    expect(repairTickClearedQueueSignature(tick(), { repairHead: HEAD, failingTests: [LANE] })).toBe(true);
  });

  it('is false when the tick measured an earlier head', () => {
    expect(
      repairTickClearedQueueSignature(tick({ head: 'fff000000000' }), { repairHead: HEAD, failingTests: [LANE] }),
    ).toBe(false);
  });

  it('is false when any tick leg failed', () => {
    expect(
      repairTickClearedQueueSignature(tick({ ok: false, failingSignatures: ['lint:tsc'] }), {
        repairHead: HEAD,
        failingTests: [LANE],
      }),
    ).toBe(false);
  });

  it('is false when a queue signature was never re-run by the tick (a test file, not a leg)', () => {
    expect(
      repairTickClearedQueueSignature(tick(), {
        repairHead: HEAD,
        failingTests: [LANE, 'lib/agent-tools/plans/arm-schedule.test.ts'],
      }),
    ).toBe(false);
  });

  it('is false with no measurement or an empty queue failing set', () => {
    expect(repairTickClearedQueueSignature(null, { repairHead: HEAD, failingTests: [LANE] })).toBe(false);
    expect(repairTickClearedQueueSignature(tick(), { repairHead: HEAD, failingTests: [] })).toBe(false);
  });
});

// WI-10007494: a same-head contradiction mixed with a real red. Before this, nothing removed
// the contradicted entry, so the fixer was told to fix a leg its own head had passed.
describe('partitionSameHeadContradictions / releaseFixerTargetsAfterSameHeadContradictions', () => {
  const HEAD = 'aa9487596d5406cc49d424a4162d99634b214cdf';
  const LANE = '@papercusp/operator-core :: test:lane-stateful';
  const FILE = 'packages/operator-core/lib/agent-tools/plans/arm-schedule.test.ts';
  const LINT = 'lint:design-primitives';
  const tick = (over: Partial<StoredRepairTickLegs> = {}): StoredRepairTickLegs => ({
    populationEvidence: { status: 'complete' },
    head: HEAD.slice(0, 12),
    atMs: 1_000,
    ok: false,
    failingSignatures: [LINT],
    legs: [
      { id: LANE, status: 'pass', durationMs: 1_159_339 },
      { id: LINT, status: 'fail', durationMs: 4_000 },
    ],
    ...over,
  });

  it('splits a passed same-head leg from a real red and a test file, keeping input order', () => {
    expect(partitionSameHeadContradictions([FILE, LANE, LINT], tick(), HEAD)).toEqual({
      contradicted: [LANE],
      actionable: [FILE, LINT],
    });
  });

  it('contradicts nothing when the tick measured an earlier head', () => {
    expect(partitionSameHeadContradictions([LANE, LINT], tick({ head: 'fff000000000' }), HEAD)).toEqual({
      contradicted: [],
      actionable: [LANE, LINT],
    });
  });

  it('contradicts nothing when currency cannot be judged (no repairHead) or there is no tick', () => {
    expect(partitionSameHeadContradictions([LANE], tick(), null).contradicted).toEqual([]);
    expect(partitionSameHeadContradictions([LANE], null, HEAD)).toEqual({ contradicted: [], actionable: [LANE] });
  });

  it('keeps an id actionable when the same tick also recorded it failing or errored', () => {
    const dup = tick({
      failingSignatures: [],
      legs: [
        { id: LANE, status: 'pass', durationMs: 1 },
        { id: LANE, status: 'errored', durationMs: 2 },
      ],
    });
    expect(partitionSameHeadContradictions([LANE], dup, HEAD).contradicted).toEqual([]);
    const named = tick({ failingSignatures: [LANE], legs: [{ id: LANE, status: 'pass', durationMs: 1 }] });
    expect(partitionSameHeadContradictions([LANE], named, HEAD).contradicted).toEqual([]);
  });

  it('never contradicts a test-file entry, which is not a tick leg id', () => {
    expect(partitionSameHeadContradictions([FILE], tick(), HEAD)).toEqual({ contradicted: [], actionable: [FILE] });
  });

  it('hands the fixer only the real red in the mixed case and names the contradicted entry', () => {
    expect(releaseFixerTargetsAfterSameHeadContradictions([LANE, LINT], tick(), HEAD)).toEqual({
      targets: [LINT],
      sameHeadContradicted: [LANE],
    });
  });

  it('leaves an all-contradicted signature to the retest path rather than emptying the target list', () => {
    const allPassed = tick({ ok: true, failingSignatures: [], legs: [{ id: LANE, status: 'pass', durationMs: 1 }] });
    expect(releaseFixerTargetsAfterSameHeadContradictions([LANE], allPassed, HEAD)).toEqual({
      targets: [LANE],
      sameHeadContradicted: [],
    });
    expect(repairTickClearedQueueSignature(allPassed, { repairHead: HEAD, failingTests: [LANE] })).toBe(true);
  });

  it('returns the input unchanged when nothing is contradicted', () => {
    expect(releaseFixerTargetsAfterSameHeadContradictions([FILE, LINT], tick(), HEAD)).toEqual({
      targets: [FILE, LINT],
      sameHeadContradicted: [],
    });
    expect(releaseFixerTargetsAfterSameHeadContradictions(undefined, tick(), HEAD)).toEqual({
      targets: [],
      sameHeadContradicted: [],
    });
  });
});
