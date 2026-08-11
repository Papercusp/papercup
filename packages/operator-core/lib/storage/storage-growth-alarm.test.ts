import { describe, it, expect, vi } from 'vitest';
import {
  detectBreaches,
  detectUndeclaredGrowth,
  formatBreachToast,
  formatGrowthEscalation,
  formatUndeclaredToast,
  runStorageGrowthAlarmOnce,
  categoryCeilingBytes,
  RETENTION_COVERED_ELSEWHERE,
  type StorageBreach,
  type TableSizeRow,
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

describe('formatGrowthEscalation', () => {
  it('names the largest explicit ceiling breach and gives an action', () => {
    const t = formatGrowthEscalation([
      { id: 'small', label: 'Small', bytes: 4 * GIB, ceilingBytes: 3 * GIB, trimmable: true },
      { id: 'large', label: 'Large', bytes: 12 * GIB, ceilingBytes: 10 * GIB, trimmable: false },
    ]);
    expect(t.title).toBe('Storage growth critical');
    expect(t.body).toContain('Large (large)');
    expect(t.body).toContain('Investigate the read-only/federated retention path');
  });
});

describe('runStorageGrowthAlarmOnce', () => {
  it('emits exactly one toast when a category breaches, and returns the breaches', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => [pgRow('decision-ledger', 12), pgRow('agent-activity', 1)],
      emitToast,
      // Isolate the CATEGORY leg: the undeclared sweep is a second, independent
      // leg with its own tests below. Without this it would hit a live catalog.
      listTableSizes: async () => [],
      escalate: async () => {},
      recentlyEscalated: async () => false,
    });
    expect(res.checked).toBe(2);
    expect(res.breaches.map((b) => b.id)).toEqual(['decision-ledger']);
    expect(emitToast).toHaveBeenCalledTimes(1);
    expect(emitToast.mock.calls[0][0].level).toBe('warning');
  });

  it('escalates an explicit category ceiling breach once', async () => {
    const escalate = vi.fn(async (_t: { title: string; body: string }) => {});
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => [pgRow('substrate-outbox', 4)],
      emitToast: async () => {},
      listTableSizes: async () => [],
      escalate,
      recentlyEscalated: async () => false,
    });
    expect(res.breaches).toHaveLength(1);
    expect(escalate).toHaveBeenCalledWith(expect.objectContaining({ title: 'Storage growth critical' }));
  });

  it('emits NO toast when every category is under its ceiling', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => [pgRow('decision-ledger', 1), pgRow('substrate-outbox', 1)],
      emitToast,
      listTableSizes: async () => [],
    });
    expect(res.breaches).toEqual([]);
    expect(emitToast).not.toHaveBeenCalled();
  });
});

// ── The undeclared sweep ────────────────────────────────────────────────────
// Regression guard for the blind spot: the category-ceiling alarm walks
// STORAGE_CATEGORIES, so a table nobody registered produces no row and can
// never breach AT ANY SIZE — an alarm whose job is catching unwatched growth
// was itself scoped to the watched set.

const MB = 1024 * 1024;
function tbl(table: string, mb: number, rows = 1000): TableSizeRow {
  return { table, totalBytes: mb * MB, rows };
}

/** A real declared category table (storage/categories.ts) — the covered control. */
const DECLARED = ['tool_invocations', 'route_invocations', 'agent_activity'];

