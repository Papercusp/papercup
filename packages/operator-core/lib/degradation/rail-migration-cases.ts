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

import { HOST_STARTUP_MIGRATION_CASES } from './host-startup-migration-cases';
import { original, execute } from './host-startup-migration-cases';
import { ROUTINE_FALLBACK_MIGRATION_CASES } from './routine-fallback-migration-cases';

export const RAIL_MIGRATION_COMPLETE_ITEMS: string[] = ['P-005', 'P-007', 'P-008', 'P-009', 'P-010', 'P-012'];

const remainingSyncCases: RailMigrationCase[] = [{
  id: 'sidecar-respawn-original-budget-failure-success-and-exclusions', item: 'P-011', route: 'observation',
  mechanism: 'substrate-sidecar-respawn',
  rowIds: ['log-only-fallback|packages/operator-core/lib/sync/hyperbee/substrate-sidecar-spawn.ts|scheduleRespawn|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    for (const scenario of ['stopped', 'pending', 'budget', 'failed', 'ready']) {
      let timer: (() => void) | undefined;
      let notified = false;
      const producer = execute(original('packages/operator-core/lib/sync/hyperbee/substrate-sidecar-spawn.ts', 'function scheduleRespawn(', 'function'), {
        deliberateStop: scenario === 'stopped', respawnTimer: scenario === 'pending' ? 1 : null,
        respawnAttempts: [], RESPAWN_WINDOW_MS: 1000, MAX_RESPAWN_ATTEMPTS: 3,
        pruneRespawnWindow: () => [], respawnBudgetExhausted: () => scenario === 'budget', gaveUp: false,
        respawnBackoffMs: () => 1, setTimeout: (fn: () => void) => { timer = fn; return 1; },
        spawnSubstrateSidecar: async () => { if (scenario === 'failed') throw new Error('spawn unavailable'); },
        notifySidecarRespawned: () => { notified = true; },
        observeFallback: (mechanism: string, row: typeof observations[number]) => {
          expect(mechanism).toBe('substrate-sidecar-respawn'); observations.push(row); return true;
        },
      }, 'scheduleRespawn') as (socketPath: string) => void;
      producer('/fixture/socket');
      if (timer) { timer(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }
      expect(notified).toBe(scenario === 'ready');
    }
    expect(observations.map((row) => [row.eligible, row.applied, row.reason])).toEqual([
      [1, 0, 'budget-exhausted'], [1, 0, 'respawn-failed'], [1, 1, 'applied'],
    ]);
    return { route: 'observation', mechanism: 'substrate-sidecar-respawn', observations };
  },
}, {
  id: 'coord-receipt-original-send-failure-primary-and-exclusions', item: 'P-011', route: 'observation',
  mechanism: 'coord-delivery-receipt',
  rowIds: ['log-only-fallback|packages/operator-core/lib/sync/hyperbee/projections/coord-message.ts|writeToPg|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const text = original('packages/operator-core/lib/sync/hyperbee/projections/coord-message.ts', '[coord-message] delivery receipt failed', 'if');
    for (const scenario of ['empty', 'unwoken', 'failed', 'sent', 'rate-limited']) {
      await execute(text, {
        fanTo: scenario === 'empty' ? [] : ['recipient'],
        fanWoken: ['unwoken', 'rate-limited'].includes(scenario) ? 0 : 1,
        fanSuppressedByRate: scenario === 'rate-limited',
        opts: { workspaceId: 'fixture', harnessSlug: 'fixture-harness' },
        row: { msg_id: 'fixture-message', harness_slug: 'fixture-harness' },
        require: (path: string) => {
          if (path.endsWith('coordination/messages')) return { sendMessage: async () => { if (scenario === 'failed') throw new Error('send unavailable'); } };
          if (path.endsWith('device-keychain-id')) return { machineFingerprint: () => 'fixture-device' };
          throw new Error(`unexpected dependency ${path}`);
        },
        observeFallback: (mechanism: string, row: typeof observations[number] & { scope?: string }) => {
          expect(mechanism).toBe('coord-delivery-receipt'); expect(row.scope).toBe('fixture-harness'); observations.push(row); return true;
        },
      });
    }
    expect(observations.map((row) => [row.eligible, row.applied, row.reason])).toEqual([
      [1, 0, 'receipt-send-failed'], [1, 1, 'applied'], [1, 1, 'applied'],
    ]);
    return { route: 'observation', mechanism: 'coord-delivery-receipt', observations };
  },
}];

