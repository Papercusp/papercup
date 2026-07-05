import { describe, it, expect, vi, afterAll } from 'vitest';
import {
  planWatchdogCaptures,
  collectServiceDownSignals,
  runWatchdogTick,
  isImprovementLoopTool,
  toolErrorSignalsFromRows,
  classifyToolError,
  isEphemeralBenchmarkHarnessSlug,
  isEphemeralBenchmarkSignal,
  ephemeralSignalSlug,
  isEphemeralSignal,
  rollupWatchdogTicks,
  collectMigrationDriftSignals,
  routineFailureSignalsFromRows,
  loopStalledSignalsFromRows,
  stuckPlanSignalsFromRows,
  escalationSignalsFromRows,
  circuitOpenSignalsFromRows,
  isResolvedFirePath,
  normalizeRedTestPath,
  redTestSignalsFromRows,
  isServiceHealthStale,
  serviceDownCollectorResult,
  DEFAULT_SERVICE_HEALTH_MAX_STALE_MS,
  planSelfEscalations,
  withWatchdogTickLock,
  watchdogTickLockUrl,
  _closeWatchdogTickLockForTests,
  watchdogKeyOf,
  partitionSignalsByKnownKeys,
  smokeFailSignalsFromRows,
  expiredLeaseSignalsFromRows,
  failedSpawnSignalsFromRows,
  stalledFeatureSignalsFromRows,
  orphanedSpawnSignalsFromRows,
  stalledClaimSignalsFromRows,
  ceilingJamSignalsFromRows,
  escalationSpikeSignalsFromRows,
  classifySpawnError,
  watchdogOptionsFromPayload,
  type WatchdogKeyDup,
  type WatchdogSignal,
  type WatchdogCollector,
  type WatchdogTickRecord,
  type RecentTick,
  type CollectorStatus,
} from './watchdog';
import type { CaptureImprovementResult } from './capture-core';
import type { ProbeResult } from '../../service-health';
import { _resetHarnessAdminUrlCacheForTests } from '../../embedded-pg-discovery';

function sig(p: Partial<WatchdogSignal> & { key: string }): WatchdogSignal {
  return {
    source: 'red-test',
    title: `Test failing repeatedly: ${p.key}`,
    body: 'detail',
    severity: 'major',
    ...p,
  };
}

/** No-op P-004 key-dup / P-009 prune deps so unit ticks never touch PG. */
const noKeyDups = async (): Promise<WatchdogKeyDup[]> => [];
const noPrune = async (): Promise<void> => {};

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

  it('RATE-LIMIT (external provider 429 / TPM) is volume-gated, kind=change, NOT a code bug (P-002)', () => {
    const signals = toolErrorSignalsFromRows([
      // The 2026-06-17 embed-429: memory:search saturated ~32/78 calls — its OWN key,
      // distinct from the scoping :structural EI it used to be masked under.
      { tool_name: 'memory:search', class: 'rate-limit' as const, n: 32, total: 78, sample: 'openai_embed_failed_429: Rate limit reached … tokens per min (TPM)' },
      { tool_name: 'memory:remember', class: 'rate-limit' as const, n: 6, total: 40, sample: 'openai_embed_failed_429' }, // <8 → gated out
    ]);
    expect(signals.map((s) => s.key)).toEqual(['memory:search:rate-limit']);
    expect(signals[0].kind).toBe('change'); // external capacity, not the auto-implement lane
    expect(signals[0].severity).toBe('major'); // ≥30 → major
    expect(signals[0].findingClass).toBe('external-rate-limit:memory:search');
    expect(signals[0].body).toMatch(/EXTERNAL CAPACITY/);
  });

  it('STRUCTURAL key is sharpened by the SQL fingerprint so two DIFFERENT modes under one tool do not mask each other (P-003)', () => {
    const signals = toolErrorSignalsFromRows([
      { tool_name: 'memory:search', class: 'structural' as const, fingerprint: 'built-in-tool-memory-search-requires', n: 4, total: 50, sample: 'requires a workspace-scoped call' },
      { tool_name: 'memory:search', class: 'structural' as const, fingerprint: 'cannot-read-properties-of-undefined', n: 3, total: 50, sample: 'Cannot read properties of undefined' },
    ]);
    expect(signals.map((s) => s.key).sort()).toEqual([
      'memory:search:structural:built-in-tool-memory-search-requires',
      'memory:search:structural:cannot-read-properties-of-undefined',
    ]);
    // Titles diverge per mode too, so the capture-core search-first dedup can't re-collapse them.
    expect(new Set(signals.map((s) => s.title)).size).toBe(2);
  });

  it('STRUCTURAL without a fingerprint keeps the legacy bare key (back-compat: pre-fingerprint ticks)', () => {
    const signals = toolErrorSignalsFromRows([
      { tool_name: 'docs:get', class: 'structural' as const, n: 7, total: 7, sample: 'boom' },
    ]);
    expect(signals.map((s) => s.key)).toEqual(['docs:get:structural']);
  });
});

describe('classifyToolError — by error_code, with a legacy error_message fallback (P-008 / D-009)', () => {
  it('classifies by the first-class error_code when present (the P-007 path)', () => {
    expect(classifyToolError('unauthorized', 'error', 'x')).toBe('structural');
    expect(classifyToolError('handler_error', 'error', 'x')).toBe('structural');
    expect(classifyToolError('harness_required', 'error', 'x')).toBe('caller'); // P-007: harness arg is the caller's job
    expect(classifyToolError('timeout', 'timeout', 'x')).toBe('transient');
    expect(classifyToolError('invalid_args', 'error', 'x')).toBe('caller');
    expect(classifyToolError('role_not_allowed', 'role-not-allowed', 'x')).toBe('caller');
  });

  it('falls back to status + message for legacy rows (error_code NULL, pre-P-007 deploy)', () => {
    expect(classifyToolError(null, 'error', 'built-in tool requires a workspace-scoped call')).toBe('structural'); // workspace-scope gap stays structural (design intent)
    expect(classifyToolError(null, 'timeout', 'exceeded timeout of 60s')).toBe('transient');
    expect(classifyToolError(null, 'error', 'exceeded timeout of 60s')).toBe('transient');
    expect(classifyToolError(null, 'role-not-allowed', '')).toBe('caller');
    expect(classifyToolError(null, 'error', 'invalid_args: slug expected string')).toBe('caller');
    expect(classifyToolError(null, 'error', 'something unrecognized')).toBe('structural');
  });

  it('classifies PG/infra connection-exhaustion as TRANSIENT, not structural — even with a handler_error code (PG-wedge collateral guard)', () => {
    // The 2026-06-17 wedge surfaced these across every PG-backed tool as handler_error /
    // status=error; the low-bar structural signal mis-filed each tool as broken (EI-1331…1344).
    for (const code of ['handler_error', null]) {
      expect(classifyToolError(code, 'error', 'sorry, too many clients already')).toBe('transient');
      expect(
        classifyToolError(code, 'error', 'remaining connection slots are reserved for roles with the SUPERUSER attribute'),
      ).toBe('transient');
      expect(classifyToolError(code, 'error', 'could not connect to server: Connection refused')).toBe('transient');
      expect(classifyToolError(code, 'error', 'the database system is starting up')).toBe('transient');
    }
    // A genuine tool bug (no infra signature) STILL classifies structural — no false negatives.
    expect(classifyToolError('handler_error', 'error', 'Cannot read properties of undefined')).toBe('structural');
    expect(classifyToolError(null, 'error', 'no such column: foo')).toBe('structural');
  });

  it('classifies an EXTERNAL provider rate-limit (OpenAI embed TPM 429) as rate-limit, not structural (P-002)', () => {
    // handler_error is the dispatcher code for an embed failure; the MESSAGE carries the signal.
    expect(
      classifyToolError('handler_error', 'error', 'openai_embed_failed_429: Rate limit reached for text-embedding-3-small … on tokens per min (TPM)'),
    ).toBe('rate-limit');
    // The misleading "Request too large … Requested 6" variant is the SAME TPM saturation.
    expect(
      classifyToolError('handler_error', 'error', 'openai_embed_failed_429: Request too large … on tokens per min (TPM): Limit 1000000, Requested 6'),
    ).toBe('rate-limit');
    expect(classifyToolError(null, 'error', '429 Too Many Requests')).toBe('rate-limit');
    expect(classifyToolError(null, 'error', 'rate limit exceeded')).toBe('rate-limit');
    // No rate-limit signature → STILL structural (no false positive).
    expect(classifyToolError('handler_error', 'error', 'Cannot read properties of undefined')).toBe('structural');
    // An INTERNAL caller quota_exceeded code stays CALLER (not an external provider limit).
    expect(classifyToolError('quota_exceeded', 'error', 'monthly budget exhausted')).toBe('caller');
  });

  it('classifies harness/scope caller errors as caller, not structural (P-007)', () => {
    expect(classifyToolError('handler_error', 'error', 'No harness specified. `harness` is a per-call arg')).toBe('caller');
    expect(classifyToolError('harness_required', 'error', 'x')).toBe('caller');
    expect(classifyToolError('handler_error', 'error', "resolvePlanScope: harness 'papercup-hive' is not registered in harness_shared.projects in any workspace")).toBe('caller');
    expect(classifyToolError(null, 'error', 'No harness specified')).toBe('caller');
    // A missing WORKSPACE-scope deliberately stays structural (a wiring gap, not a caller arg).
    expect(classifyToolError('unauthorized', 'error', 'built-in tool "memory:search" requires a workspace-scoped call')).toBe('structural');
  });

  it('classifies a timeout that surfaced as handler_error as transient, not structural (P-009)', () => {
    expect(classifyToolError('handler_error', 'error', 'tool "chat:ask_choice" exceeded timeout of 60s (handler returned but signal had aborted)')).toBe('transient');
    expect(classifyToolError('handler_error', 'error', 'plans:attention timed out')).toBe('transient');
  });
});

