import { describe, it, expect, vi } from 'vitest';
import {
  planWatchdogCaptures,
  collectServiceDownSignals,
  runWatchdogTick,
  isImprovementLoopTool,
  toolErrorSignalsFromRows,
  classifyToolError,
  collectMigrationDriftSignals,
  routineFailureSignalsFromRows,
  stuckPlanSignalsFromRows,
  escalationSignalsFromRows,
  circuitOpenSignalsFromRows,
  normalizeRedTestPath,
  redTestSignalsFromRows,
  isServiceHealthStale,
  serviceDownCollectorResult,
  DEFAULT_SERVICE_HEALTH_MAX_STALE_MS,
  planSelfEscalations,
  withWatchdogTickLock,
  runWatchdogBackfill,
  type WatchdogSignal,
  type WatchdogCollector,
  type WatchdogTickRecord,
  type RecentTick,
  type CollectorStatus,
} from './watchdog';
import type { CaptureImprovementResult } from './capture-core';
import type { ProbeResult } from '../../service-health';

function sig(p: Partial<WatchdogSignal> & { key: string }): WatchdogSignal {
  return {
    source: 'red-test',
    title: `Test failing repeatedly: ${p.key}`,
    body: 'detail',
    severity: 'major',
    ...p,
  };
}

describe('planWatchdogCaptures — pure anti-flood planning (close-loop D-003)', () => {
  it('caps captures per tick, highest severity first', () => {
    const signals = [
      sig({ key: 'a', severity: 'minor' }),
      sig({ key: 'b', severity: 'critical' }),
      sig({ key: 'c', severity: 'major' }),
    ];
    const plan = planWatchdogCaptures(signals, { maxPerTick: 2 });
    expect(plan.toCapture.map((s) => s.key)).toEqual(['b', 'c']);
    expect(plan.deferred.map((s) => s.key)).toEqual(['a']);
  });

  it('dedupes by source+key within a tick', () => {
    const plan = planWatchdogCaptures([sig({ key: 'a' }), sig({ key: 'a' })], { maxPerTick: 5 });
    expect(plan.toCapture).toHaveLength(1);
  });

  it('same key from DIFFERENT sources are distinct signals', () => {
    const plan = planWatchdogCaptures(
      [sig({ key: 'a', source: 'red-test' }), sig({ key: 'a', source: 'smoke-fail' })],
      { maxPerTick: 5 },
    );
    expect(plan.toCapture).toHaveLength(2);
  });

  it('default cap is 3', () => {
    const plan = planWatchdogCaptures([sig({ key: 'a' }), sig({ key: 'b' }), sig({ key: 'c' }), sig({ key: 'd' })]);
    expect(plan.toCapture).toHaveLength(3);
    expect(plan.deferred).toHaveLength(1);
  });

  it('PER-SOURCE cap stops a red-test backlog from starving a tool-error signal (P-009 — the memory:search starvation)', () => {
    // 5 major red-tests + 1 major tool-error signal; global cap 3, per-source cap 2.
    // OLD behaviour (global severity cap): 3 red-tests admitted, tool-error deferred.
    // NEW: red-tests capped at 2, so the tool-error signal gets a slot.
    const signals = [
      sig({ key: 'rt1', source: 'red-test', severity: 'major' }),
      sig({ key: 'rt2', source: 'red-test', severity: 'major' }),
      sig({ key: 'rt3', source: 'red-test', severity: 'major' }),
      sig({ key: 'rt4', source: 'red-test', severity: 'major' }),
      sig({ key: 'rt5', source: 'red-test', severity: 'major' }),
      sig({ key: 'mem', source: 'repeated-tool-error', severity: 'major' }),
    ];
    const plan = planWatchdogCaptures(signals); // default maxPerTick 3, perSourceCap 2
    const keys = plan.toCapture.map((s) => s.key);
    expect(keys).toContain('mem'); // the tool-error signal lands instead of being starved
    expect(keys.filter((k) => k.startsWith('rt'))).toHaveLength(2); // red-tests capped at 2
    expect(plan.toCapture).toHaveLength(3);
  });

  it('fills leftover budget rather than wasting it when ONE source dominates (no competition)', () => {
    const signals = [
      sig({ key: 'rt1', source: 'red-test' }),
      sig({ key: 'rt2', source: 'red-test' }),
      sig({ key: 'rt3', source: 'red-test' }),
    ];
    // No other source competing → use the full cap of 3 even though per-source cap is 2.
    expect(planWatchdogCaptures(signals).toCapture).toHaveLength(3);
  });

  it('deferred-escalation: a recently-deferred minor signal outranks a fresh major one (P-009)', () => {
    const signals = [
      sig({ key: 'fresh', source: 'red-test', severity: 'major' }),
      sig({ key: 'stale', source: 'repeated-tool-error', severity: 'minor' }),
    ];
    // Only 1 slot. The minor 'stale' was deferred on a recent tick → boosted (+1 rank,
    // and it wins the tie) so a persistent-but-minor signal eventually lands.
    const plan = planWatchdogCaptures(signals, {
      maxPerTick: 1,
      priorDeferredKeys: ['repeated-tool-error:stale'],
    });
    expect(plan.toCapture.map((s) => s.key)).toEqual(['stale']);
    // Without the deferral history, the fresh major would win.
    const baseline = planWatchdogCaptures(signals, { maxPerTick: 1 });
    expect(baseline.toCapture.map((s) => s.key)).toEqual(['fresh']);
  });
});

