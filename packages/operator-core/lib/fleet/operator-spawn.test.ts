/**
 * fleet/operator-spawn — unit coverage for the operator→agent nursery spawn
 * engine (Brief 4, agent-briefs-2026-06-05): harness/role/cap validation,
 * durable record/finish bookkeeping, the single-harness default, and the
 * failed-attempt rows that replace the old silent-drop dispatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ownerSteering: { value: null as null | Record<string, unknown> },
}));

vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn(), setAdminPoolStatementTimeoutProvider: vi.fn() }));
vi.mock('@papercusp/agent-mcp', () => ({
  // 'overwatch' included so the B-10 flag-gate (which runs AFTER the known-role
  // check) is reachable in the gate tests below.
  AGENT_ROLES: ['scoper', 'worker', 'validator', 'reviewer', 'operator', 'cup', 'kettle'],
  // operator-spawn now transitively imports ../inference-gateway/stall-waker-loop
  // (gateway-rate-limit-stall-autowake) → ../agent-tools/turn/interrupt, which calls
  // defineTool() at module load. The full agent-mcp module is mocked away here, so this
  // pass-through stub (the repo-standard pattern; cf. events/emit.test.ts) lets the
  // tool module evaluate without pulling in the real tool registry. The test never
  // invokes turn:interrupt — it only needs the import graph to load.
  defineTool: (def: unknown) => def,
}));
// @papercusp/flags itself stays REAL (FLAG_DEFAULTS / FLAGS); only the server-side
// getFlag is mocked so the overwatch gate's flag read is controllable. The default
// impl (set in beforeEach) returns each flag's real default, so the other getFlag
// callers in operator-spawn (WEDGE_AUTO_REAP / SPAWN_HANDOFF_HYDRATION) behave exactly
// as they did under the real getFlag's no-PostHog fallback — behavior-preserving.
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(), onFlagChange: vi.fn() }));
vi.mock('../harness-core', () => ({ resolveProject: vi.fn() }));
// WI-1937: operator-spawn.ts imports isEphemeralForeignProject directly, and
// the module graph ALSO reaches harness-registry.ts transitively (via
// inference-gateway/stall-waker-loop → ... → sync/hyperbee/projections/
// p2p-peer-grants.ts → p2p/revocation-reaper.ts, which imports
// deregisterEphemeralForeignHarness at module scope). Every ephemeral-foreign
// export is stubbed inline (matching real semantics for the pure ones) rather
// than via importOriginal, so this mock doesn't pull in the real
// harness-registry.ts's PG-backed module graph into an otherwise fully
// isolated unit test — and so a FUTURE transitive import of any of these
// doesn't silently reintroduce this same "no export defined on the mock" break.
vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(),
  isEphemeralForeignProject: (p: { ephemeral_foreign?: boolean }) => p.ephemeral_foreign === true,
  ephemeralForeignHarnessSlug: (offerId: string) => `foreign-${offerId}`,
  registerEphemeralForeignHarness: vi.fn(),
  deregisterEphemeralForeignHarness: vi.fn(async () => false),
  sweepOrphanedEphemeralForeignHarnesses: vi.fn(async () => ({ swept: 0, removed: [] })),
}));
vi.mock('../agent-config', () => ({ readAgentConfig: vi.fn(async () => null) }));
vi.mock('../owner-steering', () => ({
  getOwnerSteering: vi.fn(async () => h.ownerSteering.value ?? {
    directive: null,
    eligiblePlans: [],
    eligibleHives: [],
    pauseNewWork: false,
    pausedUntil: null,
    modelTiers: null,
    tierCeilings: null,
    modelOverrides: null,
  }),
  effectiveMaxBees: vi.fn((_steering: unknown, base: number) => base),
}));
vi.mock('../hive/wake', () => ({ resolvePotHomeSlug: vi.fn(() => 'papercusp') }));
vi.mock('../dbos/orchestrator-runner', () => ({ spawnInvokeOnceWithFallback: vi.fn() }));
vi.mock('./spawn-tree', () => ({ recordSpawn: vi.fn(), finishSpawn: vi.fn() }));
vi.mock('../inference-gateway/spawn-env', () => ({ resolveSpawnGatewayEnv: vi.fn(async () => ({})) }));
// Per-hive override resolver (P-012/P-013) is a PG-backed spawn dep like its siblings —
// mock it to a no-op so the unit tests don't touch PG. vi.mock intercepts the dynamic
// import operator-spawn uses, so the BLUEPRINT_LOCAL_ROOT producer is a clean no-op here.
vi.mock('../hive-local-blueprint-resolve', () => ({
  resolveHiveLocalBlueprintRoot: vi.fn(async () => null),
  blueprintLocalRootExtra: (root: string | null) => (root ? `BLUEPRINT_LOCAL_ROOT=${root}` : null),
}));
vi.mock('../rate-limit-config', () => ({
  getCachedRateLimitConfig: () => ({ maxSimultaneousAgents: 16, concurrencyFloor: 1 }),
}));
vi.mock('./spawn-reclaim', () => ({
  heartbeatSpawns: vi.fn(async () => {}),
  reclaimOrphanedSpawns: vi.fn(async () => ({ reclaimed: 0, spawnIds: [], workspaces: [] })),
  recordSpawnPid: vi.fn(async () => {}),
  SPAWN_HEARTBEAT_INTERVAL_MS: 60_000,
  // operator-spawn re-exports this from spawn-reclaim (threshold centralised there);
  // selectWedgeReapCandidates uses it as a default param, so the mock must expose it.
  WEDGE_REAP_SILENT_MS: 30 * 60_000,
}));
// Lazy-imported by the slot-freed announce (D-004) — vi.mock intercepts the
// dynamic import too, so the spy sees every emit.
vi.mock('../events/await/engine', () => ({
  emitAwaitedEvent: vi.fn(async () => ({ ok: true, key: '', woken: 0, notified: [], msgId: null })),
}));

import { getOrgPg } from '@papercusp/db-org';
import { FLAGS, FLAG_DEFAULTS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { resolveProject } from '../harness-core';
import { loadHarnessRegistry } from '../harness-registry';
import { spawnInvokeOnceWithFallback } from '../dbos/orchestrator-runner';
import { resolveSpawnGatewayEnv } from '../inference-gateway/spawn-env';
import { emitAwaitedEvent } from '../events/await/engine';
import { recordSpawn, finishSpawn } from './spawn-tree';
import { reclaimOrphanedSpawns, recordSpawnPid } from './spawn-reclaim';
import {
  spawnAgentInHarness,
  abortLocalSpawn,
  spawnConcurrencyCeiling,
  spawnSlotEventKey,
  findBriefPlaceholder,
  selectWedgeReapCandidates,
  WEDGE_REAP_SILENT_MS,
} from './operator-spawn';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';

// `/tmp` exists on disk, so the project-dir existence check passes without fixtures.
const PROJECT = { slug: 'demo', path: '/tmp', hasState: true, hasSpec: false };

let runningCount = 0;
let dupRows: Array<{ spawn_id: string }> = [];
let errorSpy: ReturnType<typeof vi.spyOn>;
let savedXbenchDirective: string | undefined;
let savedXbenchDirectiveLegacy: string | undefined;
let savedSpawnReadinessShadow: string | undefined;

beforeEach(() => {
  // Hermeticity (EI-1837): the external-bench launcher exports
  // PAPERCUSP_XBENCH_CUP_DIRECTIVE (dual-accept legacy: PAPERCUSP_XBENCH_BEE_DIRECTIVE) on the
  // shared env both the launcher and the :3170 host read; when present, operator-spawn appends
  // it to a `cup` brief (intentional, bench-scoped). These unit tests assert the PRODUCTION
  // contract (the brief passed through verbatim), so neutralize both var names for the suite
  // and restore them after — otherwise the suite reddens whenever it runs under the bench.
  savedXbenchDirective = process.env.PAPERCUSP_XBENCH_CUP_DIRECTIVE;
  savedXbenchDirectiveLegacy = process.env.PAPERCUSP_XBENCH_BEE_DIRECTIVE;
  savedSpawnReadinessShadow = process.env.PAPERCUSP_SPAWN_READINESS_SHADOW;
  delete process.env.PAPERCUSP_XBENCH_CUP_DIRECTIVE;
  delete process.env.PAPERCUSP_XBENCH_BEE_DIRECTIVE;
  // The readiness probe is intentionally shadow-only in production and emits
  // console.warn when the local gateway has no serviceable account. This suite
  // tests spawn semantics, not that inert telemetry, and vitest fails on any
  // unexpected console output; keep the test hermetic while preserving the
  // production default.
  process.env.PAPERCUSP_SPAWN_READINESS_SHADOW = '0';
  runningCount = 0;
  dupRows = [];
  h.ownerSteering.value = null;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  // One template-tag fn answers every query by shape; `begin` (the atomic
  // admission tx, P-017/P-039) hands the same tag back as the tx.
  const tag = vi.fn(async (strings: TemplateStringsArray | string) => {
    const q = Array.isArray(strings) ? strings.join('') : String(strings);
    if (q.includes('SELECT spawn_id')) return dupRows; // idempotency dedupe probe
    if (q.includes('count(*)')) return [{ n: String(runningCount) }];
    return [];
  });
  const sql = Object.assign(tag, {
    begin: async (cb: (tx: unknown) => Promise<unknown>) => cb(tag),
    // recordDecisionDisposition (now reached on the spawn path) does a
    // `tx.unsafe(INSERT ... RETURNING id, [params])`; without it the catch
    // logged "[decision-ledger] disposition insert failed: tx.unsafe is not a
    // function", which vitest-fail-on-console reddened. Complete the fake sql
    // interface — an empty result is fine (the disposition write is
    // fire-and-forget and the tests don't assert on it).
    unsafe: async (_q: string, _params?: unknown[]) => [] as unknown[],
  });
  vi.mocked(getOrgPg).mockReturnValue({ sql } as never);
  vi.mocked(resolveProject).mockResolvedValue(PROJECT as never);
  vi.mocked(loadHarnessRegistry).mockResolvedValue({ projects: [PROJECT] } as never);
  vi.mocked(spawnInvokeOnceWithFallback).mockResolvedValue({ output: 'done!', exitCode: 0, stderr: '' });
  vi.mocked(resolveSpawnGatewayEnv).mockResolvedValue({});
  vi.mocked(recordSpawn).mockResolvedValue(undefined);
  vi.mocked(finishSpawn).mockResolvedValue(undefined);
  // Default getFlag → each flag's real default (no PostHog), matching the prior
  // real-getFlag fallback. Overwatch defaults OFF, so the gate rejects it unless a
  // test overrides this. Other callers (WEDGE_AUTO_REAP/SPAWN_HANDOFF_HYDRATION) keep
  // their default-true behavior.
  vi.mocked(getFlag).mockImplementation(
    async (key: string) => FLAG_DEFAULTS[key as keyof typeof FLAG_DEFAULTS] ?? false,
  );
});
afterEach(() => {
  errorSpy.mockRestore();
  vi.clearAllMocks();
  if (savedXbenchDirective === undefined) delete process.env.PAPERCUSP_XBENCH_CUP_DIRECTIVE;
  else process.env.PAPERCUSP_XBENCH_CUP_DIRECTIVE = savedXbenchDirective;
  if (savedXbenchDirectiveLegacy === undefined) delete process.env.PAPERCUSP_XBENCH_BEE_DIRECTIVE;
  else process.env.PAPERCUSP_XBENCH_BEE_DIRECTIVE = savedXbenchDirectiveLegacy;
  if (savedSpawnReadinessShadow === undefined) delete process.env.PAPERCUSP_SPAWN_READINESS_SHADOW;
  else process.env.PAPERCUSP_SPAWN_READINESS_SHADOW = savedSpawnReadinessShadow;
});

/** Let the fire-and-forget completion chain settle. */
const flush = () => new Promise<void>((r) => setImmediate(r));

