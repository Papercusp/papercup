/**
 * capacity-storm-drill.test.ts — P-006 (rubric-system-hardening-2026-07-14,
 * EI-12151): the capacity-storm drill drives the REAL runScoutTick through the
 * three failure legs and proves the write path + read path agree on the persisted
 * bytes. The in-memory ledger JSON-round-trips every row (the jsonb boundary), so
 * "the typed denial survives persistence" is exercised here too. The DISCRIMINATION
 * bar: a drill never shown to fail on a broken classifier is a green light with
 * extra steps — the sabotage cases prove it goes red.
 */
import { describe, expect, it } from 'vitest';

import {
  CAPACITY_STORM_TICK_ORIGIN,
  evaluateCapacityStormEvidence,
  runCapacityStormDrill,
  type CapacityStormDrillDeps,
  type CapacityStormEvidence,
} from './capacity-storm-drill';
import type { RecordScoutTickInput, ScoutTickRow } from './tick-ledger';

/** An in-memory tick ledger that mimics the PG jsonb round-trip (JSON in/out). */
function memoryLedger(): {
  rows: RecordScoutTickInput[];
  deps: CapacityStormDrillDeps;
} {
  const rows: RecordScoutTickInput[] = [];
  const deps: CapacityStormDrillDeps = {
    recordTick: async (rec) => {
      rows.push(JSON.parse(JSON.stringify(rec)) as RecordScoutTickInput);
    },
    readTicks: async (opts) =>
      rows
        .filter((r) => (r.origin ?? 'scout') === (opts.origin ?? 'scout'))
        .filter((r) => (opts.installSlug ? r.installSlug === opts.installSlug : true))
        .map(
          (r) =>
            JSON.parse(
              JSON.stringify({
                status: r.status,
                ...(r.gate ? { gate: r.gate } : {}),
                ...(r.detail ? { detail: r.detail } : {}),
                ...(r.installSlug ? { installSlug: r.installSlug } : {}),
                tickAt: new Date().toISOString(),
              }),
            ) as ScoutTickRow,
        ),
    countForeignOriginTicks: async () => 0,
  };
  return { rows, deps };
}

const ARGS = { harnessSlug: 'papercusp', workspaceId: 'ws-test' };

describe('runCapacityStormDrill — the storm through the real scheduler', () => {
  it('passes end-to-end: capacity gates, timeout + defect stay loud, read path agrees', async () => {
    const { rows, deps } = memoryLedger();
    const result = await runCapacityStormDrill(ARGS, deps);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('capacity-storm');

    const byLeg = Object.fromEntries(result.legs.map((l) => [l.leg, l]));
    // Leg 1: the typed all-accounts-paused denial is a GATE, not an error.
    expect(byLeg['capacity']).toMatchObject({
      tickReason: 'no-capacity',
      persistedStatus: 'gated',
      persistedGate: 'no-capacity',
      classifierVersion: 1,
      readClassifiedCapacity: true,
    });
    // Leg 2: a genuine deployed-wrapper timeout stays an error on BOTH paths.
    expect(byLeg['timeout']).toMatchObject({
      tickReason: 'cycle-error',
      persistedStatus: 'error',
      readClassifiedCapacity: false,
    });
    // Leg 3: no-free-slot + legacy-looking prose stays an error on BOTH paths
    // (typed evidence beats the prose fallback — the WI-4541 inversion guard).
    expect(byLeg['admission-defect']).toMatchObject({
      tickReason: 'cycle-error',
      persistedStatus: 'error',
      classifierVersion: 1,
      readClassifiedCapacity: false,
    });

    // Every recorded row is provenance-stamped at record time.
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.origin).toBe(CAPACITY_STORM_TICK_ORIGIN);
      expect(row.installSlug).toBe(result.drillId);
      expect(row.workspaceId).toBe('ws-test');
    }

    // The timeout row carries the real wrapper's timeout detail.
    const timeoutRow = rows.find((r) => (r.detail?.cycleId as string)?.endsWith('-timeout'));
    expect(typeof timeoutRow?.detail?.timeoutMs).toBe('number');
    // The defect row's prose WOULD match the legacy classifier — proving the
    // versioned-row boundary is what kept it out of the capacity bucket.
    const defectRow = rows.find((r) => (r.detail?.cycleId as string)?.endsWith('-defect'));
    expect(String(defectRow?.detail?.error)).toContain('rate limit exceeded');
    expect(defectRow?.detail?.capacityClassifierVersion).toBe(1);
  });

  it('DISCRIMINATION: goes red when the persisted capacity row lost its classification', async () => {
    const { deps } = memoryLedger();
    const readTicks = deps.readTicks!;
    const sabotaged: CapacityStormDrillDeps = {
      ...deps,
      // Simulate a write-path regression: the capacity row lands as a plain error.
      readTicks: async (opts) =>
        (await readTicks(opts)).map((row) =>
          (row.detail?.cycleId as string)?.endsWith('-capacity')
            ? { ...row, status: 'error' as const, gate: undefined, detail: { cycleId: row.detail?.cycleId } }
            : row,
        ),
    };
    const result = await runCapacityStormDrill(ARGS, sabotaged);
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain("'no-capacity' gate");
    expect(result.failures.join('\n')).toContain('typed admissionDenial');
  });

  it('DISCRIMINATION: goes red when a storm tick leaks outside origin=drill', async () => {
    const { deps } = memoryLedger();
    const result = await runCapacityStormDrill(ARGS, {
      ...deps,
      countForeignOriginTicks: async () => 1,
    });
    expect(result.ok).toBe(false);
    expect(result.evidence.organicTickLeaks).toBe(1);
    expect(result.failures.join('\n')).toContain("leaked outside origin='drill'");
  });

  it('DISCRIMINATION: goes red when a leg never lands a persisted row', async () => {
    const { deps } = memoryLedger();
    const result = await runCapacityStormDrill(ARGS, {
      ...deps,
      recordTick: async () => {}, // ledger write silently lost
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain('persisted');
  });
});

describe('evaluateCapacityStormEvidence — the pure verdict', () => {
  const allGreen: CapacityStormEvidence = {
    capacityGated: true,
    capacityDetailTyped: true,
    capacityReadAgrees: true,
    timeoutStaysError: true,
    timeoutReadStaysError: true,
    defectStaysError: true,
    defectReadStaysError: true,
    allLegsPersisted: true,
    organicTickLeaks: 0,
    organicMetricsUnchanged: true,
  };

  it('ok on all-green', () => {
    expect(evaluateCapacityStormEvidence(allGreen)).toEqual({ ok: true, failures: [] });
  });

  it('names each failed assertion', () => {
    const verdict = evaluateCapacityStormEvidence({
      ...allGreen,
      timeoutStaysError: false,
      capacityReadAgrees: false,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toHaveLength(2);
    expect(verdict.failures.join('\n')).toContain('asymmetry-of-harm');
    expect(verdict.failures.join('\n')).toContain('disagreed with the write path');
  });
});
