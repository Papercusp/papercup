import { describe, it, expect, vi } from 'vitest';
import {
  detectBreaches,
  detectUndeclaredGrowth,
  detectUndeclaredDiskGrowth,
  formatBreachToast,
  formatGrowthEscalation,
  formatUndeclaredToast,
  formatUndeclaredDiskToast,
  runStorageGrowthAlarmOnce,
  categoryCeilingBytes,
  RETENTION_COVERED_ELSEWHERE,
  detectExemptSubsetGrowth,
  formatExemptSubsetToast,
  unprunedByDesignTables,
  EXEMPT_SUBSET_PROBES,
  NO_EPHEMERAL_SUBSET,
  NOT_AGE_PRUNABLE,
  type StorageBreach,
  type TableSizeRow,
  type ExemptSubsetCount,
  type ExemptSubsetProbe,
  type ExemptSubsetGrowth,
} from './storage-growth-alarm';
import type { DiskEntry, DiskRootChildScan } from './disk';
import type { StorageUsageRow } from './usage';

const GIB = 1024 ** 3;

/** Keep legacy alarm-leg tests independent from the host filesystem. */
const emptyDiskScan = async (_registeredPaths: readonly string[]): Promise<DiskRootChildScan> => ({
  entries: [],
  truncated: false,
});

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

  it('does not treat an unavailable PG size as a measured zero or breach', () => {
    const unavailable = pgRow('decision-ledger', 0, { totalBytes: null });
    expect(detectBreaches([unavailable])).toEqual([]);
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
      // leg with its own tests below. Without this it would hit a live catalog
      // and the host filesystem.
      listTableSizes: async () => [],
      listDiskRootChildren: emptyDiskScan,
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
      listDiskRootChildren: emptyDiskScan,
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
      listDiskRootChildren: emptyDiskScan,
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

function diskEntry(path: string, mb: number): DiskEntry {
  return { path, mtimeMs: 0, sizeBytes: mb * MB };
}

describe('detectUndeclaredDiskGrowth', () => {
  it('flags an over-floor unregistered child and sorts the largest first', () => {
    const result = detectUndeclaredDiskGrowth(
      [diskEntry('/papercusp/small', 200), diskEntry('/papercusp/big', 900)],
      [],
      128 * MB,
    );
    expect(result.undeclared.map((entry) => entry.path)).toEqual(['/papercusp/big', '/papercusp/small']);
    expect(result.incomplete).toBe(false);
  });

  it('does not flag a registered path or any registered descendant, however large', () => {
    const result = detectUndeclaredDiskGrowth(
      [diskEntry('/papercusp/owned', 9_000), diskEntry('/papercusp/owned/nested', 9_000)],
      ['/papercusp/owned'],
      128 * MB,
    );
    expect(result.undeclared).toEqual([]);
  });

  it('deduplicates overlapping snapshots and exposes a truncated walk as incomplete', () => {
    const result = detectUndeclaredDiskGrowth(
      [diskEntry('/papercusp/unknown', 500), diskEntry('/papercusp/unknown', 500)],
      [],
      128 * MB,
      true,
    );
    expect(result.undeclared).toHaveLength(1);
    expect(result.incomplete).toBe(true);
  });
});

describe('formatUndeclaredDiskToast', () => {
  it('names offenders and says a partial result is UNKNOWN, not healthy', () => {
    const toast = formatUndeclaredDiskToast(
      [diskEntry('/papercusp/unknown', 500)].map((entry) => ({
        path: entry.path,
        bytes: entry.sizeBytes,
        floorBytes: 128 * MB,
      })),
      true,
    );
    expect(toast.message).toContain('1 unowned disk entry');
    expect(toast.description).toContain('/papercusp/unknown');
    expect(toast.description).toContain('UNKNOWN, not healthy');
  });
});

describe('runStorageGrowthAlarmOnce — disk undeclared leg', () => {
  it('runs the injected disk sweep and reports its offenders independently', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const scanDiskRootChildren = vi.fn(
      async (_registeredPaths: readonly string[]): Promise<DiskRootChildScan> => ({
        entries: [diskEntry('/papercusp/unowned', 900)],
        truncated: false,
      }),
    );
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => [],
      listTableSizes: async () => [],
      listDiskRootChildren: scanDiskRootChildren,
      emitToast,
      countExemptSubsets: healthySubsetCounts,
    });

    expect(scanDiskRootChildren).toHaveBeenCalledOnce();
    expect(res.undeclaredDisk.map((entry) => entry.path)).toEqual(['/papercusp/unowned']);
    expect(res.diskScanIncomplete).toBe(false);
    expect(emitToast).toHaveBeenCalledTimes(1);
    expect(emitToast.mock.calls[0][0].description).toContain('/papercusp/unowned');
  });

  it('emits an UNKNOWN toast when the bounded disk walk is incomplete', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => [],
      listTableSizes: async () => [],
      listDiskRootChildren: async () => ({ entries: [], truncated: true }),
      emitToast,
      countExemptSubsets: healthySubsetCounts,
    });

    expect(res.undeclaredDisk).toEqual([]);
    expect(res.diskScanIncomplete).toBe(true);
    expect(emitToast).toHaveBeenCalledTimes(1);
    expect(emitToast.mock.calls[0][0].message).toContain('incomplete');
    expect(emitToast.mock.calls[0][0].description).toContain('UNKNOWN, not healthy');
  });
});