describe('tool-error sweep excludes the loop’s own tools (watchdog-robustness P-006)', () => {
  it('isImprovementLoopTool matches improvements:* and system:improvement-* only', () => {
    expect(isImprovementLoopTool('improvements:capture')).toBe(true);
    expect(isImprovementLoopTool('improvements:resolve')).toBe(true);
    expect(isImprovementLoopTool('system:improvement-watchdog')).toBe(true);
    expect(isImprovementLoopTool('system:improvement-implement')).toBe(true);
    // unrelated tools are NOT excluded
    expect(isImprovementLoopTool('git:status')).toBe(false);
    expect(isImprovementLoopTool('plans:get')).toBe(false);
    expect(isImprovementLoopTool('improvement-runner')).toBe(false); // no colon prefix
  });

  it('a synthetic improvements:capture error row is not turned into a signal; an unrelated tool still is', () => {
    const rows = [
      { tool_name: 'improvements:capture', class: 'structural' as const, n: 9, total: 9, sample: 'pg hiccup' },
      { tool_name: 'system:improvement-watchdog', class: 'structural' as const, n: 12, total: 12, sample: 'boom' },
      { tool_name: 'docs:get', class: 'structural' as const, n: 7, total: 7, sample: 'boom' },
    ];
    const signals = toolErrorSignalsFromRows(rows);
    expect(signals.map((s) => s.key)).toEqual(['docs:get:structural']);
    expect(signals[0].source).toBe('repeated-tool-error');
  });

  it('STRUCTURAL fires at a LOW bar (≥2) — the memory:search/remember miss is now caught (P-008)', () => {
    // The exact shape the old ≥5/60min ABSOLUTE threshold missed: a deterministic
    // workspace_required error at low volume.
    const signals = toolErrorSignalsFromRows([
      { tool_name: 'memory:remember', class: 'structural' as const, n: 2, total: 19, sample: 'workspace-scoped call' },
      { tool_name: 'memory:search', class: 'structural' as const, n: 18, total: 263, sample: 'workspace-scoped call' },
    ]);
    expect(signals.map((s) => s.key)).toEqual(
      expect.arrayContaining(['memory:remember:structural', 'memory:search:structural']),
    );
    expect(signals.every((s) => s.severity === 'major' && s.kind === 'bug')).toBe(true);
  });

  it('STRUCTURAL also fires on a high error-RATE below the count bar (decouples from volume → kills self-masking)', () => {
    const signals = toolErrorSignalsFromRows(
      [{ tool_name: 'x:y', class: 'structural' as const, n: 3, total: 4, sample: null }],
      { structuralMinCount: 5 }, // raise the COUNT bar so only the RATE test (3/4 = 75%) can fire it
    );
    expect(signals.map((s) => s.key)).toEqual(['x:y:structural']);
  });

  it('a single structural error does NOT fire (one-off noise is gated)', () => {
    expect(
      toolErrorSignalsFromRows([{ tool_name: 'x:y', class: 'structural' as const, n: 1, total: 100, sample: null }]),
    ).toEqual([]);
  });

  it('TRANSIENT is volume-gated; ≥50 escalates to major', () => {
    const signals = toolErrorSignalsFromRows([
      { tool_name: 'plans:list', class: 'transient' as const, n: 14, total: 1000, sample: 'exceeded timeout' }, // <15 → no
      { tool_name: 'slow:tool', class: 'transient' as const, n: 60, total: 100, sample: 'exceeded timeout' }, // ≥50 → major
    ]);
    expect(signals.map((s) => s.key)).toEqual(['slow:tool:transient']);
    expect(signals[0].severity).toBe('major');
    expect(signals[0].kind).toBe('bug');
  });

  it('CALLER/DX errors route to kind=change at low severity, only on a sustained pattern (≥10)', () => {
    const signals = toolErrorSignalsFromRows([
      { tool_name: 'coord:thread', class: 'caller' as const, n: 13, total: 22, sample: 'invalid_args: root_msg_id' }, // ≥10
      { tool_name: 'rare:tool', class: 'caller' as const, n: 3, total: 5, sample: 'invalid_args: slug' }, // <10
    ]);
    expect(signals.map((s) => s.key)).toEqual(['coord:thread:caller']);
    expect(signals[0].kind).toBe('change');
    expect(signals[0].severity).toBe('minor');
  });
});