describe('spawnAgentInHarness — happy path', () => {
  it('resolves the harness, records the nursery row, launches, and finishes done', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1',
      harness: 'demo',
      role: 'validator',
      featureId: 'F-1',
      parentSpawnId: 'op-turn-1',
    });
    expect(res.ok).toBe(true);
    expect(res.spawnId).toMatch(/^s-\d+-/);
    expect(res.harness).toBe('demo');
    expect(res.projectDir).toBe('/tmp');

    // Durable record BEFORE the child launches, with lineage + ownership.
    expect(recordSpawn).toHaveBeenCalledTimes(1);
    const rec = vi.mocked(recordSpawn).mock.calls[0][1];
    expect(rec).toMatchObject({
      workspaceId: 'ws-1',
      harnessSlug: 'demo',
      childRole: 'validator',
      parentSpawnId: 'op-turn-1',
      parentRole: 'operator',
      featureId: 'F-1',
      status: 'running',
    });
    expect(rec.sessionOwner).toBe(rec.spawnId);

    // The child launches in the harness's REAL project dir with the registry
    // slug pinned in env (schema resolution) + the feature extra.
    expect(spawnInvokeOnceWithFallback).toHaveBeenCalledTimes(1);
    const [dir, role, extras, env] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
    expect(dir).toBe('/tmp');
    expect(role).toBe('validator');
    expect(extras).toContain('FEATURE_ID=F-1');
    expect(env.HARNESS_SLUG).toBe('demo');
    expect(env.PAPERCUSP_WORKSPACE_ID).toBe('ws-1');

    await flush();
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: res.spawnId,
      status: 'done',
      exitCode: 0,
      outputTail: 'done!',
    }));
  });

  it('stamps the supervisor pid before launch so boot reconcile can own the admission-to-child window', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
    expect(res.ok).toBe(true);

    expect(recordSpawnPid).toHaveBeenCalledWith(expect.anything(), res.spawnId, process.pid);
    expect(vi.mocked(recordSpawn).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(recordSpawnPid).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(recordSpawnPid).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(spawnInvokeOnceWithFallback).mock.invocationCallOrder[0],
    );
  });

  it('times out a spawn that never reaches child pid and releases only its reserved work item claim', async () => {
    vi.useFakeTimers();
    vi.stubEnv('PAPERCUSP_SPAWN_CHILD_START_TIMEOUT_MS', '1000');
    let captured: AbortSignal | undefined;
    vi.mocked(spawnInvokeOnceWithFallback).mockImplementation(((
      _d: string,
      _r: string,
      _e: string[],
      _env: Record<string, string>,
      opts?: { signal?: AbortSignal },
    ) => {
      captured = opts?.signal;
      return new Promise(() => {});
    }) as never);
    try {
      const res = await spawnAgentInHarness({
        workspaceId: 'ws-1',
        harness: 'demo',
        role: 'cup',
        featureId: 'WI-1',
      });
      expect(res.ok).toBe(true);

      await vi.advanceTimersByTimeAsync(1000);
      expect(captured?.aborted).toBe(true);
      expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        spawnId: res.spawnId,
        status: 'failed',
        errorMessage: expect.stringContaining('timed out before child process start'),
      }));

      const sqlMock = vi.mocked(getOrgPg)().sql as unknown as ReturnType<typeof vi.fn>;
      const releaseCall = sqlMock.mock.calls.find(
        (c) => Array.isArray(c[0]) && (c[0] as string[]).join('').includes('UPDATE harness_shared.harness_features_consolidated'),
      );
      expect(releaseCall).toBeDefined();
      expect(releaseCall).toContain('demo');
      expect(releaseCall).toContain('WI-1');
      expect(releaseCall).toContain(res.spawnId);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it('a non-zero child exit finishes the row failed with the stderr tail', async () => {
    vi.mocked(spawnInvokeOnceWithFallback).mockResolvedValue({ output: '', exitCode: 1, stderr: 'boom' });
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
    expect(res.ok).toBe(true);
    await flush();
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: res.spawnId,
      status: 'failed',
      exitCode: 1,
      errorMessage: 'boom',
    }));
  });

  it('an exit-0 child with non-empty stderr persists stderr as errorMessage (WI-111 — session-limit diagnostic)', async () => {
    // Root cause of the 3.5-day archaeology: the session-limit message ("You've hit
    // your session limit") reaches the parent as stderr on an exit-0 process. The old
    // path dropped it (`exitCode === 0 ? null`), leaving error_message blank and the
    // cause invisible in fleet:tree / the Brew tab.
    const sessionMsg = "You've hit your session limit · resets 7:30pm (America/New_York)";
    vi.mocked(spawnInvokeOnceWithFallback).mockResolvedValue({ output: '', exitCode: 0, stderr: sessionMsg });
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
    expect(res.ok).toBe(true);
    await flush();
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: res.spawnId,
      status: 'done',
      exitCode: 0,
      errorMessage: sessionMsg,
    }));
  });
});