describe('detectUndeclaredGrowth', () => {
  it('flags an over-floor table that carries no retention decision', () => {
    // pot_throughput_ticks, measured live 2026-08-03: 167 MB / 410,510 rows,
    // no storage category and zero DELETE sites anywhere in the tree.
    const { undeclared } = detectUndeclaredGrowth(
      [tbl('pot_throughput_ticks', 167, 410_510)],
      DECLARED,
      128 * MB,
    );
    expect(undeclared.map((u) => u.table)).toEqual(['pot_throughput_ticks']);
    expect(undeclared[0].rows).toBe(410_510);
  });

  it('THE BLIND SPOT: a huge undeclared table yields zero category breaches but IS swept', () => {
    // The falsifiability control — it fails if the two legs are ever collapsed
    // into one. detectBreaches cannot see this table at ANY size because it is
    // not a category; only the catalog sweep can.
    const huge = tbl('pot_throughput_ticks', 500_000, 9_000_000); // ~488 GB
    expect(detectBreaches([])).toEqual([]);
    expect(detectUndeclaredGrowth([huge], DECLARED, 128 * MB).undeclared).toHaveLength(1);
  });

  it('does NOT flag a declared category table, however large', () => {
    const { undeclared } = detectUndeclaredGrowth([tbl('tool_invocations', 2313)], DECLARED, 128 * MB);
    expect(undeclared).toEqual([]);
  });

  it('does NOT flag a table whose retention lives in a bespoke GC actor', () => {
    // operator_turns is pruned by operator-turns-gc.ts, not by a category —
    // without RETENTION_COVERED_ELSEWHERE this would be a false "nothing prunes this".
    expect(RETENTION_COVERED_ELSEWHERE).toHaveProperty('operator_turns');
    const { undeclared } = detectUndeclaredGrowth([tbl('operator_turns', 337)], DECLARED, 128 * MB);
    expect(undeclared).toEqual([]);
  });

  it('does NOT flag an undeclared table under the floor', () => {
    const { undeclared } = detectUndeclaredGrowth([tbl('scout_ticks', 2)], DECLARED, 128 * MB);
    expect(undeclared).toEqual([]);
  });

  it('skips frozen bak_* pre-migration snapshots structurally', () => {
    const { undeclared } = detectUndeclaredGrowth([tbl('bak_20260713_compound_vecs', 900)], DECLARED, 128 * MB);
    expect(undeclared).toEqual([]);
  });

  it('sorts the biggest offender first', () => {
    const { undeclared } = detectUndeclaredGrowth(
      [tbl('small_one', 200), tbl('big_one', 900), tbl('mid_one', 400)],
      DECLARED,
      128 * MB,
    );
    expect(undeclared.map((u) => u.table)).toEqual(['big_one', 'mid_one', 'small_one']);
  });

  it('treats an EMPTY catalog as unknown, not as "every covered table was dropped"', () => {
    // Regression guard: deriving staleness from an empty scan named the whole
    // coverage map as rot and fired a confident, entirely false alarm.
    const { undeclared, staleCovered } = detectUndeclaredGrowth([], DECLARED, 128 * MB);
    expect(undeclared).toEqual([]);
    expect(staleCovered).toEqual([]);
  });

  it('flags a coverage-map entry that names no live table, so the map cannot rot', () => {
    const { staleCovered } = detectUndeclaredGrowth([tbl('pot_throughput_ticks', 167)], DECLARED, 128 * MB);
    // Every RETENTION_COVERED_ELSEWHERE key is absent from this one-row catalog.
    expect(staleCovered).toEqual(Object.keys(RETENTION_COVERED_ELSEWHERE).sort());
  });
});

describe('formatUndeclaredToast', () => {
  it('names each unowned table in ONE toast, not one toast per table', () => {
    const { undeclared } = detectUndeclaredGrowth(
      [tbl('pot_throughput_ticks', 167, 410_510), tbl('memory_recall_stats', 91, 117_828)],
      DECLARED,
      64 * MB,
    );
    const t = formatUndeclaredToast(undeclared, []);
    expect(t.level).toBe('warning');
    expect(t.message).toContain('2 unowned table(s)');
    expect(t.description).toContain('harness_shared.pot_throughput_ticks');
    expect(t.description).toContain('harness_shared.memory_recall_stats');
    // Says what it does NOT mean — an unowned table is an unrecorded decision,
    // not a proven-unpruned one.
    expect(t.description).toContain('not an accusation');
  });

  it('reports a stale coverage map even when nothing is over the floor', () => {
    const t = formatUndeclaredToast([], ['renamed_table']);
    expect(t.message).toContain('stale');
    expect(t.description).toContain('renamed_table');
  });
});

describe('runStorageGrowthAlarmOnce — undeclared leg', () => {
  it('sweeps the catalog even when the category usage scan throws', async () => {
    // The category path IS the blind spot, so its failure must not also blind
    // the catalog sweep.
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => {
        throw new Error('usage scan down');
      },
      emitToast,
      listTableSizes: async () => [tbl('pot_throughput_ticks', 900, 410_510)],
    });
    // The category leg degrades loudly but non-fatally...
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('usage scan skipped'));
    warn.mockRestore();
    // ...and the catalog sweep still ran.
    expect(res.breaches).toEqual([]);
    expect(res.undeclared.map((u) => u.table)).toEqual(['pot_throughput_ticks']);
    expect(emitToast).toHaveBeenCalledTimes(1);
  });

  it('emits no undeclared toast when every table is declared or under the floor', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => [],
      emitToast,
      listTableSizes: async () => [tbl('tool_invocations', 2313), ...Object.keys(RETENTION_COVERED_ELSEWHERE).map((t) => tbl(t, 1))],
    });
    expect(res.undeclared).toEqual([]);
    expect(emitToast).not.toHaveBeenCalled();
  });
});