describe('ephemeral-benchmark signal filter (P-006)', () => {
  it('matches benchmark/throwaway slugs but never real harness slugs', () => {
    for (const s of ['xbench-su-CpaQzU-instance_flipt-io__f', 'xbqbhtpys6a', 'bench-memcap-probe-DELETEME', 'hiveloop-hive', 'sb-gym', 'e2e-imp-j1', 'xbench-smoke-p009-mem'])
      expect(isEphemeralBenchmarkHarnessSlug(s)).toBe(true);
    for (const s of ['papercup', 'papercup-org', 'papercup-org-business', 'papercup-hive', 'sheets', 'sheets-from-template-e2e', 'dbosroll', 'restart'])
      expect(isEphemeralBenchmarkHarnessSlug(s)).toBe(false);
  });

  it('drops per-harness signals for benchmark instances; keeps global + real-harness signals', () => {
    const bench = { source: 'stalled-feature' as const, key: 'xbench-su-CpaQzU', title: 'features in xbench-su-CpaQzU stalled', body: '', severity: 'major' as const, scope: 'harness:xbench-su-CpaQzU-instance_flipt' };
    const govStarve = { source: 'governor-starvation' as const, key: 'gov:xbqbhtpys6a', title: 'Hive xbqbhtpys6a: fleet saturated', body: '', severity: 'minor' as const };
    const real = { source: 'stalled-feature' as const, key: 'papercup', title: 'features in papercup stalled', body: '', severity: 'major' as const, scope: 'harness:papercup' };
    const globalToolErr = { source: 'repeated-tool-error' as const, key: 'memory:search:rate-limit', title: 'rate-limit', body: '', severity: 'minor' as const };
    expect(isEphemeralBenchmarkSignal(bench)).toBe(true);
    expect(isEphemeralBenchmarkSignal(govStarve)).toBe(true);
    expect(isEphemeralBenchmarkSignal(real)).toBe(false);
    expect(isEphemeralBenchmarkSignal(globalToolErr)).toBe(false); // global source — never filtered
  });

  it('P-008: the projects.ephemeral flag drops a flagged-slug signal even when the regex would NOT', () => {
    const flagged = new Set(['some-real-looking-slug']);
    const flaggedSig = { source: 'stalled-feature' as const, key: 'k', title: 'features stalled', body: '', severity: 'major' as const, scope: 'harness:some-real-looking-slug' };
    expect(isEphemeralBenchmarkSignal(flaggedSig)).toBe(false); // regex alone would NOT catch it
    expect(isEphemeralSignal(flaggedSig, flagged)).toBe(true); // ...but the first-class flag does
    // An un-flagged real harness signal is kept; the regex still catches benchmark slugs (fallback).
    const realSig = { source: 'stalled-feature' as const, key: 'k', title: 'features in papercup', body: '', severity: 'major' as const, scope: 'harness:papercup' };
    expect(isEphemeralSignal(realSig, new Set())).toBe(false);
    const benchSig = { source: 'stalled-feature' as const, key: 'k', title: 't', body: '', severity: 'major' as const, scope: 'harness:xbench-su-x-instance_foo' };
    expect(isEphemeralSignal(benchSig, new Set())).toBe(true);
    // ephemeralSignalSlug extracts the harness slug; null for a global (non-per-harness) source.
    expect(ephemeralSignalSlug(flaggedSig)).toBe('some-real-looking-slug');
    expect(ephemeralSignalSlug({ source: 'repeated-tool-error' as const, key: 'memory:search:rate-limit', title: 't', body: '', severity: 'minor' as const })).toBeNull();
  });
});

describe('rollupWatchdogTicks (P-013 observability)', () => {
  it('sums benchmark-filter drops + buckets repeated-tool-error keys by class', () => {
    const r = rollupWatchdogTicks([
      {
        collectors: [
          { name: 'ephemeral-benchmark-filter', note: 'dropped 12 ephemeral-benchmark harness signal(s) — debris' },
          { name: 'papercusp-red-test' },
        ],
        knownOpenKeys: [
          'repeated-tool-error:memory:search:rate-limit',
          'repeated-tool-error:plans:list:caller',
          'repeated-tool-error:coord:wake-queue:transient',
          'repeated-tool-error:memory:search:structural',
          'repeated-tool-error:memory:search:structural:built-in-tool-foo', // fingerprinted structural
          'red-test:foo.test.ts', // not a tool-error → ignored
        ],
      },
      { collectors: [{ name: 'ephemeral-benchmark-filter', note: 'dropped 8 debris' }], knownOpenKeys: ['repeated-tool-error:plans:get:caller'] },
    ]);
    expect(r.benchmarkDropped).toBe(20);
    expect(r.toolErrorByClass).toEqual({ 'rate-limit': 1, caller: 2, transient: 1, structural: 2 });
  });

  it('is empty-safe', () => {
    expect(rollupWatchdogTicks([])).toEqual({ benchmarkDropped: 0, toolErrorByClass: {} });
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

  it('routine-failure (EI-5302): a loop routine\'s dbos-executor-reaper self-heal requeue is SUPPRESSED (loop-stalled already covers a real wedge)', () => {
    const signals = routineFailureSignalsFromRows([
      {
        name: 'loop-su-abc123',
        last_error: 'DBOS routineFire produced no DBOS operation output; executor reaper cancelled the stuck fire and requeued the routine',
        is_loop: true,
        last_error_source: 'dbos-executor-reaper',
      },
    ]);
    expect(signals).toEqual([]);
  });

  it('routine-failure (EI-5302): a loop routine with a NON-reaper error still fires (the exclusion is source-specific, not a blanket loop exemption)', () => {
    const signals = routineFailureSignalsFromRows([
      { name: 'loop-su-def456', last_error: 'some genuine crash', is_loop: true, last_error_source: 'runner' },
    ]);
    expect(signals.map((s) => s.key)).toEqual(['routine:loop-su-def456']);
  });

  it('routine-failure (EI-5302): a NON-loop routine with a reaper-sourced error and NO next_fire_at still fires (unproven recovery)', () => {
    const signals = routineFailureSignalsFromRows([
      { name: 'git-sync', last_error: 'produced no DBOS operation output', is_loop: false, last_error_source: 'dbos-executor-reaper' },
    ]);
    expect(signals.map((s) => s.key)).toEqual(['routine:git-sync']);
  });

  it('routine-failure (EI-6172): a NON-loop routine with a reaper-sourced error IS suppressed when next_fire_at is a concrete future timestamp (proven rescheduled)', () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // a week out, like a weekly bp-singleton battery
    const signals = routineFailureSignalsFromRows([
      {
        name: 'bp-singleton-iq-battery-0',
        last_error: 'DBOS routineFire produced no DBOS operation output; executor reaper cancelled the stuck fire and requeued the routine',
        is_loop: false,
        last_error_source: 'dbos-executor-reaper',
        next_fire_at: future,
      },
    ]);
    expect(signals).toEqual([]);
  });

  it('routine-failure (EI-6172): a NON-loop routine with a reaper-sourced error still fires when next_fire_at is in the PAST (overdue, not proven recovered)', () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const signals = routineFailureSignalsFromRows([
      { name: 'stuck-cron', last_error: 'produced no DBOS operation output', is_loop: false, last_error_source: 'dbos-executor-reaper', next_fire_at: past },
    ]);
    expect(signals.map((s) => s.key)).toEqual(['routine:stuck-cron']);
  });

  it('routine-failure (EI-5302): the body no longer names git-sync as a false example (was mis-triggering the git-sync human-gate keyword)', () => {
    const signals = routineFailureSignalsFromRows([{ name: 'loop-su-xyz', last_error: 'crash' }]);
    expect(signals[0].body).not.toContain('git-sync');
  });

  it('loop-stalled (P1b): one signal per parked-dead loop, harness-scoped, citing the runbook', () => {
    const signals = loopStalledSignalsFromRows([
      { id: 'rt-1', name: 'loop-su-x', install_slug: 'papercusp', target_owner_id: 'su-x', interval_sec: 120, parked_secs: 2400 },
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0].source).toBe('loop-stalled');
    expect(signals[0].key).toBe('loop-stalled:papercusp:loop-su-x');
    expect(signals[0].body).toContain('~40min'); // 2400s
    expect(signals[0].body).toContain('loop-wake-turn-deaths-recorded-as-delivered');
    expect(signals[0].kind).toBe('bug');
    expect(signals[0].scope).toBe('harness:papercusp');
  });

  it('stuck-plan: one signal per stuck plan, keyed by harness+plan', () => {
    const signals = stuckPlanSignalsFromRows([
      { harness_slug: 'papercup', plan_slug: 'some-plan', status: 'started', stale_hours: 51 },
    ]);
    expect(signals[0].key).toBe('stuck-plan:papercup:some-plan');
    expect(signals[0].body).toContain('51h');
    expect(signals[0].kind).toBe('bug');
    // P-032: a stuck plan is attributable to its harness → harness-scoped origin.
    expect(signals[0].scope).toBe('harness:papercup');
  });

  it('unresolved-escalation: one signal per unaddressed escalation', () => {
    const signals = escalationSignalsFromRows([{ harness_slug: 'sheets', phase: 'production' }]);
    expect(signals[0].key).toBe('escalation:sheets:production');
    expect(signals[0].source).toBe('unresolved-escalation');
    // P-032: harness-attributable origin scope.
    expect(signals[0].scope).toBe('harness:sheets');
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
    // P-032: harness-attributable origin scope.
    expect(signals[0].scope).toBe('harness:papercup-org');
  });

  // EI-6721: a dead, auto-paused loop:arm loop kept re-filing "stuck in error-backoff" EIs
  // (EI-6864/6912/6994/7127/7257/7386 all for the SAME dead loop-su-<uuid>) because this
  // collector — unlike the chronic-failure sweep — never checked the underlying routine state.
  it('fire-circuit-open: DROPS a row whose routine is auto-paused (routine_active=false)', () => {
    const signals = circuitOpenSignalsFromRows([
      { harness_slug: '*', role: 'loop-su-24eedd86', consecutive_errors: 54, last_status: 'loop-terminal-unreachable', routine_active: false },
    ]);
    expect(signals).toEqual([]);
  });

  it('fire-circuit-open: DROPS an ephemeral loop:arm owner loop (routine_target_owner_id set)', () => {
    const signals = circuitOpenSignalsFromRows([
      { harness_slug: '*', role: 'loop-su-24eedd86', consecutive_errors: 54, last_status: 'x', routine_target_owner_id: 'su-24eedd86' },
    ]);
    expect(signals).toEqual([]);
  });

  it('fire-circuit-open: STILL fires for a fixed system role (no matching routine → routine_active null, no owner)', () => {
    const signals = circuitOpenSignalsFromRows([
      { harness_slug: 'gymloopharness', role: 'gym-cycle', consecutive_errors: 9, last_status: 'error', routine_active: null, routine_target_owner_id: null },
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0].key).toBe('circuit:gymloopharness:gym-cycle');
  });

  it('isResolvedFirePath: suppresses auto-paused OR loop:arm owner; fail-open otherwise', () => {
    expect(isResolvedFirePath({ routine_active: false })).toBe(true);
    expect(isResolvedFirePath({ routine_target_owner_id: 'su-abc' })).toBe(true);
    // fail-open: unknown routine state (no join match) and a live fixed system role are NOT suppressed
    expect(isResolvedFirePath({ routine_active: null, routine_target_owner_id: null })).toBe(false);
    expect(isResolvedFirePath({ routine_active: true, routine_target_owner_id: '' })).toBe(false);
    expect(isResolvedFirePath({})).toBe(false);
  });
});