describe('spawnAgentInHarness — overwatch flag gate (overwatch-role-2026-06-15 B-10 / D-009)', () => {
  it('rejects role="kettle" when papercusp-overwatch is OFF — registered but not activatable', async () => {
    // OVERWATCH graduated to default-ON (flip-dark-flags-default-on-2026-06-23); getFlag is mocked
    // here, so this off-path test forces the flag OFF via the mock (mirrors the flag-ON sibling
    // below) instead of relying on FLAG_DEFAULTS. The gate is unchanged: OFF ⇒ not activatable.
    vi.mocked(getFlag).mockImplementation(async (key: string) =>
      key === FLAGS.OVERWATCH ? false : (FLAG_DEFAULTS[key as keyof typeof FLAG_DEFAULTS] ?? false),
    );
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'kettle' });
    expect(res.ok).toBe(false);
    // the flag-gate rejection, not the unknown-role rejection (overwatch IS registered)
    expect(res.error).toContain('papercusp-overwatch');
    expect(res.error).not.toContain('unknown role');
    // gated BEFORE any child process launches
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
  });

  it('lets role="kettle" past the gate when the flag is ON', async () => {
    vi.mocked(getFlag).mockImplementation(async (key: string) =>
      key === FLAGS.OVERWATCH ? true : (FLAG_DEFAULTS[key as keyof typeof FLAG_DEFAULTS] ?? false),
    );
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'kettle' });
    await flush();
    // the gate passed → the spawn proceeds (happy-path mocks launch + finish it)
    expect(res.ok).toBe(true);
    expect(res.error).toBeFalsy(); // no rejection (success returns error: null)
    expect(spawnInvokeOnceWithFallback).toHaveBeenCalled();
  });
});