/** A real declared category table (storage/categories.ts) — the covered control. */
const DECLARED = ['tool_invocations', 'route_invocations', 'agent_activity'];

describe('detectUndeclaredGrowth', () => {
  it('flags an over-floor table that carries no retention decision', () => {
    // pot_throughput_ticks, measured live 2026-08-03: 167 MB / 410,510 rows,
    // no storage category and zero DELETE sites anywhere in the tree.
    const { undeclared } = detectUndeclaredGrowth([tbl('pot_throughput_ticks', 167, 410_510)], DECLARED, 128 * MB);
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

  it('does NOT flag the four measured session archive/index tables with verified retention owners', () => {
    const sessionTables = [
      tbl('session_archive_files', 7_000),
      tbl('session_turns', 5_000),
      tbl('session_turn_chunks', 2_600),
      tbl('session_turn_parts', 800),
    ];
    const { undeclared } = detectUndeclaredGrowth(sessionTables, DECLARED, 128 * MB);

    expect(undeclared).toEqual([]);
    expect(RETENTION_COVERED_ELSEWHERE.session_archive_files).toContain('session-archive.ts');
    expect(RETENTION_COVERED_ELSEWHERE.session_turns).toContain('RETENTION_DAYS=45');
    expect(RETENTION_COVERED_ELSEWHERE.session_turn_parts).toContain('PART_RETENTION_DAYS=14');
    expect(RETENTION_COVERED_ELSEWHERE.session_turn_chunks).toContain('migration 749');
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
      listDiskRootChildren: emptyDiskScan,
      countExemptSubsets: healthySubsetCounts,
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
      listTableSizes: async () => [
        tbl('tool_invocations', 2313),
        ...Object.keys(RETENTION_COVERED_ELSEWHERE).map((t) => tbl(t, 1)),
      ],
      listDiskRootChildren: emptyDiskScan,
      countExemptSubsets: healthySubsetCounts,
    });
    expect(res.undeclared).toEqual([]);
    expect(emitToast).not.toHaveBeenCalled();
  });
});

/* ───────────────── THE THIRD LEG — exempt-subset growth (WI-936229) ─────────────────
 *
 * The motivating incident: ~776k ephemeral resource-governor admission receipts
 * accumulated inside `harness_shared.work_items` in two days (measured
 * 2026-08-29, +429/min) while BOTH existing legs reported nothing — leg 1
 * because work_items is not a registered storage category, leg 2 because it
 * carries a retention exemption. A table that is unregistered AND exempt was
 * invisible to this alarm at any size.
 */

/** Every declared probe, measured and comfortably under its ceiling. */
function healthySubsetCounts(): Promise<ExemptSubsetCount[]> {
  return Promise.resolve(EXEMPT_SUBSET_PROBES.map((p) => ({ table: p.table, subset: p.subset, rows: 0 })));
}

function count(table: string, subset: string, rows: number | null): ExemptSubsetCount {
  return { table, subset, rows };
}

const PROBE: ExemptSubsetProbe = {
  table: 'work_items',
  subset: 'test receipts',
  predicateSql: `payload ? 'test'`,
  rowCeiling: 100,
  why: 'receipts are not work',
};