describe('classifyToolError — by error_code, with a legacy error_message fallback (P-008 / D-009)', () => {
  it('classifies by the first-class error_code when present (the P-007 path)', () => {
    expect(classifyToolError('unauthorized', 'error', 'x')).toBe('structural');
    expect(classifyToolError('handler_error', 'error', 'x')).toBe('structural');
    expect(classifyToolError('harness_required', 'error', 'x')).toBe('structural');
    expect(classifyToolError('timeout', 'timeout', 'x')).toBe('transient');
    expect(classifyToolError('invalid_args', 'error', 'x')).toBe('caller');
    expect(classifyToolError('role_not_allowed', 'role-not-allowed', 'x')).toBe('caller');
  });

  it('falls back to status + message for legacy rows (error_code NULL, pre-P-007 deploy)', () => {
    expect(classifyToolError(null, 'error', 'built-in tool requires a workspace-scoped call')).toBe('structural');
    expect(classifyToolError(null, 'timeout', 'exceeded timeout of 60s')).toBe('transient');
    expect(classifyToolError(null, 'error', 'exceeded timeout of 60s')).toBe('transient');
    expect(classifyToolError(null, 'role-not-allowed', '')).toBe('caller');
    expect(classifyToolError(null, 'error', 'invalid_args: slug expected string')).toBe('caller');
    expect(classifyToolError(null, 'error', 'something unrecognized')).toBe('structural');
  });
});

describe('P-010 blind-source collectors (watchdog-robustness)', () => {
  it('migration-drift: fires critical when migrations are unapplied, silent when in sync', async () => {
    expect(await collectMigrationDriftSignals(async () => ({ missing: [] }))).toEqual([]);
    const drift = await collectMigrationDriftSignals(async () => ({ missing: ['205-foo.sql', '206-bar.sql'] }));
    expect(drift).toHaveLength(1);
    expect(drift[0].source).toBe('migration-drift');
    expect(drift[0].severity).toBe('critical');
    expect(drift[0].body).toContain('205-foo.sql');
  });

  it('migration-drift: a thrown check degrades to no signal (never aborts the tick)', async () => {
    expect(await collectMigrationDriftSignals(async () => { throw new Error('pg down'); })).toEqual([]);
  });

  it('routine-failure: only routines with a non-empty last_error become signals (e.g. a wedged git-sync)', () => {
    const signals = routineFailureSignalsFromRows([
      { name: 'git-sync', last_error: 'push rejected: oversized blob' },
      { name: 'healthy', last_error: null },
      { name: 'blank', last_error: '   ' },
    ]);
    expect(signals.map((s) => s.key)).toEqual(['routine:git-sync']);
    expect(signals[0].severity).toBe('major');
    expect(signals[0].body).toContain('oversized blob');
  });

  it('stuck-plan: one signal per stuck plan, keyed by harness+plan', () => {
    const signals = stuckPlanSignalsFromRows([
      { harness_slug: 'papercup', plan_slug: 'some-plan', status: 'started', stale_hours: 51 },
    ]);
    expect(signals[0].key).toBe('stuck-plan:papercup:some-plan');
    expect(signals[0].body).toContain('51h');
    expect(signals[0].kind).toBe('bug');
  });

  it('unresolved-escalation: one signal per unaddressed escalation', () => {
    const signals = escalationSignalsFromRows([{ harness_slug: 'sheets', phase: 'production' }]);
    expect(signals[0].key).toBe('escalation:sheets:production');
    expect(signals[0].source).toBe('unresolved-escalation');
  });

  it('fire-circuit-open: one signal per backed-off (slug, role) fire path', () => {
    const signals = circuitOpenSignalsFromRows([
      { harness_slug: 'papercup-org', role: 'director', consecutive_errors: 7, last_status: 'error: timeout' },
    ]);
    expect(signals[0].key).toBe('circuit:papercup-org:director');
    expect(signals[0].source).toBe('fire-circuit-open');
    expect(signals[0].severity).toBe('major');
    expect(signals[0].body).toContain('7 consecutive');
    expect(signals[0].body).toContain('error: timeout');
  });
});