describe('spawnAgentInHarness — coding-factory role needs a pushed FEATURE_ID (coding-hive-bee-vs-coding-factory-scoper-2026-06-23)', () => {
  it('rejects a coding-FACTORY pipeline role with NO pushed-feature context, pointing at role="cup"', async () => {
    // A scoper spawned with no featureId / FEATURE_ID= extra / chunkId is the
    // observed mistake (testing the coding-hive handoff by spawning a scoper +
    // setting claim-specs on it — inert). The guard refuses + names the bee unit.
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'scoper' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('coding-FACTORY');
    expect(res.error).toContain('role="cup"');
    expect(res.error).not.toContain('unknown role');
    // refused BEFORE any child process launches
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
  });

  it('allows a coding-FACTORY pipeline role WHEN a FEATURE_ID is pushed (the legit factory path)', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1',
      harness: 'demo',
      role: 'scoper',
      featureId: 'F-123',
    });
    await flush();
    // the guard passed → the spawn proceeds (happy-path mocks launch + finish it)
    expect(res.ok).toBe(true);
    expect(res.error).toBeFalsy();
    expect(spawnInvokeOnceWithFallback).toHaveBeenCalled();
  });

  it('also accepts a FEATURE_ID= extra as pushed-feature context (the spine pushes it via extras)', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1',
      harness: 'demo',
      role: 'scoper',
      extras: ['FEATURE_ID=F-456'],
    });
    await flush();
    expect(res.ok).toBe(true);
    expect(res.error).toBeFalsy();
    expect(spawnInvokeOnceWithFallback).toHaveBeenCalled();
  });

  it('a bee with no feature context is unaffected by the factory guard (the self-pulling unit)', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
    await flush();
    expect(res.ok).toBe(true);
    expect(res.error).toBeFalsy();
    expect(spawnInvokeOnceWithFallback).toHaveBeenCalled();
  });
});