describe('detectExemptSubsetGrowth', () => {
  it('flags a subset strictly over its ceiling and leaves an under-ceiling one alone', () => {
    const over = detectExemptSubsetGrowth([count('work_items', 'test receipts', 101)], [PROBE]);
    expect(over.over.map((o) => o.rows)).toEqual([101]);
    expect(over.unknown).toEqual([]);

    const under = detectExemptSubsetGrowth([count('work_items', 'test receipts', 100)], [PROBE]);
    expect(under.over).toEqual([]);
    expect(under.unknown).toEqual([]);
  });

  it('catches the real incident shape: a huge ephemeral subset inside an EXEMPT, UNREGISTERED table', () => {
    // 776,382 receipts in work_items — the exact population both other legs missed.
    const res = detectExemptSubsetGrowth(
      [count('work_items', 'resource-governor admission receipts', 776_382)],
      EXEMPT_SUBSET_PROBES,
    );
    expect(res.over).toHaveLength(1);
    expect(res.over[0].table).toBe('work_items');
    expect(res.over[0].rows).toBe(776_382);
    // ...and the table really is exempt, which is WHY leg 2 cannot see it.
    expect(RETENTION_COVERED_ELSEWHERE.work_items).toContain(NOT_AGE_PRUNABLE);
  });

  it('reports a FAILED count as unknown, never as zero — an unmeasured subset must not read as healthy', () => {
    const res = detectExemptSubsetGrowth([count('work_items', 'test receipts', null)], [PROBE]);
    expect(res.over).toEqual([]);
    expect(res.unknown).toEqual(['work_items/test receipts']);
  });

  it('reports a probe with NO count row at all as unknown, rather than silently dropping it', () => {
    const res = detectExemptSubsetGrowth([], [PROBE]);
    expect(res.unknown).toEqual(['work_items/test receipts']);
  });

  it('sorts the over-ceiling set largest-first so the worst offender leads the toast', () => {
    const probes: ExemptSubsetProbe[] = [
      { ...PROBE, subset: 'small' },
      { ...PROBE, subset: 'large' },
    ];
    const res = detectExemptSubsetGrowth(
      [count('work_items', 'small', 500), count('work_items', 'large', 900_000)],
      probes,
    );
    expect(res.over.map((o) => o.subset)).toEqual(['large', 'small']);
  });
});

describe('EXEMPT_SUBSET_PROBES registry integrity — the recurrence guard', () => {
  it('every unpruned-by-design exemption declares its ephemeral subset, or declares that it has none', () => {
    // THIS is the guard for the class. Adding a new blanket "nothing prunes
    // this" exemption without answering "what ephemeral rows land in here?"
    // fails right here, which is the question nobody asked about work_items.
    const probed = new Set(EXEMPT_SUBSET_PROBES.map((p) => p.table));
    const unanswered = unprunedByDesignTables().filter((t) => !probed.has(t) && !(t in NO_EPHEMERAL_SUBSET));
    expect(
      unanswered,
      `${unanswered.join(', ')} is declared "${NOT_AGE_PRUNABLE}" but names neither an EXEMPT_SUBSET_PROBES ` +
        `entry nor a NO_EPHEMERAL_SUBSET reason. A table nothing prunes needs an explicit answer to ` +
        `"which rows in here are not the canonical population?" — work_items had none, and 776k receipt ` +
        `rows accumulated unseen.`,
    ).toEqual([]);
  });

  it('pins the motivating case: work_items is exempt AND carries a receipt probe', () => {
    expect(unprunedByDesignTables()).toContain('work_items');
    const probe = EXEMPT_SUBSET_PROBES.find((p) => p.table === 'work_items');
    expect(probe, 'the resource-governor receipt probe must survive refactors').toBeTruthy();
    expect(probe!.predicateSql).toContain('resource_governor');
    expect(probe!.rowCeiling).toBeGreaterThan(0);
  });

  it('every probe targets a table that is actually EXEMPT — otherwise leg 2 already covers it', () => {
    for (const p of EXEMPT_SUBSET_PROBES) {
      expect(
        p.table in RETENTION_COVERED_ELSEWHERE,
        `probe ${p.table}/${p.subset} targets a table with no exemption — the undeclared leg already sweeps it`,
      ).toBe(true);
    }
  });

  it('no table is BOTH probed and declared subset-free — that is a contradiction, not a belt-and-braces', () => {
    for (const p of EXEMPT_SUBSET_PROBES) {
      expect(p.table in NO_EPHEMERAL_SUBSET, `${p.table} both has a probe and claims no ephemeral subset`).toBe(false);
    }
  });

  it('unprunedByDesignTables derives from the map text, so a reworded exemption cannot escape the guard', () => {
    expect(
      unprunedByDesignTables({
        some_table: `canonical thing — ${NOT_AGE_PRUNABLE}`,
        other_table: 'pruned by something-gc.ts',
      }),
    ).toEqual(['some_table']);
  });
});

