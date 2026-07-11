/**
 * Orchestration behavior of the `system:git-sync` routine action
 * (app-wide-test-coverage-2026-06-05 P-007). The pure pipeline (run-git-sync)
 * and the escalation decision core (git-sync-escalation) have their own suites;
 * THIS suite pins the live wiring around them:
 *
 *   - P-009/P-006 lock discipline (git-sync-any-hive: PER-SLUG resources): the
 *     tick acquires `git-sync:<slug>` (auto-registered in the same txn) plus the
 *     routine's `trigger_config.extra_lock_resources` (papercup: the legacy
 *     `git-sync` + `libs-papercusp-submodule` back-off names). Peer-held lock →
 *     skip the tick (back-pressure, partial acquisitions released); an UNKNOWN
 *     extra name → skip with a loud log (never auto-registered); lock INFRA
 *     error → proceed UNLOCKED (fail-open); locks released after the run —
 *     success, error, and throw.
 *   - P-008 runtime gate (action half): unregistered slug / hive home /
 *     remote-hive view / non-local deployment / vanished or non-git checkout →
 *     no-op with `last_status: 'skipped'` metadata, no locks, no escalation.
 *   - Outcome recording: `{ last_status, last_synced_at, head_sha, … }` patched
 *     onto the routine metadata; a `git_sync` pipeline event logged every tick.
 *   - P-010/P-012 conflict path: `git-sync-conflict` escalation upsert (at the
 *     constant phase 'git-sync' — P-007) + the merge-resolver dispatch via the
 *     launch blueprint (kickoff branch derived from cfg.branch ?? 'main', not a
 *     hardcoded 'staging'), deduped on the `last_resolver` IN-FLIGHT marker (NOT
 *     on the open escalation — a settled or stale dispatch re-dispatches); a
 *     clean pass clears the escalation.
 *   - EI-18 error path: repeated push failures write the `git-sync-error`
 *     escalation (non-clobber upsert) + a one-shot coord broadcast, and never
 *     dispatch a resolver.
 *
 * All seams are mocked (run-git-sync, su-lock-store, in-workspace-txn,
 * harness-registry, loopback-fetch, launch-blueprint, coordination/messages,
 * pipeline-events, db-org, docs/sweep-after-sync) — no PG, no network, no
 * subprocess (the eligibility gate's disk checks hit real mkdtemp dirs). The
 * action module is side-effect imported so the system-action registry is
 * populated as in production (same pattern as routines/release-actions.test.ts).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { GitSyncOutcome } from './run-git-sync';

// --- mocks (factories only close over these; nothing dereferenced at hoist time) --
const tryAcquireResourceMock = vi.fn(async (_tx: unknown, _opts: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> => ({ ok: true }));
const tryReleaseResourceMock = vi.fn(async (_tx: unknown, _opts: Record<string, unknown>): Promise<{ ok: boolean }> => ({ ok: true }));
vi.mock('../../agent-tools/locks/su-lock-store', () => ({
  tryAcquireResource: (...a: unknown[]) => tryAcquireResourceMock(a[0], a[1] as Record<string, unknown>),
  tryReleaseResource: (...a: unknown[]) => tryReleaseResourceMock(a[0], a[1] as Record<string, unknown>),
}));

// inWorkspaceTxn hands the callback a CALLABLE tagged-template fake tx — the lock
// store is mocked anyway, but the P-006 auto-register INSERT runs through the tx
// itself, so record those queries.
const txQueries: Array<{ text: string; values: unknown[] }> = [];
const fakeTx = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
  txQueries.push({ text: strings.join('?'), values });
  return Promise.resolve([]);
};
vi.mock('../../agent-tools/locks/in-workspace-txn', () => ({
  inWorkspaceTxn: (_cd: string, _owner: string, fn: (tx: unknown) => unknown) => fn(fakeTx),
}));

// Harness registry (P-008 gate): configurable per test; default = an eligible
// papercup entry pointing at a real on-disk repo dir (the gate stats the path).
let registryProjects: Array<Record<string, unknown>> = [];
vi.mock('../../harness-registry', () => ({
  loadHarnessRegistry: async () => ({ projects: registryProjects }),
}));

// Real dirs for the gate's disk checks (path exists / has .git).
const tmpRoot = mkdtempSync(join(tmpdir(), 'git-sync-action-'));
const repoDir = join(tmpRoot, 'repo');
const noGitDir = join(tmpRoot, 'norepo');
mkdirSync(join(repoDir, '.git'), { recursive: true });
mkdirSync(noGitDir, { recursive: true });
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const runGitSyncMock = vi.fn(async (_slug: string, _opts: Record<string, unknown>): Promise<GitSyncOutcome> => ({ status: 'nothing', oversized: [], contentErrors: [] }));
vi.mock('./run-git-sync', () => ({
  runGitSync: (...a: unknown[]) => runGitSyncMock(a[0] as string, a[1] as Record<string, unknown>),
}));

// EI-438 content-guard kill-switch flag — default ON; a test can flip it to exercise
// the OFF (empty-detector) path. Only '@papercusp/flags/server' (the network getFlag)
// is mocked; '@papercusp/flags' (the FLAGS constants) imports for real.
const getFlagMock = vi.fn(async (_key: string, _distinctId?: string): Promise<boolean> => true);
vi.mock('@papercusp/flags/server', () => ({
  getFlag: (...a: unknown[]) => getFlagMock(a[0] as string, a[1] as string | undefined),
  // onFlagChange: a module-load-time subscription (agent-tools/coordination/log.ts, pulled in
  // transitively via ./git-sync-action's `sendMessage` import) is not exercised by this suite —
  // a no-op subscriber returning an unsubscribe fn keeps the mock a valid drop-in without
  // needing this test to actually simulate flag-change notifications.
  onFlagChange: (_handler: (key: string | null) => void) => () => {},
}));

const appendPipelineEventMock = vi.fn(async (_ev: Record<string, unknown>): Promise<void> => {});
vi.mock('./pipeline-events', () => ({
  appendPipelineEvent: (...a: unknown[]) => appendPipelineEventMock(a[0] as Record<string, unknown>),
}));

const INVOKE_URL = 'http://127.0.0.1:3070/api/agents/invoke?role=merge-resolver';
const CONTENT_FIX_URL = 'http://127.0.0.1:3070/api/agents/invoke?role=content-fixer';
const resolveLaunchTargetForEventMock = vi.fn(
  async (event: string, _opts: Record<string, unknown>): Promise<{ blueprintId: string; role: string; url: string } | null> =>
    event === 'git-sync:content-error'
      ? { blueprintId: 'content-fix', role: 'content-fixer', url: CONTENT_FIX_URL }
      : { blueprintId: 'merge-resolution', role: 'merge-resolver', url: INVOKE_URL },
);
vi.mock('../../blueprint/launch-blueprint', () => ({
  resolveLaunchTargetForEvent: (...a: unknown[]) => resolveLaunchTargetForEventMock(a[0] as string, a[1] as Record<string, unknown>),
}));

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
const loopbackFetchMock = vi.fn(async (_url: string, _init?: Record<string, unknown>): Promise<FakeResponse> => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, exitCode: 0, timedOut: false }),
}));
vi.mock('../../loopback-fetch', () => ({
  loopbackFetch: (...a: unknown[]) => loopbackFetchMock(a[0] as string, a[1] as Record<string, unknown>),
}));

const sendMessageMock = vi.fn(async (_id: unknown, _msg: Record<string, unknown>): Promise<unknown> => ({ ok: true }));
vi.mock('../../agent-tools/coordination/messages', () => ({
  sendMessage: (...a: unknown[]) => sendMessageMock(a[0], a[1] as Record<string, unknown>),
}));

// Lazily imported by the action (best-effort doc-freshness sweep) — mock so the
// dynamic import never pulls the real docs machinery.
const captureHeadShaMock = vi.fn(async (_slug: string): Promise<string | null> => 'prev-sha-000');
const runDocSweepMock = vi.fn(async (_input: Record<string, unknown>): Promise<null> => null);
vi.mock('../docs/sweep-after-sync', () => ({
  captureHeadSha: (...a: unknown[]) => captureHeadShaMock(a[0] as string),
  runDocFreshnessSweepAfterSync: (...a: unknown[]) => runDocSweepMock(a[0] as Record<string, unknown>),
}));

// --- fake PG: the org `sql` is used as a tagged template (reads) + `.unsafe` (writes).
type Row = Record<string, unknown>;
/** Rows returned for the resolverInFlight read (`metadata->'last_resolver'`). */
let resolverRows: Array<{ lr: { status?: string; at?: number; instance?: string } | null }> = [];
/** Rows returned for the contentFixerInFlight read (`metadata->'last_content_fixer'`). */
let contentFixerRows: Array<{ lr: { status?: string; at?: number; instance?: string } | null }> = [];
/** Rows returned for the EI-18 + content counters read (`consecutive_error_ticks`/`last_oversized`/`consecutive_content_error_ticks`). */
let counterRows: Array<{ et: number; lo: string[] | null; ct?: number }> = [];
/** Every `sql.unsafe(text, params)` write, in order. */
const unsafeCalls: Array<{ text: string; params: unknown[] }> = [];

