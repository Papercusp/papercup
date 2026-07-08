/**
 * perf-regression-rig.test.ts — infra-perf-reliability-audit-round4 P-013: the
 * perf/reliability regression rig. The PURE CORE (evaluatePerfRegression,
 * dispatchOrphanRateFromAggregate) runs without PG/flags; the IO wrapper
 * (collectPerfRegressionSnapshot) runs against the injectable deps seam, covering the
 * two pins the brief demands: the flag-OFF kill-switch (note + zero signals + zero IO)
 * and dormant-tolerance (a missing table is a note, never a throw).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  PERF_REGRESSION_BUDGETS,
  PERF_REGRESSION_DISABLED_NOTE,
  type PerfRegressionDeps,
  type PerfRegressionMetrics,
  type DispatchOrphanRow,
  collectPerfRegressionSnapshot,
  dispatchOrphanAggregateFromRows,
  dispatchOrphanRateFromAggregate,
  evaluatePerfRegression,
} from './perf-regression-rig';

const B = PERF_REGRESSION_BUDGETS;

const healthy: PerfRegressionMetrics = {
  loopLagP95Ms: 50,
  connSaturationPct: 20,
  dispatchOrphanRate: 0.05,
  dispatchSample: 100,
  coordOpenEscalations: 10,
  advTabSwitchMedianMs: 253,
  advFcpMs: 1923,
};

// ── pure core: each metric breaching warn + crit ─────────────────────────────

describe('evaluatePerfRegression — all-healthy', () => {
  it('emits no signals and no breaches when every metric is within budget', () => {
    const { signals, breaches } = evaluatePerfRegression(healthy);
    expect(signals).toEqual([]);
    expect(breaches).toEqual([]);
  });

  it('skips a null (unavailable) metric — it cannot breach a budget it has no value for', () => {
    const { signals } = evaluatePerfRegression({
      loopLagP95Ms: null,
      connSaturationPct: null,
      dispatchOrphanRate: null,
      dispatchSample: 0,
      coordOpenEscalations: null,
    });
    expect(signals).toEqual([]);
  });
});

describe('evaluatePerfRegression — event-loop-lag p95', () => {
  it('warn band → ONE major signal', () => {
    const { signals } = evaluatePerfRegression({ ...healthy, loopLagP95Ms: B.loopLagP95WarnMs });
    expect(signals).toHaveLength(1);
    expect(signals[0].source).toBe('perf-regression');
    expect(signals[0].key).toBe('loop-lag-p95');
    expect(signals[0].severity).toBe('major');
    expect(signals[0].kind).toBe('bug');
    expect(signals[0].findingClass).toBe('perf-regression:loop-lag-p95');
    expect(signals[0].latestAt).toBeUndefined(); // live-state: post-resolve re-file legitimate
  });

  it('crit band → ONE critical signal (worst tier only)', () => {
    const { signals, breaches } = evaluatePerfRegression({ ...healthy, loopLagP95Ms: B.loopLagP95CritMs });
    expect(signals).toHaveLength(1);
    expect(signals[0].severity).toBe('critical');
    expect(breaches).toEqual([
      { metric: 'loop-lag-p95', value: B.loopLagP95CritMs, budget: B.loopLagP95CritMs, tier: 'crit' },
    ]);
  });
});

describe('evaluatePerfRegression — PG connection saturation', () => {
  it('warn band → major', () => {
    const { signals } = evaluatePerfRegression({ ...healthy, connSaturationPct: B.connSaturationWarnPct });
    expect(signals).toHaveLength(1);
    expect(signals[0].key).toBe('conn-saturation');
    expect(signals[0].severity).toBe('major');
  });

  it('crit band → critical', () => {
    const { signals } = evaluatePerfRegression({ ...healthy, connSaturationPct: B.connSaturationCritPct });
    expect(signals).toHaveLength(1);
    expect(signals[0].severity).toBe('critical');
  });
});

describe('evaluatePerfRegression — dispatch-orphan rate (the 91% incident class)', () => {
  it('warn band → major', () => {
    const { signals } = evaluatePerfRegression({ ...healthy, dispatchOrphanRate: B.dispatchOrphanRateWarnPct });
    expect(signals).toHaveLength(1);
    expect(signals[0].key).toBe('dispatch-orphan-rate');
    expect(signals[0].severity).toBe('major');
    expect(signals[0].findingClass).toBe('perf-regression:dispatch-orphan-rate');
  });

  it('crit band (the 91% regression) → critical', () => {
    const { signals } = evaluatePerfRegression({ ...healthy, dispatchOrphanRate: 0.91, dispatchSample: 100 });
    expect(signals).toHaveLength(1);
    expect(signals[0].severity).toBe('critical');
    expect(signals[0].body).toContain('91%');
    expect(signals[0].body).toContain('100 improvement_dispatches');
  });
});

describe('evaluatePerfRegression — coord open-escalation backlog', () => {
  it('warn band → major', () => {
    const { signals } = evaluatePerfRegression({ ...healthy, coordOpenEscalations: B.coordOpenEscalationsWarn });
    expect(signals).toHaveLength(1);
    expect(signals[0].key).toBe('coord-open-escalations');
    expect(signals[0].severity).toBe('major');
  });

  it('crit band → critical', () => {
    const { signals } = evaluatePerfRegression({ ...healthy, coordOpenEscalations: B.coordOpenEscalationsCrit });
    expect(signals).toHaveLength(1);
    expect(signals[0].severity).toBe('critical');
  });
});

describe('evaluatePerfRegression — /adv UI perf budgets (EI-3034)', () => {
  it('/adv tab-switch median warn band → major', () => {
    const { signals, breaches } = evaluatePerfRegression({
      ...healthy,
      advTabSwitchMedianMs: B.advTabSwitchMedianWarnMs,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      key: 'adv-tab-switch-median',
      severity: 'major',
      findingClass: 'perf-regression:adv-tab-switch-median',
    });
    expect(breaches).toEqual([
      {
        metric: 'adv-tab-switch-median',
        value: B.advTabSwitchMedianWarnMs,
        budget: B.advTabSwitchMedianWarnMs,
        tier: 'warn',
      },
    ]);
  });

  it('/adv FCP crit band → critical', () => {
    const { signals, breaches } = evaluatePerfRegression({
      ...healthy,
      advFcpMs: B.advFcpCritMs,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      key: 'adv-fcp',
      severity: 'critical',
      findingClass: 'perf-regression:adv-fcp',
    });
    expect(signals[0].body).toContain('/adv first-contentful-paint');
    expect(breaches).toEqual([
      { metric: 'adv-fcp', value: B.advFcpCritMs, budget: B.advFcpCritMs, tier: 'crit' },
    ]);
  });
});

describe('evaluatePerfRegression — multiple simultaneous breaches', () => {
  it('emits one signal per breaching metric', () => {
    const { signals } = evaluatePerfRegression({
      loopLagP95Ms: B.loopLagP95CritMs,
      connSaturationPct: B.connSaturationWarnPct,
      dispatchOrphanRate: B.dispatchOrphanRateCritPct,
      dispatchSample: 50,
      coordOpenEscalations: 5,
    });
    expect(signals.map((s) => s.key).sort()).toEqual(
      ['conn-saturation', 'dispatch-orphan-rate', 'loop-lag-p95'],
    );
  });
});

// ── orphan-rate computation over a synthetic dispatch row set ────────────────

describe('dispatchOrphanRateFromAggregate', () => {
  it('computes orphaned/total over a sufficient sample', () => {
    // 91 of 100 orphaned — the silently-regressed incident shape.
    expect(dispatchOrphanRateFromAggregate({ total: 100, orphaned: 91 })).toEqual({ rate: 0.91, sample: 100 });
  });

  it('returns null rate below the min sample (a rate over 1-2 rows is noise)', () => {
    expect(dispatchOrphanRateFromAggregate({ total: 1, orphaned: 1 })).toEqual({ rate: null, sample: 1 });
    expect(
      dispatchOrphanRateFromAggregate({ total: B.dispatchOrphanMinSample - 1, orphaned: 5 }).rate,
    ).toBeNull();
  });

  it('is 0 when nothing is orphaned over a sufficient sample', () => {
    expect(dispatchOrphanRateFromAggregate({ total: 50, orphaned: 0 })).toEqual({ rate: 0, sample: 50 });
  });

  it('the min-sample boundary applies the SLO exactly at the threshold', () => {
    const { rate, sample } = dispatchOrphanRateFromAggregate({
      total: B.dispatchOrphanMinSample,
      orphaned: B.dispatchOrphanMinSample,
    });
    expect(rate).toBe(1);
    expect(sample).toBe(B.dispatchOrphanMinSample);
  });
});

// EI-7534 regression: the orphan-rate numerator must count only GENUINE lane-breakage
// orphans (reusing isLaneBreakageOrphan), NOT every outcome='orphaned' row. Benign
// host-restart / worker-timeout / context-overflow / env deaths have their own bounded
// handling and must not inflate the reliability SLO — else a benign restart storm +
// worker timeouts false-breach the 60% crit budget (the live snapshot: 28/48 raw = 58%
// vs 12/48 genuine = 25%).
describe('dispatchOrphanAggregateFromRows (EI-7534 — genuine-orphan numerator)', () => {
  const row = (outcome: string | null, resolvedBy: string | null, fireError: string | null = null): DispatchOrphanRow =>
    ({ outcome: outcome as DispatchOrphanRow['outcome'], resolvedBy, fireError });

  it('excludes every benign worker-death category', () => {
    const benign: DispatchOrphanRow[] = [
      row('orphaned', 'host-restart-recovery'),
      row('orphaned', 'worker-exit-backedge-timeout'),
      row('orphaned', 'worker-exit-backedge-context-overflow'),
      row('orphaned', 'worker-exit-backedge-env'),
      row('orphaned', 'worker-exit-backedge', '[env-failure] rate-limit'), // legacy pre-distinct resolved_by
      row('orphaned', 'worker-exit-backedge', 'died [context-overflow] mid-fix'), // legacy
    ];
    expect(dispatchOrphanAggregateFromRows(benign)).toEqual({ total: benign.length, orphaned: 0 });
  });

  it('counts genuine lane-breakage orphans (2h catch-all + a plain non-env worker crash)', () => {
    const genuine: DispatchOrphanRow[] = [
      row('orphaned', 'orphaned-dispatch-collector'), // the 2h timeout catch-all
      row('orphaned', 'worker-exit-backedge', 'segfault'), // a real non-env crash
    ];
    expect(dispatchOrphanAggregateFromRows(genuine)).toEqual({ total: 2, orphaned: 2 });
  });

  it('ignores non-orphaned outcomes but keeps them in the sample (the denominator)', () => {
    const rows: DispatchOrphanRow[] = [
      row('fixed', 'su-loopback'),
      row('needs-human', 'improvement-runner'),
      row('fire-failed', 'system'),
      row(null, null), // still open — not terminal
      row('orphaned', 'worker-exit-backedge', 'crash'), // the one genuine orphan
    ];
    expect(dispatchOrphanAggregateFromRows(rows)).toEqual({ total: 5, orphaned: 1 });
  });

  it('does not false-breach the crit budget when benign deaths dominate (the live 48/28/12 shape)', () => {
    const rows: DispatchOrphanRow[] = [
      ...Array.from({ length: 11 }, () => row('orphaned', 'worker-exit-backedge', 'crash')), // genuine
      ...Array.from({ length: 10 }, () => row('orphaned', 'host-restart-recovery')), // benign
      ...Array.from({ length: 6 }, () => row('orphaned', 'worker-exit-backedge-timeout')), // benign
      row('orphaned', 'orphaned-dispatch-collector'), // genuine
      ...Array.from({ length: 20 }, () => row('fixed', 'su-loopback')), // resolved
    ];
    const agg = dispatchOrphanAggregateFromRows(rows);
    expect(agg).toEqual({ total: 48, orphaned: 12 });

    // Raw (pre-fix) counting would be 28/48 ≈ 0.58 → past the 0.60-adjacent crit band and
    // firing warn/crit; the genuine rate is 0.25 — below BOTH the warn (0.30) and crit (0.60).
    const { rate } = dispatchOrphanRateFromAggregate(agg);
    expect(rate).toBeCloseTo(0.25, 5);
    expect(rate!).toBeLessThan(B.dispatchOrphanRateWarnPct);
    const { signals } = evaluatePerfRegression({ ...healthy, dispatchOrphanRate: rate, dispatchSample: agg.total });
    expect(signals.some((s) => s.key === 'dispatch-orphan-rate')).toBe(false);
  });
});

// ── IO wrapper: flag gate + dormant-tolerance + persistence ──────────────────

/** A fake `sql` tagged-template that routes each query by a matcher → rows (or throws). */
/**
 * Raw improvement_dispatches rows for the fakeSql (readDispatchOrphanRate now fetches
 * per-row death-cause fields, not an aggregate count): `total` rows, `orphaned` of them
 * GENUINE lane-breakage orphans (a plain non-env worker crash), the rest resolved 'fixed'.
 */
