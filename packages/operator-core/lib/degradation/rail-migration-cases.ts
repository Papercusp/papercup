/**
 * P-017's manifest-to-test binding. Cases execute the migrated caller at its real dependency
 * seams; static assertions about source text do not count as a passing migration case.
 * An item enters COMPLETE_ITEMS only after every original row is covered and on the rail.
 */
export type RailMigrationOutcome =
  | { route: 'condition'; openedKeys: string[]; resolvedKeys: string[] }
  | { route: 'observation'; mechanism: string; observations: Array<{ eligible: number; applied: number; reason: string }> };

export interface RailMigrationCase {
  id: string;
  item: string;
  rowIds: string[];
  route: 'condition' | 'observation';
  mechanism?: string;
  run: () => RailMigrationOutcome | Promise<RailMigrationOutcome>;
}

export const RAIL_MIGRATION_COMPLETE_ITEMS: string[] = ['P-005', 'P-007', 'P-010'];
export const RAIL_MIGRATION_CASES: RailMigrationCase[] = [{
  id: 'retrieval-authoritative-samples-and-one-shot-sweep',
  item: 'P-005',
  route: 'condition',
  rowIds: [
    'bespoke-watchdog|packages/operator-core/lib/system-health/retrieval-degradation-watchdog.ts|<module>|1',
    'health-flag-no-condition|packages/operator-core/lib/system-health/retrieval-degradation-watchdog.ts|defaultEscalate|1',
  ],
  run: async () => {
    const search = await import('@papercusp/search');
    const producer = await import('../system-health/retrieval-degradation-watchdog');
    const watchdog = await import('../system-health/degradation-watchdog');
    const { summarizeFallbackWindow } = await import('./fallback-observations');
    const observations: Array<{ reason: string; samples: number; eligible: number; applied: number }> = [];
    const open = new Set<string>();
    const openedKeys: string[] = [];
    const resolvedKeys: string[] = [];
    const observe = (_mechanism: string, row: { reason: string; eligible: number; applied: number }) => {
      observations.push({ ...row, samples: 1 });
      return true;
    };
    const sweep = () => watchdog.runDegradationSweepOnce({
      mechanisms: () => [watchdog.getDegradationMechanism('retrieval')!],
      readWindows: async () => [{ scope: null, window: summarizeFallbackWindow('retrieval', 60_000, observations) }],
      readOpenConditionKeys: async () => [...open],
      broadcast: async ({ conditionKey }) => { open.add(conditionKey!); openedKeys.push(conditionKey!); return true; },
      resolve: async ({ conditionKey }) => { open.delete(conditionKey); resolvedKeys.push(conditionKey); return true; },
      prune: async () => 0,
    });
    const leg = { status: 'ran', candidates: 5, blocked: null };
    const legs = { lexical: leg, semantic: { ...leg, status: 'errored', candidates: 0, blocked: 'timeout' }, degraded: true } as import('@papercusp/search').SearchLegs;
    try {
      // Executes the actual startup wiring and existing search recorder, not source assertions.
      producer.startRetrievalDegradationWatchdog({ observe });
      for (let i = 0; i < 20; i++) search.observeLegs(legs);
      await sweep();
      // Executes the seed's old owner-only escalation site through its actual sweep.
      await producer.runRetrievalDegradationSweepOnce({ flagEnabled: async () => true, observe,
        readHealth: () => ({ windowMs: 60_000, searches: 100, degraded: 90, degradedRate: 0.9,
          semanticBlocked: 90, lexicalBlocked: 0, semanticEmpty: 0, lexicalEmpty: 0,
          oldestSampleMs: 1, newestSampleMs: 2, truncatedByCapacity: false }) });
      await sweep();
      for (let i = 0; i < 400; i++) search.observeLegs({ ...legs, semantic: leg, degraded: false } as import('@papercusp/search').SearchLegs);
      await sweep();
      return { route: 'condition' as const, openedKeys, resolvedKeys };
    } finally {
      search.setLegHealthObserver(null);
    }
  },
}];

for (const updater of ['manifest', 'rollback'] as const) {
  RAIL_MIGRATION_CASES.push({
    id: `update-${updater}-metadata-failure-and-primary-read`, item: 'P-008', route: 'observation', mechanism: 'release-state-read',
    rowIds: [`log-only-fallback|packages/operator-core/lib/endpoint-route/routes/misc/updates-${updater}.ts|handler|1`],
    run: async () => {
      const { vi, expect } = await import('vitest');
      const github = await import('../endpoint-route/routes/misc/updates-github');
      const recorder = await import('./fallback-observations');
      const operatorState = await import('../operator-state-pg');
      const route = updater === 'manifest'
        ? (await import('../endpoint-route/routes/misc/updates-manifest')).default
        : (await import('../endpoint-route/routes/misc/updates-rollback')).default;
      const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
      const release = { tag_name: 'desktop-v0.0.4-alpha', prerelease: true, draft: false,
        published_at: '2026-07-09T00:00:00Z', body: '', assets: [{ id: 1,
          name: 'papercusp-latest-desktop-v0.0.4-alpha.json', browser_download_url: 'https://coverage.invalid/latest.json' }] };
      const mocks: Array<{ mockRestore: () => void }> = [
        vi.spyOn(operatorState, 'readOperatorState').mockResolvedValue({ update_channel: 'alpha' }),
        vi.spyOn(github, 'resolveGithubToken').mockResolvedValue('coverage-token'),
        vi.spyOn(github, 'releaseHostBase').mockReturnValue('https://coverage.invalid'),
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => String(input).startsWith('https://coverage.invalid')
          ? new Response(null, { status: 404 }) : Response.json([release])),
        vi.spyOn(recorder, 'observeFallback').mockImplementation((_mechanism, row) => { observations.push(row); return true; }),
        vi.spyOn(console, 'warn').mockImplementation(() => {}),
      ];
      const asset = vi.spyOn(github, 'fetchAssetText').mockResolvedValue('{');
      mocks.push(asset);
      const request = new Request(`http://coverage.invalid/api/updates/${updater}?target=linux&arch=x86_64&channel=alpha&current_version=0.0.1-alpha&tag=desktop-v0.0.4-alpha`);
      const handler = (route as unknown as { handler: (req: Request) => Promise<Response> }).handler;
      try {
        await handler(request);
        expect(observations.map(({ applied, reason }) => [applied, reason])).toEqual([[0, 'metadata-read-failed']]);
        asset.mockResolvedValue(JSON.stringify({ version: '0.0.4-alpha', platforms: {
          'linux-x86_64': { signature: 'coverage-signature', url: '__RELEASE_HOST__/Papercusp_GUI_0.0.4_amd64.AppImage' },
        } }));
        expect((await handler(request)).status).toBe(200);
        expect(observations.map(({ applied, reason }) => [applied, reason])).toEqual([
          [0, 'metadata-read-failed'], [1, 'applied']]);
        return { route: 'observation', mechanism: 'release-state-read', observations };
      } finally { for (const mock of mocks) mock.mockRestore(); }
    },
  });
}