describe('red-test path normalization — one identity per broken test', () => {
  it('strips the green-checkpoint (and any sibling-tree) prefix to the repo-relative path', () => {
    expect(normalizeRedTestPath('papercupai-workspace/papercup-checkpoint/packages/operator-core/lib/a.test.ts'))
      .toBe('packages/operator-core/lib/a.test.ts');
    expect(normalizeRedTestPath('/home/dev/papercupai-workspace/papercup/apps/operator/lib/b.test.ts'))
      .toBe('apps/operator/lib/b.test.ts');
    // Already repo-relative → unchanged.
    expect(normalizeRedTestPath('packages/operator-core/lib/a.test.ts'))
      .toBe('packages/operator-core/lib/a.test.ts');
  });

  it('drops synthetic fixture tests (loop probes, not bugs)', () => {
    expect(normalizeRedTestPath('lib/__synthetic__/close-loop-watchdog-probe.test.ts')).toBeNull();
  });

  it('MERGES the canonical + checkpoint rows of the SAME test into ONE signal (the EI-36/EI-143 dup)', () => {
    const signals = redTestSignalsFromRows(
      [
        { file_path: 'apps/operator/lib/__tests__/x.test.ts', framework: 'vitest', fails: 3, sample: 'boom' },
        { file_path: 'papercupai-workspace/papercup-checkpoint/apps/operator/lib/__tests__/x.test.ts', framework: 'vitest', fails: 4, sample: null },
        { file_path: 'lib/__synthetic__/probe.test.ts', framework: 'vitest', fails: 9, sample: null },
      ],
      6,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].key).toBe('apps/operator/lib/__tests__/x.test.ts');
    expect(signals[0].paths).toEqual(['apps/operator/lib/__tests__/x.test.ts']);
    expect(signals[0].body).toContain('failed 7×'); // counts summed across trees
    expect(signals[0].body).toContain('boom');
  });
});

describe('runWatchdogBackfill — one-time historical sweep (P-011)', () => {
  function recorder() {
    const calls: string[] = [];
    const capture = (async (input: { title: string }) => {
      calls.push(input.title);
      return { ok: true, created: true, issue: { id: `iss-${calls.length}` } as never, possibleDuplicates: [] };
    }) as unknown as typeof import('./capture-core').captureImprovement;
    return { calls, capture };
  }

  it('captures up to the cap and REPORTS (does not silently drop) the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { calls, capture } = recorder();
      const signals = [
        sig({ key: 't1', source: 'repeated-tool-error', severity: 'major' }),
        sig({ key: 't2', source: 'repeated-tool-error', severity: 'major' }),
        sig({ key: 't3', source: 'repeated-tool-error', severity: 'minor' }),
      ];
      const res = await runWatchdogBackfill('ws', { maxCaptures: 2 }, { collect: async () => signals, capture });
      expect(res.captured).toHaveLength(2);
      expect(res.dropped).toEqual(['repeated-tool-error:t3']); // the minor one
      expect(calls).toHaveLength(2);
      // The drop is REPORTED to the log, not silently truncated (D-008).
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('repeated-tool-error:t3'));
    } finally {
      warn.mockRestore();
    }
  });

  it('dedupes by source:key before capturing', async () => {
    const { capture } = recorder();
    const res = await runWatchdogBackfill('ws', {}, {
      collect: async () => [
        sig({ key: 'x', source: 'repeated-tool-error' }),
        sig({ key: 'x', source: 'repeated-tool-error' }),
      ],
      capture,
    });
    expect(res.signals).toBe(2);
    expect(res.captured).toHaveLength(1);
  });
});