function dispatchRows(total: number, orphaned: number): unknown[] {
  return Array.from({ length: total }, (_, i) =>
    i < orphaned
      ? { outcome: 'orphaned', resolved_by: 'worker-exit-backedge', fire_error: 'crash' }
      : { outcome: 'fixed', resolved_by: 'su-loopback', fire_error: null },
  );
}

function fakeSql(handlers: { match: RegExp; rows?: unknown[]; throws?: Error }[]): {
  sql: Sql;
  readonly inserts: number;
} {
  let insertCount = 0;
  const tag = (strings: TemplateStringsArray, ..._args: unknown[]): Promise<unknown[]> => {
    const text = strings.join(' ');
    if (/INSERT\s+INTO/i.test(text)) {
      insertCount++;
      // Route the INSERT to its snapshot-table handler ONLY. The INSERT column list
      // also names coord_open_escalations, so match the snapshot handler by its own
      // source rather than testing it against the (column-rich) INSERT text.
      const snap = handlers.find((x) => x.match.source.includes('perf_regression_snapshots'));
      if (snap?.throws) return Promise.reject(snap.throws);
      return Promise.resolve([]);
    }
    const h = handlers.find((x) => x.match.test(text));
    if (!h) return Promise.resolve([]);
    if (h.throws) return Promise.reject(h.throws);
    return Promise.resolve(h.rows ?? []);
  };
  return {
    sql: tag as unknown as Sql,
    get inserts() {
      return insertCount;
    },
  };
}