RAIL_MIGRATION_CASES.push({
  id: 'loop-standdown-read-failure-and-complete-read', item: 'P-008', route: 'observation', mechanism: 'release-state-read',
  rowIds: ['log-only-fallback|packages/operator-core/lib/harness/routines/release-pause-ttl.ts|listLoopStanddownOwners|1'],
  run: async () => {
    const { listLoopStanddownOwners } = await import('../harness/routines/release-pause-ttl');
    const { vi, expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const observeFallback = (_mechanism: string, row: typeof observations[number]) => { observations.push(row); return true; };
    const failure = (async () => { throw new Error('scan unavailable'); }) as unknown as import('postgres').Sql;
    const success = (async () => []) as unknown as import('postgres').Sql;
    const full = (async () => [{ target_owner_id: 'held', pause: {} }]) as unknown as import('postgres').Sql;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await listLoopStanddownOwners(failure, { observeFallback })).toEqual(new Set());
      await listLoopStanddownOwners(full, { observeFallback, limit: 1 });
      await listLoopStanddownOwners(success, { observeFallback });
      expect(observations.map(({ applied, reason }) => [applied, reason])).toEqual([
        [0, 'hold-scan-failed'], [0, 'scan-truncated'], [1, 'applied']]);
      return { route: 'observation', mechanism: 'release-state-read', observations };
    } finally { warn.mockRestore(); }
  },
}, {
  id: 'checkpoint-state-routing-failure-skip-and-primary-read', item: 'P-008', route: 'observation', mechanism: 'release-state-read',
  rowIds: ['log-only-fallback|packages/operator-core/lib/release/green-stall-watchdog.ts|readCheckpointRunState|1'],
  run: async () => {
    const { readCheckpointRunState } = await import('../release/green-stall-watchdog');
    const { vi, expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const observeFallback = (_mechanism: string, row: typeof observations[number]) => { observations.push(row); return true; };
    const route: NonNullable<NonNullable<Parameters<typeof readCheckpointRunState>[2]>['route']> = async () => ({
      root: '/coverage', extraEnv: {}, clearEnv: [],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await readCheckpointRunState('coverage', 'coverage', { observeFallback,
        route: async () => { throw new Error('routing unavailable'); } })).toEqual({});
      await readCheckpointRunState('coverage', 'coverage', { observeFallback,
        route: async () => ({ ...(await route({ installSlug: 'coverage', workspaceId: 'coverage' }, '/coverage')), skip: { reason: 'coverage skip' } }) });
      const deps = { observeFallback, route, readLock: () => ({ held: true, elapsedSec: 1 }), readPhase: () => null };
      await readCheckpointRunState('coverage', 'coverage', deps);
      await readCheckpointRunState('coverage', 'coverage', { ...deps, readLock: () => ({ held: false, elapsedSec: null }) });
      expect(observations.map(({ applied, reason }) => [applied, reason])).toEqual([
        [0, 'run-state-unavailable'], [0, 'routing-skipped'], [0, 'phase-unavailable'], [1, 'applied']]);
      return { route: 'observation', mechanism: 'release-state-read', observations };
    } finally { warn.mockRestore(); }
  },
}, {
  id: 'lost-gate-run-owner-fallback-and-measured-recovery', item: 'P-008', route: 'condition',
  rowIds: ['owner-only-alarm|packages/operator-core/lib/release/lost-gate-run-alarm.ts|defaultNotifyOwner|1'],
  run: async () => {
    const { sweepLostGateRuns } = await import('../release/lost-gate-run-alarm');
    const { expect } = await import('vitest');
    const openedKeys: string[] = [], resolvedKeys: string[] = [];
    const nowMs = Date.now();
    let marker: unknown = { candidate: 'deadbeef', candidateSource: 'tip', base: 'base',
      selectedAtMs: nowMs - 60_000, quietCutApplied: false, tipAtSelection: null, refireDepth: 0,
      pid: 42, observedAtMs: nowMs - 60_000, verdictWrittenAtMs: null };
    let alarmed_key: string | null = null;
    const sql = (async (strings: TemplateStringsArray) => strings.join('').includes('SELECT')
      ? [{ install_slug: 'coverage', workspace_id: 'coverage', marker, alarmed_key }]
      : Object.assign([], { count: 1 })) as unknown as import('postgres').Sql;
    const attention = { broadcast: async (e: { conditionKey?: string }) => { openedKeys.push(e.conditionKey!); return true; },
      resolve: async (e: { conditionKey: string }) => { resolvedKeys.push(e.conditionKey); return true; }, notify: async () => {} };
    const deps = { nowMs, selfPid: 1, pidAlive: () => false, hostFleetSlug: null,
      readHolder: async () => null, claim: async (_sql: unknown, _target: unknown, key: string) => { alarmed_key = key; return true; },
      broadcast: attention.broadcast, attention };
    await sweepLostGateRuns(sql, deps);
    expect(openedKeys).toHaveLength(2); // both the existing broadcast and actual owner fallback execute
    await sweepLostGateRuns(sql, { ...deps, pidAlive: () => null });
    expect(resolvedKeys).toEqual([]);
    marker = null; await sweepLostGateRuns(sql, deps);
    return { route: 'condition', openedKeys: [...new Set(openedKeys)], resolvedKeys };
  },
}, {
  id: 'release-watchdog-failed-passes-and-measured-recovery', item: 'P-008', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/release/watchdog-health.ts|<module>|1'],
  run: async () => {
    const { recordWatchdogPassOutcome } = await import('../release/watchdog-health');
    const watchdog = await import('../system-health/degradation-watchdog');
    const { summarizeFallbackWindow } = await import('./fallback-observations');
    const observations: Array<{ eligible: number; applied: number; reason: string; samples: number }> = [];
    const openedKeys: string[] = [], resolvedKeys: string[] = [];
    const open = new Set<string>();
    const sql = (async () => Object.assign([], { count: 1 })) as unknown as import('postgres').Sql;
    const scope = { routineName: 'green-checkpoint' as const, installSlug: 'coverage' };
    const deps = { observeFallback: (_mechanism: string, row: { eligible: number; applied: number; reason: string }) => {
      if (_mechanism !== 'release-watchdog-pass') throw new Error('unexpected pass mechanism');
      observations.push({ ...row, samples: 1 }); return true;
    } };
    const sweep = () => watchdog.runDegradationSweepOnce({
      mechanisms: () => [watchdog.getDegradationMechanism('release-watchdog-pass')!],
      readWindows: async () => [{ scope: 'coverage:green-checkpoint:green-stall',
        window: summarizeFallbackWindow('release-watchdog-pass', 60_000, observations) }],
      readOpenConditionKeys: async () => [...open],
      broadcast: async ({ conditionKey }) => { open.add(conditionKey!); openedKeys.push(conditionKey!); return true; },
      resolve: async ({ conditionKey }) => { open.delete(conditionKey); resolvedKeys.push(conditionKey); return true; },
      prune: async () => 0,
    });
    const { expect } = await import('vitest');
    await recordWatchdogPassOutcome(sql, 'green-stall', scope, new Error('failed pass'), deps);
    await sweep();
    expect(openedKeys).toHaveLength(1); // the production sparse floor is actually used
    for (let i = 0; i < 3; i++) await recordWatchdogPassOutcome(sql, 'green-stall', scope, new Error('failed pass'), deps);
    await sweep();
    for (let i = 0; i < 4; i++) await recordWatchdogPassOutcome(sql, 'green-stall', scope, undefined, deps);
    await sweep();
    return { route: 'condition', openedKeys, resolvedKeys };
  },
}, {
  id: 'gate-canary-store-failure-unknown-and-healthy', item: 'P-008', route: 'condition',
  rowIds: ['owner-only-alarm|packages/operator-core/lib/gates/gate-canary-sweep-action.ts|recordCanaryVerdict|1'],
  run: async () => {
    const { recordCanaryVerdict } = await import('../gates/gate-canary-sweep-action');
    const { classifyGateCanary } = await import('../gates/canary');
    const { vi, expect } = await import('vitest');
    const openedKeys: string[] = [], resolvedKeys: string[] = [];
    let storeFails = true;
    const deps = {
      attention: { broadcast: async (e: { conditionKey?: string }) => { openedKeys.push(e.conditionKey!); return true; },
        resolve: async (e: { conditionKey: string }) => { resolvedKeys.push(e.conditionKey); return true; }, notify: async () => {} },
      assertFact: (async () => ({})) as unknown as typeof import('../agent-facts/store').assertFact,
      sql: { unsafe: async () => { if (storeFails) throw new Error('escalation store unavailable'); return []; } } as unknown as Pick<import('postgres').Sql, 'unsafe'>,
    };
    const run = (canaryOk: boolean | null, systemGreen: boolean | null) => recordCanaryVerdict({
      ctx: { installSlug: 'coverage', workspaceId: 'coverage', triggerConfig: {}, payloadTemplate: null },
      report: { id: 'coverage', describe: 'known-good sample', ranAtMs: 0, canaryOk, canaryDetail: 'fixture', systemGreen,
        classification: classifyGateCanary({ canaryOk, systemGreen }) },
      factKey: 'coverage', escalationPhase: 'coverage', title: 'Canary apparatus failed',
    }, deps);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run(false, false);
      expect(openedKeys).toHaveLength(1); // independent of failed legacy store
      storeFails = false;
      await run(null, null);
      expect(resolvedKeys).toEqual([]);
      await run(true, null); // a successful known-good sample proves apparatus recovery
      return { route: 'condition', openedKeys: [...new Set(openedKeys)], resolvedKeys };
    } finally { warn.mockRestore(); log.mockRestore(); }
  },
}, {
  id: 'worktree-coverage-partial-scans-never-recover', item: 'P-008', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/release/worktree-coverage-watchdog.ts|<module>|1'],
  run: async () => {
    const { checkWorktreeCoverage, checkGitSyncCoverage } = await import('../release/worktree-coverage-watchdog');
    const { expect } = await import('vitest');
    const openedKeys: string[] = [], resolvedKeys: string[] = [];
    const attention = { broadcast: async (e: { conditionKey?: string }) => { openedKeys.push(e.conditionKey!); return true; },
      resolve: async (e: { conditionKey: string }) => { resolvedKeys.push(e.conditionKey); return true; } };
    let state: 'dirty' | 'unreadable' | 'clean' = 'dirty';
    const canonical = '/rail/canonical', stray = '/rail/work-in-flight';
    const runGit = async (args: string[], cwd: string) => {
      if (args[0] === 'worktree') return `worktree ${canonical}\n\nworktree ${stray}\n\n`;
      if (args[0] === 'rev-parse') return cwd;
      if (args[0] === 'log') return '1';
      if (cwd === stray && state === 'unreadable') throw new Error('status unavailable');
      return cwd === stray && state === 'dirty' ? ' M work.ts\n' : '';
    };
    const deps = { runGit, attention, log: () => {} };
    await checkWorktreeCoverage(canonical, deps);
    state = 'unreadable'; await checkWorktreeCoverage(canonical, deps);
    expect(resolvedKeys).toEqual([]);
    state = 'clean'; await checkWorktreeCoverage(canonical, deps);
    state = 'dirty';
    // The sibling pass has no linked stray; it must independently find clones.
    const siblingDeps = { ...deps,
      runGit: async (args: string[], cwd: string) => args[0] === 'worktree' ? `worktree ${canonical}\n` : runGit(args, cwd),
      listChildDirs: async () => [stray], realpath: async (p: string) => p, pathExists: async () => true,
      loadActiveGitSyncSlugs: async () => [], loadRegistryProjects: async () => [],
    };
    await checkGitSyncCoverage(canonical, siblingDeps);
    state = 'unreadable'; await checkGitSyncCoverage(canonical, siblingDeps);
    expect(resolvedKeys).toHaveLength(1);
    state = 'clean'; await checkGitSyncCoverage(canonical, siblingDeps);
    return { route: 'condition', openedKeys, resolvedKeys };
  },
});