const fakeSql = Object.assign(
  (strings: TemplateStringsArray, ..._values: unknown[]): Promise<Row[]> => {
    const text = strings.join('?');
    if (text.includes("'last_content_fixer'")) return Promise.resolve(contentFixerRows as unknown as Row[]);
    if (text.includes("'last_resolver'")) return Promise.resolve(resolverRows as unknown as Row[]);
    if (text.includes('consecutive_error_ticks')) return Promise.resolve(counterRows as unknown as Row[]);
    return Promise.resolve([]);
  },
  {
    unsafe: (text: string, params: unknown[] = []): Promise<Row[]> => {
      unsafeCalls.push({ text, params });
      return Promise.resolve([]);
    },
  },
);
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: fakeSql }) }));

// importing the action module registers `git-sync` into the system-action registry,
// exactly as production's register-system-actions side-effect import does.
import './git-sync-action';
import { isResolverInFlight, acquireWithContentionRetry } from './git-sync-action';
import { getSystemAction, getSystemActionEntry, type SystemActionCtx } from '../routines/system-actions';

// --- helpers over the captured PG writes ------------------------------------------

/** ALL JSONB patches applied to the routine's metadata, in order (breadcrumb included). */
const allRoutinePatches = (): Array<Record<string, unknown>> =>
  unsafeCalls
    .filter((c) => c.text.includes('UPDATE harness_shared.routines'))
    .map((c) => JSON.parse(String(c.params[1])) as Record<string, unknown>);

/** WI-1416: the `fire_started_at` breadcrumb patched at the very top of every fire. */
const fireBreadcrumbs = (): Array<Record<string, unknown>> =>
  allRoutinePatches().filter((p) => 'fire_started_at' in p);

/** JSONB patches applied to the routine's metadata (recordOutcome + resolver markers) —
 *  the WI-1416 fire_started_at breadcrumb excluded so outcome assertions stay focused. */
const routinePatches = (): Array<Record<string, unknown>> =>
  allRoutinePatches().filter((p) => !('fire_started_at' in p));

/** Escalation upserts (conflict + error kinds), with the parsed body. */
const escalationUpserts = (): Array<{ text: string; params: unknown[]; body: Record<string, unknown> }> =>
  unsafeCalls
    .filter((c) => c.text.includes('INSERT INTO harness_shared.harness_escalations'))
    .map((c) => ({ text: c.text, params: c.params, body: JSON.parse(String(c.params[2])) as Record<string, unknown> }));

/** Escalation clears — each entry is the `kinds` array passed to the UPDATE. */
const escalationClears = (): string[][] =>
  unsafeCalls.filter((c) => c.text.includes('SET escalation = NULL')).map((c) => c.params[3] as string[]);

const releasedResources = (): string[] =>
  tryReleaseResourceMock.mock.calls.map(([, o]) => (o as { resource: string }).resource);

const acquiredResources = (): string[] =>
  tryAcquireResourceMock.mock.calls.map(([, o]) => (o as { resource: string }).resource);

/** Resource names auto-registered via the in-txn agent_resource_registry INSERT (P-006). */
const registeredResources = (): string[] =>
  txQueries.filter((q) => q.text.includes('agent_resource_registry')).map((q) => q.values[0] as string);

/** papercup's MIGRATED trigger_config (db mig 237): the legacy back-off names ride
 *  extra_lock_resources, so peers acquiring exclusive(git-sync) still back it off. */
const PAPERCUP_EXTRAS = ['git-sync', 'libs-papercusp-submodule'];