function depsWith(over: Partial<PerfRegressionDeps>): PerfRegressionDeps {
  return {
    isEnabled: () => Promise.resolve(true),
    sql: () => ({}) as Sql,
    readLoopLagP95Ms: () => 50,
    readConnSaturationPct: () => Promise.resolve(20),
    ...over,
  };
}

describe('collectPerfRegressionSnapshot — flag gate', () => {
  it('flag OFF → disabled note, zero signals, zero IO', async () => {
    const sql = vi.fn();
    const loop = vi.fn();
    const conn = vi.fn();
    const out = await collectPerfRegressionSnapshot(
      'ws',
      depsWith({
        isEnabled: () => Promise.resolve(false),
        sql: () => sql as unknown as Sql,
        readLoopLagP95Ms: loop,
        readConnSaturationPct: conn,
      }),
    );
    expect(out.signals).toEqual([]);
    expect(out.note).toBe(PERF_REGRESSION_DISABLED_NOTE);
    expect(sql).not.toHaveBeenCalled();
    expect(loop).not.toHaveBeenCalled();
    expect(conn).not.toHaveBeenCalled();
  });

  it('a broken flag read keeps the rig quiet (never fails toward filing)', async () => {
    const out = await collectPerfRegressionSnapshot(
      'ws',
      depsWith({ isEnabled: () => Promise.reject(new Error('flag service down')) }),
    );
    expect(out.signals).toEqual([]);
    expect(out.note).toBe(PERF_REGRESSION_DISABLED_NOTE);
  });
});