// Each entry executes a real producer twice: a breached sample with the owner cooldown
// active, then a healthy sample. No source-text assertion stands in for caller behavior.
type AlarmCapture = import('../alarm-attention').AlarmAttentionDeps;
const alarmCases: Array<{ id: string; rowId: string; run: (deps: AlarmCapture) => Promise<void> }> = [
  { id: 'shared-attention', rowId: 'owner-only-alarm|packages/operator-core/lib/alarm-attention.ts|defaultNotify|1',
    run: async (deps) => {
      const { escalateAlarm, resolveAlarm } = await import('../alarm-attention');
      await escalateAlarm({ title: 'Condition coverage', body: 'Measured breach', cooldownMs: 1,
        source: 'coverage', conditionKey: 'alarm:coverage' }, deps);
      await resolveAlarm('alarm:coverage', 'coverage', deps);
    } },
  { id: 'rate-governor', rowId: 'owner-only-alarm|packages/operator-core/lib/agent-governor-observer.ts|surfacePause|1',
    run: async (attention) => {
      const { initAgentGovernorObserver, _resetAgentGovernorObserver, flushAgentGovernorAlarms } = await import('../agent-governor-observer');
      const { getGovernor, resetGovernorRegistry } = await import('@papercusp/papercusp-shared/agent');
      _resetAgentGovernorObserver(); resetGovernorRegistry();
      let clock = Date.now();
      try {
        initAgentGovernorObserver({ ...attention, status: async () => {}, recentlyEscalated: async () => true });
        const governor = getGovernor('anthropic', 'condition-rail', { now: () => clock });
        governor.penalize({ retryAfterMs: 100_000 });
        await flushAgentGovernorAlarms();
        clock = governor.snapshot().pausedUntil;
        (await governor.acquire())?.();
        await flushAgentGovernorAlarms();
      } finally { _resetAgentGovernorObserver(); resetGovernorRegistry(); }
    } },
  { id: 'replication-slot', rowId: 'owner-only-alarm|packages/operator-core/lib/storage/replication-slot-alarm.ts|runReplicationSlotAlarmOnce|1',
    run: async (attention) => {
      const { runReplicationSlotAlarmOnce } = await import('../storage/replication-slot-alarm');
      const deps = { ...attention, emitToast: async () => {}, recentlyEscalated: async () => true };
      await runReplicationSlotAlarmOnce({ ...deps, fetchSlots: async () => [{ slotName: 'stuck',
        slotType: 'logical', active: false, retainedWalBytes: 1024 ** 4, walStatus: 'reserved' }] });
      await runReplicationSlotAlarmOnce({ ...deps, fetchSlots: async () => [] });
    } },
  { id: 'disk-space', rowId: 'owner-only-alarm|packages/operator-core/lib/storage/disk-space-alarm.ts|runDiskSpaceAlarmOnce|1',
    run: async (attention) => {
      const { runDiskSpaceAlarmOnce, DEFAULT_DISK_POLICY } = await import('../storage/disk-space-alarm');
      const deps = { ...attention, emitToast: async () => {}, recentlyEscalated: async () => true,
        attributeUsage: async () => ({ entries: [], truncated: false }) };
      const snapshot = { path: '/coverage', totalBytes: 100 * 1024 ** 3, freeBytes: 1,
        freePct: 0, totalInodes: 100, freeInodes: 100, freeInodesPct: 1 };
      await runDiskSpaceAlarmOnce({ ...deps, sample: async () => [snapshot] }, DEFAULT_DISK_POLICY);
      await runDiskSpaceAlarmOnce({ ...deps, sample: async () => [{ ...snapshot,
        freeBytes: snapshot.totalBytes, freePct: 1 }] }, DEFAULT_DISK_POLICY);
    } },
  { id: 'storage-growth', rowId: 'owner-only-alarm|packages/operator-core/lib/storage/storage-growth-alarm.ts|runStorageGrowthAlarmOnce|1',
    run: async (attention) => {
      const { runStorageGrowthAlarmOnce } = await import('../storage/storage-growth-alarm');
      const deps = { ...attention, emitToast: async () => {}, recentlyEscalated: async () => true,
        listTableSizes: async () => [], listDiskRootChildren: async () => ({ entries: [], truncated: false }),
        countExemptSubsets: async () => [] };
      const row: import('../storage/usage').StorageUsageRow = { id: 'coverage', label: 'Coverage',
        kind: 'pg', federation: 'local-diagnostic', trimmable: true, bloats: false,
        totalBytes: 1024 ** 4, totalRows: 1, ageBuckets: [], description: 'Coverage' };
      await runStorageGrowthAlarmOnce({ ...deps, computeUsage: async () => [row] });
      await runStorageGrowthAlarmOnce({ ...deps, computeUsage: async () => [{ ...row, totalBytes: null }] });
      await runStorageGrowthAlarmOnce({ ...deps, computeUsage: async () => [{ ...row, totalBytes: 0 }] });
    } },
  { id: 'poll-suspect', rowId: 'owner-only-alarm|packages/operator-core/lib/poll-suspect-alarm.ts|runPollSuspectScanOnce|1',
    run: async (attention) => {
      const { runPollSuspectScanOnce } = await import('../poll-suspect-alarm');
      const suspect = { tool_name: 'coverage:poll', call_count: 1000, calls_per_hour: 200,
        callers: 5, calls_per_caller_per_hour: 40, total_bytes: 0, reason: 'polling-shaped' };
      // This row was already toasted. Deduplication must not suppress its condition.
      const deps = { ...attention, emitToast: async () => {}, recentlyEscalated: async () => true,
        now: () => 1000, lastAlertedAt: new Map([[suspect.tool_name, 1000]]) };
      await runPollSuspectScanOnce({ ...deps, loadSuspects: async () => [suspect] });
      await runPollSuspectScanOnce({ ...deps, loadSuspects: async () => [] });
    } },
  { id: 'localstorage-wal', rowId: 'owner-only-alarm|packages/operator-core/lib/storage/localstorage-wal-guard.ts|runWalCheckpointGuard|1',
    run: async (deps) => {
      const { DatabaseSync } = await import('node:sqlite');
      const { mkdtempSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { runWalCheckpointGuard } = await import('../storage/localstorage-wal-guard');
      const root = mkdtempSync(join(tmpdir(), 'condition-rail-wal-'));
      let writer: InstanceType<typeof DatabaseSync> | undefined;
      let reader: InstanceType<typeof DatabaseSync> | undefined;
      try {
        const path = join(root, 'coverage.localstorage');
        writer = new DatabaseSync(path);
        writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t (v TEXT);');
        writer.prepare('INSERT INTO t VALUES (?)').run('before');
        reader = new DatabaseSync(path);
        reader.exec('BEGIN;');
        reader.prepare('SELECT * FROM t').all();
        writer.prepare('INSERT INTO t VALUES (?)').run('x'.repeat(16_384));
        await runWalCheckpointGuard({ roots: [root], thresholdBytes: 1 }, deps);
        reader.exec('COMMIT;'); reader.close(); reader = undefined;
        await runWalCheckpointGuard({ roots: [root], thresholdBytes: 1 }, deps);
      } finally {
        reader?.close(); writer?.close(); rmSync(root, { recursive: true, force: true });
      }
    } },
  { id: 'gui-surface', rowId: 'owner-only-alarm|packages/operator-core/lib/system-health/gui-e2e-surface-scheduled-run.ts|escalate|1',
    run: async (attention) => {
      const { EventEmitter } = await import('node:events');
      const { defaultIO, runGuiE2eSurfaceScheduledRun } = await import('../system-health/gui-e2e-surface-scheduled-run');
      const run = async (code: number) => {
        const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(),
          stderr: new EventEmitter(), kill: () => true });
        const pending = runGuiE2eSurfaceScheduledRun({ ...defaultIO, readEnabled: async () => true,
          spawnFn: () => child as unknown as import('node:child_process').ChildProcess,
          escalate: (input) => defaultIO.escalate(input, attention),
          resolve: () => defaultIO.resolve!(attention) });
        await Promise.resolve();
        child.stdout.emit('data', `P001_TAURI_SURFACE_VERIFY_${code ? 'FAIL' : 'OK'} leg=coverage\n`);
        child.emit('close', code);
        await pending;
      };
      const { vi, expect } = await import('vitest');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try { await run(1); expect(warn).toHaveBeenCalled(); }
      finally { warn.mockRestore(); }
      await run(0);
    } },
];