const ctx: SystemActionCtx = {
  installSlug: 'papercup',
  workspaceId: 'ws-42',
  triggerConfig: { extra_lock_resources: PAPERCUP_EXTRAS },
  payloadTemplate: null,
};

const syncedOutcome: GitSyncOutcome = {
  status: 'synced',
  headSha: 'abc123def456',
  pushed: ['libs/generic/sync', 'superproject'],
  merged: ['superproject'],
  oversized: [],
  contentErrors: [],
};
const conflictOutcome: GitSyncOutcome = {
  status: 'conflict',
  conflicts: [{ scope: 'libs/generic/sync', conflictedFiles: ['src/a.ts', 'src/b.ts'] }],
  errors: [],
  pushed: ['libs/papercusp'],
  merged: [],
  oversized: [],
  contentErrors: [],
};
const errorOutcome: GitSyncOutcome = {
  status: 'error',
  errors: [{ scope: 'superproject', message: 'push failed: HTTP 500' }],
  pushed: [],
  merged: [],
  oversized: [],
  contentErrors: [],
};
/** EI-438: a tick that quarantined a broken .mdx (synced everything else). */
const contentErrorOutcome: GitSyncOutcome = {
  status: 'synced',
  headSha: 'def789',
  pushed: ['superproject'],
  merged: [],
  oversized: [],
  contentErrors: [
    { scope: 'superproject', file: 'apps/operator-docs/src/content/docs/x.mdx', detectorKey: 'mdx', error: 'MDX compile error at line 7: closing tag for `<date>`', fixerRole: 'content-fixer' },
  ],
};

const action = getSystemAction('git-sync')!;

beforeEach(() => {
  tryAcquireResourceMock.mockReset();
  tryReleaseResourceMock.mockReset();
  runGitSyncMock.mockReset();
  appendPipelineEventMock.mockReset();
  resolveLaunchTargetForEventMock.mockReset();
  loopbackFetchMock.mockReset();
  sendMessageMock.mockReset();
  captureHeadShaMock.mockReset();
  runDocSweepMock.mockReset();
  getFlagMock.mockReset();
  // content-guard defaults ON; derived-attribution (P-004) defaults OFF — mirror the real
  // defaults so the runGitSync-opts assertions don't see a loadRoster added.
  getFlagMock.mockImplementation(async (key: string) => key !== 'papercusp-git-sync-derived-attribution');
  resolverRows = [];
  contentFixerRows = [];
  counterRows = [];
  unsafeCalls.length = 0;
  txQueries.length = 0;
  registryProjects = [{ slug: 'papercup', path: repoDir }];
});

describe('registry population', () => {
  it('side-effect import registers the git-sync system action', () => {
    expect(action).toBeTypeOf('function');
  });

  it('WI-1416: git-sync registers with ownSteps so the engine runs it at the WORKFLOW layer (sub-steps checkpoint)', () => {
    expect(getSystemActionEntry('git-sync')).toMatchObject({ ownSteps: true });
  });
});

describe('WI-1416 durable-fire breadcrumbs', () => {
  it('stamps fire_started_at as the FIRST metadata write of every fire (before locks/gate)', async () => {
    runGitSyncMock.mockResolvedValue({ status: 'nothing', oversized: [], contentErrors: [] });

    await action(ctx);

    const first = allRoutinePatches()[0];
    expect(first).toEqual({ fire_started_at: expect.any(Number) });
  });

  it('stamps the breadcrumb even on an ineligible (skipped) tick — a gate-stalled fire is still visible', async () => {
    registryProjects = []; // no registry entry → no_path skip
    await action(ctx);
    expect(fireBreadcrumbs()).toEqual([{ fire_started_at: expect.any(Number) }]);
  });

  it('a COMPLETED tick resets reaped_count to 0 (recordOutcome) — the reaper counter reads as CONSECUTIVE reaps', async () => {
    runGitSyncMock.mockResolvedValue(syncedOutcome);

    await action(ctx);

    expect(routinePatches()[0]).toMatchObject({ last_status: 'synced', reaped_count: 0 });
  });
});