describe('collectPerfRegressionSnapshot — healthy tick persists, emits nothing', () => {
  it('reads metrics, INSERTs a snapshot, emits no signals', async () => {
    const fake = fakeSql([
      { match: /improvement_dispatches/i, rows: dispatchRows(100, 3) },
      { match: /coord_open_escalations/i, rows: [{ n: 7 }] },
    ]);
    const out = await collectPerfRegressionSnapshot(
      'ws',
      depsWith({ sql: () => fake.sql, readLoopLagP95Ms: () => 40, readConnSaturationPct: () => Promise.resolve(30) }),
    );
    expect(out.signals).toEqual([]);
    expect(fake.inserts).toBe(1); // snapshot persisted
    expect(out.note).toBeUndefined();
  });

  it('includes optional /adv UI perf metrics when a sampler provides them', async () => {
    const fake = fakeSql([
      { match: /improvement_dispatches/i, rows: dispatchRows(100, 3) },
      { match: /coord_open_escalations/i, rows: [{ n: 7 }] },
    ]);
    const out = await collectPerfRegressionSnapshot(
      'ws',
      depsWith({
        sql: () => fake.sql,
        readAdvTabSwitchMedianMs: () => Promise.resolve(B.advTabSwitchMedianWarnMs),
        readAdvFcpMs: () => Promise.resolve(1923),
      }),
    );
    expect(out.signals).toHaveLength(1);
    expect(out.signals[0].key).toBe('adv-tab-switch-median');
    expect(fake.inserts).toBe(1);
  });
});