describe('hive-loop invariant monitors (hive-loop-e2e-testing-2026-06-10 P-010)', () => {
  const HOUR = 3_600_000;

  it('stalled-feature: ONE aggregate signal per harness, sample ids + oldest age in the body', () => {
    const now = Date.now();
    const signals = stalledFeatureSignalsFromRows(
      [
        { harness_slug: 'alpha', feature_id: 'F-1', updated_ts: now - 30 * HOUR },
        { harness_slug: 'alpha', feature_id: 'F-2', updated_ts: now - 14 * HOUR },
        { harness_slug: 'beta', feature_id: 'F-9', updated_ts: now - 13 * HOUR },
      ],
      { staleHours: 12, nowMs: now },
    );
    expect(signals.map((s) => s.key).sort()).toEqual(['stalled:alpha', 'stalled:beta']);
    const alpha = signals.find((s) => s.key === 'stalled:alpha')!;
    expect(alpha.source).toBe('stalled-feature');
    expect(alpha.severity).toBe('major');
    expect(alpha.body).toContain('2 dispatchable feature(s)');
    expect(alpha.body).toContain('F-1');
    expect(alpha.body).toContain('~30h');
    // P-032: one aggregate signal PER harness → harness-scoped origin (not blanket operator).
    expect(alpha.scope).toBe('harness:alpha');
    expect(signals.find((s) => s.key === 'stalled:beta')!.scope).toBe('harness:beta');
  });

  it('stalled-feature: no rows → no signal', () => {
    expect(stalledFeatureSignalsFromRows([])).toEqual([]);
  });

  it('orphaned-spawn: lingering past-reclaim running rows collapse to ONE signal with samples', () => {
    const signals = orphanedSpawnSignalsFromRows(
      [
        { spawn_id: 's-dead-1', harness_slug: 'alpha', heartbeat_at: null, started_at: new Date() },
        { spawn_id: 's-dead-2', harness_slug: null, heartbeat_at: new Date(), started_at: new Date() },
      ],
      { staleMinutes: 15 },
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].source).toBe('orphaned-spawn');
    expect(signals[0].key).toBe('orphaned-running-rows');
    expect(signals[0].body).toContain('2 spawned_agents row(s)');
    expect(signals[0].body).toContain('s-dead-1');
    // P-032: reclaim-non-execution is a WORKSPACE-global aggregate (it collapses
    // rows from many harnesses into one signal) → no harness scope; defaults to operator.
    expect(signals[0].scope).toBeUndefined();
    expect(orphanedSpawnSignalsFromRows([])).toEqual([]);
  });

  it('stalled-claim: live-holder-no-progress claims collapse to ONE signal (P-007, folds EI-2311)', () => {
    const signals = stalledClaimSignalsFromRows(
      [
        { work_item_id: 'WI-1', agent_id: 'bee-stuck', harness_slug: 'alpha', detail: 'a feature', stalled_minutes: 42 },
        { work_item_id: 'F-9', agent_id: 'bee-2', harness_slug: null, detail: 'another', stalled_minutes: 33 },
      ],
      { minMinutes: 30 },
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].source).toBe('stalled-claim');
    expect(signals[0].key).toBe('stalled-work-item-claims');
    expect(signals[0].findingClass).toBe('coordination:stalled-claim');
    expect(signals[0].body).toContain('2 work-item claim(s)');
    expect(signals[0].body).toContain('WI-1<-bee-stuck');
    expect(stalledClaimSignalsFromRows([])).toEqual([]);
  });

  describe('spawn-ceiling-jam (EI-2186): admission consumed by non-streaming rows', () => {
    const now = Date.UTC(2026, 5, 21, 4, 0, 0);
    const minsAgo = (m: number) => new Date(now - m * 60_000);
    const opts = { ceiling: 8, minAgeMinutes: 15, silentMinutes: 15, slack: 2, now };

    it('fires ONE critical signal when old non-streaming rows dominate the ceiling (the jam)', () => {
      // 8 rows started 60 min ago, none streamed in the last 15 min → the EI-2186 jam.
      const rows = Array.from({ length: 8 }, (_, i) => ({
        spawn_id: `s-jam-${i}`,
        harness_slug: 'papercup',
        started_at: minsAgo(60),
        last_output_at: i < 1 ? minsAgo(40) : null, // even the one with output is stale
      }));
      const signals = ceilingJamSignalsFromRows(rows, opts);
      expect(signals).toHaveLength(1);
      expect(signals[0].source).toBe('spawn-ceiling-jam');
      expect(signals[0].key).toBe('spawn-ceiling-jam');
      expect(signals[0].severity).toBe('critical');
      expect(signals[0].body).toContain('maxSimultaneousAgents=8');
      expect(signals[0].body).toContain('s-jam-0');
    });

    it('stays silent on a busy fleet — most running rows streamed recently', () => {
      const rows = Array.from({ length: 8 }, (_, i) => ({
        spawn_id: `s-live-${i}`,
        harness_slug: 'papercup',
        started_at: minsAgo(60),
        last_output_at: minsAgo(1), // all actively streaming → genuinely alive
      }));
      expect(ceilingJamSignalsFromRows(rows, opts)).toEqual([]);
    });

    it('absorbs a couple of quiet/long-tool-call bees via slack (does not fire on 2)', () => {
      const rows = [
        { spawn_id: 'q1', harness_slug: 'papercup', started_at: minsAgo(60), last_output_at: null },
        { spawn_id: 'q2', harness_slug: 'papercup', started_at: minsAgo(60), last_output_at: null },
      ];
      expect(ceilingJamSignalsFromRows(rows, opts)).toEqual([]);
    });

    it('does not count YOUNG rows that have not had time to stream yet', () => {
      // 5 rows started 3 min ago with no output → too young to be suspect; no fire.
      const rows = Array.from({ length: 5 }, (_, i) => ({
        spawn_id: `young-${i}`,
        harness_slug: 'papercup',
        started_at: minsAgo(3),
        last_output_at: null,
      }));
      expect(ceilingJamSignalsFromRows(rows, opts)).toEqual([]);
    });

    it('does not fire when live streamers outnumber the stale-suspect rows', () => {
      const rows = [
        // 3 genuinely live (streamed in the last minute)
        ...Array.from({ length: 5 }, (_, i) => ({ spawn_id: `live-${i}`, harness_slug: 'p', started_at: minsAgo(60), last_output_at: minsAgo(1) })),
        // 3 stale suspects — but they do NOT outnumber the live ones
        ...Array.from({ length: 3 }, (_, i) => ({ spawn_id: `s-${i}`, harness_slug: 'p', started_at: minsAgo(60), last_output_at: null })),
      ];
      expect(ceilingJamSignalsFromRows(rows, opts)).toEqual([]);
    });

    it('is silent with no rows', () => {
      expect(ceilingJamSignalsFromRows([], opts)).toEqual([]);
    });

    // EI-7215: in-process loopback launches (durable-spawn workers, launch-* blueprints,
    // Queen/overwatch wakes) NEVER populate last_output_at — so the stream-recency proxy
    // is inapplicable and they must be EXCLUDED, else every live one reads as a stale debit.
    it('does NOT fire on a fleet of live in-process launches (the EI-7215 false positive)', () => {
      // A healthy fleet: durable-spawn implement workers + a launch-* doc-steward,
      // all old, none streaming (they structurally never do). This is exactly the
      // state that fired a false-positive critical before the fix.
      const rows = [
        { spawn_id: 'durable-spawn:implement:EI-6743:1', harness_slug: 'papercup', started_at: minsAgo(60), last_output_at: null, run_id: 'implement:EI-6743:1' },
        { spawn_id: 'durable-spawn:implement:EI-6966:1', harness_slug: 'papercup', started_at: minsAgo(45), last_output_at: null, run_id: 'implement:EI-6966:1' },
        { spawn_id: 'durable-spawn:implement:EI-7204:1', harness_slug: 'papercup', started_at: minsAgo(30), last_output_at: null, run_id: 'implement:EI-7204:1' },
        { spawn_id: 's-doc-steward-1', harness_slug: 'papercup', started_at: minsAgo(20), last_output_at: null, run_id: 'launch-1783137290156-c0e6f1' },
      ];
      expect(ceilingJamSignalsFromRows(rows, opts)).toEqual([]);
    });

    it('still fires on a genuine bee-spawn jam while ignoring co-running in-process launches', () => {
      // 4 real invoke-once bee spawns, old + never streamed → a genuine jam,
      // PLUS 3 live in-process launches that must NOT be counted (neither as
      // running, streamers, nor jammed).
      const rows = [
        ...Array.from({ length: 4 }, (_, i) => ({ spawn_id: `s-bee-${i}`, harness_slug: 'papercup', started_at: minsAgo(60), last_output_at: null as string | null, run_id: `bee-run-${i}` })),
        ...Array.from({ length: 3 }, (_, i) => ({ spawn_id: `durable-spawn:implement:EI-${i}:1`, harness_slug: 'papercup', started_at: minsAgo(60), last_output_at: null as string | null, run_id: `implement:EI-${i}:1` })),
      ];
      const signals = ceilingJamSignalsFromRows(rows, opts);
      expect(signals).toHaveLength(1);
      expect(signals[0].source).toBe('spawn-ceiling-jam');
      // Body reports the 4 EVALUABLE bee rows as running, not all 7.
      expect(signals[0].body).toContain('4 spawned_agents row(s)');
      expect(signals[0].body).toContain('s-bee-0');
      // The in-process launches are never named as jammed.
      expect(signals[0].body).not.toContain('durable-spawn');
    });
  });

  it('escalation-spike: silent below threshold, ONE signal with per-harness breakdown at/above it', () => {
    const rows = [
      { harness_slug: 'alpha', mtime_ms: Date.now() },
      { harness_slug: 'alpha', mtime_ms: Date.now() },
      { harness_slug: 'beta', mtime_ms: Date.now() },
    ];
    expect(escalationSpikeSignalsFromRows(rows.slice(0, 2), { minCount: 3 })).toEqual([]);
    const signals = escalationSpikeSignalsFromRows(rows, { windowHours: 6, minCount: 3 });
    expect(signals).toHaveLength(1);
    expect(signals[0].source).toBe('escalation-spike');
    expect(signals[0].key).toBe('escalation-rate');
    expect(signals[0].body).toContain('3 escalation(s)');
    expect(signals[0].body).toContain('alpha×2');
    expect(signals[0].body).toContain('beta×1');
    // P-032: a RATE spike ACROSS the hive spans multiple harnesses (alpha + beta
    // here) — genuinely workspace-global → no harness scope; defaults to operator.
    expect(signals[0].scope).toBeUndefined();
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
    const res = await runWatchdogTick('ws', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune,
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

  it('a FRESH snapshot yields the down signals as before', async () => {
    const now = 1_000_000;
    const res = await serviceDownCollectorResult({
      results: [probe({ name: 'vite', up: false, status: null })],
      at: now - 10_000,
      now,
      maxStaleMs: 120_000,
    });
    expect(res.signals.map((s) => s.key)).toEqual(['vite']);
    expect(res.note).toBeUndefined();
  });

  // R4-7: with inline-probe DISABLED, the stale path keeps the legacy skip.
  it('a STALE snapshot (inline-probe off) yields NO signals + a stale-service-health skip note', async () => {
    const now = 1_000_000;
    const res = await serviceDownCollectorResult({
      results: [probe({ name: 'vite', up: false, status: null })],
      at: now - 200_000, // older than the 120s window
      now,
      maxStaleMs: 120_000,
      inlineProbe: false,
    });
    expect(res.signals).toEqual([]);
    expect(res.note).toMatch(/stale-service-health/);
    expect(res.note).toMatch(/skipping service-down/);
    expect(res.note).toMatch(/200s old/);
  });

  it('a NEVER-populated snapshot (at=null, inline-probe off) skips with a "never populated" note', async () => {
    const res = await serviceDownCollectorResult({
      results: [], at: null, now: 1_000_000, maxStaleMs: 120_000, inlineProbe: false,
    });
    expect(res.signals).toEqual([]);
    expect(res.note).toMatch(/never populated/);
  });

  // R4-7: with inline-probe ENABLED (default), a stale snapshot runs a FRESH probe
  // instead of going blind — a real DOWN is still caught when the writer stalled.
  it('a STALE snapshot (inline-probe on) runs a fresh inline probe + emits its DOWN signals', async () => {
    const now = 1_000_000;
    let probed = false;
    const res = await serviceDownCollectorResult({
      // The cached `results` are intentionally all-UP — they must be IGNORED on
      // the stale path; the fresh probe (vite DOWN) is what should drive signals.
      results: [probe({ name: 'vite', up: true })],
      at: now - 200_000,
      now,
      maxStaleMs: 120_000,
      inlineProbe: true,
      probe: async () => {
        probed = true;
        return [probe({ name: 'operator' }), probe({ name: 'vite', up: false, status: null })];
      },
    });
    expect(probed).toBe(true);
    expect(res.signals.map((s) => s.key)).toEqual(['vite']);
    expect(res.signals[0].severity).toBe('major');
    expect(res.note).toMatch(/fresh inline probe/);
  });

  it('a STALE snapshot (inline-probe on) with all-up fresh probe emits NO signals (no phantom down)', async () => {
    const now = 1_000_000;
    const res = await serviceDownCollectorResult({
      at: now - 200_000,
      now,
      maxStaleMs: 120_000,
      inlineProbe: true,
      probe: async () => [probe({ name: 'operator' }), probe({ name: 'vite' })],
    });
    expect(res.signals).toEqual([]);
    expect(res.note).toMatch(/fresh inline probe/);
  });

  // R4-7: if the inline probe itself throws, never go blind — emit a single
  // DEGRADED/unknown signal so a stale-and-unprobeable monitor is visible.
  it('a STALE snapshot (inline-probe on) whose probe THROWS emits a degraded monitor signal', async () => {
    const now = 1_000_000;
    const res = await serviceDownCollectorResult({
      at: now - 200_000,
      now,
      maxStaleMs: 120_000,
      inlineProbe: true,
      probe: async () => { throw new Error('probe blew up'); },
    });
    expect(res.signals).toHaveLength(1);
    expect(res.signals[0].source).toBe('service-down');
    expect(res.signals[0].key).toBe('service-health-monitor');
    expect(res.signals[0].title).toMatch(/degraded/i);
    expect(res.signals[0].body).toMatch(/probe blew up/);
    expect(res.signals[0].findingClass).toBe('service-down:monitor-degraded');
    expect(res.note).toMatch(/inline probe failed/);
  });

  // The blind-spot regression guard: a stale snapshot must NEVER produce both
  // zero signals AND no note (the old silent-skip-under-load failure mode).
  it('a STALE snapshot is never fully blind (signals OR a note, both inline modes)', async () => {
    const now = 1_000_000;
    const stale = { at: now - 200_000, now, maxStaleMs: 120_000 } as const;
    const off = await serviceDownCollectorResult({ ...stale, inlineProbe: false, results: [] });
    const onDown = await serviceDownCollectorResult({
      ...stale, inlineProbe: true, probe: async () => [probe({ name: 'vite', up: false })],
    });
    const onThrow = await serviceDownCollectorResult({
      ...stale, inlineProbe: true, probe: async () => { throw new Error('x'); },
    });
    for (const r of [off, onDown, onThrow]) {
      expect(r.signals.length > 0 || (r.note != null && r.note.length > 0)).toBe(true);
    }
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
    const res = await runWatchdogTick('ws', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune, collect: async () => signals, capture, recordTick: noopRecord });
    expect(res.captured).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: 'bug',
      dedupScope: 'open',
      paths: ['lib/a.test.ts'],
      foundDuring: 'improvement-watchdog',
      // consume-edges P-021: scope is always explicit so the D-005 triage
      // taxonomy can key off it ('operator' when the signal doesn't set one).
      scope: 'operator',
    });
  });

  it('passes a per-signal scope through to the capture (consume-edges P-021)', async () => {
    const { calls, capture } = captureRecorder();
    const signals = [sig({ key: 'hive-x', scope: 'harness:sheets' })];
    await runWatchdogTick('ws', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune, collect: async () => signals, capture, recordTick: noopRecord });
    expect(calls[0]).toMatchObject({ scope: 'harness:sheets' });
  });

  it('passes a per-signal findingClass through to the capture (frontier P-044 taxonomy slug)', async () => {
    const { calls, capture } = captureRecorder();
    const signals = [sig({ key: 'slo-x', findingClass: 'learning-slo:triage-degeneracy' })];
    await runWatchdogTick('ws', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune, collect: async () => signals, capture, recordTick: noopRecord });
    expect(calls[0]).toMatchObject({ findingClass: 'learning-slo:triage-degeneracy' });
    // absent on the signal stays absent on the capture — graduation's
    // findingClassOf falls back to `<source>:unclassified`, never a fake stamp.
    const { calls: bare, capture: bareCapture } = captureRecorder();
    await runWatchdogTick('ws', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune, collect: async () => [sig({ key: 'y' })], capture: bareCapture, recordTick: noopRecord });
    expect((bare[0] as { findingClass?: string }).findingClass).toBeUndefined();
  });

  it('counts declined open-duplicates instead of re-filing (cross-tick dedup)', async () => {
    const { capture } = captureRecorder([{ created: false, reason: 'likely-duplicate' }]);
    const res = await runWatchdogTick('ws', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune, collect: async () => [sig({ key: 'x' })], capture, recordTick: noopRecord });
    expect(res.captured).toHaveLength(0);
    expect(res.declinedDuplicates).toBe(1);
  });

  it('respects the per-tick cap (deferred surfaces in the result)', async () => {
    const { calls, capture } = captureRecorder();
    const signals = [sig({ key: 'a' }), sig({ key: 'b' }), sig({ key: 'c' })];
    const res = await runWatchdogTick('ws', { maxPerTick: 1 }, { readKeyDups: noKeyDups, pruneTicks: noPrune, collect: async () => signals, capture, recordTick: noopRecord });
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
      const res = await runWatchdogTick('ws', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune, collect: async () => [sig({ key: 'a' }), sig({ key: 'b' })], capture, recordTick: noopRecord });
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
    const res = await runWatchdogTick('ws', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune, collectors: customCollectors, capture, recordTick: noopRecord });
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
      const res = await runWatchdogTick('ws', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune, collectors, capture, recordTick: noopRecord });
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
      const res = await runWatchdogTick('ws-1', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune,
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
    await runWatchdogTick('ws-2', { installSlug: 'papercup' }, { readKeyDups: noKeyDups, pruneTicks: noPrune,
      collect: async () => [],
      capture: captureOk(),
      recordTick: async (r) => { records.push(r); },
    });
    expect(records[0].installSlug).toBe('papercup');
  });

  it('a tick-record failure does NOT abort the tick (best-effort bookkeeping)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await runWatchdogTick('ws-3', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune,
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
      const res = await runWatchdogTick('ws', { failStreakToEscalate: 3 }, { readKeyDups: noKeyDups, pruneTicks: noPrune,
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
      const res = await runWatchdogTick('ws', { failStreakToEscalate: 3 }, { readKeyDups: noKeyDups, pruneTicks: noPrune,
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
      const res = await runWatchdogTick('ws', { failStreakToEscalate: 3 }, { readKeyDups: noKeyDups, pruneTicks: noPrune,
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
    const res = await runWatchdogTick('ws', { failStreakToEscalate: 3 }, { readKeyDups: noKeyDups, pruneTicks: noPrune,
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
      const res = await runWatchdogTick('ws', { failStreakToEscalate: 1, maxSelfEscalationsPerTick: 1 }, { readKeyDups: noKeyDups, pruneTicks: noPrune,
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
    const res = await runWatchdogTick('ws', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune,
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
    const res = await runWatchdogTick('ws', { installSlug: 'papercup' }, { readKeyDups: noKeyDups, pruneTicks: noPrune,
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

  // backend-connection-scaling-2026-06-17 P-001: the tick mutex is a SESSION-level
  // pg_advisory_lock — acquire + release MUST hit the same backend. Under PgBouncer
  // transaction pooling (PAPERCUSP_PGBOUNCER=1) the pooled org client reassigns
  // backends per statement, so the lock connection MUST bypass the pooler. This
  // guards against a future refactor "helpfully" routing it through maybePgbouncer.
  describe('tick-lock connection is DIRECT, never the PgBouncer pooler (P-001)', () => {
    const DIRECT = 'postgresql://harness_admin:pw@db-direct.test:5432/papercusp';
    const env = process.env;
    const KEYS = [
      'HARNESS_ADMIN_DATABASE_URL',
      'DATABASE_URL',
      'PAPERCUSP_PG_URL',
      'PAPERCUSP_PGBOUNCER',
      'PAPERCUSP_PGBOUNCER_PORT',
    ] as const;
    // Snapshot originals so we can restore EXACTLY — `env.X = undefined` coerces to
    // the STRING "undefined" (poisoning getHarnessAdminUrl for later tests), so an
    // originally-unset var must be `delete`-d, not assigned.
    const original = new Map(KEYS.map((k) => [k, env[k]]));
    const setOrDelete = (k: string, v: string | undefined) => {
      if (v === undefined) delete env[k];
      else env[k] = v;
    };
    afterAll(() => {
      for (const k of KEYS) setOrDelete(k, original.get(k));
      _resetHarnessAdminUrlCacheForTests();
    });

    it('stays the direct admin URL even when PAPERCUSP_PGBOUNCER=1', () => {
      env.HARNESS_ADMIN_DATABASE_URL = DIRECT;
      delete env.DATABASE_URL;
      delete env.PAPERCUSP_PG_URL;
      env.PAPERCUSP_PGBOUNCER = '1';
      env.PAPERCUSP_PGBOUNCER_PORT = '6432';
      _resetHarnessAdminUrlCacheForTests();

      const url = watchdogTickLockUrl();
      expect(url).toBe(DIRECT);
      // The whole point: NOT rerouted to the local pooler port.
      expect(url).not.toContain('6432');
      expect(url).not.toContain('127.0.0.1');
    });
  });

  // Close the dedicated tick-lock connection the default-path tests may have opened
  // (idle_timeout:0 singleton) so the suite leaves no open PG handle.
  afterAll(async () => {
    await _closeWatchdogTickLockForTests();
  });
});

// ── watchdog-audit-2026-06-09 coverage ───────────────────────────────────────

describe('partitionSignalsByKnownKeys — key pre-filter (audit P-004/P-005)', () => {
  const dup = (watchdogKey: string, state: string, updatedAt: string): WatchdogKeyDup => ({ watchdogKey, state, updatedAt });

  it('drops a signal whose key matches an OPEN improvement (already filed)', () => {
    const s = sig({ key: 'lib/a.test.ts' });
    const out = partitionSignalsByKnownKeys([s], [dup('red-test:lib/a.test.ts', 'open', '2026-06-09T00:00:00Z')]);
    expect(out.knownOpen).toEqual([s]);
    expect(out.fresh).toEqual([]);
    expect(out.staleResolved).toEqual([]);
  });

  it('drops a resolved-dup signal whose evidence pre-dates the resolution (D-002 — not a regression)', () => {
    const s = sig({ key: 'lib/a.test.ts', latestAt: '2026-06-08T00:00:00.000Z' });
    const out = partitionSignalsByKnownKeys([s], [dup('red-test:lib/a.test.ts', 'resolved', '2026-06-09T00:00:00.000Z')]);
    expect(out.staleResolved).toEqual([s]);
    expect(out.fresh).toEqual([]);
  });

  it('re-files a resolved dup when the evidence POST-dates the resolution (real regression)', () => {
    const s = sig({ key: 'lib/a.test.ts', latestAt: '2026-06-09T12:00:00.000Z' });
    const out = partitionSignalsByKnownKeys([s], [dup('red-test:lib/a.test.ts', 'resolved', '2026-06-09T00:00:00.000Z')]);
    expect(out.fresh).toEqual([s]);
  });

  it('a live-state signal (no latestAt) with only resolved dups re-files (the problem exists NOW)', () => {
    const s = sig({ key: 'vite', source: 'service-down' });
    const out = partitionSignalsByKnownKeys([s], [dup('service-down:vite', 'resolved', '2026-06-09T00:00:00.000Z')]);
    expect(out.fresh).toEqual([s]);
  });

  it('an OPEN match wins over resolved matches (knownOpen, never staleResolved)', () => {
    const s = sig({ key: 'x', latestAt: '2026-06-01T00:00:00.000Z' });
    const out = partitionSignalsByKnownKeys([s], [
      dup('red-test:x', 'resolved', '2026-06-09T00:00:00.000Z'),
      dup('red-test:x', 'open', '2026-06-02T00:00:00.000Z'),
    ]);
    expect(out.knownOpen).toEqual([s]);
  });

  it('no matching key → fresh', () => {
    const s = sig({ key: 'x' });
    expect(partitionSignalsByKnownKeys([s], [dup('red-test:other', 'open', '2026-06-09T00:00:00.000Z')]).fresh).toEqual([s]);
  });
});

describe('partitionSignalsByKnownKeys — resolution cooldown (EI-427 deploy-lag suppressor)', () => {
  const dup = (watchdogKey: string, state: string, updatedAt: string): WatchdogKeyDup => ({ watchdogKey, state, updatedAt });
  const COOLDOWN = 2 * 60 * 60 * 1000; // 2h

  it('suppresses a re-file when the fix resolved WITHIN the cooldown before the scan (still deploying)', () => {
    // latestAt (scan) is 1h after the resolution → without a cooldown this would
    // re-file as a "real regression"; the cooldown holds it for the deploy window.
    const s = sig({ key: 'dbos', source: 'insight-staleness', latestAt: '2026-06-09T01:00:00.000Z', resolutionCooldownMs: COOLDOWN });
    const out = partitionSignalsByKnownKeys([s], [dup('insight-staleness:dbos', 'resolved', '2026-06-09T00:00:00.000Z')]);
    expect(out.staleResolved).toEqual([s]);
    expect(out.fresh).toEqual([]);
  });

  it('re-files once the resolution is OLDER than the cooldown (the fix genuinely never deployed)', () => {
    const s = sig({ key: 'dbos', source: 'insight-staleness', latestAt: '2026-06-09T05:00:00.000Z', resolutionCooldownMs: COOLDOWN });
    const out = partitionSignalsByKnownKeys([s], [dup('insight-staleness:dbos', 'resolved', '2026-06-09T00:00:00.000Z')]);
    expect(out.fresh).toEqual([s]); // resolved 5h ago, past the 2h cooldown
  });

  it('cooldown is opt-in — a signal without resolutionCooldownMs still re-files on post-resolution evidence', () => {
    const s = sig({ key: 'dbos', source: 'insight-staleness', latestAt: '2026-06-09T01:00:00.000Z' });
    const out = partitionSignalsByKnownKeys([s], [dup('insight-staleness:dbos', 'resolved', '2026-06-09T00:00:00.000Z')]);
    expect(out.fresh).toEqual([s]);
  });
});

describe('runWatchdogTick — key pre-filter frees the capture budget (audit P-004)', () => {
  function captureRec() {
    const calls: Array<Record<string, unknown>> = [];
    let i = 0;
    const capture = (async (input: Record<string, unknown>) => {
      calls.push(input);
      return { ok: true, created: true, issue: { id: `EI-${++i}` } as never, possibleDuplicates: [] };
    }) as unknown as typeof import('./capture-core').captureImprovement;
    return { calls, capture };
  }

  it('known-open signals never consume capture slots; the fresh one lands; the record carries the keys', async () => {
    const { calls, capture } = captureRec();
    const records: WatchdogTickRecord[] = [];
    const known = [sig({ key: 'a' }), sig({ key: 'b' }), sig({ key: 'c' })];
    const fresh = sig({ key: 'new-one', source: 'repeated-tool-error', title: 'Tool new-one returns a structural error' });
    const res = await runWatchdogTick('ws', {}, {
      collect: async () => [...known, fresh],
      capture,
      recordTick: async (r) => { records.push(r); },
      readRecentTicks: async () => [],
      readKeyDups: async () => known.map((s) => ({ watchdogKey: watchdogKeyOf(s), state: 'open', updatedAt: '2026-06-09T00:00:00.000Z' })),
      pruneTicks: noPrune,
      processAging: async () => [],
    });
    // OLD behavior: 3 known-open red-tests fill the cap and the fresh signal defers.
    // NEW: they are pre-filtered, the fresh signal captures, nothing is declined.
    expect(res.knownOpen).toBe(3);
    expect(res.declinedDuplicates).toBe(0);
    expect(res.captured).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(records[0].knownOpenKeys).toEqual(['red-test:a', 'red-test:b', 'red-test:c']);
  });

  it('captures carry watchdogKey + evidenceAt (the next tick pre-filters on them)', async () => {
    const { calls, capture } = captureRec();
    const s = sig({ key: 'lib/x.test.ts', latestAt: '2026-06-09T10:00:00.000Z' });
    await runWatchdogTick('ws', {}, {
      collect: async () => [s],
      capture,
      recordTick: async () => {},
      readRecentTicks: async () => [],
      readKeyDups: noKeyDups,
      pruneTicks: noPrune,
    });
    expect(calls[0]).toMatchObject({ watchdogKey: 'red-test:lib/x.test.ts', evidenceAt: '2026-06-09T10:00:00.000Z' });
  });

  it('stale-resolved signals are dropped pre-plan and recorded (audit P-005)', async () => {
    const { calls, capture } = captureRec();
    const records: WatchdogTickRecord[] = [];
    const s = sig({ key: 'lib/x.test.ts', latestAt: '2026-06-08T00:00:00.000Z' });
    const res = await runWatchdogTick('ws', {}, {
      collect: async () => [s],
      capture,
      recordTick: async (r) => { records.push(r); },
      readRecentTicks: async () => [],
      readKeyDups: async () => [{ watchdogKey: 'red-test:lib/x.test.ts', state: 'resolved', updatedAt: '2026-06-09T00:00:00.000Z' }],
      pruneTicks: noPrune,
    });
    expect(res.staleResolved).toBe(1);
    expect(calls).toHaveLength(0); // never even attempted — no wasted capture slot
    expect(records[0].staleResolvedKeys).toEqual(['red-test:lib/x.test.ts']);
  });

  it('a key-dup read failure degrades to the old behavior (everything planned, title net catches dups)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { calls, capture } = captureRec();
      const res = await runWatchdogTick('ws', {}, {
        collect: async () => [sig({ key: 'a' })],
        capture,
        recordTick: async () => {},
        readRecentTicks: async () => [],
        readKeyDups: async () => { throw new Error('pg down'); },
        pruneTicks: noPrune,
      });
      expect(res.captured).toHaveLength(1);
      expect(calls).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/key-dup pre-filter failed/));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('runWatchdogTick — known-open aging wiring (consume-edges P-020 / EI-363)', () => {
  function knownOpenTick(processAging: (ws: string, keys: string[], o: unknown) => Promise<{ issueId: string; watchdogKey: string; reescalation: boolean }[]>) {
    const known = [sig({ key: 'shop', source: 'service-down', title: 'Service shop is down' })];
    return runWatchdogTick('ws', {}, {
      collect: async () => known,
      capture: (async () => ({ ok: true, created: true, issue: { id: 'EI-X' }, possibleDuplicates: [] })) as never,
      recordTick: async () => {},
      readRecentTicks: async () => [],
      readKeyDups: async () => [{ watchdogKey: 'service-down:shop', state: 'open', updatedAt: '2026-06-09T00:00:00.000Z' }],
      pruneTicks: noPrune,
      processAging: processAging as never,
    });
  }

  it('passes the known-open keys to the aging seam and surfaces escalated ids in the result', async () => {
    const seen: string[][] = [];
    const res = await knownOpenTick(async (_ws, keys) => {
      seen.push(keys);
      return [{ issueId: 'EI-42', watchdogKey: keys[0], reescalation: false }];
    });
    expect(seen).toEqual([['service-down:shop']]);
    expect(res.agingEscalations).toEqual(['EI-42']);
  });

  it('an aging failure is logged but never aborts the tick', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await knownOpenTick(async () => { throw new Error('pg hiccup'); });
      expect(res.status).toBe('ran');
      expect(res.agingEscalations).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/known-open aging failed/));
    } finally {
      warn.mockRestore();
    }
  });

  it('a tick with NO known-open signals never invokes aging (zero extra reads when quiet)', async () => {
    const processAging = vi.fn(async () => []);
    const res = await runWatchdogTick('ws', {}, {
      collect: async () => [sig({ key: 'fresh-one' })],
      capture: (async () => ({ ok: true, created: true, issue: { id: 'EI-1' }, possibleDuplicates: [] })) as never,
      recordTick: async () => {},
      readRecentTicks: async () => [],
      readKeyDups: noKeyDups,
      pruneTicks: noPrune,
      processAging,
    });
    expect(processAging).not.toHaveBeenCalled();
    expect(res.agingEscalations).toEqual([]);
  });
});

describe('expiredLeaseSignalsFromRows — recency window (audit P-006)', () => {
  const now = Date.parse('2026-06-09T12:00:00.000Z');
  const daysAgo = (d: number): string => new Date(now - d * 86_400_000).toISOString();

  it('counts only leases expired within the window; ancient ones no longer fire forever', () => {
    const ancient = Array.from({ length: 42 }, () => ({ expires_ts: daysAgo(30) }));
    expect(expiredLeaseSignalsFromRows(ancient, { windowDays: 7, minCount: 15, nowMs: now })).toEqual([]);
  });

  it('fires at the threshold within the window, with latestAt = the newest expiry', () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ expires_ts: daysAgo(i % 6) }));
    const out = expiredLeaseSignalsFromRows(rows, { windowDays: 7, minCount: 15, nowMs: now });
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('expired-leases');
    expect(out[0].latestAt).toBe(daysAgo(0));
    expect(out[0].body).toContain('within the last 7d');
  });

  it('boundary: a lease expired exactly at the window edge counts; one just past it does not', () => {
    const edge = Array.from({ length: 15 }, () => ({ expires_ts: daysAgo(7) }));
    expect(expiredLeaseSignalsFromRows(edge, { windowDays: 7, minCount: 15, nowMs: now })).toHaveLength(1);
    const past = Array.from({ length: 15 }, () => ({ expires_ts: new Date(now - 7 * 86_400_000 - 1).toISOString() }));
    expect(expiredLeaseSignalsFromRows(past, { windowDays: 7, minCount: 15, nowMs: now })).toEqual([]);
  });
});

describe('smokeFailSignalsFromRows — recency gate via mtime_ms (audit P-007)', () => {
  const now = Date.parse('2026-06-09T12:00:00.000Z');
  const hoursAgoMs = (h: number): number => now - h * 3_600_000;

  it('a failure recorded within the gate fires, with latestAt from mtime_ms', () => {
    const out = smokeFailSignalsFromRows(
      [{ harness_slug: 'papercup', failure_content: 'boom', mtime_ms: hoursAgoMs(2) }],
      { recentHours: 48, nowMs: now },
    );
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('papercup');
    expect(out[0].latestAt).toBe(new Date(hoursAgoMs(2)).toISOString());
    // P-032: a smoke fail is attributable to ONE harness → harness-scoped origin.
    expect(out[0].scope).toBe('harness:papercup');
  });

  it('a weeks-old failing smoke does NOT fire (no more monthly re-files forever)', () => {
    expect(smokeFailSignalsFromRows(
      [{ harness_slug: 'papercup', failure_content: 'boom', mtime_ms: hoursAgoMs(24 * 21) }],
      { recentHours: 48, nowMs: now },
    )).toEqual([]);
  });

  it('a row with NO mtime is treated as stale (cannot show the failure is current)', () => {
    expect(smokeFailSignalsFromRows(
      [{ harness_slug: 'papercup', failure_content: 'boom', mtime_ms: null }],
      { recentHours: 48, nowMs: now },
    )).toEqual([]);
  });

  it('boundary: exactly at the gate fires; one ms past it does not', () => {
    expect(smokeFailSignalsFromRows([{ harness_slug: 'p', failure_content: null, mtime_ms: hoursAgoMs(48) }], { recentHours: 48, nowMs: now })).toHaveLength(1);
    expect(smokeFailSignalsFromRows([{ harness_slug: 'p', failure_content: null, mtime_ms: hoursAgoMs(48) - 1 }], { recentHours: 48, nowMs: now })).toEqual([]);
  });
});

describe('per-signal ORIGIN scope tagging (per-hive-learning-loops P-032)', () => {
  // The per-hive improvement LENS (P-040) keys off each captured improvement's
  // origin scope, read back through readImprovementItems({ harnessSlug }) which
  // matches scope === `harness:<slug>`. So a harness-attributable signal MUST
  // carry its harness scope, and a genuinely workspace-global signal MUST stay
  // unscoped (→ 'operator' at the capture site) — NOT blanket-tagged.

  it('harness-attributable signals carry scope=harness:<slug>', () => {
    expect(
      smokeFailSignalsFromRows([{ harness_slug: 'sheets', failure_content: 'x', mtime_ms: Date.now() }])[0].scope,
    ).toBe('harness:sheets');
    expect(
      stuckPlanSignalsFromRows([{ harness_slug: 'docs', plan_slug: 'p', status: 'started', stale_hours: 30 }])[0].scope,
    ).toBe('harness:docs');
    expect(
      escalationSignalsFromRows([{ harness_slug: 'mail', phase: null }])[0].scope,
    ).toBe('harness:mail');
    expect(
      circuitOpenSignalsFromRows([{ harness_slug: 'calendar', role: 'director', consecutive_errors: 6, last_status: null }])[0].scope,
    ).toBe('harness:calendar');
    expect(
      stalledFeatureSignalsFromRows([{ harness_slug: 'forms', feature_id: 'F-1', updated_ts: Date.now() - 30 * 3_600_000 }])[0].scope,
    ).toBe('harness:forms');
  });

  it('genuinely workspace-global signals stay UNSCOPED (→ operator at capture), not blanket-tagged', () => {
    // service-down: a workspace-wide dev endpoint.
    expect(
      collectServiceDownSignals([{ name: 'sidecar', up: false } as ProbeResult])[0].scope,
    ).toBeUndefined();
    // routine-failure: a system background routine, not one harness.
    expect(
      routineFailureSignalsFromRows([{ name: 'git-sync', last_error: 'push rejected' }])[0].scope,
    ).toBeUndefined();
    // failed-spawn: a workspace aggregate keyed by dominant cause class.
    const spawnRows = Array.from({ length: 6 }, () => ({ error_message: 'timed out', started_at: new Date() }));
    expect(failedSpawnSignalsFromRows(spawnRows, { minCount: 5 })[0].scope).toBeUndefined();
    // red-test: box-global (test_runs has no workspace/harness column).
    expect(
      redTestSignalsFromRows([{ file_path: 'packages/x/a.test.ts', framework: 'vitest', fails: 5, sample: null }], 6)[0].scope,
    ).toBeUndefined();
  });

  it('the capture site resolves a harness signal to its scope and an unscoped one to operator', async () => {
    const calls: unknown[] = [];
    const capture = (async (input: unknown): Promise<CaptureImprovementResult> => {
      calls.push(input);
      return { ok: true, created: true, issue: { id: `EI-${calls.length}` }, possibleDuplicates: [] } as unknown as CaptureImprovementResult;
    }) as typeof import('./capture-core').captureImprovement;
    const harnessSig = smokeFailSignalsFromRows([{ harness_slug: 'sheets', failure_content: 'x', mtime_ms: Date.now() }]);
    const globalSig = collectServiceDownSignals([{ name: 'sidecar', up: false } as ProbeResult]);
    await runWatchdogTick('ws', { maxPerTick: 5 }, {
      readKeyDups: noKeyDups, pruneTicks: noPrune,
      collect: async () => [...harnessSig, ...globalSig],
      capture, recordTick: async () => {},
    });
    const scopes = calls.map((c) => (c as { scope?: string }).scope).sort();
    expect(scopes).toEqual(['harness:sheets', 'operator']);
  });
});

describe('failed-spawn dominant-class identity (audit P-008)', () => {
  it('classifySpawnError buckets the common failure shapes', () => {
    expect(classifySpawnError('spawn timed out after 280s')).toBe('timeout');
    expect(classifySpawnError('connect ECONNREFUSED 127.0.0.1:3070')).toBe('network');
    expect(classifySpawnError('401 unauthorized: bad api key')).toBe('auth');
    expect(classifySpawnError('ENOENT: no such file or directory')).toBe('missing-file');
    expect(classifySpawnError('invalid spawn config: missing role')).toBe('config');
    expect(classifySpawnError('something else entirely')).toBe('other');
    expect(classifySpawnError(null)).toBe('other');
  });

  // EI-5485: an admission-ceiling rejection is expected D-004 backpressure (await spawn-slot:freed +
  // retry), recorded as a `failed` row for durability — NOT a spawn failure. It must classify as
  // 'backpressure', not 'other', so it can be excluded from the failed-spawn signal.
  it('classifies the admission-ceiling rejection as backpressure, not a failure', () => {
    const ceilingMsg =
      'spawn rejected: 3 bee spawns already running (fleet ceiling 3 — owner maxBees). ' +
      'Do not drop or busy-wait: events:await { event: "spawn-slot:freed:papercusp-workspace" }, ' +
      'end your turn, and retry this spawn on wake (a slot-free wakes you) — or fleet:cancel one.';
    expect(classifySpawnError(ceilingMsg)).toBe('backpressure');
    expect(classifySpawnError('spawn rejected: 16 spawns already running (fleet ceiling 16 — maxSimultaneousAgents).')).toBe('backpressure');
  });

  it('EXCLUDES admission-ceiling backpressure rows from the failed-spawn signal (EI-5485)', () => {
    const ceiling = (slot: number) => ({
      error_message:
        `spawn rejected: 3 bee spawns already running (fleet ceiling 3 — owner maxBees). ` +
        `events:await { event: "spawn-slot:freed:papercusp-workspace" } — slot ${slot}`,
      started_at: '2026-06-30T16:00:00.000Z',
    });
    // 57 ceiling rejections + 4 timeouts + 4 config: only the 8 genuine failures should count.
    const rows = [
      ...Array.from({ length: 57 }, (_, i) => ceiling(i)),
      ...Array.from({ length: 4 }, () => ({ error_message: 'spawn timed out after 280s', started_at: '2026-06-30T15:00:00.000Z' })),
      ...Array.from({ length: 4 }, () => ({ error_message: 'invalid spawn config', started_at: '2026-06-30T14:00:00.000Z' })),
    ];
    const out = failedSpawnSignalsFromRows(rows, { windowHours: 6, minCount: 5 });
    expect(out).toHaveLength(1);
    // Dominant of the GENUINE failures is timeout (4), not the ceiling backpressure (57).
    expect(out[0].key).toBe('failed-spawns:timeout');
    expect(out[0].title).toContain('(timeout)');
    expect(out[0].body).not.toContain('backpressure');
    // Count reflects only the 8 real failures, not the 65 total rows.
    expect(out[0].body).toContain('8 agent spawn(s) failed');
    expect(out[0].body).toContain('timeout: 4');
    expect(out[0].body).toContain('config: 4');
  });

  // EI-6018: a fleet infra-reclaim (boot reconcile EI-2186 / orphan sweep EI-85 / wedge reaper
  // WI-233) settles a `running` row `failed` to FREE the concurrency ceiling — expected
  // housekeeping, NOT a spawn failure. All such messages are `reclaimed`-prefixed and must
  // classify as 'reclaimed', not 'other'.
  it('classifies fleet infra-reclaim rows as reclaimed, not a failure (EI-6018)', () => {
    expect(classifySpawnError(
      'reclaimed at operator boot: launched by a prior incarnation on host-A ' +
      '(host/process restarted before its admission-release ran) — stale spawn-ceiling debit ' +
      'freed by the boot reconcile (EI-2186)',
    )).toBe('reclaimed');
    expect(classifySpawnError(
      'reclaimed: launched by a prior operator incarnation (boot-id mismatch on host-A) — ' +
      'host restarted, concurrency ceiling freed by the reclaim sweep (EI-2186)',
    )).toBe('reclaimed');
    expect(classifySpawnError(
      'reclaimed: child process (pid 4242) confirmed dead on host-A — concurrency ceiling freed ' +
      'by the P-011 reclaim sweep (EI-85)',
    )).toBe('reclaimed');
    expect(classifySpawnError(
      "reclaimed: spawn heartbeat stale > 300s (launching operator host presumed dead) — " +
      'concurrency ceiling freed by the P-011 reclaim sweep',
    )).toBe('reclaimed');
  });

  // EI-7520: EVERY no-turn diagnostic (invoke-outcome.ts `agentProducedTurn`) embeds a
  // literal `timedOut=<bool>` token. The generic `timed?\s*out` alternative matched the
  // camelCase substring `timedOut`, so a `timedOut=false` gateway-stall / infra_loss death
  // (NOT a timeout) was mis-bucketed as 'timeout' — inflating the class and conflating it
  // with real wall-clock timeouts. `=true` is a genuine kill → timeout; `=false` is not.
  it('does NOT bucket a `timedOut=false` infra_loss as timeout (EI-7520 false-positive)', () => {
    // The real shape recorded by agentProducedTurn for a mid-turn gateway stall: the
    // detail carries `timedOut=false` but the death is not a timeout at all.
    const infraLossFalse =
      'infra_loss: papercusp/doc-steward returned HTTP 200 but the agent produced no turn ' +
      '(ok=false, exitCode=1, timedOut=false, outLen=257; rawStdoutTail="PG bootstrap: connected; ' +
      'orchestrator running with ctx.pg active; prompt-budget role=doc-steward feature=- total=52758")';
    expect(classifySpawnError(infraLossFalse)).not.toBe('timeout');
    expect(classifySpawnError(infraLossFalse)).toBe('other');
    // A `timedOut=true` IS a genuine wall-clock kill → timeout (the diagnostic token is a
    // positive signal here, so the fix must keep classifying it).
    const infraLossTrue =
      'infra_loss: quartermaster-hive/release-fixer returned HTTP 200 but the agent produced no turn ' +
      '(ok=false, exitCode=143, timedOut=true, outLen=0; rawStdoutTail="invoke-once: received termination signal")';
    expect(classifySpawnError(infraLossTrue)).toBe('timeout');
    // Genuine timeout PHRASES still classify as timeout (the fix must not regress them).
    expect(classifySpawnError('spawn timed out after 280s')).toBe('timeout');
    expect(classifySpawnError('agent invoke timeout exceeded (900s)')).toBe('timeout');
  });

  // EI-7520: a storm of `timedOut=false` infra_loss deaths must NOT masquerade as a
  // 'timeout' dominant class — the whole point of keying by cause is to keep a
  // gateway-stall storm distinguishable from a real wall-clock-timeout storm.
  it('does not let `timedOut=false` infra_loss inflate the timeout class (EI-7520)', () => {
    const infraLoss = (i: number) => ({
      error_message:
        'infra_loss: papercusp/doc-steward returned HTTP 200 but the agent produced no turn ' +
        `(ok=false, exitCode=1, timedOut=false, outLen=257; rawStdoutTail="run ${i}")`,
      started_at: '2026-07-05T08:00:00.000Z',
    });
    const realTimeout = (i: number) => ({
      error_message:
        'infra_loss: quartermaster-hive/release-fixer returned HTTP 200 but the agent produced no turn ' +
        `(ok=false, exitCode=143, timedOut=true, outLen=0; rawStdoutTail="termination signal ${i}")`,
      started_at: '2026-07-05T07:00:00.000Z',
    });
    // 8 gateway-stall (timedOut=false) + 5 genuine timeouts (timedOut=true).
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => infraLoss(i)),
      ...Array.from({ length: 5 }, (_, i) => realTimeout(i)),
    ];
    const out = failedSpawnSignalsFromRows(rows, { windowHours: 6, minCount: 5 });
    expect(out).toHaveLength(1);
    // Only the 5 genuine `timedOut=true` deaths are 'timeout'; the 8 `=false` ones are 'other'.
    expect(out[0].body).toContain('timeout: 5');
    expect(out[0].body).toContain('other: 8');
    // Dominant is 'other' (the gateway-stall storm), NOT a phantom 'timeout: 13'.
    expect(out[0].key).toBe('failed-spawns:other');
  });

  it('EXCLUDES fleet infra-reclaim rows from the failed-spawn signal (EI-6018)', () => {
    const reclaim = (i: number) => ({
      error_message:
        'reclaimed at operator boot: launched by a prior incarnation on host-A ' +
        `(host/process restarted before its admission-release ran) — freed by the boot reconcile (EI-2186) slot ${i}`,
      started_at: '2026-07-01T10:00:00.000Z',
    });
    // 15 boot-reclaim rows (the EI-6018 "other" phantom) + 4 timeouts + 4 network:
    // only the 8 genuine failures should count, and the reclaim rows must not be the dominant class.
    const rows = [
      ...Array.from({ length: 15 }, (_, i) => reclaim(i)),
      ...Array.from({ length: 4 }, () => ({ error_message: 'spawn timed out after 280s', started_at: '2026-07-01T09:00:00.000Z' })),
      ...Array.from({ length: 4 }, () => ({ error_message: 'connect ECONNREFUSED 127.0.0.1:3070', started_at: '2026-07-01T08:00:00.000Z' })),
    ];
    const out = failedSpawnSignalsFromRows(rows, { windowHours: 6, minCount: 5 });
    expect(out).toHaveLength(1);
    // Dominant of the GENUINE failures is timeout (4), not the reclaim housekeeping (15).
    expect(out[0].key).toBe('failed-spawns:timeout');
    expect(out[0].body).not.toContain('reclaimed');
    // Count reflects only the 8 real failures, not the 23 total rows.
    expect(out[0].body).toContain('8 agent spawn(s) failed');
    expect(out[0].body).toContain('timeout: 4');
    expect(out[0].body).toContain('network: 4');
  });

  it('reclaim-only rows never fire (all reclaimed housekeeping, no genuine failures) (EI-6018)', () => {
    const rows = Array.from({ length: 30 }, () => ({
      error_message: 'reclaimed at operator boot: freed by the boot reconcile (EI-2186)',
      started_at: '2026-07-01T10:00:00.000Z',
    }));
    expect(failedSpawnSignalsFromRows(rows, { minCount: 5 })).toEqual([]);
  });

  it('ceiling-only rejections never fire (all backpressure, below the genuine-failure threshold)', () => {
    const rows = Array.from({ length: 30 }, () => ({
      error_message: 'spawn rejected: 3 bee spawns already running (fleet ceiling 3 — owner maxBees).',
      started_at: '2026-06-30T16:00:00.000Z',
    }));
    expect(failedSpawnSignalsFromRows(rows, { minCount: 5 })).toEqual([]);
  });

  it('keys by the DOMINANT class with the full breakdown in the body + latestAt', () => {
    const rows = [
      { error_message: 'timed out', started_at: '2026-06-09T10:00:00.000Z' },
      { error_message: 'timed out again', started_at: '2026-06-09T11:00:00.000Z' },
      { error_message: 'timeout', started_at: '2026-06-09T09:00:00.000Z' },
      { error_message: '401 unauthorized', started_at: '2026-06-09T08:00:00.000Z' },
      { error_message: 'ECONNREFUSED', started_at: '2026-06-09T07:00:00.000Z' },
    ];
    const out = failedSpawnSignalsFromRows(rows, { windowHours: 6, minCount: 5 });
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('failed-spawns:timeout');
    expect(out[0].title).toContain('(timeout)');
    expect(out[0].body).toContain('timeout: 3');
    expect(out[0].body).toContain('auth: 1');
    expect(out[0].latestAt).toBe('2026-06-09T11:00:00.000Z');
  });

  it('below the threshold → no signal', () => {
    expect(failedSpawnSignalsFromRows(
      [{ error_message: 'x', started_at: null }],
      { minCount: 5 },
    )).toEqual([]);
  });
});

describe('tick prune — retention is best-effort (audit P-009)', () => {
  it('prune runs after the tick with the retention default and an error never aborts the tick', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pruned: Array<[string, number]> = [];
      const okCapture = (async () => ({ ok: true, created: true, issue: { id: 'EI-1' } as never, possibleDuplicates: [] })) as unknown as typeof import('./capture-core').captureImprovement;
      const res = await runWatchdogTick('ws', {}, {
        collect: async () => [sig({ key: 'a' })],
        capture: okCapture,
        recordTick: async () => {},
        readRecentTicks: async () => [],
        readKeyDups: noKeyDups,
        pruneTicks: async (ws, days) => { pruned.push([ws, days]); },
      });
      expect(res.captured).toHaveLength(1);
      expect(pruned).toEqual([['ws', 14]]);

      const res2 = await runWatchdogTick('ws', { tickRetentionDays: 7 }, {
        collect: async () => [],
        capture: okCapture,
        recordTick: async () => {},
        readRecentTicks: async () => [],
        readKeyDups: noKeyDups,
        pruneTicks: async () => { throw new Error('gc hiccup'); },
      });
      expect(res2.status).toBe('ran'); // prune failure swallowed
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/tick prune failed: gc hiccup/));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('deferred boost survives a skipped tick (audit P-011)', () => {
  it('the contended deferred-keys read asks for the last RAN tick, not the last tick', async () => {
    let filterSeen: { status?: 'ran' | 'skipped' } | undefined;
    const okCapture = (async () => ({ ok: true, created: true, issue: { id: 'EI-1' } as never, possibleDuplicates: [] })) as unknown as typeof import('./capture-core').captureImprovement;
    await runWatchdogTick('ws', { maxPerTick: 1 }, {
      collect: async () => [sig({ key: 'a' }), sig({ key: 'b' })], // contention → the read happens
      capture: okCapture,
      recordTick: async () => {},
      readRecentTicks: async (_ws, _n, filter) => {
        filterSeen = filter;
        return [{ status: 'ran', collectors: [], deferredKeys: [] }];
      },
      readKeyDups: noKeyDups,
      pruneTicks: noPrune,
    });
    expect(filterSeen).toEqual({ status: 'ran' });
  });
});

describe('watchdogOptionsFromPayload — routine-tunable bars (audit P-012)', () => {
  it('extracts whitelisted numeric keys, coercing numeric strings', () => {
    expect(watchdogOptionsFromPayload({
      maxPerTick: 5,
      transientMinCount: '20',
      smokeFailRecentHours: 24,
      notATunable: 99,
      structuralMinCount: 'not-a-number',
    })).toEqual({ maxPerTick: 5, transientMinCount: 20, smokeFailRecentHours: 24 });
  });

  it('null/undefined payload → empty options', () => {
    expect(watchdogOptionsFromPayload(null)).toEqual({});
    expect(watchdogOptionsFromPayload(undefined)).toEqual({});
  });
});

describe('latestAt plumbing (audit P-005)', () => {
  it('red-test merge keeps the NEWEST failure timestamp across trees', () => {
    const signals = redTestSignalsFromRows(
      [
        { file_path: 'apps/x.test.ts', framework: 'vitest', fails: 3, sample: 'boom', latest_fail_at: '2026-06-09T08:00:00.000Z' },
        { file_path: 'papercupai-workspace/papercup-checkpoint/apps/x.test.ts', framework: 'vitest', fails: 4, sample: null, latest_fail_at: '2026-06-09T11:00:00.000Z' },
      ],
      6,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].latestAt).toBe('2026-06-09T11:00:00.000Z');
  });

  it('tool-error signals carry latestAt from the newest failure row', () => {
    const signals = toolErrorSignalsFromRows([
      { tool_name: 'docs:get', class: 'structural' as const, n: 7, total: 7, sample: 'boom', latest_at: '2026-06-09T10:30:00.000Z' },
    ]);
    expect(signals[0].latestAt).toBe('2026-06-09T10:30:00.000Z');
  });
});
