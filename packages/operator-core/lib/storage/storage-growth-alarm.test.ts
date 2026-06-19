import { describe, it, expect, vi } from 'vitest';
import {
  detectBreaches,
  formatBreachToast,
  runStorageGrowthAlarmOnce,
  categoryCeilingBytes,
  type StorageBreach,
} from './storage-growth-alarm';
import type { StorageUsageRow } from './usage';

const GIB = 1024 ** 3;

function pgRow(id: string, gb: number, extra: Partial<StorageUsageRow> = {}): StorageUsageRow {
  return {
    id,
    label: id.replace(/-/g, ' '),
    kind: 'pg',
    federation: 'local-diagnostic',
    trimmable: true,
    bloats: false,
    totalBytes: Math.round(gb * GIB),
    totalRows: 1,
    ageBuckets: [],
    description: 'test',
    ...extra,
  };
}

describe('categoryCeilingBytes', () => {
  it('defaults to 10 GiB and a tighter 3 GiB for the substrate-outbox bloat-queue', () => {
    expect(categoryCeilingBytes('decision-ledger')).toBe(10 * GIB);
    expect(categoryCeilingBytes('substrate-outbox')).toBe(3 * GIB);
  });
});

describe('detectBreaches', () => {
  it('flags PG categories strictly over their ceiling, leaves under-ceiling alone', () => {
    const breaches = detectBreaches([
      pgRow('decision-ledger', 12), // > 10 GiB default → breach
      pgRow('agent-activity', 6), //   < 10 GiB → ok
      pgRow('substrate-outbox', 4), // > 3 GiB outbox ceiling → breach
    ]);
    expect(breaches.map((b) => b.id).sort()).toEqual(['decision-ledger', 'substrate-outbox']);
  });

  it('does NOT flag the substrate-outbox queue while it is small (the EI-126 guard, pre-runaway)', () => {
    expect(detectBreaches([pgRow('substrate-outbox', 2)])).toEqual([]);
  });

  it('ignores non-PG (disk) categories — the guarded runaway class is a Postgres table', () => {
    const huge = pgRow('scratch', 999, { kind: 'disk' });
    expect(detectBreaches([huge])).toEqual([]);
  });
});

describe('formatBreachToast', () => {
  it('produces a warning toast naming each over-ceiling table', () => {
    const breaches: StorageBreach[] = [
      { id: 'substrate-outbox', label: 'Substrate outbox', bytes: 5 * GIB, ceilingBytes: 3 * GIB, trimmable: true },
    ];
    const t = formatBreachToast(breaches);
    expect(t.level).toBe('warning');
    expect(t.message).toContain('1 table(s)');
    expect(t.description).toContain('Substrate outbox (substrate-outbox)');
    expect(t.description).toContain('5.0 GB');
    expect(t.description).toContain('3.0 GB ceiling');
  });
});

describe('runStorageGrowthAlarmOnce', () => {
  it('emits exactly one toast when a category breaches, and returns the breaches', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => [pgRow('decision-ledger', 12), pgRow('agent-activity', 1)],
      emitToast,
    });
    expect(res.checked).toBe(2);
    expect(res.breaches.map((b) => b.id)).toEqual(['decision-ledger']);
    expect(emitToast).toHaveBeenCalledTimes(1);
    expect(emitToast.mock.calls[0][0].level).toBe('warning');
  });

  it('emits NO toast when every category is under its ceiling', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => [pgRow('decision-ledger', 1), pgRow('substrate-outbox', 1)],
      emitToast,
    });
    expect(res.breaches).toEqual([]);
    expect(emitToast).not.toHaveBeenCalled();
  });
});