describe('collectPerfRegressionSnapshot — a breach files', () => {
  it('a regressed orphan rate emits a critical signal AND persists the snapshot', async () => {
    const fake = fakeSql([
      { match: /improvement_dispatches/i, rows: dispatchRows(100, 91) },
      { match: /coord_open_escalations/i, rows: [{ n: 7 }] },
    ]);
    const out = await collectPerfRegressionSnapshot('ws', depsWith({ sql: () => fake.sql }));
    expect(out.signals).toHaveLength(1);
    expect(out.signals[0].key).toBe('dispatch-orphan-rate');
    expect(out.signals[0].severity).toBe('critical');
    expect(fake.inserts).toBe(1);
  });
});

// EI-8719: the loop-lag p95 the rig reads is a point-in-time ≤10s histogram window
// sampled once per ~15-min tick — inherently spiky (the live series oscillated
// 20→400→820ms with a single breach and no sustained trend). A lone spike must NOT
// file a churning auto-implement bug: the loop-lag SIGNAL is gated behind
// consecutive-tick hysteresis (it fires only when the metric ALSO breached the prior
// snapshot), while the breach is still persisted every tick so the next tick can
// confirm. Non-loop-lag metrics keep firing on the first sample.
describe('collectPerfRegressionSnapshot — loop-lag hysteresis (EI-8719 single-sample spike)', () => {
  it('suppresses a FIRST loop-lag breach (no prior breach) — the transient-spike case', async () => {
    // No perf_regression_snapshots SELECT handler ⇒ the prior-breach read returns []
    // ⇒ empty prior set ⇒ a first-sample loop-lag breach is suppressed.
    const fake = fakeSql([
      { match: /improvement_dispatches/i, rows: dispatchRows(50, 1) },
      { match: /coord_open_escalations/i, rows: [{ n: 3 }] },
    ]);
    const out = await collectPerfRegressionSnapshot(
      'ws',
      depsWith({ sql: () => fake.sql, readLoopLagP95Ms: () => 820.5 }), // the live EI-8719 value
    );
    expect(out.signals.some((s) => s.key === 'loop-lag-p95')).toBe(false);
    expect(out.note).toContain('suppressed pending sustained confirmation');
    expect(fake.inserts).toBe(1); // the breach is still persisted so the next tick can confirm
  });

  it('EMITS a loop-lag breach that ALSO breached last tick — the sustained-regression case', async () => {
    const fake = fakeSql([
      { match: /improvement_dispatches/i, rows: dispatchRows(50, 1) },
      { match: /coord_open_escalations/i, rows: [{ n: 3 }] },
      // the prior snapshot's persisted breached JSONB names loop-lag ⇒ hysteresis satisfied
      {
        match: /perf_regression_snapshots/i,
        rows: [{ breached: [{ metric: 'loop-lag-p95', value: 700, budget: 600, tier: 'warn' }] }],
      },
    ]);
    const out = await collectPerfRegressionSnapshot(
      'ws',
      depsWith({ sql: () => fake.sql, readLoopLagP95Ms: () => 820.5 }),
    );
    const loop = out.signals.find((s) => s.key === 'loop-lag-p95');
    expect(loop).toBeDefined();
    expect(loop!.severity).toBe('major');
    expect(fake.inserts).toBe(1);
  });

  it('also suppresses a CRIT loop-lag first-breach (a single ≥1000ms sample is still a point-sample)', async () => {
    const fake = fakeSql([
      { match: /improvement_dispatches/i, rows: dispatchRows(50, 1) },
      { match: /coord_open_escalations/i, rows: [{ n: 3 }] },
    ]);
    const out = await collectPerfRegressionSnapshot(
      'ws',
      depsWith({ sql: () => fake.sql, readLoopLagP95Ms: () => B.loopLagP95CritMs + 200 }),
    );
    expect(out.signals.some((s) => s.key === 'loop-lag-p95')).toBe(false);
    expect(out.note).toContain('single-sample hysteresis');
  });

  it('does NOT gate a non-loop-lag metric — conn-saturation still fires on the first sample', async () => {
    const fake = fakeSql([
      { match: /improvement_dispatches/i, rows: dispatchRows(50, 1) },
      { match: /coord_open_escalations/i, rows: [{ n: 3 }] },
    ]);
    const out = await collectPerfRegressionSnapshot(
      'ws',
      depsWith({ sql: () => fake.sql, readConnSaturationPct: () => Promise.resolve(B.connSaturationCritPct) }),
    );
    expect(out.signals.some((s) => s.key === 'conn-saturation' && s.severity === 'critical')).toBe(true);
  });
});