describe('P-009/P-006 lock discipline (per-slug resources)', () => {
  it('SKIPS the tick when a peer holds a lock (back-pressure) — releasing the partial acquisitions', async () => {
    // per-slug + first extra acquire; the last extra is held by a peer
    tryAcquireResourceMock.mockImplementation(async (_tx, opts) =>
      (opts as { resource: string }).resource === 'libs-papercusp-submodule'
        ? { ok: false, reason: 'held by agent:peer' }
        : { ok: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await action(ctx);

    expect(acquiredResources()).toEqual(['git-sync:papercup', 'git-sync', 'libs-papercusp-submodule']);
    // the routine did NOTHING this tick: no sync, no outcome writes, no pipeline event
    // (the only PG write is the WI-1416 fire_started_at breadcrumb, stamped before locks)
    expect(runGitSyncMock).not.toHaveBeenCalled();
    expect(appendPipelineEventMock).not.toHaveBeenCalled();
    expect(routinePatches()).toEqual([]);
    expect(fireBreadcrumbs()).toEqual([{ fire_started_at: expect.any(Number) }]);
    expect(captureHeadShaMock).not.toHaveBeenCalled();
    // …but the partially-acquired locks were released (reverse order)
    expect(releasedResources()).toEqual(['git-sync', 'git-sync:papercup']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('a peer holds libs-papercusp-submodule'));
    log.mockRestore();
  });

  it('proceeds UNLOCKED when the lock infra errors (fail-open) — partials released, no release after the run', async () => {
    tryAcquireResourceMock
      .mockResolvedValueOnce({ ok: true }) // git-sync:papercup acquires…
      .mockRejectedValueOnce(new Error('su-lock DB unreachable')); // …then the infra dies
    runGitSyncMock.mockResolvedValue(syncedOutcome);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lock infra unavailable'));
    // the documented fail-open contract: the sync still RUNS
    expect(runGitSyncMock).toHaveBeenCalledTimes(1);
    expect(appendPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'git_sync', status: 'synced' }));
    // the partial acquisition was released inside acquireLocks; the unlocked run
    // releases nothing afterwards (exactly one release total)
    expect(releasedResources()).toEqual(['git-sync:papercup']);
    warn.mockRestore();
  });

  it('acquires the per-slug resource FIRST (auto-registered in-txn), then the configured extras, releasing in reverse order', async () => {
    runGitSyncMock.mockResolvedValue(syncedOutcome);

    await action(ctx);

    // papercup regression: per-slug name + BOTH legacy back-off names from
    // extra_lock_resources, all exclusive, same owner/ttl as before
    expect(acquiredResources()).toEqual(['git-sync:papercup', 'git-sync', 'libs-papercusp-submodule']);
    expect(tryAcquireResourceMock.mock.calls[0][1]).toMatchObject({
      coordinationDomain: 'ws-42',
      resource: 'git-sync:papercup',
      mode: 'exclusive',
      owner: 'system:git-sync',
      ttlSec: 600,
    });
    // ONLY the per-slug name is auto-registered (idempotent ON CONFLICT DO NOTHING);
    // the extras are a human-registered coordination surface
    expect(registeredResources()).toEqual(['git-sync:papercup']);
    expect(txQueries.find((q) => q.text.includes('agent_resource_registry'))?.text)
      .toContain('ON CONFLICT (resource) DO NOTHING');
    expect(releasedResources()).toEqual(['libs-papercusp-submodule', 'git-sync', 'git-sync:papercup']);
  });

  it('a harness with NO extra_lock_resources acquires only its own per-slug resource', async () => {
    registryProjects = [{ slug: 'otherapp', path: repoDir }];
    runGitSyncMock.mockResolvedValue({ status: 'nothing', oversized: [], contentErrors: [] });

    await action({ ...ctx, installSlug: 'otherapp', triggerConfig: {} });

    expect(acquiredResources()).toEqual(['git-sync:otherapp']);
    expect(registeredResources()).toEqual(['git-sync:otherapp']);
    expect(runGitSyncMock).toHaveBeenCalledTimes(1);
    expect(releasedResources()).toEqual(['git-sync:otherapp']);
  });

  it('an UNKNOWN extra lock resource SKIPS the tick with a loud warning — and is never auto-registered', async () => {
    tryAcquireResourceMock.mockImplementation(async (_tx, opts) =>
      (opts as { resource: string }).resource === 'my-deploy-lock'
        ? { ok: false, reason: 'unknown_resource' }
        : { ok: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action({ ...ctx, triggerConfig: { extra_lock_resources: ['my-deploy-lock'] } });

    expect(runGitSyncMock).not.toHaveBeenCalled();
    expect(appendPipelineEventMock).not.toHaveBeenCalled();
    expect(routinePatches()).toEqual([]); // only the WI-1416 breadcrumb is written
    // the deliberate, human-registered surface: warned about, not auto-registered
    expect(registeredResources()).toEqual(['git-sync:papercup']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"my-deploy-lock" is not registered'));
    expect(releasedResources()).toEqual(['git-sync:papercup']);
    warn.mockRestore();
  });

  it('releases the locks even when runGitSync THROWS (the finally), and the error propagates', async () => {
    runGitSyncMock.mockRejectedValue(new Error('git exploded'));

    await expect(action(ctx)).rejects.toThrow('git exploded');

    expect(releasedResources()).toEqual(['libs-papercusp-submodule', 'git-sync', 'git-sync:papercup']);
    // nothing past the run executed
    expect(routinePatches()).toEqual([]);
    expect(appendPipelineEventMock).not.toHaveBeenCalled();
  });
});

describe('P-008 runtime eligibility gate (action half)', () => {
  /** Run the action and assert it no-opped with the given skip reason. */
  async function expectSkip(runCtx: SystemActionCtx, reason: string): Promise<void> {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await action(runCtx);

    // no locks, no auto-register, no sync, no pipeline event, no escalation
    expect(tryAcquireResourceMock).not.toHaveBeenCalled();
    expect(registeredResources()).toEqual([]);
    expect(runGitSyncMock).not.toHaveBeenCalled();
    expect(appendPipelineEventMock).not.toHaveBeenCalled();
    expect(escalationUpserts()).toEqual([]);
    // …just the logged reason + the 'skipped' metadata patch
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`ineligible (${reason})`));
    expect(routinePatches()).toEqual([
      expect.objectContaining({ last_status: 'skipped', last_skip_reason: reason, last_skipped_at: expect.any(Number) }),
    ]);
    log.mockRestore();
  }

  it('a slug with NO registry entry no-ops as skipped/no_path (vanished install) — not an error escalation', async () => {
    registryProjects = [];
    await expectSkip(ctx, 'no_path');
  });

  it('a hive HOME row (kind hive, non-repo state dir) no-ops as hive_home', async () => {
    registryProjects = [{ slug: 'papercup', path: repoDir, harness_kind: 'hive' }];
    await expectSkip(ctx, 'hive_home');
  });

  it('a joiner-side remote-hive VIEW no-ops as remote_hive_view', async () => {
    registryProjects = [{ slug: 'papercup', path: repoDir, harness_kind: 'hive', remote_hive: true }];
    await expectSkip(ctx, 'remote_hive_view');
  });

  it('a non-local deployment no-ops as non_local_deployment', async () => {
    registryProjects = [{ slug: 'papercup', path: repoDir, deployment: { target: 'cloud' } }];
    await expectSkip(ctx, 'non_local_deployment');
  });

  it('a VANISHED checkout (registered path no longer on disk) no-ops as no_path', async () => {
    registryProjects = [{ slug: 'papercup', path: join(tmpRoot, 'gone') }];
    await expectSkip(ctx, 'no_path');
  });

  it('a checkout without a .git no-ops as not_a_git_repo', async () => {
    registryProjects = [{ slug: 'papercup', path: noGitDir }];
    await expectSkip(ctx, 'not_a_git_repo');
  });
});

describe('clean sync outcome', () => {
  it('records routine metadata, logs a git_sync event, clears BOTH escalation kinds, sweeps docs', async () => {
    runGitSyncMock.mockResolvedValue(syncedOutcome);

    await action(ctx);

    // trigger config defaults flow into the pipeline (+ WI-1416: the checkpoint seam)
    expect(runGitSyncMock).toHaveBeenCalledWith('papercup', {
      config: expect.objectContaining({ push: true, pushSubmodules: true }),
      step: expect.any(Function),
    });

    // { last_synced_at, last_status, head_sha } + the EI-18 counters on the metadata
    expect(routinePatches()).toEqual([
      expect.objectContaining({
        last_status: 'synced',
        last_synced_at: expect.any(Number),
        head_sha: 'abc123def456',
        last_pushed: ['libs/generic/sync', 'superproject'],
        last_merged: ['superproject'],
        last_conflicts: [],
        last_errors: [],
        last_error: null,
        consecutive_error_ticks: 0,
        last_oversized: [],
      }),
    ]);

    expect(appendPipelineEventMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        workspaceId: 'ws-42',
        installSlug: 'papercup',
        kind: 'git_sync',
        status: 'synced',
        detail: expect.objectContaining({ headSha: 'abc123def456', consecutiveErrorTicks: 0 }),
      }));

    // a clean pass clears the conflict escalation AND (errTicks 0) the error one —
    // targeting the P-007 constant 'git-sync' phase row. (The content escalation clear is
    // gated on a PRIOR content quarantine — none here — so it does not fire this tick.)
    expect(escalationClears()).toEqual([['git-sync-conflict'], ['git-sync-error']]);
    const clears = unsafeCalls.filter((c) => c.text.includes('SET escalation = NULL'));
    expect(clears.map((c) => c.params[2])).toEqual(['git-sync', 'git-sync']); // phase
    expect(escalationUpserts()).toEqual([]);

    // no resolver business on a clean tick
    expect(resolveLaunchTargetForEventMock).not.toHaveBeenCalled();
    expect(loopbackFetchMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();

    // P-003 doc-freshness sweep rides a real sync, with the pre-sync HEAD
    expect(runDocSweepMock).toHaveBeenCalledExactlyOnceWith({
      harnessSlug: 'papercup',
      workspaceId: 'ws-42',
      prevSha: 'prev-sha-000',
      headSha: 'abc123def456',
    });
  });

  it("a 'nothing' pass also clears escalations but records no head_sha and runs no doc sweep", async () => {
    runGitSyncMock.mockResolvedValue({ status: 'nothing', oversized: [], contentErrors: [] });

    await action(ctx);

    const [patch] = routinePatches();
    expect(patch).toMatchObject({ last_status: 'nothing', consecutive_error_ticks: 0, consecutive_content_error_ticks: 0 });
    expect(patch).not.toHaveProperty('head_sha');
    expect(escalationClears()).toEqual([['git-sync-conflict'], ['git-sync-error']]);
    expect(runDocSweepMock).not.toHaveBeenCalled();
    expect(appendPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'git_sync', status: 'nothing' }));
  });

  it('maps the routine trigger_config onto the pipeline config', async () => {
    runGitSyncMock.mockResolvedValue({ status: 'nothing', oversized: [], contentErrors: [] });

    await action({
      ...ctx,
      triggerConfig: { push: false, push_submodules: false, branch: 'staging', remote: 'upstream', max_blob_bytes: 1024 },
    });

    expect(runGitSyncMock).toHaveBeenCalledWith('papercup', {
      config: { push: false, pushSubmodules: false, branch: 'staging', remote: 'upstream', maxBlobBytes: 1024 },
      step: expect.any(Function),
    });
  });
});