describe('spawnAgentInHarness — forced session id for claude bees (P-016 / D-007)', () => {
  const findUpdate = () => {
    const sqlMock = vi.mocked(getOrgPg)().sql as unknown as ReturnType<typeof vi.fn>;
    return sqlMock.mock.calls.find(
      (c) => Array.isArray(c[0]) && (c[0] as string[]).join('').includes('UPDATE harness_shared.spawned_agents'),
    );
  };

  it('mints + records a session_id and threads forceSessionId for a claude backend', async () => {
    vi.stubEnv('AGENT_CMD', 'claude -p');
    try {
      const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
      expect(res.ok).toBe(true);

      // forceSessionId (a uuid) is threaded to the launcher so buildInvokeOnce bakes --session-id.
      const opts = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0][4] as { forceSessionId?: string } | undefined;
      expect(opts?.forceSessionId).toMatch(/[0-9a-f-]{36}/);

      // ...and recorded on the nursery row via the best-effort UPDATE — same id.
      const updateCall = findUpdate();
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toBe(opts?.forceSessionId);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('mints NO session id for the omp backend (omp resumes by thread id)', async () => {
    // Force the omp backend explicitly — resolveSpawnBackendModel reads the AMBIENT
    // AGENT_CMD, which on any real agent box is `claude …` (the box runs claude bees),
    // so relying on the unset-env default would mint a uuid and fail in the gate.
    vi.stubEnv('AGENT_CMD', 'omp -p');
    try {
      const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
      expect(res.ok).toBe(true);
      const opts = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0][4] as { forceSessionId?: string } | undefined;
      expect(opts?.forceSessionId).toBeUndefined();
      expect(findUpdate()).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('mints NO session id for the codex backend (codex resumes by CODEX_HOME rollout)', async () => {
    vi.stubEnv('AGENT_CMD', 'codex exec');
    try {
      const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
      expect(res.ok).toBe(true);
      const opts = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0][4] as { forceSessionId?: string } | undefined;
      expect(opts?.forceSessionId).toBeUndefined();
      expect(findUpdate()).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('spawnAgentInHarness — backend-aware gateway account routing', () => {
  it('applies owner steering to an unpinned cup spawn instead of falling back to the host Claude command', async () => {
    vi.stubEnv('AGENT_CMD', 'claude -p');
    h.ownerSteering.value = {
      modelTiers: [
        { name: 'quick', spec: 'chatgpt:5.5', backend: 'codex' },
        { name: 'standard', spec: 'chatgpt:5.5', backend: 'codex' },
      ],
      tierCeilings: { cup: 'quick' },
      modelOverrides: null,
    };
    try {
      const res = await spawnAgentInHarness({
        workspaceId: 'ws-1',
        harness: 'demo',
        role: 'cup',
      });
      expect(res.ok).toBe(true);
      const [, , , env, opts] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
      expect(env.PAPERCUSP_SPAWN_MODEL).toBe('chatgpt:5.5');
      expect(env.PAPERCUSP_SPAWN_BACKEND).toBe('codex');
      expect((opts as { forceSessionId?: string } | undefined)?.forceSessionId).toBeUndefined();
      expect(resolveSpawnGatewayEnv).toHaveBeenCalledWith(expect.objectContaining({
        backend: 'codex',
        role: 'cup',
        ownerId: res.spawnId,
      }));
      expect(recordSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        modelSpec: 'chatgpt:5.5',
        modelTier: 'quick',
      }));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('forces Codex backend for a chatgpt:* per-spawn model even when the host command is Claude', async () => {
    vi.stubEnv('AGENT_CMD', 'claude -p');
    try {
      const res = await spawnAgentInHarness({
        workspaceId: 'ws-1',
        harness: 'demo',
        role: 'cup',
        modelSpec: 'chatgpt:5.5',
      });
      expect(res.ok).toBe(true);
      const [, , , env, opts] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
      expect(env.PAPERCUSP_SPAWN_MODEL).toBe('chatgpt:5.5');
      expect(env.PAPERCUSP_SPAWN_BACKEND).toBe('codex');
      expect((opts as { forceSessionId?: string } | undefined)?.forceSessionId).toBeUndefined();
      expect(resolveSpawnGatewayEnv).toHaveBeenCalledWith(expect.objectContaining({
        backend: 'codex',
        ownerId: res.spawnId,
      }));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('passes the resolved Codex backend to the shared gateway env helper and carries only the returned Codex account id', async () => {
    vi.stubEnv('AGENT_CMD', 'codex exec');
    vi.mocked(resolveSpawnGatewayEnv).mockResolvedValue({ PAPERCUSP_ACCOUNT_ID: 'codex-main' });
    try {
      const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
      expect(res.ok).toBe(true);

      expect(resolveSpawnGatewayEnv).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: 'ws-1',
        slug: 'demo',
        ownerId: res.spawnId,
        backend: 'codex',
      }));
      const [, , , env] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
      expect(env.PAPERCUSP_ACCOUNT_ID).toBe('codex-main');
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('abortLocalSpawn — fleet:cancel actually stops the child (EI-40)', () => {
  it('passes an AbortSignal to spawnInvokeOnceWithFallback and abortLocalSpawn fires it', async () => {
    // Hold the child open so the spawn stays "live" (registered in the abort map)
    // until we abort it. Capture the signal handed to spawnInvokeOnceWithFallback.
    let captured: AbortSignal | undefined;
    let resolveChild: (v: { output: string; exitCode: number; stderr: string }) => void;
    vi.mocked(spawnInvokeOnceWithFallback).mockImplementation(((
      _d: string, _r: string, _e: string[], _env: Record<string, string>, opts?: { signal?: AbortSignal },
    ) => {
      captured = opts?.signal;
      return new Promise((res) => { resolveChild = res; });
    }) as never);

    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
    expect(res.ok).toBe(true);
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured!.aborted).toBe(false);

    // The live spawn is locally tracked → abortLocalSpawn finds + signals it.
    expect(abortLocalSpawn(res.spawnId!)).toBe(true);
    expect(captured!.aborted).toBe(true);

    // Let the (now-aborted) child settle so the finally-cleanup runs.
    resolveChild!({ output: '', exitCode: 1, stderr: 'aborted (fleet:cancel)' });
    await flush();

    // The completion records 'cancelled' (abort was the cause), and the handle is
    // removed from the registry → a second abort is a no-op.
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: res.spawnId, status: 'cancelled',
    }));
    expect(abortLocalSpawn(res.spawnId!)).toBe(false);
  });

  it('abortLocalSpawn returns false for an unknown / already-finished spawn', async () => {
    expect(abortLocalSpawn('s-nonexistent')).toBe(false);
    // A spawn that finished normally is de-registered → not abortable.
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
    await flush();
    expect(abortLocalSpawn(res.spawnId!)).toBe(false);
  });

  it('de-registers the local spawn handle even when the durable finishSpawn write throws (EI-7235)', async () => {
    // Regression: a rejected finishSpawn (transient DB error) used to leave
    // this spawn's entry in localSpawnAborts/localSpawnOutput forever, because
    // the cleanup ran AFTER the (now-throwing) await and terminalRecorded's
    // early-return guard silently no-oped every later retry. Since the
    // heartbeat loop re-heartbeats every id still in the map with no per-id
    // liveness check, the row's heartbeat_at would stay "falsely fresh"
    // forever — invisible to reclaimOrphanedSpawns's stale-heartbeat query.
    // The fix clears local bookkeeping in a `finally`, independent of whether
    // the durable write succeeded — asserted here via abortLocalSpawn flipping
    // to false (the existing de-registration proxy) despite the rejection.
    vi.mocked(finishSpawn).mockRejectedValueOnce(new Error('ECONNRESET: pg pool exhausted'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
    await flush();

    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: res.spawnId, status: 'done',
    }));
    // Cleared despite the throw — no lingering entry to keep heartbeating.
    expect(abortLocalSpawn(res.spawnId!)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('completeSpawn durable-write failed'),
      expect.anything(),
    );
  });
});

describe('spawnAgentInHarness — harness resolution', () => {
  it('defaults to the single registered harness when none is named', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', role: 'cup' });
    expect(res.ok).toBe(true);
    expect(res.harness).toBe('demo');
  });

  it('rejects when no harness is named and several are registered', async () => {
    vi.mocked(loadHarnessRegistry).mockResolvedValue({
      projects: [PROJECT, { ...PROJECT, slug: 'other' }],
    } as never);
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', role: 'cup' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('2 are registered');
    expect(res.error).toContain('demo');
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
  });

  it('rejects an unregistered harness, naming the registered ones, and records the failed attempt', async () => {
    vi.mocked(resolveProject).mockResolvedValue(null as never);
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'nope', role: 'cup' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('"nope" is not a registered project');
    expect(res.error).toContain('demo');
    // The rejection is DURABLE — a failed nursery row, not a dropped warn.
    expect(recordSpawn).toHaveBeenCalledTimes(1);
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: 'failed',
      errorMessage: expect.stringContaining('nope'),
    }));
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
  });
});

describe('spawnAgentInHarness — SU MCP slug remap (EI-429)', () => {
  // The Queen sometimes passes its SU MCP server slug ("<project>-su", or the
  // legacy "papercusp-su") as a spawn target instead of the registered project,
  // so every such spawn was rejected — burning Queen turns (a whole turn fired 5
  // bad-slug spawns). The central chokepoint deterministically remaps a KNOWN -su
  // MCP slug to its project (strip the "-su" suffix; alias the legacy
  // "papercusp-su" → the dogfood project "papercup") — never a silent normalize of
  // an arbitrary wrong slug — so the spawn proceeds against the real project.
  const PAPERCUP = { slug: 'papercup', path: '/tmp', hasState: true, hasSpec: false };
  // null for the -su MCP slug, the real project for the stripped base.
  const onlyResolves = (base: string) =>
    vi.mocked(resolveProject).mockImplementation(
      (async (s: string) => (s === base ? PAPERCUP : null)) as never,
    );

  it('remaps the "<project>-su" MCP slug to its project and spawns against it', async () => {
    onlyResolves('papercup');
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'papercup-su', role: 'cup' });
    expect(res.ok).toBe(true);
    // the nursery row + child env carry the REMAPPED project slug, not the -su MCP slug
    expect(res.harness).toBe('papercup');
    expect(vi.mocked(recordSpawn).mock.calls[0][1]).toMatchObject({ harnessSlug: 'papercup' });
    const [dir, , , env] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
    expect(dir).toBe('/tmp');
    expect(env.HARNESS_SLUG).toBe('papercup');
  });

  it('aliases the legacy "papercusp-su" slug to the operator-home project', async () => {
    // The legacy "papercusp-su" MCP slug remaps to the operator-home project —
    // operatorHomeHarnessSlug() (PAPERCUSP_POT_HOME_SLUG, else the migrated
    // legacy default, post papercup→papercusp migration). Derive `home` from the
    // SAME source of truth the production remap uses, so this stays hermetic under
    // the gate's PAPERCUSP_*-stripped env (and under any host-configured pointer).
    const home = operatorHomeHarnessSlug();
    const HOME_PROJECT = { slug: home, path: '/tmp', hasState: true, hasSpec: false };
    vi.mocked(resolveProject).mockImplementation(
      (async (s: string) => (s === home ? HOME_PROJECT : null)) as never,
    );
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'papercusp-su', role: 'cup' });
    expect(res.ok).toBe(true);
    expect(res.harness).toBe(home);
  });

  it('does NOT silently normalize an arbitrary wrong slug — a non -su typo still rejects', async () => {
    vi.mocked(resolveProject).mockResolvedValue(null as never);
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'paprcup', role: 'cup' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('"paprcup" is not a registered project');
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
  });

  it('rejects a "<base>-su" slug whose stripped base is also unregistered (remap only when the project exists)', async () => {
    // foo-su strips to foo, which is not a project → no remap, normal rejection.
    vi.mocked(resolveProject).mockResolvedValue(null as never);
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'foo-su', role: 'cup' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('"foo-su" is not a registered project');
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
  });
});

describe('spawnAgentInHarness — role + cap validation', () => {
  it('rejects an unknown role before touching the registry', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'wizard' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('unknown role "wizard"');
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
  });

  it('accepts a plugin-namespaced role (contains a colon)', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'myplugin:gardener' });
    expect(res.ok).toBe(true);
  });

  it('rejects worker without a chunk', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'worker' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('requires a chunk');
  });

  it('accepts worker with a chunk and passes CHUNK_ID through', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: 'worker', chunkId: 'F-1.c2',
    });
    expect(res.ok).toBe(true);
    const [, , extras] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
    expect(extras).toContain('CHUNK_ID=F-1.c2');
  });

  it('accepts the generic `cup` role WITHOUT a chunk (no pipeline guard — local-hive P-011)', async () => {
    // The flip-to-real-path criterion: cup:spawn { role:'cup' } must pass
    // admission with no chunkId (unlike `worker`, which is chunk-coupled).
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
    expect(res.ok).toBe(true);
    expect(res.error).toBeNull();
    const [, role] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
    expect(role).toBe('cup');
  });

  it('threads the Queen brief into the child env as MUG_BRIEF (P-060 — the real delivery channel, not `extras`)', async () => {
    // P-060: the brief reaches the bee via extraEnv.MUG_BRIEF (which buildInvokeOnce
    // sets on the child env, and invoke-once's buildPrompt renders as `## Queen brief`),
    // NOT as a generic `extras` positional. Assert the real channel.
    const brief = 'watch for the migration race; this connects to bee-2; priority: unblock CI';
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: 'cup', brief,
    });
    expect(res.ok).toBe(true);
    const [, , , env] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
    expect(env.MUG_BRIEF).toBe(brief);
  });

  it('threads the operator `s-…` spawnId into the child env as PAPERCUSP_SPAWN_ID (THE UMBILICAL — bee coord identity)', async () => {
    // The voice-gap fix: the durable s-… spawnId is the child's stable coord owner.
    // It rides extraEnv.PAPERCUSP_SPAWN_ID so invoke()/spawn-mcp bakes it as the signed
    // MCP URL's client= param → resolveAgentIdentity attributes the bee's coord writes
    // to it instead of throwing "no attributable identity".
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
    expect(res.ok).toBe(true);
    const [, , , env] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
    expect(env.PAPERCUSP_SPAWN_ID).toBe(res.spawnId);
    expect(env.PAPERCUSP_SPAWN_ID).toMatch(/^s-\d+-/);
  });

  it('rejects when the workspace is at the running-spawn ceiling', async () => {
    const ceiling = spawnConcurrencyCeiling();
    runningCount = ceiling;
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain(`ceiling ${ceiling}`);
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
  });
});