describe('collectPerfRegressionSnapshot — dormant-tolerance (missing table → note, no throw)', () => {
  it('a missing improvement_dispatches table is a note, the tick still completes', async () => {
    const fake = fakeSql([
      {
        match: /improvement_dispatches/i,
        throws: new Error('relation "harness_shared.improvement_dispatches" does not exist'),
      },
      { match: /coord_open_escalations/i, rows: [{ n: 3 }] },
    ]);
    const out = await collectPerfRegressionSnapshot('ws', depsWith({ sql: () => fake.sql }));
    expect(out.signals).toEqual([]); // orphan rate unavailable → can't breach
    expect(out.note).toContain('improvement_dispatches not migrated');
    expect(fake.inserts).toBe(1); // still persists the partial snapshot
  });

  it('a missing snapshot table is a note (the rig never breaks the watchdog tick it rides)', async () => {
    const fake = fakeSql([
      { match: /improvement_dispatches/i, rows: dispatchRows(50, 2) },
      { match: /coord_open_escalations/i, rows: [{ n: 3 }] },
      {
        match: /perf_regression_snapshots/i,
        throws: new Error('relation "harness_shared.perf_regression_snapshots" does not exist'),
      },
    ]);
    const out = await collectPerfRegressionSnapshot('ws', depsWith({ sql: () => fake.sql }));
    expect(out.note).toContain('perf_regression_snapshots not migrated');
    expect(out.signals).toEqual([]); // healthy metrics → no breach, no throw
  });

  it('a null loop-lag metric (no monitor on this thread) is noted, not breached', async () => {
    const fake = fakeSql([
      { match: /improvement_dispatches/i, rows: dispatchRows(50, 1) },
      { match: /coord_open_escalations/i, rows: [{ n: 1 }] },
    ]);
    const out = await collectPerfRegressionSnapshot(
      'ws',
      depsWith({ sql: () => fake.sql, readLoopLagP95Ms: () => null }),
    );
    expect(out.note).toContain('no event-loop-lag monitor');
    expect(out.signals).toEqual([]);
  });
});