describe('watchdog COVERAGE self-test — the original miss is caught end-to-end (P-012)', () => {
  // A REGRESSION GUARD. The watchdog exists because it missed a low-frequency
  // STRUCTURAL tool error (memory:search workspace_required), starved by a backlog of
  // MAJOR red-tests. If a future change reintroduces EITHER half of that blind spot —
  // the structural classification (detection) or the per-source budget (anti-starvation)
  // — one of these tests fails, so the next blind spot is caught at CI time, not by an
  // owner noticing months later.
  function captureRec() {
    const captured: string[] = [];
    const capture = (async (input: { title: string }) => {
      captured.push(input.title);
      return { ok: true, created: true, issue: { id: `iss-${captured.length}` } as never, possibleDuplicates: [] };
    }) as unknown as typeof import('./capture-core').captureImprovement;
    return { captured, capture };
  }

  it('DETECTION: the memory:search workspace_required shape classifies as structural and fires at the LOW bar', () => {
    expect(classifyToolError('unauthorized', 'error', 'x')).toBe('structural');
    expect(classifyToolError(null, 'error', 'requires a workspace-scoped call')).toBe('structural');
    const signals = toolErrorSignalsFromRows([
      { tool_name: 'memory:search', class: 'structural' as const, n: 2, total: 21, sample: 'workspace-scoped call' },
    ]);
    expect(signals.map((s) => s.key)).toEqual(['memory:search:structural']);
    expect(signals[0].severity).toBe('major');
  });

  it('ANTI-STARVATION: a structural tool-error signal lands end-to-end despite a 5× red-test backlog', async () => {
    const { captured, capture } = captureRec();
    const memSignal = sig({
      key: 'memory:search:structural', source: 'repeated-tool-error', severity: 'major',
      title: 'Tool memory:search returns a structural error',
    });
    const redTests = Array.from({ length: 5 }, (_, i) =>
      sig({ key: `t${i}`, source: 'red-test', severity: 'major', title: `Test failing repeatedly: t${i}` }),
    );
    const res = await runWatchdogTick('ws', {}, {
      // red-tests FIRST in the list — under the old global cap-3 they would fill every
      // slot and starve the memory signal. The per-source budget (P-009) prevents that.
      collect: async () => [...redTests, memSignal],
      capture,
      recordTick: async () => {},
      readRecentTicks: async () => [],
    });
    expect(captured).toContain('Tool memory:search returns a structural error');
    expect(res.captured.length).toBeGreaterThanOrEqual(1);
  });
});

describe('collectServiceDownSignals', () => {
  const probe = (p: Partial<ProbeResult> & { name: string }): ProbeResult => ({
    up: true,
    status: 200,
    latencyMs: 5,
    ...p,
  });

  it('captures only DOWN + present services', () => {
    const out = collectServiceDownSignals([
      probe({ name: 'operator' }),
      probe({ name: 'vite', up: false, status: null }),
      probe({ name: 'desktop', up: false, present: false }), // legitimately absent → no signal
    ]);
    expect(out.map((s) => s.key)).toEqual(['vite']);
    expect(out[0].title).toBe('Service vite is down');
    expect(out[0].severity).toBe('major');
  });
});

describe('service-down freshness gate (watchdog-robustness P-004)', () => {
  const probe = (p: Partial<ProbeResult> & { name: string }): ProbeResult => ({
    up: true,
    status: 200,
    latencyMs: 5,
    ...p,
  });

  it('isServiceHealthStale: never-probed (null) is stale; fresh is not; beyond the window is', () => {
    const now = 1_000_000;
    const maxStale = 120_000;
    expect(isServiceHealthStale(null, now, maxStale)).toBe(true);
    expect(isServiceHealthStale(now - 30_000, now, maxStale)).toBe(false);
    expect(isServiceHealthStale(now - 200_000, now, maxStale)).toBe(true);
    expect(isServiceHealthStale(now, now, maxStale)).toBe(false);
  });

  it('a FRESH snapshot yields the down signals as before', () => {
    const now = 1_000_000;
    const res = serviceDownCollectorResult({
      results: [probe({ name: 'vite', up: false, status: null })],
      at: now - 10_000,
      now,
      maxStaleMs: 120_000,
    });
    expect(res.signals.map((s) => s.key)).toEqual(['vite']);
    expect(res.note).toBeUndefined();
  });

  it('a STALE snapshot yields NO signals + a stale-service-health note', () => {
    const now = 1_000_000;
    const res = serviceDownCollectorResult({
      results: [probe({ name: 'vite', up: false, status: null })],
      at: now - 200_000, // older than the 120s window
      now,
      maxStaleMs: 120_000,
    });
    expect(res.signals).toEqual([]);
    expect(res.note).toMatch(/stale-service-health/);
    expect(res.note).toMatch(/200s old/);
  });

  it('a NEVER-populated snapshot (at=null) skips with a "never populated" note', () => {
    const res = serviceDownCollectorResult({ results: [], at: null, now: 1_000_000, maxStaleMs: 120_000 });
    expect(res.signals).toEqual([]);
    expect(res.note).toMatch(/never populated/);
  });

  it('default window is 2× the 60s probe interval', () => {
    expect(DEFAULT_SERVICE_HEALTH_MAX_STALE_MS).toBe(120_000);
  });
});