/**
 * BENCH-SCOPED, FAIL-CLOSED OPUS PIN (P-033 Fix 2). Only a bench bee (the bench flag
 * PAPERCUSP_XBENCH_CUP_DIRECTIVE set) gets pinned to opus PER-SPAWN via
 * extraEnv.PAPERCUSP_SPAWN_MODEL — so the opus requirement is bench-scoped (a normal
 * hive bee keeps its committed haiku floor; no GLOBAL AGENT_MODELS opus needed). The
 * pin is the highest-precedence model channel buildInvokeOnce reads, so a paused opus
 * bucket WAITS (fail-closed) and the floor-clamp never downgrades below it.
 */
describe('spawnAgentInHarness — bench-scoped opus pin (P-033 Fix 2)', () => {
  const KEY = 'PAPERCUSP_XBENCH_CUP_DIRECTIVE';
  const MODEL = 'PAPERCUSP_XBENCH_MODEL';
  let savedKey: string | undefined;
  let savedModel: string | undefined;
  beforeEach(() => {
    savedKey = process.env[KEY];
    savedModel = process.env[MODEL];
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env[KEY]; else process.env[KEY] = savedKey;
    if (savedModel === undefined) delete process.env[MODEL]; else process.env[MODEL] = savedModel;
  });

  it('pins a BENCH bee to opus:xhigh via PAPERCUSP_SPAWN_MODEL when the bench flag is set', async () => {
    process.env[KEY] = 'claim + implement your lone bench feature';
    delete process.env[MODEL]; // default → opus:xhigh
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
    expect(res.ok).toBe(true);
    const [, , , env] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
    expect(env.PAPERCUSP_SPAWN_MODEL).toBe('opus:xhigh');
  });

  it('honors the PAPERCUSP_XBENCH_MODEL knob', async () => {
    process.env[KEY] = 'claim + implement your lone bench feature';
    process.env[MODEL] = 'opus:high';
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
    expect(res.ok).toBe(true);
    const [, , , env] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
    expect(env.PAPERCUSP_SPAWN_MODEL).toBe('opus:high');
  });

  it('does NOT pin a bee to opus when the bench flag is unset (normal hive keeps its floor)', async () => {
    delete process.env[KEY];
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
    expect(res.ok).toBe(true);
    const [, , , env] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
    expect(env.PAPERCUSP_SPAWN_MODEL).toBeUndefined();
  });

  it('does NOT pin a non-bee role even under the bench flag (only bench bees are pinned)', async () => {
    process.env[KEY] = 'claim + implement your lone bench feature';
    // A genuine non-bee role (scoper) — carries a featureId so it clears the
    // coding-factory pushed-feature guard while staying a factory pipeline role.
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'scoper', featureId: 'F-1' });
    expect(res.ok).toBe(true);
    const [, , , env] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
    expect(env.PAPERCUSP_SPAWN_MODEL).toBeUndefined();
  });
});