RAIL_MIGRATION_CASES.push(...alarmCases.map((caller): RailMigrationCase => ({
  id: `alarm-${caller.id}-open-recover`, item: 'P-007', route: 'condition', rowIds: [caller.rowId],
  run: async () => {
    const openedKeys: string[] = [];
    const resolvedKeys: string[] = [];
    await caller.run({
      broadcast: async (event) => { openedKeys.push(event.conditionKey!); return true; },
      resolve: async (event) => { resolvedKeys.push(event.conditionKey); return true; },
      notify: async () => {}, recentlyEscalated: async () => true,
    });
    return { route: 'condition', openedKeys, resolvedKeys };
  },
})));

RAIL_MIGRATION_CASES.push({
  id: 'coverage-snapshot-read-failure-cache-and-recovery', item: 'P-010', route: 'observation',
  mechanism: 'coverage-snapshot-read',
  rowIds: ['log-only-fallback|packages/operator-core/lib/search/coverage-gate.ts|loadCoverageSnapshotCached|1'],
  run: async () => {
    const producer = await import('../search/coverage-gate');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const observe: typeof import('./fallback-observations').observeFallback = (mechanism, decision) => {
      if (mechanism !== 'coverage-snapshot-read') throw new Error('unexpected coverage mechanism');
      observations.push(decision); return true;
    };
    let reads = 0;
    const sql = { unsafe: async () => { reads++; if (reads === 1) throw new Error('coverage fixture read failed'); return []; } };
    const now = new Date();
    producer.resetCoverageSnapshotCache();
    const { vi, expect } = await import('vitest');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await producer.loadCoverageSnapshotCached(sql, 'coverage', now, observe);
      await producer.loadCoverageSnapshotCached(sql, 'coverage', new Date(now.getTime() + 1_000), observe);
      await producer.loadCoverageSnapshotCached(sql, 'coverage', new Date(now.getTime() + 120_000), observe);
      if (reads !== 2 || observations.map((entry) => entry.applied).join() !== '0,0,1') {
        throw new Error('failed cached reads must stay degraded until a real successful read');
      }
      expect(warn).toHaveBeenCalledTimes(1);
      return { route: 'observation', mechanism: 'coverage-snapshot-read', observations };
    } finally { producer.resetCoverageSnapshotCache(); warn.mockRestore(); }
  },
}, {
  id: 'bm25-scan-score-disagreement-and-verified-recovery', item: 'P-010', route: 'observation',
  mechanism: 'bm25-scan-score',
  rowIds: ['log-only-fallback|packages/operator-core/lib/search/lexical/rank.ts|runBm25TopK|1'],
  run: async () => {
    const producer = await import('../search/lexical/rank');
    const { default: postgres } = await import('postgres');
    // postgres supplies actual fragment construction; only the check-query execution is
    // replaced at its existing Sql seam. No connection is opened by lazy fragments.
    const sql = postgres();
    const exec = new Proxy(sql, { apply: () => Promise.resolve([{ bm25_d: -5 }]) });
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const observe: typeof import('./fallback-observations').observeFallback = (mechanism, decision) => {
      if (mechanism !== 'bm25-scan-score') throw new Error('unexpected lexical mechanism');
      observations.push(decision); return true;
    };
    const req = { distance: sql`-5`, columns: sql`1 AS id`, from: sql`(VALUES (1)) source(id)`,
      where: sql`true`, limit: 1, scanScore: sql`0` };
    let runs = 0;
    producer.resetBm25ScanScoreFallbacks();
    const { vi, expect } = await import('vitest');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await producer.runBm25TopK(sql, exec, req, async () => [{ bm25_d: ++runs === 1 ? 0 : -5 }],
        (row) => row.bm25_d, observe);
      if (runs !== 2) throw new Error('untrusted scan score did not trigger standalone rerun');
      await producer.runBm25TopK(sql, exec, req, async () => [{ bm25_d: -5 }], (row) => row.bm25_d, observe);
      if (observations.map((entry) => entry.applied).join() !== '0,1') throw new Error('scan score decisions not observed');
      expect(warn).toHaveBeenCalledTimes(1);
      return { route: 'observation', mechanism: 'bm25-scan-score', observations };
    } finally { await sql.end(); producer.resetBm25ScanScoreFallbacks(); warn.mockRestore(); }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'query-embedder-acquisition-failure-and-measured-recovery', item: 'P-010', route: 'observation',
  mechanism: 'query-embedder-acquisition',
  rowIds: ['log-only-fallback|packages/operator-core/lib/agent-tools/search/embedder.ts|buildQueryEmbedderResolved|1'],
  run: async () => {
    const producer = await import('../agent-tools/search/embedder');
    const { EMBEDDER_DIM_SPECS } = await import('@papercusp/memory');
    const { vi, expect } = await import('vitest');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const observeFallback: typeof import('./fallback-observations').observeFallback = (mechanism, decision) => {
      expect(mechanism).toBe('query-embedder-acquisition'); observations.push(decision); return true;
    };
    try {
      expect(await producer.buildQueryEmbedderResolved(undefined, {
        acquire: async () => { throw new Error('pipeline unavailable'); }, observeFallback,
      })).toBeNull();
      expect(await producer.buildQueryEmbedderResolved(undefined, {
        acquire: async () => ({ mode: 'disabled' }), observeFallback,
      })).toBeNull();
      // A preference-disabled call contributes no eligible unit and no false recovery.
      expect(observations).toHaveLength(1);
      expect(await producer.buildQueryEmbedderResolved(undefined, {
        acquire: async () => ({ mode: 'local', dims: EMBEDDER_DIM_SPECS.local.targetDims,
          profile: EMBEDDER_DIM_SPECS.local, embed: async () => [1, 2, 3] }), observeFallback,
      })).not.toBeNull();
      expect(observations.map((row) => row.applied)).toEqual([0, 1]);
      expect(warn).toHaveBeenCalledTimes(1);
      return { route: 'observation', mechanism: 'query-embedder-acquisition', observations };
    } finally { warn.mockRestore(); producer._clearQueryEmbedCacheForTests(); }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'jev-worker-transport-per-request-fallback-and-new-worker-recovery', item: 'P-010', route: 'observation',
  mechanism: 'jev-worker-transport',
  rowIds: ['log-only-fallback|packages/operator-core/lib/memory/jev-transport.ts|reportTransportEvent|1'],
  run: async () => {
    const { createServer } = await import('node:http');
    const { createWorkerTransport, WORKER_TRANSPORT_MAX_FAILURES } = await import('@papercusp/decision-model');
    const { reportTransportEvent } = await import('../memory/jev-transport');
    const { vi, expect } = await import('vitest');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const observe: typeof import('./fallback-observations').observeFallback = (mechanism, decision) => {
      expect(mechanism).toBe('jev-worker-transport'); observations.push(decision); return true;
    };
    const server = createServer((_req, response) => response.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/`;
    const transports: import('@papercusp/decision-model').WorkerTransport[] = [];
    const make = () => {
      const transport = createWorkerTransport({ keepAliveIdleMs: 1000,
        fallback: async () => ({ status: 200, headers: { get: () => null }, text: async () => 'fallback' }),
        onEvent: (event) => reportTransportEvent(event, observe) });
      transports.push(transport); return transport;
    };
    const call = (transport: import('@papercusp/decision-model').WorkerTransport) => transport.fetch(url, {
      method: 'POST', body: '', headers: {}, signal: AbortSignal.timeout(5000) });
    try {
      const broken = make();
      for (let i = 0; i < WORKER_TRANSPORT_MAX_FAILURES; i++) {
        await call(broken); await broken.__killWorkerForTest();
      }
      expect(broken.mode()).toBe('fallback');
      expect(await (await call(broken)).text()).toBe('fallback');
      expect(await (await call(broken)).text()).toBe('fallback');
      expect(observations.slice(-2).map((row) => row.applied)).toEqual([0, 0]);
      await call(make());
      expect(observations.at(-1)?.applied).toBe(1);
      expect(warn).toHaveBeenCalledTimes(WORKER_TRANSPORT_MAX_FAILURES + 1);
      return { route: 'observation', mechanism: 'jev-worker-transport', observations };
    } finally {
      await Promise.all(transports.map((transport) => transport.close()));
      await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
      warn.mockRestore();
    }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'backfill-batch-host-wired-failure-and-success', item: 'P-010', route: 'observation',
  mechanism: 'backfill-batch',
  rowIds: ['log-only-fallback|libs/generic/search/src/backfill/backfill-table.ts|backfillTable|1'],
  run: async () => {
    const host = await import('../search/embed-backfill');
    const primitive = await import('./fallback-observations');
    const { PROSE_VECTOR_DIMS } = await import('../search/prose-vector-dims');
    const { vi, expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const sink = vi.spyOn(primitive, 'observeFallback').mockImplementation((mechanism, decision) => {
      expect(mechanism).toBe('backfill-batch'); observations.push(decision); return true;
    });
    const vector = new Array<number>(PROSE_VECTOR_DIMS).fill(0);
    const target = { table: 'coverage.notes', embedCol: 'embedding', keyCols: ['id'], bodySql: 'body' };
    // The caller only awaits unsafe; this fixture replaces SQL execution, not
    // postgres.js's lazy PendingQuery construction API.
    const sql = {
      unsafe: async (query: string) => query.startsWith('SELECT')
        ? [{ k0: 'a', body: 'a' }, { k0: 'b', body: 'b' }] : [],
    } as unknown as Parameters<typeof host.backfillTable>[0];
    const warn = vi.fn();
    try {
      const options = { mode: 'local' as const, embed: async () => vector, maxRows: 2,
        spaceAware: false, logger: { log: vi.fn(), warn, error: vi.fn() } };
      expect((await host.backfillTable(sql, target, { ...options,
        embedMany: async () => { throw new Error('batch down'); } })).embedded).toBe(2);
      expect((await host.backfillTable(sql, target, { ...options,
        embedMany: async (texts) => texts.map(() => vector) })).embedded).toBe(2);
      expect(observations.map((row) => row.applied)).toEqual([0, 2]);
      expect(observations.map((row) => row.eligible)).toEqual([2, 2]);
      expect(warn).toHaveBeenCalledTimes(1);
      const config = host.proseBackfillSweeperConfig({ running: false, lastResult: null, sweepCounter: 0, startedAt: null });
      expect(config.observeFallback).toBeTypeOf('function');
      config.observeFallback!({ eligible: 2, applied: 2, reason: 'batch-applied', scope: target.table });
      expect(observations).toHaveLength(3);
      return { route: 'observation', mechanism: 'backfill-batch', observations };
    } finally { sink.mockRestore(); }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'embed-device-host-observation-and-verified-construction-recovery', item: 'P-010', route: 'observation',
  mechanism: 'embed-device',
  rowIds: ['log-only-fallback|libs/generic/memory/src/embed-device.ts|recordEmbedDeviceDemotion|1'],
  run: async () => {
    await import('../memory/configure');
    const memory = await import('@papercusp/memory');
    const config = await import('../../../../libs/generic/memory/src/config');
    const { vi, expect } = await import('vitest');
    const savedHost = config.memoryHost();
    const saved = process.env[memory.EMBED_DEVICE_ENV];
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    config.configureMemory({ ...savedHost, observeFallback: (mechanism, decision) => {
      expect(mechanism).toBe('embed-device'); observations.push(decision);
    } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      memory._resetEmbedDeviceState();
      process.env[memory.EMBED_DEVICE_ENV] = 'gpu';
      const failed = { pipeline: async (_task: string, _model: string, opts?: Record<string, unknown>) => {
        if (opts?.device === 'cuda') throw new Error('GPU provider failed');
        return { device: opts?.device };
      } };
      expect(await memory.constructEmbedPipeline(failed, 'first', {})).toEqual({ device: 'cpu' });
      expect(await memory.constructEmbedPipeline(failed, 'second', {})).toEqual({ device: 'cpu' });
      expect(observations.map((row) => row.applied)).toEqual([0, 0]);
      memory._resetEmbedDeviceState();
      expect(await memory.constructEmbedPipeline({ pipeline: async (_task, _model, opts) => ({ device: opts?.device }) }, 'recovered', {}))
        .toEqual({ device: 'cuda' });
      process.env[memory.EMBED_DEVICE_ENV] = 'cpu';
      await memory.constructEmbedPipeline(failed, 'deliberate-cpu', {});
      expect(observations.map((row) => row.applied)).toEqual([0, 0, 1]);
      expect(warn).toHaveBeenCalledTimes(1);
      return { route: 'observation', mechanism: 'embed-device', observations };
    } finally {
      config.__setMemoryHostForTests(savedHost); memory._resetEmbedDeviceState(); warn.mockRestore();
      if (saved === undefined) delete process.env[memory.EMBED_DEVICE_ENV]; else process.env[memory.EMBED_DEVICE_ENV] = saved;
    }
  },
}, {
  id: 'embed-worker-host-observation-before-log-cooldown-and-real-protocol-success', item: 'P-010', route: 'observation',
  mechanism: 'embed-worker',
  rowIds: ['log-only-fallback|libs/generic/memory/src/local-embedder-worker.ts|warnEmbedFallback|1'],
  run: async () => {
    await import('../memory/configure');
    const config = await import('../../../../libs/generic/memory/src/config');
    const worker = await import('../../../../libs/generic/memory/src/local-embedder-worker');
    const { Worker } = await import('node:worker_threads');
    const { vi, expect } = await import('vitest');
    const savedHost = config.memoryHost();
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    config.configureMemory({ ...savedHost, observeFallback: (mechanism, decision) => {
      if (mechanism === 'embed-worker') observations.push(decision);
    } });
    const originalPost = Worker.prototype.postMessage;
    const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: InstanceType<typeof Worker>, message, ...args) {
      if (message?.kind === 'embed') {
        queueMicrotask(() => this.emit('message', { kind: 'embed_ok', id: message.id, vector: [1, 2, 3] }));
      } else { originalPost.call(this, message, ...args); }
    });
    try {
      await worker._resetWorker(); worker._resetFallbackWarnForTest();
      worker.warnEmbedFallback('local', new Error('worker unavailable'));
      worker.warnEmbedFallback('local', new Error('still unavailable'));
      expect(observations.map((row) => row.applied)).toEqual([0, 0]);
      // The real request/response protocol runs; only native inference is replaced.
      expect(await worker.embedViaWorker('recovered')).toEqual([1, 2, 3]);
      expect(observations.map((row) => row.applied)).toEqual([0, 0, 1]);
      return { route: 'observation', mechanism: 'embed-worker', observations };
    } finally {
      post.mockRestore(); await worker._resetWorker(); worker._resetFallbackWarnForTest();
      config.__setMemoryHostForTests(savedHost);
    }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'search-sampler-authoritative-verdict-through-host-sink-once', item: 'P-010', route: 'observation', mechanism: 'retrieval',
  rowIds: ['health-flag-no-condition|libs/generic/search/src/leg-health.ts|sampleOfLegs|1'],
  run: async () => {
    const search = await import('@papercusp/search');
    const host = await import('../system-health/retrieval-degradation-watchdog');
    const { expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const leg = { status: 'ran', candidates: 5, blocked: null };
    try {
      host.startRetrievalDegradationWatchdog({ observe: (_mechanism, decision) => { observations.push(decision); return true; } });
      search.observeLegs({ lexical: leg, semantic: { ...leg, candidates: 0, blocked: 'timeout' }, degraded: true } as import('@papercusp/search').SearchLegs);
      search.observeLegs({ lexical: leg, semantic: leg, degraded: false } as import('@papercusp/search').SearchLegs);
      expect(observations.map((row) => row.applied)).toEqual([0, 1]);
      return { route: 'observation', mechanism: 'retrieval', observations };
    } finally { search.setLegHealthObserver(null); }
  },
}, {
  id: 'rerank-device-failed-sticky-and-verified-gpu-construction', item: 'P-010', route: 'observation', mechanism: 'rerank-device',
  rowIds: ['log-only-fallback|libs/generic/rerank/src/local-engine.ts|reportDemotion|1'],
  run: async () => {
    const engine = await import('../../../../libs/generic/rerank/src/local-engine');
    const { vi, expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const observeFallback: import('../../../../libs/generic/rerank/src/local-engine').LocalRerankOptions['observeFallback'] = (mechanism, decision) => {
      if (mechanism === 'rerank-device') observations.push(decision);
    };
    const loaded = { tokenizer: () => ({}), model: async () => ({ logits: { dims: [1, 1], data: [0] } }) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      engine._setLoaderForTest(async (_model, _dtype, device) => { if (device === 'cuda') throw new Error('GPU unavailable'); return loaded; });
      await engine.loadCrossEncoder({ model: 'first', device: 'cuda', dtype: 'fp16', observeFallback });
      await engine.loadCrossEncoder({ model: 'second', device: 'cuda', dtype: 'fp16', observeFallback });
      expect(observations.map((row) => row.applied)).toEqual([0, 0]);
      engine._setLoaderForTest(async () => loaded);
      await engine.loadCrossEncoder({ device: 'cuda', dtype: 'fp16', observeFallback });
      await engine.loadCrossEncoder({ device: 'cpu', dtype: 'q8', observeFallback });
      expect(observations.map((row) => row.applied)).toEqual([0, 0, 1]);
      expect(warn).toHaveBeenCalledTimes(1);
      return { route: 'observation', mechanism: 'rerank-device', observations };
    } finally { engine._setLoaderForTest(null); warn.mockRestore(); }
  },
}, {
  id: 'rerank-worker-repeated-fallback-before-cooldown-and-real-protocol-recovery', item: 'P-010', route: 'observation', mechanism: 'rerank-worker',
  rowIds: ['log-only-fallback|libs/generic/rerank/src/local-reranker-worker.ts|warnRerankFallback|1'],
  run: async () => {
    const engine = await import('../../../../libs/generic/rerank/src/local-engine');
    const worker = await import('../../../../libs/generic/rerank/src/local-reranker-worker');
    const { Worker } = await import('node:worker_threads');
    const { vi, expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const observeFallback: import('../../../../libs/generic/rerank/src/local-engine').LocalRerankOptions['observeFallback'] = (mechanism, decision) => {
      if (mechanism === 'rerank-worker') observations.push(decision);
      if (mechanism === 'rerank-device') deviceObservations.push(decision);
    };
    const deviceObservations: Array<{ eligible: number; applied: number; reason: string }> = [];
    let attempts = 0;
    const originalPost = Worker.prototype.postMessage;
    const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: InstanceType<typeof Worker>, message, ...args) {
      if (message?.kind === 'score') {
        attempts++;
        expect(message.observeFallback).toBeUndefined(); // functions never cross the clone boundary
        queueMicrotask(() => {
          this.emit('message', { kind: 'device_decision', id: message.id,
            decision: { eligible: 1, applied: attempts < 3 ? 0 : 1, reason: attempts < 3 ? 'gpu-construction-failed' : 'applied' } });
          this.emit('message', attempts < 3
            ? { kind: 'score_err', id: message.id, error: 'unavailable' }
            : { kind: 'score_ok', id: message.id, scores: [0.75] });
        });
      } else { originalPost.call(this, message, ...args); }
    });
    try {
      await worker._resetRerankWorkerForTest(); worker._resetFallbackWarnForTest();
      engine._setLoaderForTest(async () => ({ tokenizer: () => ({}), model: async () => ({ logits: { dims: [1, 1], data: [0] } }) }));
      engine._setWorkerWithLoaderForTest(true);
      await engine.scoreCrossEncoder('query', ['document'], { device: 'cpu', dtype: 'q8', observeFallback });
      await engine.scoreCrossEncoder('query', ['document'], { device: 'cpu', dtype: 'q8', observeFallback });
      expect(observations.map((row) => row.applied)).toEqual([0, 0]);
      expect(await engine.scoreCrossEncoder('query', ['document'], { device: 'cpu', dtype: 'q8', observeFallback })).toEqual([0.75]);
      expect(observations.map((row) => row.applied)).toEqual([0, 0, 1]);
      expect(deviceObservations.map((row) => row.applied)).toEqual([0, 0, 1]);
      return { route: 'observation', mechanism: 'rerank-worker', observations };
    } finally {
      post.mockRestore(); await worker._resetRerankWorkerForTest(); worker._resetBeforeExitHookForTest();
      worker._resetFallbackWarnForTest(); engine._setLoaderForTest(null);
    }
  },
}, {
  id: 'embed-sidecar-crash-ready-handshake-and-idle-exclusion', item: 'P-010', route: 'observation', mechanism: 'embed-sidecar-respawn',
  rowIds: ['log-only-fallback|packages/operator-core/lib/memory/embed-sidecar-spawn.ts|scheduleRespawn|1'],
  run: async () => {
    const { vi, expect } = await import('vitest');
    const { EventEmitter } = await import('node:events');
    const watchdog = await import('../system-health/degradation-watchdog');
    const { summarizeFallbackWindow } = await import('./fallback-observations');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const children: Array<InstanceType<typeof EventEmitter> & { stdout: InstanceType<typeof EventEmitter> }> = [];
    vi.resetModules();
    vi.doMock('../degradation/fallback-observations', async (importOriginal) => ({
      ...await importOriginal<typeof import('./fallback-observations')>(),
      observeFallback: (mechanism: string, decision: { eligible: number; applied: number; reason: string }) => {
        if (mechanism === 'embed-sidecar-respawn') observations.push(decision);
        return true;
      },
    }));
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...await importOriginal<typeof import('node:child_process')>(),
      spawn: () => {
        const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false, kill() { return true; } });
        children.push(child); return child;
      },
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const savedPort = process.env.PAPERCUSP_EMBED_SIDECAR_PORT;
    delete process.env.PAPERCUSP_EMBED_SIDECAR_PORT;
    let producer: typeof import('../memory/embed-sidecar-spawn') | undefined;
    try {
      producer = await import('../memory/embed-sidecar-spawn');
      const protocol = await import('../memory/embed-sidecar-server');
      const ready = (port: number) => children.at(-1)!.stdout.emit('data', Buffer.from(`${protocol.EMBED_SIDECAR_READY_LINE} port=${port}\n`));
      const first = producer.spawnEmbedSidecar(); ready(41001); await first;
      observations.length = 0;
      children.at(-1)!.emit('exit', 1, null);
      expect(observations.map((row) => row.applied)).toEqual([0]);
      const verdict = () => watchdog.judgeDegradation(summarizeFallbackWindow('embed-sidecar-respawn', 60_000,
        observations.map((row) => ({ ...row, samples: 1 }))), { mechanism: 'embed-sidecar-respawn' },
        watchdog.getDegradationMechanism('embed-sidecar-respawn')!.thresholds);
      expect(verdict().kind).toBe('collapsed'); // sparse circuit must be actionable
      expect(warn).toHaveBeenCalledTimes(2); // actual death and respawn decision
      const second = producer.spawnEmbedSidecar(); ready(41002); await second;
      expect(observations.map((row) => row.applied)).toEqual([0, 1]);
      expect(verdict().kind).toBe('recovered');
      children.at(-1)!.stdout.emit('data', Buffer.from(`${protocol.EMBED_SIDECAR_IDLE_EXIT_LINE}\n`));
      children.at(-1)!.emit('exit', 0, null);
      expect(observations.map((row) => row.applied)).toEqual([0, 1]);
      return { route: 'observation', mechanism: 'embed-sidecar-respawn', observations };
    } finally {
      producer?._resetEmbedSidecarSpawnStateForTests();
      warn.mockRestore(); log.mockRestore();
      vi.doUnmock('node:child_process'); vi.doUnmock('../degradation/fallback-observations'); vi.resetModules();
      if (savedPort === undefined) delete process.env.PAPERCUSP_EMBED_SIDECAR_PORT; else process.env.PAPERCUSP_EMBED_SIDECAR_PORT = savedPort;
    }
  },
});