describe('P-010/P-012 merge-conflict path', () => {
  it('writes the git-sync-conflict escalation AND dispatches the merge-resolver (observably)', async () => {
    runGitSyncMock.mockResolvedValue(conflictOutcome);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    // escalation row: kind + every conflicted scope/file, UNIQUE per harness+phase
    const ups = escalationUpserts();
    expect(ups).toHaveLength(1);
    // G23: on a conflict the row is genuinely INSERTed into harness_escalations
    // (not merely a metadata patch) — the resolver's read path keys off this row.
    expect(ups[0].text).toContain('INSERT INTO harness_shared.harness_escalations');
    expect(ups[0].body).toMatchObject({
      kind: 'git-sync-conflict',
      harness_slug: 'papercup',
      conflicts: [{ scope: 'libs/generic/sync', conflicted_files: ['src/a.ts', 'src/b.ts'] }],
      scope: 'libs/generic/sync',
    });
    expect(ups[0].params[0]).toBe('papercup'); // harness_slug
    expect(ups[0].params[1]).toBe('git-sync'); // phase — P-007: git-sync's own constant row key
    expect(ups[0].params[4]).toBe('ws-42'); // workspace_id
    // a conflict tick clears NOTHING (the resolver clears by producing a clean pass)
    expect(escalationClears()).toEqual([]);

    // dispatch resolved declaratively from the launch blueprint by event key
    expect(resolveLaunchTargetForEventMock).toHaveBeenCalledExactlyOnceWith(
      'git-sync:conflict',
      { installSlug: 'papercup', workspaceId: 'ws-42' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dispatching merge-resolver'));

    // the durable 'dispatched' marker is recorded (GAP-2 observability)
    expect(routinePatches()).toContainEqual({
      last_resolver: expect.objectContaining({ status: 'dispatched', scopes: ['libs/generic/sync'] }),
    });

    // the invoke call itself: fire-and-forget POST with the conflict context + 900s budget
    expect(loopbackFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = loopbackFetchMock.mock.calls[0];
    expect(url).toBe(INVOKE_URL);
    const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
    expect(body.timeoutMs).toBe(900_000);
    expect((body.extra as string[])[0]).toBe('--git-sync-conflict');
    expect(JSON.parse((body.extra as string[])[1])).toMatchObject({ scopes: ['libs/generic/sync'] });
    expect(body.kickoff).toContain('libs/generic/sync');
    // P-007: no routine branch configured → the kickoff derives the default 'main',
    // NOT a hardcoded papercup 'staging'
    expect(body.kickoff).toContain('superproject = `main`');

    // the dangling invoke promise SETTLES observably: last_resolver → ok + a
    // merge_resolver pipeline event (resolver success rate for the Git tab)
    await vi.waitFor(() => {
      expect(appendPipelineEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'merge_resolver', status: 'ok' }));
    });
    expect(routinePatches()).toContainEqual({
      last_resolver: expect.objectContaining({ status: 'ok', httpStatus: 200 }),
    });

    // sibling submodules that DID push are still recorded (GAP-1)
    expect(routinePatches()[0]).toMatchObject({ last_status: 'conflict', last_pushed: ['libs/papercusp'], last_conflicts: ['libs/generic/sync'] });
    warn.mockRestore();
  });

  it('does NOT dispatch a second resolver while one is genuinely in flight (dedup on last_resolver, not the open escalation)', async () => {
    runGitSyncMock.mockResolvedValue(conflictOutcome);
    // a dispatch recorded 1 min ago that has not settled → in flight
    resolverRows = [{ lr: { status: 'dispatched', at: Date.now() - 60_000 } }];

    await action(ctx);

    // the escalation is still refreshed every conflict tick…
    expect(escalationUpserts()).toHaveLength(1);
    // …but no duplicate resolver fires
    expect(resolveLaunchTargetForEventMock).not.toHaveBeenCalled();
    expect(loopbackFetchMock).not.toHaveBeenCalled();
    expect(routinePatches().some((p) => 'last_resolver' in p)).toBe(false);
  });

  it('RE-dispatches when the previous resolver already SETTLED (failed) — a settled dispatch never suppresses retry', async () => {
    runGitSyncMock.mockResolvedValue(conflictOutcome);
    resolverRows = [{ lr: { status: 'failed', at: Date.now() - 60_000 } }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    expect(loopbackFetchMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(appendPipelineEventMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'merge_resolver' }));
    });
    warn.mockRestore();
  });

  it('RE-dispatches when a dispatched marker is STALE (older than the 20-min in-flight window)', async () => {
    runGitSyncMock.mockResolvedValue(conflictOutcome);
    resolverRows = [{ lr: { status: 'dispatched', at: Date.now() - 21 * 60_000 } }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    expect(loopbackFetchMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(appendPipelineEventMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'merge_resolver' }));
    });
    warn.mockRestore();
  });

  it('P-006: RE-dispatches a marker ORPHANED by an operator restart (different process instance) — within the 20-min window, not waiting it out', async () => {
    runGitSyncMock.mockResolvedValue(conflictOutcome);
    // A 'dispatched' marker recorded 1 min ago by a PRIOR operator incarnation:
    // its fire-and-forget settle promise died with that process and can never land
    // here, so it is NOT really in flight even though it is well inside the TTL.
    resolverRows = [{ lr: { status: 'dispatched', at: Date.now() - 60_000, instance: 'a-prior-process-incarnation' } }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    expect(loopbackFetchMock).toHaveBeenCalledTimes(1);
    // the fresh dispatch is stamped with the LIVE instance (not the orphan's).
    const dispatched = routinePatches().find(
      (p) => (p.last_resolver as Record<string, unknown> | undefined)?.status === 'dispatched',
    );
    expect((dispatched!.last_resolver as Record<string, unknown>).instance).toBeTypeOf('string');
    expect((dispatched!.last_resolver as Record<string, unknown>).instance).not.toBe('a-prior-process-incarnation');
    await vi.waitFor(() => {
      expect(appendPipelineEventMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'merge_resolver' }));
    });
    warn.mockRestore();
  });

  it('skips the dispatch (warning) when no launch blueprint declares git-sync:conflict — escalation still written', async () => {
    runGitSyncMock.mockResolvedValue(conflictOutcome);
    resolveLaunchTargetForEventMock.mockResolvedValue(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    expect(escalationUpserts()).toHaveLength(1);
    expect(loopbackFetchMock).not.toHaveBeenCalled();
    // no 'dispatched' marker either — the next conflict tick is free to retry
    expect(routinePatches().some((p) => 'last_resolver' in p)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no launch blueprint declares'));
    warn.mockRestore();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P-006/P-007 — the resolver dedup WINDOW, pure. `isResolverInFlight` keys ONLY
// on PG timestamps + the process instance, never on git round-trip timing, so
// the window holds identically whether a fetch/push takes 1ms or 5s (P-007: real
// latency is negligible against the 20-min TTL / 900s resolver ceiling). The
// instance leg is the P-006 restart-liveness path.
// ════════════════════════════════════════════════════════════════════════════
describe('isResolverInFlight — dedup window (P-006/P-007)', () => {
  const NOW = 1_000_000_000_000;
  const ME = 'pid.live';
  const WINDOW = 20 * 60_000;

  it('no marker / never run → not in flight (free to dispatch)', () => {
    expect(isResolverInFlight(null, NOW, ME)).toBe(false);
    expect(isResolverInFlight(undefined, NOW, ME)).toBe(false);
    expect(isResolverInFlight({}, NOW, ME)).toBe(false);
  });

  it('a SETTLED marker (ok/failed/error) → not in flight, regardless of age', () => {
    for (const status of ['ok', 'failed', 'error']) {
      expect(isResolverInFlight({ status, at: NOW - 1000, instance: ME }, NOW, ME)).toBe(false);
    }
  });

  it('same-instance dispatched, INSIDE the window → in flight (deduped)', () => {
    expect(isResolverInFlight({ status: 'dispatched', at: NOW - 60_000, instance: ME }, NOW, ME)).toBe(true);
    expect(isResolverInFlight({ status: 'dispatched', at: NOW - (WINDOW - 1), instance: ME }, NOW, ME)).toBe(true);
  });

  it('same-instance dispatched, PAST the window (stale) → not in flight (TTL expiry)', () => {
    expect(isResolverInFlight({ status: 'dispatched', at: NOW - WINDOW, instance: ME }, NOW, ME)).toBe(false);
    expect(isResolverInFlight({ status: 'dispatched', at: NOW - 2 * WINDOW, instance: ME }, NOW, ME)).toBe(false);
  });

  it('P-006: dispatched by a DIFFERENT instance (restart orphan) → not in flight even INSIDE the window', () => {
    expect(isResolverInFlight({ status: 'dispatched', at: NOW - 60_000, instance: 'prior-incarnation' }, NOW, ME)).toBe(false);
    // and once stale it's still not in flight (both reasons agree)
    expect(isResolverInFlight({ status: 'dispatched', at: NOW - 2 * WINDOW, instance: 'prior-incarnation' }, NOW, ME)).toBe(false);
  });

  it('a legacy marker with NO instance falls back to the pure TTL (no regression, no spurious re-dispatch)', () => {
    expect(isResolverInFlight({ status: 'dispatched', at: NOW - 60_000 }, NOW, ME)).toBe(true); // in window → deduped
    expect(isResolverInFlight({ status: 'dispatched', at: NOW - 2 * WINDOW }, NOW, ME)).toBe(false); // stale → retry
  });

  it('P-007: latency-invariance — the window verdict depends on the marker timestamp delta, not wall-time of the git ops', () => {
    // Whatever real latency a tick incurred, the only inputs are `now` and `at`.
    // A 5s-latency tick that records `at` and re-reads 5s later is still ~5s < 20min.
    const at = NOW;
    expect(isResolverInFlight({ status: 'dispatched', at, instance: ME }, NOW + 5_000, ME)).toBe(true);
    expect(isResolverInFlight({ status: 'dispatched', at, instance: ME }, NOW + WINDOW + 5_000, ME)).toBe(false);
  });
});

describe('EI-18 repeated-failure escalation (git-sync-error)', () => {
  it('an error tick BELOW the threshold only bumps the counter — no escalation, no broadcast, no clear', async () => {
    runGitSyncMock.mockResolvedValue(errorOutcome);
    counterRows = [{ et: 0, lo: [] }]; // previous tick was clean

    await action(ctx);

    expect(routinePatches()[0]).toMatchObject({
      last_status: 'error',
      consecutive_error_ticks: 1,
      last_error: 'superproject: push failed: HTTP 500',
    });
    expect(escalationUpserts()).toEqual([]);
    // an error tick must NOT clear an open conflict escalation either
    expect(escalationClears()).toEqual([]);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(loopbackFetchMock).not.toHaveBeenCalled();
  });

  it('the THIRD consecutive error tick writes the git-sync-error escalation + broadcasts, and dispatches NO resolver', async () => {
    runGitSyncMock.mockResolvedValue(errorOutcome);
    counterRows = [{ et: 2, lo: [] }]; // two prior error ticks → this one crosses the threshold
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    // EI-18 escalation row, kind git-sync-error, via the NON-CLOBBER conditional upsert
    const ups = escalationUpserts();
    expect(ups).toHaveLength(1);
    expect(ups[0].body).toMatchObject({
      kind: 'git-sync-error',
      harness_slug: 'papercup',
      reasons: ['push-failure'],
      consecutive_error_ticks: 3,
      errors: [{ scope: 'superproject', message: 'push failed: HTTP 500' }],
    });
    // the conditional DO UPDATE: an open git-sync-conflict row always wins
    expect(ups[0].text).toContain('WHERE harness_escalations.escalation IS NULL');
    expect(ups[0].params[5]).toBe('git-sync-error');

    // it is NOT a merge conflict: no resolver dispatch, no conflict-escalation clear
    expect(resolveLaunchTargetForEventMock).not.toHaveBeenCalled();
    expect(loopbackFetchMock).not.toHaveBeenCalled();
    expect(escalationClears()).toEqual([]);

    // the transition broadcast (fires exactly at the threshold) goes fleet-wide
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [identity, msg] = sendMessageMock.mock.calls[0];
    expect(identity).toMatchObject({ ownerId: 'system:git-sync' });
    expect(msg).toMatchObject({ to: ['*'], category: 'git-sync' });
    expect((msg as { summary: string }).summary).toContain('FAILED 3 consecutive ticks');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('FAILED 3 consecutive ticks'));

    expect(routinePatches()[0]).toMatchObject({ consecutive_error_ticks: 3 });
    expect(appendPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'git_sync',
        status: 'error',
        detail: expect.objectContaining({ consecutiveErrorTicks: 3 }),
      }));
    warn.mockRestore();
  });
});

describe('EI-438 content-guard path (git-sync-content-error)', () => {
  /** Content escalation upserts — their OWN phase 'git-sync-content' (never the conflict row). */
  const contentUpserts = (): Array<{ text: string; params: unknown[]; body: Record<string, unknown> }> =>
    escalationUpserts().filter((u) => u.params[1] === 'git-sync-content');

  it('a quarantine tick writes the content escalation (own phase) AND dispatches the content-fixer observably', async () => {
    runGitSyncMock.mockResolvedValue(contentErrorOutcome);
    counterRows = [{ et: 0, lo: [], ct: 0 }]; // no prior content errors
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    // escalation row on its OWN phase, kind + files, needs_human false (first attempt). The
    // separate phase is what keeps it from clobbering the conflict/error row (single (slug,phase)).
    const ups = contentUpserts();
    expect(ups).toHaveLength(1);
    expect(ups[0].params[1]).toBe('git-sync-content');
    expect(ups[0].params[4]).toBe('ws-42'); // workspace_id
    expect(ups[0].body).toMatchObject({
      kind: 'git-sync-content-error',
      harness_slug: 'papercup',
      needs_human: false,
      consecutive_content_error_ticks: 1,
      files: [{ scope: 'superproject', file: 'apps/operator-docs/src/content/docs/x.mdx', detector: 'mdx' }],
    });

    // dispatch resolved declaratively from the launch blueprint by the content-error event key
    expect(resolveLaunchTargetForEventMock).toHaveBeenCalledWith(
      'git-sync:content-error', { installSlug: 'papercup', workspaceId: 'ws-42' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dispatching content-fixer'));

    // the durable 'dispatched' marker is on its OWN key — never the merge-resolver's
    expect(routinePatches()).toContainEqual({
      last_content_fixer: expect.objectContaining({ status: 'dispatched' }),
    });
    expect(routinePatches().some((p) => 'last_resolver' in p)).toBe(false);

    // the invoke POST: content-fix URL + the --git-sync-content-error extra carrying the files
    expect(loopbackFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = loopbackFetchMock.mock.calls[0];
    expect(url).toBe(CONTENT_FIX_URL);
    const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
    expect((body.extra as string[])[0]).toBe('--git-sync-content-error');
    expect(JSON.parse((body.extra as string[])[1]).files[0]).toMatchObject({ detector: 'mdx' });
    expect(body.kickoff).toContain('x.mdx');

    // the dangling invoke promise SETTLES observably → last_content_fixer ok + a
    // content_fixer pipeline event (the Git-tab timeline)
    await vi.waitFor(() => {
      expect(appendPipelineEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'content_fixer', status: 'ok' }));
    });
    expect(routinePatches()).toContainEqual({
      last_content_fixer: expect.objectContaining({ status: 'ok', httpStatus: 200 }),
    });
    warn.mockRestore();
  });

  it('does NOT dispatch a second content-fixer while one is genuinely in flight (dedup on last_content_fixer)', async () => {
    runGitSyncMock.mockResolvedValue(contentErrorOutcome);
    counterRows = [{ et: 0, lo: [], ct: 1 }];
    // a content-fixer dispatch recorded 1 min ago that has not settled → in flight
    contentFixerRows = [{ lr: { status: 'dispatched', at: Date.now() - 60_000 } }];

    await action(ctx);

    // the escalation is still refreshed every quarantine tick…
    expect(contentUpserts()).toHaveLength(1);
    // …but no duplicate fixer fires, and no new dispatched marker is written
    expect(loopbackFetchMock).not.toHaveBeenCalled();
    expect(routinePatches().some((p) => 'last_content_fixer' in p)).toBe(false);
  });

  it('after MAX attempts the file is STILL broken → surfaces to a human + STOPS auto-dispatching (P-005)', async () => {
    runGitSyncMock.mockResolvedValue(contentErrorOutcome);
    counterRows = [{ et: 0, lo: [], ct: 4 }]; // 4 prior failing ticks → this is the 5th (= MAX), crosses the threshold
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    // the escalation is marked needs_human (a human must fix; it stays quarantined)
    const ups = contentUpserts();
    expect(ups).toHaveLength(1);
    expect(ups[0].body).toMatchObject({ needs_human: true, consecutive_content_error_ticks: 5 });

    // NO new fixer dispatch — never an infinite silent loop
    expect(loopbackFetchMock).not.toHaveBeenCalled();
    expect(routinePatches().some((p) => 'last_content_fixer' in p)).toBe(false);
    // …and a one-shot fleet broadcast fires exactly on the transition
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [identity, msg] = sendMessageMock.mock.calls[0];
    expect(identity).toMatchObject({ ownerId: 'system:git-sync' });
    expect(msg).toMatchObject({ to: ['*'], category: 'git-sync' });
    expect((msg as { summary: string }).summary).toContain('human is needed');
    warn.mockRestore();
  });

  it('does NOT re-broadcast on a failing tick already PAST the threshold (transition-only)', async () => {
    runGitSyncMock.mockResolvedValue(contentErrorOutcome);
    counterRows = [{ et: 0, lo: [], ct: 5 }]; // already at MAX last tick → this is the 6th
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    expect(contentUpserts()[0].body).toMatchObject({ needs_human: true, consecutive_content_error_ticks: 6 });
    expect(sendMessageMock).not.toHaveBeenCalled(); // no repeat broadcast
    expect(loopbackFetchMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a clean re-check after a quarantine clears the content escalation (own phase + kind)', async () => {
    runGitSyncMock.mockResolvedValue(syncedOutcome); // contentErrors: []
    counterRows = [{ et: 0, lo: [], ct: 2 }]; // a prior quarantine was open

    await action(ctx);

    const clears = unsafeCalls.filter((c) => c.text.includes('SET escalation = NULL'));
    const contentClear = clears.find((c) => c.params[2] === 'git-sync-content');
    expect(contentClear).toBeDefined();
    expect(contentClear!.params[3]).toEqual(['git-sync-content-error']);
    // no content escalation WRITE + no fixer dispatch on a clean tick
    expect(contentUpserts()).toEqual([]);
    expect(loopbackFetchMock).not.toHaveBeenCalled();
  });

  it('a clean tick with NO prior quarantine does NOT issue a content-escalation clear (gated on the prior counter)', async () => {
    runGitSyncMock.mockResolvedValue(syncedOutcome);
    counterRows = [{ et: 0, lo: [], ct: 0 }];

    await action(ctx);

    const clears = unsafeCalls.filter((c) => c.text.includes('SET escalation = NULL'));
    expect(clears.some((c) => c.params[2] === 'git-sync-content')).toBe(false);
  });
});

describe('EI-438 content-guard kill-switch flag', () => {
  const runGitSyncOpts = (): { config?: unknown; contentDetectors?: unknown } =>
    runGitSyncMock.mock.calls[0][1] as { config?: unknown; contentDetectors?: unknown };

  it('flag ON (default): runGitSync runs with the DEFAULT detector set (guard active)', async () => {
    runGitSyncMock.mockResolvedValue(syncedOutcome);

    await action(ctx);

    // undefined contentDetectors → runGitSync falls back to DEFAULT_CONTENT_DETECTORS.
    expect(runGitSyncOpts().contentDetectors).toBeUndefined();
    // gate read keyed by the harness slug.
    expect(getFlagMock).toHaveBeenCalledWith('papercusp-git-sync-content-guard', 'papercup');
  });

  it('flag OFF (kill-switch): runGitSync runs with an EMPTY detector set — commits as before this plan', async () => {
    getFlagMock.mockResolvedValue(false);
    runGitSyncMock.mockResolvedValue(syncedOutcome);

    await action(ctx);

    // [] disables the guard entirely: no quarantine, so outcome.contentErrors is always
    // empty → no content escalation + no fixer dispatch downstream.
    expect(runGitSyncOpts().contentDetectors).toEqual([]);
    expect(loopbackFetchMock).not.toHaveBeenCalled();
    expect(escalationUpserts().filter((u) => u.params[1] === 'git-sync-content')).toEqual([]);
  });
});

describe('acquireWithContentionRetry (EI-1720 — transient pg 57014/55P03 is retried, not skipped)', () => {
  const contended = () => Object.assign(new Error('workspace "ws" contended (pg 57014: lock/statement timeout)'), {
    name: 'WorkspaceContendedError', pgCode: '57014',
  });

  it('retries on contention then succeeds; backs off between attempts', async () => {
    const slept: number[] = [];
    let n = 0;
    const run = vi.fn(async () => {
      if (n++ < 2) throw contended();
      return { ok: true };
    });
    const r = await acquireWithContentionRetry(run, { backoffsMs: [10, 20, 40], sleep: async (ms) => { slept.push(ms); } });
    expect(r).toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([10, 20]); // two backoffs before the 3rd (successful) attempt
  });

  it('throws the contention error after exhausting retries (next tick retries)', async () => {
    const run = vi.fn(async () => { throw contended(); });
    await expect(
      acquireWithContentionRetry(run, { backoffsMs: [1, 1], sleep: async () => {} }),
    ).rejects.toMatchObject({ name: 'WorkspaceContendedError', pgCode: '57014' });
    expect(run).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('does NOT retry a non-contention error (real bug surfaces immediately)', async () => {
    const slept: number[] = [];
    const run = vi.fn(async () => { throw new Error('SU-lock DB unreachable'); });
    await expect(
      acquireWithContentionRetry(run, { backoffsMs: [10, 20], sleep: async (ms) => { slept.push(ms); } }),
    ).rejects.toThrow('SU-lock DB unreachable');
    expect(run).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it('also retries the lock_timeout SQLSTATE 55P03', async () => {
    let n = 0;
    const run = vi.fn(async () => {
      if (n++ < 1) throw Object.assign(new Error('lock_timeout'), { code: '55P03' });
      return { ok: false, reason: 'held' };
    });
    const r = await acquireWithContentionRetry(run, { backoffsMs: [1], sleep: async () => {} });
    expect(r).toEqual({ ok: false, reason: 'held' });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