export const RAIL_MIGRATION_CASES: RailMigrationCase[] = [...HOST_STARTUP_MIGRATION_CASES, ...ROUTINE_FALLBACK_MIGRATION_CASES, ...remainingSyncCases, {
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

for (const kind of ['plan-item-claim', 'work-item-claim', 'work-item-replica'] as const) {
  const path = kind === 'plan-item-claim' ? 'plan-items/claim-authority-swarm.ts'
    : kind === 'work-item-claim' ? 'work-item-claim-authority-swarm.ts' : 'work-item-replica-authority-swarm.ts';
  RAIL_MIGRATION_CASES.push({
    id: `${kind}-real-authority-routing-fallback-and-recovery`, item: 'P-011', route: 'observation',
    mechanism: 'swarm-authority-route',
    rowIds: [`log-only-fallback|packages/operator-core/lib/${path}|route|1`],
    run: async () => {
      const { expect, vi } = await import('vitest');
      const recorder = await import('./fallback-observations');
      const rpc = await import('../authority/peer-rpc-transport');
      const watchdog = await import('../system-health/degradation-watchdog');
      const observations: Array<{ eligible: number; applied: number; reason: string; scope?: string | null }> = [];
      const scope = `${kind}:rail-fixture`;
      const sink = vi.spyOn(recorder, 'observeFallback').mockImplementation((mechanism, row) => {
        if (mechanism === 'swarm-authority-route' && row.scope === scope) observations.push(row);
        return true;
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const previousTransport = rpc.getPeerRpcTransport();
      let remote = true;
      const presence = async () => remote ? [{ device_pubkey: 'aaa-authority', github_user_id: 1,
        machine_label: 'remote', last_seen_ms: 1_000 }] : [];
      const deps = { fetchPresenceRows: presence, fetchHivePresenceRows: presence,
        resolveSelf: async () => ({ devicePubkey: 'zzz-self', githubUserId: 2 }),
        now: () => 1_000, useHrwRendezvous: false, evictionMonitor: null };
      try {
        const producer = kind === 'plan-item-claim'
          ? new (await import('../plan-items/claim-authority-swarm')).SwarmClaimAuthority(deps)
          : kind === 'work-item-claim'
            ? new (await import('../work-item-claim-authority-swarm')).SwarmWorkItemClaimAuthority(deps)
            : new (await import('../work-item-replica-authority-swarm')).SwarmWorkItemReplicaAuthority(deps);
        // A no-op identity probe is not an eligible claim/replica decision.
        expect(await producer.isSelf('rail-fixture')).toBe(false);
        expect(observations).toHaveLength(0);
        rpc.setPeerRpcTransport(null);
        const op = { local: async () => 'local-value', remote: { kind: 'rail-case', payload: {}, decode: String } };
        for (let i = 0; i < 20; i++) expect(await producer.route('rail-fixture', op)).toBe('local-value');
        expect(observations).toHaveLength(20);
        expect(observations.every((row) => row.applied === 0 && row.reason === 'authority-unreachable')).toBe(true);
        const verdict = () => watchdog.judgeDegradation(recorder.summarizeFallbackWindow('swarm-authority-route', 60_000,
          observations.map((row) => ({ ...row, samples: 1 }))), { mechanism: 'swarm-authority-route', scope },
          watchdog.getDegradationMechanism('swarm-authority-route')!.thresholds);
        expect(verdict().kind).toBe('collapsed');
        rpc.setPeerRpcTransport({ rpc: async () => 'remote-value' });
        for (let i = 0; i < 25; i++) expect(await producer.route('rail-fixture', op)).toBe('remote-value');
        expect(verdict().kind).toBe('recovered');
        remote = false;
        expect(await producer.route('rail-fixture', op)).toBe('local-value');
        expect(observations.at(-1)).toMatchObject({ eligible: 1, applied: 1, reason: 'applied' });
        expect(warn).toHaveBeenCalledTimes(20);
        return { route: 'observation', mechanism: 'swarm-authority-route', observations };
      } finally { rpc.setPeerRpcTransport(previousTransport); sink.mockRestore(); warn.mockRestore(); }
    },
  });
}

RAIL_MIGRATION_CASES.push({
  id: 'storage-slug-original-resolver-error-and-verified-unpotted-recovery', item: 'P-011', route: 'observation',
  mechanism: 'work-item-storage-resolution',
  rowIds: ['log-only-fallback|packages/operator-core/lib/pot-membership.ts|workItemStorageSlug|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    let result: string | null = null;
    let fail = true;
    const producer = execute(original('packages/operator-core/lib/pot-membership.ts', 'function workItemStorageSlug(', 'function'), {
      resolveWorkItemPot: async () => { if (fail) throw new Error('resolver unavailable'); return result; },
      observeFallback: (mechanism: string, row: typeof observations[number]) => {
        expect(mechanism).toBe('work-item-storage-resolution'); observations.push(row); return true;
      },
    }, 'workItemStorageSlug') as (slug: string, workspace: string) => Promise<string>;
    expect(await producer('member', 'fixture')).toBe('member');
    fail = false;
    expect(await producer('member', 'fixture')).toBe('member'); // verified unpotted tenant
    result = 'pot-home';
    expect(await producer('member', 'fixture')).toBe('pot-home');
    expect(observations.map((row) => [row.applied, row.reason])).toEqual([
      [0, 'pot-resolution-failed'], [1, 'applied'], [1, 'applied'],
    ]);
    return { route: 'observation', mechanism: 'work-item-storage-resolution', observations };
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'substrate-binding-original-required-hive-failure-and-configured-local-recovery', item: 'P-011', route: 'observation',
  mechanism: 'substrate-binding-resolution',
  rowIds: ['log-only-fallback|packages/operator-core/lib/sync/hyperbee/boot-all.ts|defaultResolveSwarmBinding|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    let fail = false;
    let hive: object | null = null;
    let home: string | null = 'pot-home';
    let projectDir = '/fixture';
    let config: { topic?: string; github_repository_id: number } | null = { github_repository_id: 1 };
    const producer = execute(original('packages/operator-core/lib/sync/hyperbee/boot-all.ts', 'function defaultResolveSwarmBinding(', 'function'), {
      require: (path: string) => path.endsWith('hive-federation') ? {
        resolveHiveSwarmBinding: async () => { if (fail) throw new Error('identity unavailable'); return hive; },
        potHomeSlugForHarness: async () => home,
      } : { resolveHarnessPaths: async () => ({ projectDir }) },
      loadSharedConfigFromProjectDir: () => config,
      observeFallback: (mechanism: string, row: typeof observations[number]) => {
        expect(mechanism).toBe('substrate-binding-resolution'); observations.push(row); return true;
      },
    }, 'defaultResolveSwarmBinding') as (workspace: string, slug: string) => Promise<unknown>;
    expect(await producer('fixture', 'member')).toBeNull();
    fail = true; expect(await producer('fixture', 'member')).toBeNull();
    fail = false; projectDir = '/tmp/papercusp-unresolved/member';
    expect(await producer('fixture', 'member')).toBeNull();
    projectDir = '/fixture'; config = null;
    expect(await producer('fixture', 'member')).toBeNull(); // verified local-only
    config = { topic: 'a'.repeat(64), github_repository_id: 1 };
    expect(await producer('fixture', 'member')).toEqual({ kind: 'topic', topic_hex: 'a'.repeat(64) });
    config = { github_repository_id: 1 }; home = null;
    expect(await producer('fixture', 'member')).toEqual({ kind: 'gh', github_repository_id: 1 });
    hive = { kind: 'topic', topic_hex: 'b'.repeat(64) };
    expect(await producer('fixture', 'member')).toEqual(hive);
    expect(observations.map((row) => row.reason)).toEqual([
      'hive-binding-unresolved', 'binding-read-failed', 'harness-path-unresolved', 'applied', 'applied', 'applied', 'applied',
    ]);
    return { route: 'observation', mechanism: 'substrate-binding-resolution', observations };
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'substrate-boot-original-latch-timeout-decided-route-and-cached-exclusion', item: 'P-011', route: 'observation',
  mechanism: 'substrate-boot-routing',
  rowIds: ['log-only-fallback|packages/operator-core/lib/sync/hyperbee/boot-all.ts|bootSingleHarness|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const text = original('packages/operator-core/lib/sync/hyperbee/boot-all.ts', 'function bootSingleHarness(', 'function');
    for (const timedOut of [true, false]) {
      const handles = new Map();
      const inflight = new Map();
      let boots = 0;
      const producer = execute(text, {
        key: (workspace: string, slug: string) => `${workspace}:${slug}`, handles, inflight,
        routingDecisionFailure: null, routingDecisionPending: timedOut ? new Promise(() => {}) : null,
        SUBSTRATE_ROUTING_WAIT_MS: 1, setTimeout: (callback: () => void, ms: number) => { if (ms === 1) callback(); return { unref() {} }; },
        defaultBootHarness: null, defaultInProcessBootAllowed: () => true, defaultSkipSendSideWiring: true,
        bootHarnessSubstrate: async () => { boots++; return {}; }, defaultMergeCursorStoreFactory: null,
        createPgMergeCursorStore: () => ({}), process: { env: {} }, workspaceRootForId: () => '/fixture',
        evictionTrackingEnabled: false, disarmSubstrateWakeKeepalive: async () => {},
        observeFallback: (mechanism: string, row: typeof observations[number]) => {
          expect(mechanism).toBe('substrate-boot-routing'); observations.push(row); return true;
        },
      }, 'bootSingleHarness') as (workspace: string, slug: string, opts: object) => Promise<{ state: string }>;
      const opts = { resolveSwarmBinding: async () => null };
      expect((await producer('fixture', 'member', opts)).state).toBe('booted');
      expect((await producer('fixture', 'member', opts)).state).toBe('already-booted');
      expect(boots).toBe(1);
    }
    expect(observations.map((row) => [row.applied, row.reason])).toEqual([[0, 'routing-decision-timeout'], [1, 'applied']]);
    return { route: 'observation', mechanism: 'substrate-boot-routing', observations };
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'substrate-activation-original-failed-plan-partial-registry-and-recovery', item: 'P-011', route: 'observation',
  mechanism: 'substrate-activation-plan',
  rowIds: ['log-only-fallback|packages/operator-core/lib/sync/hyperbee/boot-all.ts|resolveActivationDeferrals|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    let fail = true;
    let enabled = true;
    let projects = [{ slug: 'one' }, { slug: 'two' }];
    const policy = await import('../sync/hyperbee/substrate-active-set-policy');
    const facts = await import('../sync/hyperbee/substrate-active-set-facts');
    const producer = execute(original('packages/operator-core/lib/sync/hyperbee/boot-all.ts', 'function resolveActivationDeferrals(', 'function'), {
      require: (path: string) => {
        if (path === '@papercusp/flags/server') return { getFlag: async () => enabled };
        if (path === '@papercusp/flags') return { FLAGS: { LAZY_SUBSTRATE_BOOT: 'lazy' } };
        if (path.endsWith('harness-registry')) return { loadHarnessRegistry: async () => { if (fail) throw new Error('registry unavailable'); return { projects }; } };
        if (path.endsWith('substrate-active-set-policy')) return policy;
        if (path.endsWith('substrate-active-set-facts')) return facts;
        throw new Error(`unexpected dependency ${path}`);
      },
      observeFallback: (mechanism: string, row: typeof observations[number]) => {
        expect(mechanism).toBe('substrate-activation-plan'); observations.push(row); return true;
      },
    }, 'resolveActivationDeferrals') as (pairs: object[], opts: object) => Promise<Set<string>>;
    const pairs = [{ wsId: 'fixture', slug: 'one' }, { wsId: 'fixture', slug: 'two' }];
    const opts = { activationFactDeps: { pendingOutboxCounts: async () => new Map(), lastPresenceMs: async () => new Map() } };
    expect((await producer(pairs, opts)).size).toBe(0);
    fail = false; projects = [{ slug: 'one' }];
    expect([...await producer(pairs, opts)]).toEqual(['fixture::one']);
    projects.push({ slug: 'two' });
    expect((await producer(pairs, opts)).size).toBe(2);
    await producer([], opts); enabled = false; await producer(pairs, opts);
    expect(observations.map((row) => [row.eligible, row.applied, row.reason])).toEqual([
      [2, 0, 'activation-plan-failed'], [2, 1, 'registry-entry-missing'], [2, 2, 'applied'],
    ]);
    return { route: 'observation', mechanism: 'substrate-activation-plan', observations };
  },
});

for (const cleanup of [false, true]) {
  const mechanism = cleanup ? 'substrate-sidecar-cleanup' : 'substrate-sidecar-boot';
  RAIL_MIGRATION_CASES.push({
    id: `${mechanism}-original-wrapper-failed-and-primary`, item: 'P-011', route: 'observation', mechanism,
    rowIds: [`log-only-fallback|packages/operator-core/lib/sync/hyperbee/substrate-boot-wrapper.ts|bootSubstrateWithFallback|${cleanup ? 2 : 1}`],
    run: async () => {
      const { expect } = await import('vitest');
      const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
      let enabled = true;
      let failBoot = true;
      let failStop = true;
      let stops = 0;
      const producer = execute(original('packages/operator-core/lib/sync/hyperbee/substrate-boot-wrapper.ts', 'function bootSubstrateWithFallback(', 'function'), {
        getFlag: async (flag: string) => flag === 'sidecar' ? enabled : false,
        FLAGS: { SUBSTRATE_SIDECAR: 'sidecar', SUBSTRATE_MERGE_CURSOR_PG: 'cursor' },
        createPgMergeCursorStore: () => ({}), maybeStartSubstrateEvictionReaper: async () => false, keepalive: null,
        setSubstrateBootDefaults() {}, bootAllHarnessesForActiveWorkspace: async () => ({ booted: 1 }),
        spawnSubstrateSidecar: async () => { if (failBoot) throw new Error('spawn failed'); },
        stopSubstrateSidecar: async () => { stops++; if (failStop) throw new Error('stop failed'); },
        registerSidecarShutdownHooks() {}, ensureSidecarRespawnReconcileRegistered() {},
        getSubstrateIpcClient: () => ({ call: async () => ({}) }), closeInProcessBootedHarnesses: async () => [],
        observeFallback: (name: string, row: typeof observations[number]) => {
          if (name === mechanism) observations.push(row); return true;
        },
      }, 'bootSubstrateWithFallback') as () => Promise<{ usedSidecar: boolean }>;
      expect((await producer()).usedSidecar).toBe(false);
      failStop = false; expect((await producer()).usedSidecar).toBe(false);
      failBoot = false; expect((await producer()).usedSidecar).toBe(true);
      const before = observations.length;
      enabled = false; expect((await producer()).usedSidecar).toBe(false);
      expect(observations).toHaveLength(before); expect(stops).toBe(2);
      expect(observations.map((row) => row.applied)).toEqual(cleanup ? [0, 1] : [0, 0, 1]);
      return { route: 'observation', mechanism, observations };
    },
  });
}

RAIL_MIGRATION_CASES.push({
  id: 'substrate-activation-facts-real-probe-failure-empty-and-recovery', item: 'P-011', route: 'observation',
  mechanism: 'substrate-activation-probe',
  rowIds: ['log-only-fallback|packages/operator-core/lib/sync/hyperbee/substrate-active-set-facts.ts|gatherActivationFacts|1'],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const recorder = await import('./fallback-observations');
    const producer = await import('../sync/hyperbee/substrate-active-set-facts');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const sink = vi.spyOn(recorder, 'observeFallback').mockImplementation((mechanism, row) => {
      if (mechanism === 'substrate-activation-probe') observations.push(row);
      return true;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const entries = [{ workspaceId: 'rail-workspace', harnessSlug: 'one' }, { workspaceId: 'rail-workspace', harnessSlug: 'two' }];
    const good = { pendingOutboxCounts: async () => new Map([['rail-workspace::one', 3]]),
      lastPresenceMs: async () => new Map([['rail-workspace::two', 1000]]) };
    try {
      for (const failedDependency of ['pendingOutboxCounts', 'lastPresenceMs'] as const) {
        const result = await producer.gatherActivationFacts(entries,
          { ...good, [failedDependency]: async () => { throw new Error('probe unavailable'); } });
        expect(result.every((row) => row.pinned && row.pendingOutboxRows === 1)).toBe(true);
      }
      expect(await producer.gatherActivationFacts([], good)).toEqual([]);
      expect(observations).toHaveLength(2);
      const recovered = await producer.gatherActivationFacts(entries, good);
      expect(recovered[0]).toMatchObject({ pendingOutboxRows: 3, pinned: false });
      expect(recovered[1]).toMatchObject({ lastPresenceMs: 1000, pendingOutboxRows: 0 });
      expect(observations).toEqual([
        { eligible: 2, applied: 0, reason: 'activation-probe-failed' },
        { eligible: 2, applied: 0, reason: 'activation-probe-failed' },
        { eligible: 2, applied: 2, reason: 'applied' },
      ]);
      return { route: 'observation', mechanism: 'substrate-activation-probe', observations };
    } finally { sink.mockRestore(); warn.mockRestore(); }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'sync-relay-real-reader-failure-empty-config-and-primary', item: 'P-011', route: 'observation',
  mechanism: 'sync-relay-config',
  rowIds: ['log-only-fallback|packages/operator-core/lib/sync/hyperbee/sync-relay.ts|resolveSyncRelayKeys|1'],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const recorder = await import('./fallback-observations');
    const producer = await import('../sync/hyperbee/sync-relay');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const sink = vi.spyOn(recorder, 'observeFallback').mockImplementation((mechanism, row) => {
      if (mechanism === 'sync-relay-config') observations.push(row);
      return true;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await producer.resolveSyncRelayKeys(async () => { throw new Error('relay store unavailable'); })).toEqual([]);
      expect(await producer.resolveSyncRelayKeys(async () => [])).toEqual([]);
      const keys = [Buffer.alloc(32, 1)];
      expect(await producer.resolveSyncRelayKeys(async () => keys)).toEqual(keys);
      expect(observations.map(({ applied, reason }) => [applied, reason])).toEqual([
        [0, 'relay-key-read-failed'], [1, 'applied'], [1, 'applied'],
      ]);
      return { route: 'observation', mechanism: 'sync-relay-config', observations };
    } finally { sink.mockRestore(); warn.mockRestore(); }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'authority-env-real-parser-invalid-cache-and-verified-config', item: 'P-011', route: 'observation',
  mechanism: 'authority-peer-addresses',
  rowIds: ['log-only-fallback|packages/operator-core/lib/authority/transport-wiring.ts|envAddressMap|1'],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const recorder = await import('./fallback-observations');
    const producer = await import('../authority/transport-wiring');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const sink = vi.spyOn(recorder, 'observeFallback').mockImplementation((mechanism, row) => {
      if (mechanism === 'authority-peer-addresses') observations.push(row);
      return true;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = process.env[producer.PEER_ADDRESSES_ENV];
    const peer = { devicePubkey: 'fixture-key', githubUserId: 1, machineLabel: 'fixture-peer' };
    try {
      producer._testing.reset(); delete process.env[producer.PEER_ADDRESSES_ENV];
      expect(await producer.resolvePeerAddress(peer)).toBeNull();
      expect(observations).toHaveLength(0); // no configuration was requested
      producer._testing.reset(); process.env[producer.PEER_ADDRESSES_ENV] = '{invalid';
      expect(await producer.resolvePeerAddress(peer)).toBeNull();
      expect(await producer.resolvePeerAddress(peer)).toBeNull();
      expect(observations).toEqual([{ eligible: 1, applied: 0, reason: 'invalid-json' }]);
      expect(warn).toHaveBeenCalledTimes(1);
      producer._testing.reset(); process.env[producer.PEER_ADDRESSES_ENV] = JSON.stringify({ 'fixture-key': 'http://fixture-peer' });
      expect(await producer.resolvePeerAddress(peer)).toBe('http://fixture-peer');
      expect(await producer.resolvePeerAddress(peer)).toBe('http://fixture-peer');
      expect(observations.at(-1)).toEqual({ eligible: 1, applied: 1, reason: 'applied' });
      expect(observations).toHaveLength(2); // memoization cannot invent healthy samples
      producer._testing.reset(); producer.configurePeerAddressResolver(async () => 'http://configured-peer');
      expect(await producer.resolvePeerAddress(peer)).toBe('http://configured-peer');
      expect(observations).toHaveLength(2); // env path was bypassed
      return { route: 'observation', mechanism: 'authority-peer-addresses', observations };
    } finally {
      producer._testing.reset();
      if (saved === undefined) delete process.env[producer.PEER_ADDRESSES_ENV]; else process.env[producer.PEER_ADDRESSES_ENV] = saved;
      sink.mockRestore(); warn.mockRestore();
    }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'spawner-sidecar-fallback-primary-denominator-and-recovery', item: 'P-012', route: 'observation',
  mechanism: 'spawner-sidecar-exec',
  rowIds: ['log-only-fallback|packages/operator-core/lib/fleet/git-via-sidecar.ts|recordSidecarFallback|1'],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const recorder = await import('./fallback-observations');
    const producer = await import('../fleet/git-via-sidecar');
    const spawner = await import('../fleet/spawner-sidecar-spawn');
    const ipc = await import('../fleet/spawner-ipc-client');
    const watchdog = await import('../system-health/degradation-watchdog');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const mocks = [
      vi.spyOn(recorder, 'observeFallback').mockImplementation((mechanism, row) => {
        if (mechanism === 'spawner-sidecar-exec') observations.push(row);
        return true;
      }),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(spawner, 'spawnSpawnerSidecar').mockResolvedValue(undefined),
      vi.spyOn(ipc, 'getSpawnerIpcClient').mockReturnValue({
        call: async () => ({ code: 3, stdout: 'child ran', stderr: 'child exit' }),
      } as unknown as ReturnType<typeof ipc.getSpawnerIpcClient>),
    ];
    const verdict = () => watchdog.judgeDegradation(recorder.summarizeFallbackWindow('spawner-sidecar-exec', 60_000,
      observations.map((row) => ({ ...row, samples: 1 }))),
      { mechanism: 'spawner-sidecar-exec' }, watchdog.getDegradationMechanism('spawner-sidecar-exec')!.thresholds);
    producer.resetSidecarFallbackStatsForTest();
    try {
      // Original producer, including warnings suppressed by the per-subsystem throttle.
      const failedAt = Date.now() - producer.SIDECAR_BREAKER_COOLDOWN_MS - 1;
      for (let i = 0; i < 20; i++) producer.noteSidecarFallback('coverage', new Error(`failure ${i}`), failedAt);
      expect(observations).toHaveLength(20);
      expect(verdict().kind).toBe('collapsed');
      // Disabled routing makes no sidecar decision and cannot manufacture recovery.
      await producer.execFileViaSidecar('git', ['status'], { timeoutMs: 1000, subsystem: 'coverage' }, {
        sidecarEnabled: () => false, local: async () => ({ stdout: '' }),
      });
      expect(observations).toHaveLength(20);
      // Execute the actual primary RPC path. Child exit status is not transport health.
      for (let i = 0; i < 25; i++) await producer.runCommandViaSpawnerSidecar('git', ['status'], { timeoutMs: 1000 });
      expect(observations.filter((row) => row.applied === 1)).toHaveLength(25);
      expect(verdict().kind).toBe('recovered');
      return { route: 'observation', mechanism: 'spawner-sidecar-exec', observations };
    } finally {
      producer.resetSidecarFallbackStatsForTest();
      for (const mock of mocks) mock.mockRestore();
    }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'bounded-operation-deadline-error-primary-and-cancellation-exclusion', item: 'P-012', route: 'observation',
  mechanism: 'bounded-operation',
  rowIds: [
    'log-only-fallback|packages/operator-core/lib/bounded-timeout.ts|withBoundedTimeout|1',
    'log-only-fallback|packages/operator-core/lib/bounded-timeout.ts|withBoundedTimeout|2',
  ],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const recorder = await import('./fallback-observations');
    const producer = await import('../bounded-timeout');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const sink = vi.spyOn(recorder, 'observeFallback').mockImplementation((mechanism, row) => {
      if (mechanism === 'bounded-operation') observations.push(row);
      return true;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deadline = producer.withBoundedTimeout(new Promise<string>(() => {}), { fallback: 'fallback', timeoutMs: 1, label: 'coverage' });
      expect((await deadline).reason).toBe('timeout');
      expect((await producer.withBoundedTimeout(Promise.reject(new Error('query error')), {
        fallback: 'fallback', timeoutMs: 1000, label: 'coverage',
      })).reason).toBe('error');
      expect((await producer.withBoundedTimeout(Promise.resolve('primary'), {
        fallback: 'fallback', timeoutMs: 1000, label: 'coverage',
      })).degraded).toBe(false);
      const controller = new AbortController();
      controller.abort();
      await producer.withBoundedTimeout(async () => { throw new Error('must not run'); }, {
        fallback: 'fallback', timeoutMs: 1000, signal: controller.signal,
      });
      expect(observations.map(({ applied, reason }) => [applied, reason])).toEqual([
        [0, 'timeout'], [0, 'error'], [1, 'applied'],
      ]);
      return { route: 'observation', mechanism: 'bounded-operation', observations };
    } finally { sink.mockRestore(); warn.mockRestore(); }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'primary-count-missing-capability-before-log-throttle-and-verified-recovery', item: 'P-012', route: 'observation',
  mechanism: 'primary-count-capability',
  rowIds: ['log-only-fallback|packages/operator-core/lib/system-health/single-primary-check.ts|countBackgroundPrimaries|1'],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const recorder = await import('./fallback-observations');
    const producer = await import('../system-health/single-primary-check');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const sink = vi.spyOn(recorder, 'observeFallback').mockImplementation((mechanism, row) => {
      if (mechanism === 'primary-count-capability') observations.push(row);
      return true;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let answer: Array<{ n: number; can_read_all_stats?: boolean }> = [{ n: 0 }];
    const sql = (async () => answer) as unknown as Parameters<typeof producer.countBackgroundPrimaries>[0];
    try {
      expect(await producer.countBackgroundPrimaries(sql)).toBe(0);
      expect(await producer.countBackgroundPrimaries(sql)).toBe(0);
      answer = [{ n: 0, can_read_all_stats: false }];
      expect(await producer.countBackgroundPrimaries(sql)).toBeNull();
      answer = [{ n: 1, can_read_all_stats: true }];
      expect(await producer.countBackgroundPrimaries(sql)).toBe(1);
      expect(observations.map(({ applied, reason }) => [applied, reason])).toEqual([
        [0, 'probe-column-absent'], [0, 'probe-column-absent'], [0, 'stats-permission-denied'], [1, 'applied'],
      ]);
      return { route: 'observation', mechanism: 'primary-count-capability', observations };
    } finally { sink.mockRestore(); warn.mockRestore(); }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'cache-l2-backend-failures-before-throttle-healthy-miss-and-disabled-exclusion', item: 'P-012', route: 'observation',
  mechanism: 'cache-l2-operation',
  rowIds: ['log-only-fallback|packages/operator-core/lib/cache/l2-tier.ts|noteL2Error|1'],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const recorder = await import('./fallback-observations');
    const producer = await import('../cache/l2-tier');
    const instance = await import('../cache/instance');
    const flags = await import('@papercusp/flags');
    const flagTest = await import('@papercusp/flags/test');
    const observations: Array<{ eligible: number; applied: number; reason: string; scope?: string | null }> = [];
    const sink = vi.spyOn(recorder, 'observeFallback').mockImplementation((mechanism, row) => {
      if (mechanism === 'cache-l2-operation') observations.push(row);
      return true;
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let fails = true;
    const store = {
      get: async () => { if (fails) throw new Error('get unavailable'); return undefined; },
      set: async () => { if (fails) throw new Error('set unavailable'); },
      invalidateByTags: async () => { if (fails) throw new Error('invalidation unavailable'); return 1; },
    } as unknown as Parameters<typeof producer.installL2StoreForTests>[0];
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      flagTest.setFlagOverridesForTest({ [flags.FLAGS.CACHE_LAYER]: true, [flags.FLAGS.CACHE_L2]: true });
      await instance._refreshCacheLayerForTests();
      producer.setL2EnabledForTests(true);
      producer.installL2StoreForTests(store);
      producer.resetL2ErrorLogForTests();
      const read = producer.withL2('coverage', 'key', async () => 'fresh build', { tags: [], softTtlMs: 1000 });
      for (let i = 0; i < 20; i++) { expect(await read()).toBe('fresh build'); await settle(); }
      expect(observations.filter((row) => row.scope === 'get' && row.applied === 0)).toHaveLength(20);
      expect(observations.filter((row) => row.scope === 'set' && row.applied === 0)).toHaveLength(20);
      expect(log).toHaveBeenCalledTimes(2);
      producer.invalidateL2ByTags('coverage', ['tag']);
      await settle();
      expect(observations).toContainEqual({ eligible: 1, applied: 0, reason: 'backend-error', scope: 'invalidateByTags' });
      fails = false;
      expect(await read()).toBe('fresh build'); // A successful backend MISS is a healthy consultation.
      await settle();
      await producer.invalidateL2ByTagsWithRetry('coverage', ['tag']);
      for (const scope of ['get', 'set', 'invalidateByTags']) {
        expect(observations).toContainEqual({ eligible: 1, applied: 1, reason: 'applied', scope });
      }
      const measured = observations.length;
      producer.setL2EnabledForTests(false);
      await producer.withL2('coverage', 'off', async () => 'local', { tags: [], softTtlMs: 1000 })();
      expect(observations).toHaveLength(measured);
      return { route: 'observation', mechanism: 'cache-l2-operation', observations };
    } finally {
      producer.installL2StoreForTests(null);
      producer.setL2EnabledForTests(true);
      flagTest.setFlagOverridesForTest({});
      await instance._refreshCacheLayerForTests();
      sink.mockRestore(); log.mockRestore();
    }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'gate-stall-fixer-succession-and-readable-end', item: 'P-008', route: 'condition',
  rowIds: ['owner-only-alarm|packages/operator-core/lib/harness/routines/release-actions.ts|trackGateStall|1'],
  run: async () => {
    const { vi, expect } = await import('vitest');
    const producer = await import('../harness/routines/release-actions');
    const org = await import('@papercusp/db-org');
    const attention = await import('../attention-notify');
    const now = Date.now();
    let queue: unknown = { schemaVersion: 3, phase: 'awaiting-fixer', candidate: 'a'.repeat(40),
      base: 'b'.repeat(40), repairHead: 'c'.repeat(40), worktreePath: '/coverage',
      qualificationAttemptId: null, affectedTestProofGroup: null, attempts: 0,
      openedAtMs: now - producer.FIXER_SUCCESSION_STALL_MS * 2,
      updatedAtMs: now - producer.FIXER_SUCCESSION_STALL_MS - 1000,
      fixerSpawnId: null, failingTests: ['coverage.test.ts'] };
    const gh = { lastGreenAt: now, consecutiveReds: 1 };
    const openedKeys: string[] = [], resolvedKeys: string[] = [], open = new Set<string>();
    const sql = Object.assign(async () => [], { unsafe: async (query: string) =>
      query.includes('SELECT') && query.includes("metadata->'gate_health'")
        ? [{ gh, lf: null, rq: queue }] : Object.assign([], { count: 1 }) });
    const notify = vi.spyOn(attention, 'notifyAttentionOnce').mockResolvedValue({ recordId: 1, deduped: false } as never);
    const db = vi.spyOn(org, 'getOrgPg').mockReturnValue({ sql } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const opts = { alarm: {
        broadcast: async ({ conditionKey }: { conditionKey?: string }) => {
          open.add(conditionKey!); openedKeys.push(conditionKey!); return true;
        },
        resolve: async ({ conditionKey }: { conditionKey: string }) => {
          if (!open.delete(conditionKey)) return false;
          resolvedKeys.push(conditionKey); return true;
        },
      } };
      const ctx = { installSlug: 'coverage', workspaceId: 'coverage' };
      await producer.trackGateStall(ctx, 'repair-in-progress', undefined, undefined, undefined, undefined, undefined, undefined, opts);
      expect(notify).toHaveBeenCalledOnce();
      expect(openedKeys).toEqual(['alarm:release-fixer-succession:coverage']);
      queue = { schemaVersion: 3, phase: 'awaiting-fixer' };
      await producer.trackGateStall(ctx, 'repair-in-progress', undefined, undefined, undefined, undefined, undefined, undefined, opts);
      expect(resolvedKeys).toEqual([]);
      queue = null;
      await producer.trackGateStall(ctx, 'repair-in-progress', undefined, undefined, undefined, undefined, undefined, undefined, opts);
      return { route: 'condition', openedKeys, resolvedKeys };
    } finally { log.mockRestore(); db.mockRestore(); notify.mockRestore(); }
  },
}, {
  id: 'gate-stall-main-ladder-and-green-recovery', item: 'P-008', route: 'condition',
  rowIds: ['owner-only-alarm|packages/operator-core/lib/harness/routines/release-actions.ts|trackGateStall|2'],
  run: async () => {
    const { vi, expect } = await import('vitest');
    const producer = await import('../harness/routines/release-actions');
    const org = await import('@papercusp/db-org');
    const attention = await import('../attention-notify');
    const severe = await import('../severe-event-broadcast');
    const { releaseCheckpointConfig } = await import('../release-checkpoint-config');
    let gh: Record<string, unknown> = { consecutiveReds: releaseCheckpointConfig().stallReds - 1,
      stallAlerted: false, lastGreenAt: Date.now() };
    const openedKeys: string[] = [], resolvedKeys: string[] = [], open = new Set<string>();
    const sql = Object.assign(async () => [], { unsafe: async (query: string, params: unknown[] = []) => {
      if (query.includes('SELECT') && query.includes('AS gh')) return [{ gh, lf: null, rq: null }];
      if (query.includes('AS headline_health')) return [{ headline_health: gh }];
      if (query.includes('UPDATE harness_shared.routines') && typeof params[1] === 'string') {
        const body = JSON.parse(params[1]) as { gate_health?: Record<string, unknown> };
        if (body.gate_health) gh = body.gate_health;
      }
      return Object.assign([], { count: 1 });
    } });
    const mocks = [
      vi.spyOn(org, 'getOrgPg').mockReturnValue({ sql } as never),
      vi.spyOn(attention, 'notifyAttentionOnce').mockResolvedValue({ recordId: 1, deduped: false } as never),
      vi.spyOn(severe, 'broadcastSevereEvent').mockImplementation(async ({ conditionKey }) => {
        open.add(conditionKey!); openedKeys.push(conditionKey!); return true;
      }),
      vi.spyOn(severe, 'broadcastSevereEventResolved').mockImplementation(async ({ conditionKey }) => {
        if (!open.delete(conditionKey)) return false;
        resolvedKeys.push(conditionKey); return true;
      }),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
    ];
    try {
      const opts = { alarm: { resolve: async () => false } };
      const ctx = { installSlug: 'coverage', workspaceId: 'coverage' };
      await producer.trackGateStall(ctx, 'not-green', undefined, ['coverage.test.ts'], undefined, undefined, undefined, undefined, opts);
      expect(attention.notifyAttentionOnce).toHaveBeenCalledOnce();
      expect(openedKeys).toEqual(['gate-red-streak:coverage']);
      expect(gh.stallAlerted).toBe(true);
      await producer.trackGateStall(ctx, 'advanced', undefined, [], undefined, undefined, undefined, undefined, opts);
      return { route: 'condition', openedKeys, resolvedKeys };
    } finally { mocks.reverse().forEach((mock) => mock.mockRestore()); }
  },
}, {
  id: 'green-stall-verdict-rate-owner-and-measured-recovery', item: 'P-008', route: 'condition',
  rowIds: ['owner-only-alarm|packages/operator-core/lib/release/green-stall-watchdog.ts|checkGreenStall|1'],
  run: async () => {
    const { vi, expect } = await import('vitest');
    const producer = await import('../release/green-stall-watchdog');
    const org = await import('@papercusp/db-org');
    const attention = await import('../attention-notify');
    const severe = await import('../severe-event-broadcast');
    const routing = await import('../harness/routines/hive-release-env');
    const launch = await import('../release-checkpoint-launch');
    const engine = await import('../release/routine-engine-liveness');
    const now = Date.now();
    const row = { install_slug: 'coverage', workspace_id: 'coverage', last_fired_ms: now,
      last_verdict_ms: now - 60_000, gh: { lastGreenAt: now, watchdogAlerted: false,
        consecutiveReds: 1, verdictRateAlarmed: false } };
    let verdictWindow: Array<{ fires: number; verdicts: number; last_verdict_ms: number }> =
      [{ fires: 6, verdicts: 1, last_verdict_ms: now }];
    const openedKeys: string[] = [], resolvedKeys: string[] = [], open = new Set<string>();
    const query = async (text: string) => {
      if (text.includes('SELECT r.install_slug')) return [row];
      if (text.includes('AS fires')) return verdictWindow;
      if (text.includes('UPDATE harness_shared.routines') && text.includes('"verdictRateAlarmed":true')) row.gh.verdictRateAlarmed = true;
      if (text.includes('UPDATE harness_shared.routines') && text.includes('"verdictRateAlarmed":false')) row.gh.verdictRateAlarmed = false;
      if (text.includes('UPDATE harness_shared.routines') && text.includes('"watchdogAlerted":true')) row.gh.watchdogAlerted = true;
      if (text.includes('UPDATE harness_shared.routines') && text.includes('"watchdogAlerted":false')) row.gh.watchdogAlerted = false;
      return Object.assign([], { count: text.includes('UPDATE harness_shared.routines') ||
        (text.includes('UPDATE harness_shared.harness_escalations') && open.has('green-stall:coverage')) ? 1 : 0 });
    };
    const sql = Object.assign((strings: TemplateStringsArray) => query(strings.join('?')), { unsafe: query });
    const mocks = [
      vi.spyOn(org, 'getOrgPg').mockReturnValue({ sql } as never),
      vi.spyOn(attention, 'notifyAttentionOnce').mockResolvedValue({ recordId: 1, deduped: false } as never),
      vi.spyOn(routing, 'resolveCheckpointRouting').mockResolvedValue({ root: '/coverage', extraEnv: {}, clearEnv: [] } as never),
      vi.spyOn(launch, 'isCheckpointRunLockHeldCheap').mockReturnValue({ held: false } as never),
      vi.spyOn(launch, 'readCheckpointRunPhaseCheap').mockReturnValue(null),
      vi.spyOn(engine, 'readRoutineEngineLiveness').mockResolvedValue({ stale: false } as never),
      vi.spyOn(severe, 'broadcastSevereEvent').mockImplementation(async ({ conditionKey }) => {
        open.add(conditionKey!); openedKeys.push(conditionKey!); return true;
      }),
      vi.spyOn(severe, 'broadcastSevereEventResolved').mockImplementation(async ({ conditionKey }) => {
        if (!open.delete(conditionKey)) return false;
        resolvedKeys.push(conditionKey); return true;
      }),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
    ];
    try {
      expect((await producer.checkGreenStall(sql as never)).alarmed).toEqual(['coverage']);
      expect(attention.notifyAttentionOnce).toHaveBeenCalledOnce();
      expect(openedKeys).toEqual(['alarm:release-verdict-rate:coverage']);
      verdictWindow = [];
      await producer.checkGreenStall(sql as never);
      expect(row.gh.verdictRateAlarmed).toBe(true);
      expect(resolvedKeys).toEqual([]);
      verdictWindow = [{ fires: 6, verdicts: 6, last_verdict_ms: now }];
      expect((await producer.checkGreenStall(sql as never)).recovered).toEqual(['coverage']);
      return { route: 'condition', openedKeys, resolvedKeys };
    } finally { mocks.reverse().forEach((mock) => mock.mockRestore()); }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'release-fixer-dispatch-promoted-recovery', item: 'P-008', route: 'condition',
  rowIds: ['owner-only-alarm|packages/operator-core/lib/harness/routines/release-actions.ts|dispatchReleaseFixer|1'],
  run: async () => {
    const { vi, expect } = await import('vitest');
    const producer = await import('../harness/routines/release-actions');
    const org = await import('@papercusp/db-org');
    const scope = await import('../work-scope-policy');
    const blueprint = await import('../blueprint/launch-blueprint');
    const dev = await import('../dev-data');
    const { buildCandidateSnapshot } = await import('../release/candidate-snapshot');
    const candidate = 'a'.repeat(40), failures = ['coverage::red.test.ts'];
    const snapshot = buildCandidateSnapshot({ candidate, failingTests: failures }, Date.now());
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    const alarm = {
      broadcast: async (e: { conditionKey?: string }) => { open.add(e.conditionKey!); openedKeys.push(e.conditionKey!); return true; },
      resolve: async (e: { conditionKey: string }) => { if (!open.delete(e.conditionKey)) return false; resolvedKeys.push(e.conditionKey); return true; },
      notify: async () => {},
    };
    const sql = Object.assign(async () => Object.assign([], { count: 1 }), { unsafe: async (text: string) =>
      text.includes('SELECT') ? [{ lf: null, ftm: 'true', cs: snapshot }]
        : Object.assign([{ written: true }], { count: 1 }) });
    const mocks = [
      vi.spyOn(org, 'getOrgPg').mockReturnValue({ sql } as never),
      vi.spyOn(scope, 'gateWorkScope').mockResolvedValue({ allowed: true } as never),
      vi.spyOn(blueprint, 'fireLaunchBlueprintForEvent').mockResolvedValue(null),
      vi.spyOn(dev, 'testFlakeRollup').mockResolvedValue({ entries: [] } as never),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
    ];
    try {
      const ctx = { installSlug: 'coverage', workspaceId: 'coverage' };
      await producer.dispatchReleaseFixer(ctx, candidate, failures, undefined, undefined,
        { alarm, checkCandidate: async () => ({ candidateExists: true, candidatePromoted: false }) });
      expect(openedKeys).toEqual(['alarm:release-fixer-dispatch:coverage']);
      await producer.dispatchReleaseFixer(ctx, candidate, failures, undefined, undefined,
        { alarm, checkCandidate: async () => ({ candidateExists: false, candidatePromoted: false }) });
      expect(resolvedKeys).toEqual([]);
      await producer.dispatchReleaseFixer(ctx, candidate, failures, undefined, undefined,
        { alarm, checkCandidate: async () => ({ candidateExists: true, candidatePromoted: true }) });
      return { route: 'condition', openedKeys, resolvedKeys };
    } finally { mocks.reverse().forEach((mock) => mock.mockRestore()); }
  },
}, {
  id: 'idle-repair-owner-escalation-readable-recovery', item: 'P-008', route: 'condition',
  rowIds: ['owner-only-alarm|packages/operator-core/lib/release/idle-repair-queue-actuator.ts|escalateOwner|1'],
  run: async () => {
    const { vi, expect } = await import('vitest');
    const producer = await import('../release/idle-repair-queue-actuator');
    const actions = await import('../harness/routines/release-actions');
    const ownership = await import('../coord/gate-ownership');
    const queue = { schemaVersion: 1, phase: 'awaiting-fixer', candidate: 'a'.repeat(40),
      base: 'b'.repeat(40), repairHead: 'c'.repeat(40), affectedTestProofGroup: 'coverage', attempts: 0,
      openedAtMs: 1, updatedAtMs: 1, fixerSpawnId: null, failingTests: ['red.test.ts'], signature: [] } as const;
    let episode: import('../release/idle-repair-queue-actuator').IdleQueueEpisode | null = null;
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    const alarm = {
      broadcast: async (e: { conditionKey?: string }) => { open.add(e.conditionKey!); openedKeys.push(e.conditionKey!); return true; },
      resolve: async (e: { conditionKey: string }) => { if (!open.delete(e.conditionKey)) return false; resolvedKeys.push(e.conditionKey); return true; },
      notify: async () => {},
    };
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      if (text.includes('SELECT workspace_id')) return [{ workspace_id: 'coverage' }];
      if (text.includes('RETURNING escalation')) return [{ escalation: episode }];
      if (text.includes('INSERT INTO harness_shared.harness_escalations')) {
        const encoded = values.find((value) => typeof value === 'string' && value.includes('"rungs"'));
        if (encoded) episode = JSON.parse(String(encoded));
      }
      return Object.assign([], { count: 1 });
    }) as unknown as import('postgres').Sql;
    const read = vi.spyOn(actions, 'readFrozenCandidateRepairQueueState').mockResolvedValue({ status: 'value', queue } as never);
    const mocks = [read, vi.spyOn(actions, 'dispatchReleaseFixer').mockResolvedValue(null),
      vi.spyOn(ownership, 'readGateOwnership').mockResolvedValue(null as never),
      vi.spyOn(console, 'warn').mockImplementation(() => {})];
    try {
      const opts = { installSlug: 'coverage', workspaceId: 'coverage', nowMs: () => 10 * 60 * 60_000, alarm };
      await producer.checkIdleRepairQueue(sql, opts);
      expect(openedKeys).toEqual(['alarm:idle-repair-queue:coverage']);
      const before = structuredClone(episode);
      read.mockResolvedValue({ status: 'unknown', queue: null } as never);
      await producer.checkIdleRepairQueue(sql, opts);
      expect(resolvedKeys).toEqual([]); expect(episode).toEqual(before);
      read.mockResolvedValue({ status: 'absent', queue: null } as never);
      await producer.checkIdleRepairQueue(sql, opts);
      return { route: 'condition', openedKeys, resolvedKeys };
    } finally { mocks.reverse().forEach((mock) => mock.mockRestore()); }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'checkpoint-prebuild-read-failure-and-primary-read', item: 'P-008', route: 'observation', mechanism: 'release-state-read',
  rowIds: ['log-only-fallback|apps/operator/lib/release/green-checkpoint.ts|beginCheckpointPreflight|1'],
  run: async () => {
    const { beginCheckpointPreflight } = await import('../../../../apps/operator/lib/release/green-checkpoint');
    const { releaseConfig } = await import('../../../../apps/operator/lib/release/release-config');
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { vi, expect } = await import('vitest');
    const root = mkdtempSync(join(tmpdir(), 'condition-rail-preflight-'));
    const cfg = { ...releaseConfig(), checkpointLogDir: root };
    const candidate = execFileSync('git', ['-C', cfg.integrationRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const input = 'a'.repeat(64);
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const observeFallback = (_mechanism: string, row: typeof observations[number]) => { observations.push(row); return true; };
    const exec: Parameters<typeof beginCheckpointPreflight>[2] = async (_cmd, args) => ({ code: 0, stderr: '',
      stdout: args.includes('--fingerprint-ref') ? `DEPENDENCY_INPUT_FINGERPRINT schema=1 candidate=${candidate} input=${input}`
        : `DEPENDENCY_GENERATION_RESULT schema=1 identity=coverage token=coverage input=${input} reused=false` });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const base = { target: { workspaceId: 'coverage', installSlug: 'coverage' }, observeFallback, env: {},
        generationPresent: () => true, liveToken: () => 'coverage', log: () => {} };
      const failed = await beginCheckpointPreflight(cfg, candidate, exec, { ...base, awaitState: async () => { throw new Error('state unavailable'); } });
      expect(failed.kind).toBe('ready');
      if (failed.kind === 'ready') { expect(failed.prewarmedDependencyGeneration.reused).toBe(false); failed.lock.release(); }
      const recovered = await beginCheckpointPreflight(cfg, candidate, exec, { ...base, awaitState: async () => ({
        schema: 1, status: 'ready', key: `${candidate}:${input}`, candidate, inputFingerprint: input,
        attemptId: 'coverage', queuedAtMs: 1, startedAtMs: 2, updatedAtMs: 3, completedAtMs: 3,
        producerPid: 4, childPid: 5, identity: 'coverage', token: 'coverage', reused: true,
      }) });
      if (recovered.kind === 'ready') { expect(recovered.prewarmedDependencyGeneration.reused).toBe(true); recovered.lock.release(); }
      expect(observations.map(({ applied, reason }) => [applied, reason])).toEqual([[0, 'prebuild-state-unavailable'], [1, 'applied']]);
      return { route: 'observation', mechanism: 'release-state-read', observations };
    } finally { error.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  },
}, {
  id: 'inconclusive-verdict-partial-delivery-and-complete-pair', item: 'P-008', route: 'observation', mechanism: 'release-verdict-event',
  rowIds: ['log-only-fallback|apps/operator/lib/release/green-checkpoint.ts|emitInconclusiveVerdict|1'],
  run: async () => {
    const { emitInconclusiveVerdict } = await import('../../../../apps/operator/lib/release/green-checkpoint');
    const { vi, expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const observeFallback = (_mechanism: string, row: typeof observations[number]) => { observations.push(row); return true; };
    const result = { advanced: false, candidate: 'deadbeef', from: null, green: null, reason: 'error' } as const;
    const emitted: string[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await emitInconclusiveVerdict(result, 'coverage', { observeFallback, emit: async ({ key }) => {
        emitted.push(key); if (key.endsWith(':coverage')) throw new Error('second event failed');
      } });
      expect(observations.map(({ applied }) => applied)).toEqual([0]);
      await emitInconclusiveVerdict(result, 'coverage', { observeFallback, emit: async ({ key }) => { emitted.push(key); } });
      expect(emitted).toEqual(['green-checkpoint:inconclusive', 'green-checkpoint:inconclusive:coverage',
        'green-checkpoint:inconclusive', 'green-checkpoint:inconclusive:coverage']);
      expect(observations.map(({ applied, reason }) => [applied, reason])).toEqual([[0, 'inconclusive-emit-failed'], [1, 'applied']]);
      return { route: 'observation', mechanism: 'release-verdict-event', observations };
    } finally { error.mockRestore(); }
  },
});

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
  id: 'checkpoint-owner-red-dedup-and-green-recovery', item: 'P-008', route: 'condition',
  rowIds: ['owner-only-alarm|apps/operator/lib/release/green-checkpoint.ts|escalate|1'],
  run: async () => {
    const { realCheckpointDeps } = await import('../../../../apps/operator/lib/release/green-checkpoint');
    const { releaseConfig } = await import('../../../../apps/operator/lib/release/release-config');
    const escalation = await import('../agent-tools/coordination/escalations');
    const attention = await import('../attention-notify');
    const severe = await import('../severe-event-broadcast');
    const alarm = await import('../alarm-attention');
    const { vi, expect } = await import('vitest');
    const openedKeys: string[] = [], resolvedKeys: string[] = [];
    const rows: Awaited<ReturnType<typeof escalation.listEscalations>> = [];
    const mocks = [
      vi.spyOn(escalation, 'listEscalations').mockImplementation(async () => rows),
      vi.spyOn(escalation, 'openEscalation').mockImplementation(async (_identity, input) => {
        rows.push({ ...input, msg_id: 'coverage', source: 'green-checkpoint' } as unknown as typeof rows[number]);
        return undefined as never;
      }),
      vi.spyOn(escalation, 'resolveEscalation').mockImplementation(async () => undefined as never),
      vi.spyOn(attention, 'notifyAttention').mockImplementation(async () => undefined as never),
      vi.spyOn(severe, 'broadcastSevereEvent').mockImplementation(async (e) => { openedKeys.push(e.conditionKey!); return true; }),
      vi.spyOn(alarm, 'resolveAlarm').mockImplementation(async (key) => { resolvedKeys.push(key); return true; }),
    ];
    try {
      const deps = realCheckpointDeps(releaseConfig());
      await deps.escalate?.('red fixture', 'red fixture body');
      await deps.escalate?.('still red fixture', 'red fixture body');
      expect(openedKeys).toHaveLength(2);
      expect(attention.notifyAttention).toHaveBeenCalledTimes(1);
      await deps.clearEscalation?.();
      return { route: 'condition', openedKeys: [...new Set(openedKeys)], resolvedKeys };
    } finally { for (const mock of mocks) mock.mockRestore(); }
  },
}, {
  id: 'checkpoint-self-watchdog-owner-failure-and-measured-verdict-recovery', item: 'P-008', route: 'condition',
  rowIds: ['owner-only-alarm|apps/operator/lib/release/green-checkpoint.ts|onFire|1'],
  run: async () => {
    const { onFire, resolveCheckpointSelfWatchdog } = await import('../../../../apps/operator/lib/release/green-checkpoint');
    const { expect } = await import('vitest');
    const openedKeys: string[] = [], resolvedKeys: string[] = [];
    const deps = { broadcast: async (e: { conditionKey?: string }) => { openedKeys.push(e.conditionKey!); return true; },
      resolve: async (e: { conditionKey: string }) => { resolvedKeys.push(e.conditionKey); return true; },
      notify: async () => { throw new Error('owner delivery unavailable'); } };
    const result = { advanced: false, candidate: 'deadbeef', from: null, green: null, reason: 'error' } as const;
    await onFire(result, 'coverage', deps);
    await resolveCheckpointSelfWatchdog(result, 'coverage', deps);
    await resolveCheckpointSelfWatchdog({ ...result, green: true, reason: 'up-to-date' }, 'coverage', deps);
    expect(resolvedKeys).toEqual([]);
    await resolveCheckpointSelfWatchdog({ ...result, green: false, reason: 'not-green' }, 'coverage', deps);
    return { route: 'condition', openedKeys, resolvedKeys };
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'chronic-release-flake-cooldown-unknown-read-and-quiet-recovery', item: 'P-008', route: 'condition',
  rowIds: ['owner-only-alarm|packages/operator-core/lib/harness/routines/release-actions.ts|trackFlakeHistory|1'],
  run: async () => {
    const { trackFlakeHistory } = await import('../harness/routines/release-actions');
    const { releaseCheckpointConfig } = await import('../release-checkpoint-config');
    const { expect } = await import('vitest');
    const openedKeys: string[] = [], resolvedKeys: string[] = [], notifications: string[] = [];
    let now = 1_000, unavailable = false;
    let history: Record<string, { flakes?: number; lastFlakeAt?: number; notifiedAt?: number }> = {};
    const sql = Object.assign(async () => [], { unsafe: async (text: string, values: unknown[]) => {
      if (unavailable) throw new Error('history unavailable');
      if (text.includes('SELECT')) return [{ fh: structuredClone(history) }];
      history = JSON.parse(String(values[1])).flake_history; return [];
    } }) as unknown as import('postgres').Sql;
    const open = new Set<string>();
    const deps = { sql, nowMs: () => now, alarm: {
      broadcast: async (e: { conditionKey?: string }) => { open.add(e.conditionKey!); openedKeys.push(e.conditionKey!); return true; },
      resolve: async (e: { conditionKey: string }) => {
        if (!open.delete(e.conditionKey)) return false; resolvedKeys.push(e.conditionKey); return true;
      }, notify: async (e: { title: string }) => { notifications.push(e.title); },
    } };
    const ctx = { installSlug: 'coverage', workspaceId: 'coverage' };
    for (let i = 0; i < releaseCheckpointConfig().chronicFlakeCount + 1; i++) {
      await trackFlakeHistory(ctx, undefined, ['workspace::test.ts'], deps);
    }
    expect(notifications).toHaveLength(1);
    expect(openedKeys).toHaveLength(2); // condition refresh survives owner cooldown
    await trackFlakeHistory(ctx, undefined, [], deps);
    expect(resolvedKeys).toEqual([]); // one clean tick does not establish recovery
    now += releaseCheckpointConfig().flakeNotifyCooldownMs;
    unavailable = true;
    await expect(trackFlakeHistory(ctx, undefined, [], deps)).rejects.toThrow('history unavailable');
    expect(resolvedKeys).toEqual([]);
    unavailable = false; await trackFlakeHistory(ctx, undefined, [], deps);
    expect(history['workspace::test.ts'].flakes).toBe(releaseCheckpointConfig().chronicFlakeCount + 1);
    return { route: 'condition', openedKeys: [...new Set(openedKeys)], resolvedKeys };
  },
});

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
      await readCheckpointRunState('misconfigured', 'coverage', { observeFallback,
        route: async () => ({ root: '/coverage', extraEnv: {}, clearEnv: [],
          skip: { reason: 'integration-equals-release', misconfigured: true } }) });
      const deps = { observeFallback, route, readLock: () => ({ held: true, elapsedSec: 1 }), readPhase: () => null };
      await readCheckpointRunState('coverage', 'coverage', deps);
      await readCheckpointRunState('coverage', 'coverage', { ...deps, readLock: () => ({ held: false, elapsedSec: null }) });
      expect(observations.map(({ applied, reason }) => [applied, reason])).toEqual([
        [0, 'run-state-unavailable'], [0, 'routing-misconfigured'], [0, 'phase-unavailable'], [1, 'applied']]);
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
