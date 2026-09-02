/**
 * Unit tests for correction-decay-miner (P-019) — the MEMORY and CAPTURE side.
 *
 * The measurement maths is covered by `../../correction-decay.test.ts`; what is tested
 * here is the part that exists only in this module: that the persisted snapshot can carry
 * a baseline PAST the raw table's ~14-day retention, which is the whole reason this tick
 * writes anything at all.
 */
import { describe, expect, it, vi } from 'vitest';
import { rollupCorrectionShape, type CorrectionShapeDayRow } from '../../correction-decay';
import {
  CORRECTION_DECAY_METADATA_KEY,
  CORRECTION_DECAY_ROUTINE_TARGET,
  mergeCorrectionSnapshot,
  runCorrectionDecayMinerTick,
  snapshotToRows,
  type CorrectionDecaySnapshot,
} from './correction-decay-miner';

const RULE = 'premises.unwrap-ref-objects';

function day(
  d: string,
  fieldCalls: number,
  coercedCalls: number,
  coercedOkCalls = 0,
): CorrectionShapeDayRow {
  return { rule: RULE, day: d, fieldCalls, coercedCalls, coercedOkCalls, distinctOwners: 30 };
}

describe('mergeCorrectionSnapshot', () => {
  it('round-trips a day through the snapshot without losing a count', () => {
    const merged = mergeCorrectionSnapshot(null, [day('2026-08-21', 1000, 100, 3)]);
    expect(snapshotToRows(merged.snapshot)).toEqual([day('2026-08-21', 1000, 100, 3)]);
  });

  it('lets a FRESH read correct a day already stored — a partial day must not freeze', () => {
    const first = mergeCorrectionSnapshot(null, [day('2026-08-21', 100, 10)]);
    const second = mergeCorrectionSnapshot(first.snapshot, [day('2026-08-21', 1000, 100)]);
    expect(snapshotToRows(second.snapshot)).toEqual([day('2026-08-21', 1000, 100)]);
  });

  it('KEEPS THE PRE-CORRECTION BASELINE when the current window grows past the raw retention', () => {
    // The failure this guards: a plain "retain the newest N days" prune eventually
    // evicts the pre-correction days, and the check then compares the correction
    // against itself — silently, months after anyone was watching.
    let snap: CorrectionDecaySnapshot | null = null;
    for (const d of ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04']) {
      snap = mergeCorrectionSnapshot(snap, [day(d, 1000, 100)]).snapshot;
    }
    // 50 post-correction days — well past the ~14d the raw table would still hold.
    for (let i = 0; i < 50; i += 1) {
      const d = `2026-09-${String(i + 1).padStart(2, '0')}`;
      snap = mergeCorrectionSnapshot(snap, [day(d, 1000, 100, 100)]).snapshot;
    }
    const rows = snapshotToRows(snap);
    expect(rows.filter((r) => r.day < '2026-08-05')).toHaveLength(4);
    const verdict = rollupCorrectionShape(rows).rules[0]!;
    expect(verdict.coercionLiveFrom).toBe('2026-09-01');
    expect(verdict.baseline.days).toBe(4);
    expect(verdict.verdict).toBe('not-decaying');
  });

  it('stays bounded: neither window grows without limit', () => {
    let snap: CorrectionDecaySnapshot | null = null;
    for (let i = 0; i < 120; i += 1) {
      const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      snap = mergeCorrectionSnapshot(snap, [day(d, 1000, 100, i >= 40 ? 100 : 0)]).snapshot;
    }
    // 30 retained baseline days + 60 retained current days, never all 120.
    expect(snapshotToRows(snap)).toHaveLength(90);
  });

  it('reads an unknown snapshot version as EMPTY rather than half-parsing it', () => {
    expect(snapshotToRows({ v: 2, days: { [RULE]: { '2026-08-21': [1, 2, 3, 4] } } })).toEqual([]);
    expect(snapshotToRows(null)).toEqual([]);
    expect(snapshotToRows('nonsense')).toEqual([]);
  });
});

describe('runCorrectionDecayMinerTick', () => {
  const liveRows = [
    day('2026-08-25', 1000, 100, 100),
    day('2026-08-26', 1000, 100, 100),
    day('2026-08-27', 1000, 100, 100),
  ];
  /** The baseline exists ONLY in the snapshot — the raw window no longer reaches it. */
  const storedSnapshot = mergeCorrectionSnapshot(null, [
    day('2026-08-21', 1000, 100),
    day('2026-08-22', 1000, 100),
    day('2026-08-23', 1000, 100),
  ]).snapshot;

  function runQueryReturning(rows: unknown[]) {
    return (async () => rows) as never;
  }

  it('grades against the SNAPSHOTTED baseline and files the promotion proposal', async () => {
    // Typed input param: `vi.fn(async () => …)` infers a zero-length arg tuple, so
    // `mock.calls[0][0]` below would not typecheck against it.
    const capture = vi.fn(
      async (input: { watchdogKey?: string }) =>
        ({ created: true, issue: { id: 'EI-1' }, input }) as never,
    );
    const written: CorrectionDecaySnapshot[] = [];
    const result = await runCorrectionDecayMinerTick('papercusp', 'ws', undefined, {
      runQuery: runQueryReturning(
        liveRows.map((r) => ({
          day: r.day,
          field_calls: r.fieldCalls,
          coerced_calls: r.coercedCalls,
          coerced_ok_calls: r.coercedOkCalls,
          distinct_owners: r.distinctOwners,
        })),
      ),
      capture,
      readSnapshot: async () => storedSnapshot,
      writeSnapshot: async (_slug, snap) => {
        written.push(snap);
      },
    });

    expect(result.rating).toBe('degraded');
    expect(result.notDecaying).toBe(1);
    expect(result.captured).toEqual(['EI-1']);
    expect(result.snapshotted).toBe(true);
    expect(result.daysSeen).toBe(6); // 3 replayed + 3 live
    expect(capture.mock.calls[0]![0]).toMatchObject({
      kind: 'change',
      subTopic: 'correction-decay',
      watchdogKey: `correction-decay:${RULE}`,
    });
    // The day just read is now remembered, so the next tick keeps the baseline.
    expect(snapshotToRows(written[0]!).map((r) => r.day)).toContain('2026-08-21');
  });

  it('still grades — and says so — when the snapshot write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runCorrectionDecayMinerTick('papercusp', 'ws', undefined, {
      runQuery: runQueryReturning([]),
      capture: (async () => ({ created: false })) as never,
      readSnapshot: async () => storedSnapshot,
      writeSnapshot: async () => {
        throw new Error('routine row missing');
      },
    });
    expect(result.snapshotted).toBe(false);
    expect(result.rulesSeen).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('files nothing while the correction has not shipped', async () => {
    const capture = vi.fn(async () => ({ created: true, issue: { id: 'EI-2' } }) as never);
    const result = await runCorrectionDecayMinerTick('papercusp', 'ws', undefined, {
      runQuery: runQueryReturning([
        { day: '2026-08-21', field_calls: 1000, coerced_calls: 100, coerced_ok_calls: 0, distinct_owners: 30 },
      ]),
      capture,
      readSnapshot: async () => null,
      writeSnapshot: async () => {},
    });
    expect(result.rating).toBe('unknown');
    expect(result.notDecaying).toBe(0);
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('snapshot location', () => {
  it('names the routine that owns it, so the metadata write can only hit its own row', () => {
    expect(CORRECTION_DECAY_ROUTINE_TARGET).toBe('system:improvement-correction-decay');
    expect(CORRECTION_DECAY_METADATA_KEY).toBe('correction_decay');
  });
});