describe('un-substituted brief placeholder guard (EI-249 — dispatch-pack stampede)', () => {
  describe('findBriefPlaceholder (pure)', () => {
    it('flags the repo `{item}` template token and the historical `brief-NN` placeholder', () => {
      expect(findBriefPlaceholder('Universal schema {item}: single handler')).toBe('{item}');
      expect(findBriefPlaceholder('You are brief-NN — read brief-NN-*.md and execute it')).toBe('brief-NN');
      expect(findBriefPlaceholder('You are Brief-NN')).toBe('Brief-NN'); // case-insensitive
    });

    it('passes a fully-substituted brief, an empty/absent brief, and incidental text', () => {
      expect(findBriefPlaceholder('Universal schema reviews: single handler')).toBeNull();
      expect(findBriefPlaceholder('watch for the migration race; priority: unblock CI')).toBeNull();
      expect(findBriefPlaceholder('')).toBeNull();
      expect(findBriefPlaceholder(null)).toBeNull();
      expect(findBriefPlaceholder(undefined)).toBeNull();
      // tight by design — no false positive on words merely containing the marker letters
      expect(findBriefPlaceholder('debrief the inn-keeper about ANN')).toBeNull();
    });
  });

  it('REFUSES to spawn when the brief still holds a placeholder — durable, no child launched', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: 'cup',
      brief: 'You are brief-NN — read brief-NN-*.md and execute it',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('un-substituted placeholder "brief-NN"');
    expect(res.error).toContain('EI-249');
    // refused BEFORE any child process launches — no claim-race stampede
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
    // the rejection is DURABLE (a failed nursery row), not a silent drop
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: 'failed',
      errorMessage: expect.stringContaining('un-substituted placeholder'),
    }));
  });

  it('also refuses the `{item}` template token (a caller that bypassed buildWaveFeatures)', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: 'cup', brief: 'Implement the {item} handler',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('un-substituted placeholder "{item}"');
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
  });

  it('a fully-substituted brief spawns normally — the guard never false-positives', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: 'cup', brief: 'Implement the reviews handler',
    });
    expect(res.ok).toBe(true);
    const [, , , env] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
    expect(env.MUG_BRIEF).toBe('Implement the reviews handler');
  });
});