describe('detectExemptSubsetGrowth falsifiability control', () => {
  // A PERMANENT wrong implementation, kept in-tree per the repo's mutation
  // discipline (never mutate the shared tree to prove a guard can fail). This
  // is the pre-fix behaviour: a table-level exemption answers for every row.
  function blanketExemptionOnly(
    counts: readonly ExemptSubsetCount[],
    _probes: readonly ExemptSubsetProbe[],
  ): { over: ExemptSubsetGrowth[]; unknown: string[] } {
    // The old world: work_items is exempt, so nothing inside it is ever reported.
    void counts;
    return { over: [], unknown: [] };
  }

  const incident = [count('work_items', 'resource-governor admission receipts', 776_382)];

  it('the CONTROL misses the incident (this is what shipped, and why it went unseen for two days)', () => {
    expect(blanketExemptionOnly(incident, EXEMPT_SUBSET_PROBES).over).toEqual([]);
  });

  it('the REAL implementation catches it — so this suite can distinguish the two', () => {
    expect(detectExemptSubsetGrowth(incident, EXEMPT_SUBSET_PROBES).over).toHaveLength(1);
  });

  it('CALIBRATION: both agree that a healthy subset is silent, so the split above is the defect, not noise', () => {
    const healthy = [count('work_items', 'resource-governor admission receipts', 12)];
    expect(blanketExemptionOnly(healthy, EXEMPT_SUBSET_PROBES).over).toEqual([]);
    expect(detectExemptSubsetGrowth(healthy, EXEMPT_SUBSET_PROBES).over).toEqual([]);
  });
});

describe('formatExemptSubsetToast', () => {
  it('names the table, the subset, the count, the ceiling and WHY the exemption does not cover it', () => {
    const t = formatExemptSubsetToast([
      {
        table: 'work_items',
        subset: 'resource-governor admission receipts',
        rows: 776_382,
        rowCeiling: 50_000,
        why: 'receipts are queue telemetry, not work',
      },
    ]);
    expect(t.level).toBe('warning');
    expect(t.message).toContain('1 ephemeral subset(s)');
    expect(t.description).toContain('harness_shared.work_items');
    expect(t.description).toContain('776,382 rows');
    expect(t.description).toContain('50,000 ceiling');
    expect(t.description).toContain('receipts are queue telemetry, not work');
  });

  it('says UNMEASURED out loud when a probe could not be counted, rather than implying health', () => {
    const t = formatExemptSubsetToast([], ['work_items/resource-governor admission receipts']);
    expect(t.message).toContain('incomplete');
    expect(t.description).toContain('UNKNOWN');
    expect(t.description).toContain('not as healthy');
  });
});

describe('runStorageGrowthAlarmOnce — exempt-subset leg', () => {
  it('runs even when BOTH other legs throw — it is blind to this class by construction', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => {
        throw new Error('usage scan down');
      },
      listTableSizes: async () => {
        throw new Error('catalog scan down');
      },
      listDiskRootChildren: emptyDiskScan,
      emitToast,
      countExemptSubsets: async () => [count('work_items', 'resource-governor admission receipts', 776_382)],
    });
    warn.mockRestore();
    expect(res.exemptSubsets.map((o) => o.rows)).toEqual([776_382]);
    expect(emitToast).toHaveBeenCalledTimes(1);
    expect(emitToast.mock.calls[0][0].description).toContain('resource-governor admission receipts');
  });

  it('stays silent when every declared subset is measured and under its ceiling', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => [],
      listTableSizes: async () => [],
      listDiskRootChildren: emptyDiskScan,
      emitToast,
      countExemptSubsets: healthySubsetCounts,
    });
    expect(res.exemptSubsets).toEqual([]);
    expect(res.exemptUnknown).toEqual([]);
    expect(emitToast).not.toHaveBeenCalled();
  });

  it('toasts when a subset cannot be measured — a hole in the guard is reported, not swallowed', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => [],
      listTableSizes: async () => [],
      listDiskRootChildren: emptyDiskScan,
      emitToast,
      countExemptSubsets: async () => [count('work_items', 'resource-governor admission receipts', null)],
    });
    expect(res.exemptUnknown).toEqual(['work_items/resource-governor admission receipts']);
    expect(emitToast).toHaveBeenCalledTimes(1);
  });

  it('a throwing counter degrades loudly and non-fatally, leaving the other legs intact', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => [],
      listTableSizes: async () => [],
      listDiskRootChildren: emptyDiskScan,
      emitToast,
      countExemptSubsets: async () => {
        throw new Error('subset count down');
      },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exempt-subset sweep skipped'));
    warn.mockRestore();
    expect(res.exemptSubsets).toEqual([]);
    expect(emitToast).not.toHaveBeenCalled();
  });
});