describe('runWatchdogTick — captures through the shared core', () => {
  /** No-op tick sink so unit tests never touch PG (the default recordTick writes PG). */
  const noopRecord = async (): Promise<void> => {};

  function captureRecorder(results: Partial<CaptureImprovementResult>[] = []) {
    const calls: unknown[] = [];
    let i = 0;
    const capture = async (input: unknown): Promise<CaptureImprovementResult> => {
      calls.push(input);
      const r = results[i++] ?? {};
      return {
        ok: true,
        created: r.created ?? true,
        reason: r.reason,
        issue: r.created === false ? undefined : ({ id: `EI-${100 + i}` } as never),
        possibleDuplicates: [],
        ...r,
      } as CaptureImprovementResult;
    };
    return { calls, capture };
  }

  it('captures each planned signal as kind=bug with dedupScope open + the paths', async () => {
    const { calls, capture } = captureRecorder();
    const signals = [sig({ key: 'lib/a.test.ts', paths: ['lib/a.test.ts'] })];
    const res = await runWatchdogTick('ws', {}, { collect: async () => signals, capture, recordTick: noopRecord });
    expect(res.captured).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: 'bug',
      dedupScope: 'open',
      paths: ['lib/a.test.ts'],
      foundDuring: 'improvement-watchdog',
    });
  });

  it('counts declined open-duplicates instead of re-filing (cross-tick dedup)', async () => {
    const { capture } = captureRecorder([{ created: false, reason: 'likely-duplicate' }]);
    const res = await runWatchdogTick('ws', {}, { collect: async () => [sig({ key: 'x' })], capture, recordTick: noopRecord });
    expect(res.captured).toHaveLength(0);
    expect(res.declinedDuplicates).toBe(1);
  });

  it('respects the per-tick cap (deferred surfaces in the result)', async () => {
    const { calls, capture } = captureRecorder();
    const signals = [sig({ key: 'a' }), sig({ key: 'b' }), sig({ key: 'c' })];
    const res = await runWatchdogTick('ws', { maxPerTick: 1 }, { collect: async () => signals, capture, recordTick: noopRecord });
    expect(calls).toHaveLength(1);
    expect(res.deferred).toBe(2);
  });

  it('a single capture failure does not abort the tick', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let n = 0;
      const capture = async (): Promise<CaptureImprovementResult> => {
        n += 1;
        if (n === 1) throw new Error('pg hiccup');
        return { ok: true, created: true, issue: { id: 'EI-9' } as never, possibleDuplicates: [] };
      };
      const res = await runWatchdogTick('ws', {}, { collect: async () => [sig({ key: 'a' }), sig({ key: 'b' })], capture, recordTick: noopRecord });
      expect(res.captured).toEqual(['EI-9']);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/capture failed for red-test:a/));
    } finally {
      warn.mockRestore();
    }
  });

  it('(P-011) accepts pluggable per-target collectors', async () => {
    const { calls, capture } = captureRecorder();
    const customCollectors: WatchdogCollector[] = [
      {
        name: 'my-project-integration-tests',
        collect: async () => [
          sig({ key: 'integration-test', source: 'red-test', title: 'My project integration test failing' }),
        ],
      },
      {
        name: 'my-project-smoke',
        collect: async () => [sig({ key: 'smoke', source: 'smoke-fail', title: 'My project smoke test failing' })],
      },
    ];
    const res = await runWatchdogTick('ws', {}, { collectors: customCollectors, capture, recordTick: noopRecord });
    expect(res.captured).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ title: 'My project integration test failing' });
    expect(calls[1]).toMatchObject({ title: 'My project smoke test failing' });
  });

  it('(P-011) collector failures are caught + logged but do not abort the tick', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { capture } = captureRecorder();
      const collectors: WatchdogCollector[] = [
        {
          name: 'good-collector',
          collect: async () => [sig({ key: 'good', title: 'Good signal' })],
        },
        {
          name: 'bad-collector',
          collect: async () => {
            throw new Error('connection timeout');
          },
        },
      ];
      const res = await runWatchdogTick('ws', {}, { collectors, capture, recordTick: noopRecord });
      expect(res.signals).toBe(1); // only the good signal
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/collector "bad-collector" failed/));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('runWatchdogTick — tick record (watchdog-robustness P-001)', () => {
  function captureOk() {
    let i = 0;
    return async (): Promise<CaptureImprovementResult> =>
      ({ ok: true, created: true, issue: { id: `EI-${++i}` } as never, possibleDuplicates: [] }) as CaptureImprovementResult;
  }

  it('writes one tick record with status, captured ids, and per-collector statuses', async () => {
    const records: WatchdogTickRecord[] = [];
    const collectors: WatchdogCollector[] = [
      { name: 'good', collect: async () => [sig({ key: 'a', title: 'A' })] },
      { name: 'bad', collect: async () => { throw new Error('boom'); } },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await runWatchdogTick('ws-1', {}, {
        collectors,
        capture: captureOk(),
        recordTick: async (r) => { records.push(r); },
      });
      expect(records).toHaveLength(1);
      const rec = records[0];
      expect(rec).toMatchObject({ workspaceId: 'ws-1', status: 'ran', signals: 1 });
      expect(rec.captured).toEqual(res.captured);
      // per-collector status reflects the good + failed collector
      expect(rec.collectors).toEqual([
        { name: 'good', ok: true, signalCount: 1 },
        { name: 'bad', ok: false, signalCount: 0, error: 'boom' },
      ]);
      expect(rec.selfEscalations).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('records the installSlug when given', async () => {
    const records: WatchdogTickRecord[] = [];
    await runWatchdogTick('ws-2', { installSlug: 'papercup' }, {
      collect: async () => [],
      capture: captureOk(),
      recordTick: async (r) => { records.push(r); },
    });
    expect(records[0].installSlug).toBe('papercup');
  });

  it('a tick-record failure does NOT abort the tick (best-effort bookkeeping)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await runWatchdogTick('ws-3', {}, {
        collect: async () => [sig({ key: 'a' })],
        capture: captureOk(),
        recordTick: async () => { throw new Error('pg down'); },
      });
      expect(res.captured).toHaveLength(1); // tick still completed + returned
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/tick record failed: pg down/));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('planSelfEscalations — the watchdog watches itself (watchdog-robustness P-002)', () => {
  const fail = (name: string): CollectorStatus => ({ name, ok: false, signalCount: 0, error: 'boom' });
  const okc = (name: string): CollectorStatus => ({ name, ok: true, signalCount: 1 });
  const tick = (collectors: CollectorStatus[], status: 'ran' | 'skipped' = 'ran'): RecentTick => ({ status, collectors });

  it('escalates a collector failing this tick + the (need-1) prior ticks', () => {
    const out = planSelfEscalations([fail('bad')], [tick([fail('bad')]), tick([fail('bad')])], { failStreakToEscalate: 3 });
    expect(out).toEqual(['bad']);
  });

  it('does NOT escalate before the streak is reached', () => {
    const out = planSelfEscalations([fail('bad')], [tick([fail('bad')])], { failStreakToEscalate: 3 });
    expect(out).toEqual([]); // streak = 2 < 3
  });

  it('a recovered (ok) prior tick breaks the streak', () => {
    const out = planSelfEscalations([fail('bad')], [tick([okc('bad')]), tick([fail('bad')])], { failStreakToEscalate: 3 });
    expect(out).toEqual([]); // most-recent prior shows it recovered → streak resets
  });

  it('a skipped prior tick (no sweep) breaks the streak', () => {
    const out = planSelfEscalations([fail('bad')], [tick([], 'skipped'), tick([fail('bad')])], { failStreakToEscalate: 3 });
    expect(out).toEqual([]);
  });

  it('a collector healthy this tick never escalates', () => {
    const out = planSelfEscalations([okc('good')], [tick([fail('good')]), tick([fail('good')])], { failStreakToEscalate: 3 });
    expect(out).toEqual([]);
  });

  it('failStreakToEscalate=1 escalates on the first failing tick', () => {
    expect(planSelfEscalations([fail('bad')], [], { failStreakToEscalate: 1 })).toEqual(['bad']);
  });
});

describe('runWatchdogTick — self-escalation through the shared core (P-002)', () => {
  const throwingCollector: WatchdogCollector = {
    name: 'papercusp-red-test',
    collect: async () => { throw new Error('relation test_runs does not exist'); },
  };
  const priorFails = (n: number): RecentTick[] =>
    Array.from({ length: n }, () => ({ status: 'ran' as const, collectors: [{ name: 'papercusp-red-test', ok: false, signalCount: 0, error: 'x' }] }));

  function captureRecorder(result: Partial<CaptureImprovementResult> = {}) {
    const calls: unknown[] = [];
    const capture = async (input: unknown): Promise<CaptureImprovementResult> => {
      calls.push(input);
      return {
        ok: true,
        created: result.created ?? true,
        reason: result.reason,
        issue: result.created === false ? undefined : ({ id: 'EI-SELF' } as never),
        possibleDuplicates: [],
        ...result,
      } as CaptureImprovementResult;
    };
    return { calls, capture };
  }

  it('files exactly one kind=bug self-escalation when a collector hits the fail streak', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { calls, capture } = captureRecorder();
      const res = await runWatchdogTick('ws', { failStreakToEscalate: 3 }, {
        collectors: [throwingCollector],
        capture,
        recordTick: async () => {},
        readRecentTicks: async () => priorFails(2), // 2 priors + this tick = streak 3
      });
      expect(res.selfEscalations).toEqual(['EI-SELF']);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        kind: 'bug',
        dedupScope: 'open',
        sourceRole: 'system',
        title: 'Watchdog collector "papercusp-red-test" is failing',
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('does NOT self-escalate before the streak (no prior failing ticks)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { calls, capture } = captureRecorder();
      const res = await runWatchdogTick('ws', { failStreakToEscalate: 3 }, {
        collectors: [throwingCollector],
        capture,
        recordTick: async () => {},
        readRecentTicks: async () => [], // no priors → streak 1 < 3
      });
      expect(res.selfEscalations).toEqual([]);
      expect(calls).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('an OPEN-duplicate self-escalation is not re-filed (dedup across ticks)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { capture } = captureRecorder({ created: false, reason: 'likely-duplicate' });
      const res = await runWatchdogTick('ws', { failStreakToEscalate: 3 }, {
        collectors: [throwingCollector],
        capture,
        recordTick: async () => {},
        readRecentTicks: async () => priorFails(3),
      });
      expect(res.selfEscalations).toEqual([]); // declined as an open duplicate
    } finally {
      warn.mockRestore();
    }
  });

  it('a healthy tick does not read recent ticks or self-escalate', async () => {
    let readCalled = false;
    const { calls, capture } = captureRecorder();
    const res = await runWatchdogTick('ws', { failStreakToEscalate: 3 }, {
      collect: async () => [sig({ key: 'a' })], // injected → collectors = [{injected, ok:true}]
      capture,
      recordTick: async () => {},
      readRecentTicks: async () => { readCalled = true; return []; },
    });
    expect(res.selfEscalations).toEqual([]);
    expect(readCalled).toBe(false); // short-circuited: nothing failed this tick
    expect(calls).toHaveLength(1); // only the real signal capture
  });

  it('caps self-escalations per tick (maxSelfEscalationsPerTick)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { calls, capture } = captureRecorder();
      const twoBad: WatchdogCollector[] = [
        { name: 'col-a', collect: async () => { throw new Error('a'); } },
        { name: 'col-b', collect: async () => { throw new Error('b'); } },
      ];
      const res = await runWatchdogTick('ws', { failStreakToEscalate: 1, maxSelfEscalationsPerTick: 1 }, {
        collectors: twoBad,
        capture,
        recordTick: async () => {},
        readRecentTicks: async () => [],
      });
      expect(res.selfEscalations).toHaveLength(1); // both crossed, but capped at 1
      expect(calls).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('runWatchdogTick — cross-host lock (watchdog-robustness P-003)', () => {
  const captureOk = (counter: { n: number }) =>
    async (): Promise<CaptureImprovementResult> => {
      counter.n += 1;
      return { ok: true, created: true, issue: { id: `EI-${counter.n}` } as never, possibleDuplicates: [] } as CaptureImprovementResult;
    };

  it('runs the tick (and captures) when it HOLDS the lock', async () => {
    const counter = { n: 0 };
    const res = await runWatchdogTick('ws', {}, {
      collect: async () => [sig({ key: 'a' })],
      capture: captureOk(counter),
      recordTick: async () => {},
      withTickLock: async (_ws, fn) => ({ ran: true, value: await fn() }),
    });
    expect(res.status).toBe('ran');
    expect(res.captured).toEqual(['EI-1']);
    expect(counter.n).toBe(1);
  });

  it('SKIPS the tick (zero captures) + records a skipped tick when another host holds the lock', async () => {
    const counter = { n: 0 };
    const records: WatchdogTickRecord[] = [];
    const res = await runWatchdogTick('ws', { installSlug: 'papercup' }, {
      collect: async () => [sig({ key: 'a' })],
      capture: captureOk(counter),
      recordTick: async (r) => { records.push(r); },
      withTickLock: async () => ({ ran: false }), // another host owns it
    });
    expect(res.status).toBe('skipped');
    expect(res.captured).toEqual([]);
    expect(counter.n).toBe(0); // body never ran → nothing captured (no duplicate race)
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'skipped', installSlug: 'papercup', signals: 0 });
  });

  it('default lock FAILS OPEN when the DB is unavailable (runs fn unlocked, never double-runs)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let runs = 0;
      const out = await withWatchdogTickLock('ws', async () => { runs += 1; return 42; });
      expect(out).toEqual({ ran: true, value: 42 });
      expect(runs).toBe(1); // ran exactly once (fail-open, no double-run)
    } finally {
      warn.mockRestore();
    }
  });

  it('default lock propagates a fn error without double-running it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let runs = 0;
      await expect(
        withWatchdogTickLock('ws', async () => { runs += 1; throw new Error('body boom'); }),
      ).rejects.toThrow('body boom');
      expect(runs).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});
