/**
 * success-metrics-code-hash-floor.test.ts — buildProgramSuccessReport's WI-5451 fix.
 *
 * The bug (verified live 2026-07-19): a `watermarkRef`/`sinceMs` window floor never
 * reached the WI-5397 code-hash union reads, so `readScoutTicksByCodeHash` unioned in a
 * PRE-floor, code-identical tick as if it were evidence for the running (post-floor)
 * generation — a floor requested by the caller was silently ignored.
 *
 * The fix INTERSECTS, never replaces: `buildProgramSuccessReport` threads its own
 * `opts.sinceMs` into BOTH tick-ledger reads (`readNewestScoutCodeHash` +
 * `readScoutTicksByCodeHash`) ONLY when the caller explicitly requested a floor —
 * `scopes.tickSinceMs` (always populated, even on the implicit rolling-default path)
 * would be the wrong signal to key off of; `opts.sinceMs` is the caller's ask.
 *
 * Kept in its OWN file (not success-metrics.test.ts) so its module-level mocks of
 * quality-metrics/tick-ledger never leak into that file's unmocked-by-design pure-core
 * fixtures (mirrors scheduler-scout-code-hash.test.ts's own isolation rationale). The
 * SQL-level intersection itself (a floored read never counts a pre-floor tick) is pinned
 * against real PG in tick-ledger.integration.test.ts; this file pins the WIRING between
 * buildProgramSuccessReport and those readers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScoutQualityInputs } from './quality-metrics';
import { CREATIVE_LENSES, type CreativeLens } from './types';

const mocks = vi.hoisted(() => ({
  buildQualityReportInputs: vi.fn(),
  readNewestScoutCodeHash: vi.fn(),
  readScoutTicksByCodeHash: vi.fn(),
}));

vi.mock('./quality-metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./quality-metrics')>();
  return { ...actual, buildQualityReportInputs: mocks.buildQualityReportInputs };
});

vi.mock('./tick-ledger', () => ({
  readNewestScoutCodeHash: mocks.readNewestScoutCodeHash,
  readScoutTicksByCodeHash: mocks.readScoutTicksByCodeHash,
}));

const { buildProgramSuccessReport } = await import('./success-metrics');

const emptyQuality = (): ScoutQualityInputs<CreativeLens> => ({
  ticks: [],
  routedIdeas: [],
  lensOutcomes: {
    total: 0,
    ranked: [],
    byLens: Object.fromEntries(
      CREATIVE_LENSES.map((l) => [l, { won: 0, lost: 0, pending: 0, winRate: null, weight: 1 }]),
    ) as ScoutQualityInputs<CreativeLens>['lensOutcomes']['byLens'],
  },
});

describe('buildProgramSuccessReport — code-hash union floor threading (WI-5451)', () => {
  beforeEach(() => {
    mocks.buildQualityReportInputs.mockReset().mockResolvedValue(emptyQuality());
    mocks.readNewestScoutCodeHash.mockReset().mockResolvedValue('hash-x');
    mocks.readScoutTicksByCodeHash.mockReset().mockResolvedValue([]);
  });

  it('passes NO sinceMs to either tick-ledger read on the implicit rolling-default path (no explicit floor requested)', async () => {
    await buildProgramSuccessReport({});
    expect(mocks.readNewestScoutCodeHash).toHaveBeenCalledOnce();
    expect(mocks.readNewestScoutCodeHash.mock.calls[0]![0]).not.toHaveProperty('sinceMs');
    expect(mocks.readScoutTicksByCodeHash).toHaveBeenCalledOnce();
    expect(mocks.readScoutTicksByCodeHash.mock.calls[0]![0]).not.toHaveProperty('sinceMs');
  });

  it('threads the caller\'s EXPLICIT sinceMs into BOTH tick-ledger reads — intersect, not replace', async () => {
    const sinceMs = Date.parse('2026-07-19T02:30:00Z');
    await buildProgramSuccessReport({ sinceMs });
    expect(mocks.readNewestScoutCodeHash.mock.calls[0]![0]).toMatchObject({ sinceMs });
    expect(mocks.readScoutTicksByCodeHash.mock.calls[0]![0]).toMatchObject({ sinceMs, codeHash: 'hash-x' });
  });

  it('an explicit floor with NO post-floor hash yet resolves UNKNOWN (readNewestScoutCodeHash → null), never falls back to the previous generation\'s ledger hash', async () => {
    const sinceMs = Date.parse('2026-07-19T02:30:00Z');
    mocks.readNewestScoutCodeHash.mockResolvedValue(null);
    const report = await buildProgramSuccessReport({ sinceMs });
    // The union is unavailable — the bar falls back to the (correctly floored, via
    // buildQualityReportInputs' own tickSinceMs) time-windowed read rather than
    // resolving a codeHash from before the requested floor.
    expect(report.window.codeHash).toBeUndefined();
    expect(mocks.readScoutTicksByCodeHash).not.toHaveBeenCalled();
  });

  it('propagates the code-hash union + provenance onto the report when it resolves under a floor', async () => {
    const sinceMs = Date.parse('2026-07-19T02:30:00Z');
    mocks.readScoutTicksByCodeHash.mockResolvedValue([
      { status: 'ran', detail: { cycleId: 'post-floor', scoutCodeHash: 'hash-x' } },
    ]);
    const report = await buildProgramSuccessReport({ sinceMs });
    expect(report.window.codeHash).toBe('hash-x');
    expect(report.window.codeHashTicks).toBe(1);
  });
});