describe('spawnAgentInHarness — idempotency dedupe (P-017 / EI-73)', () => {
  it('a retry with a matched idempotencyKey returns the ORIGINAL spawn, launching nothing', async () => {
    dupRows = [{ spawn_id: 's-original-123' }];
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: 'cup', idempotencyKey: 'retry-key-1',
    });
    expect(res.ok).toBe(true);
    expect(res.spawnId).toBe('s-original-123');
    expect(res.deduped).toBe(true);
    expect(recordSpawn).not.toHaveBeenCalled();
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
  });

  it('an unmatched idempotencyKey spawns normally and stamps the key on the row', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: 'cup', idempotencyKey: 'fresh-key',
    });
    expect(res.ok).toBe(true);
    expect(res.deduped).toBeUndefined();
    expect(recordSpawn).toHaveBeenCalledTimes(1);
    const sqlMock = vi.mocked(getOrgPg)().sql as unknown as ReturnType<typeof vi.fn>;
    const stamp = sqlMock.mock.calls.find(
      (c) => Array.isArray(c[0]) && (c[0] as string[]).join('').includes('SET idempotency_key'),
    );
    expect(stamp).toBeDefined();
    expect(stamp![1]).toBe('fresh-key');
  });

  it('a spawn without a key never touches the dedupe probe', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
    expect(res.ok).toBe(true);
    const sqlMock = vi.mocked(getOrgPg)().sql as unknown as ReturnType<typeof vi.fn>;
    const probe = sqlMock.mock.calls.find(
      (c) => Array.isArray(c[0]) && (c[0] as string[]).join('').includes('SELECT spawn_id'),
    );
    expect(probe).toBeUndefined();
  });
});

describe('over-ceiling slot-wait — queue + await, never a silent drop (D-004)', () => {
  it('an over-ceiling rejection carries the wake key + the events:await instruction', async () => {
    runningCount = spawnConcurrencyCeiling();
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
    expect(res.ok).toBe(false);
    // The caller sleeps on this exact key and retries on wake — no drop, no busy-wait.
    expect(res.awaitEvent).toBe(spawnSlotEventKey('ws-1'));
    expect(res.error).toContain(`events:await { event: "${spawnSlotEventKey('ws-1')}" }`);
  });

  it('a finished spawn announces the freed slot on the workspace slot key', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
    expect(res.ok).toBe(true);
    await flush();
    await flush(); // the announce is a void-chained promise off the finally
    expect(emitAwaitedEvent).toHaveBeenCalledWith(expect.objectContaining({
      key: spawnSlotEventKey('ws-1'),
      workspaceId: 'ws-1',
    }));
  });

  it('a reclaim that freed slots announces per freed workspace before the cap check', async () => {
    vi.mocked(reclaimOrphanedSpawns).mockResolvedValue({
      reclaimed: 2, spawnIds: ['s-a', 's-b'], workspaces: ['ws-1', 'ws-2'],
    });
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
    expect(res.ok).toBe(true);
    await flush();
    const keys = vi.mocked(emitAwaitedEvent).mock.calls.map((c) => c[0].key);
    expect(keys).toContain(spawnSlotEventKey('ws-1'));
    expect(keys).toContain(spawnSlotEventKey('ws-2'));
  });

  it('a successful under-ceiling spawn result carries NO awaitEvent', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
    expect(res.ok).toBe(true);
    expect(res.awaitEvent ?? null).toBeNull();
  });
});

/**
 * Gap 13 — selectWedgeReapCandidates (operator-spawn.ts:190-202): the PURE candidate
 * filter for the wedge reaper. A local spawn is a candidate iff it is TRACKED (this
 * host holds its abort handle), NOT already mid-reap (inFlight), has OBSERVED output
 * (at > 0 — absence of signal is never a wedge), and has been stream-silent past the
 * threshold (now - at > silentMs). The four exclusion arms each get a row.
 */
describe('selectWedgeReapCandidates — pure wedge-reaper filter (Gap 13 / P-010)', () => {
  const NOW = 10_000_000_000; // fixed clock
  const silentMs = 30 * 60_000; // 30 min
  const tracked = (...ids: string[]) => new Set(ids);

  it('returns ONLY the silent-old tracked spawn, excluding in-flight / never-output / recent', () => {
    const output = new Map<string, { at: number }>([
      ['silent-old', { at: NOW - silentMs - 1 }],   // tracked, silent past threshold → REAPED
      ['silent-in-flight', { at: NOW - silentMs - 1 }], // silent-old BUT already mid-reap → excluded
      ['never-output', { at: 0 }],                   // at:0 (no observed output) → excluded
      ['recent', { at: NOW - 60_000 }],              // moved 1 min ago, not silent → excluded
    ]);
    const out = selectWedgeReapCandidates(
      output,
      tracked('silent-old', 'silent-in-flight', 'never-output', 'recent'),
      new Set(['silent-in-flight']), // inFlight
      NOW,
      silentMs,
    );
    expect(out).toEqual(['silent-old']);
  });

  it('excludes a spawn this host does NOT track even when its stream is silent-old', () => {
    const output = new Map<string, { at: number }>([['foreign', { at: NOW - silentMs - 1 }]]);
    // tracked set is empty → the host holds no abort handle → not its verdict to make.
    expect(selectWedgeReapCandidates(output, new Set(), new Set(), NOW, silentMs)).toEqual([]);
  });

  it('boundary: exactly-at-threshold is NOT silent enough (strict >), one ms past IS', () => {
    const atThreshold = new Map<string, { at: number }>([['x', { at: NOW - silentMs }]]);
    expect(selectWedgeReapCandidates(atThreshold, tracked('x'), new Set(), NOW, silentMs)).toEqual([]);
    const pastThreshold = new Map<string, { at: number }>([['x', { at: NOW - silentMs - 1 }]]);
    expect(selectWedgeReapCandidates(pastThreshold, tracked('x'), new Set(), NOW, silentMs)).toEqual(['x']);
  });

  it('defaults silentMs to WEDGE_REAP_SILENT_MS when omitted', () => {
    const output = new Map<string, { at: number }>([
      ['old', { at: NOW - WEDGE_REAP_SILENT_MS - 1 }],
      ['fresh', { at: NOW - WEDGE_REAP_SILENT_MS + 60_000 }],
    ]);
    expect(selectWedgeReapCandidates(output, tracked('old', 'fresh'), new Set(), NOW)).toEqual(['old']);
  });
});
