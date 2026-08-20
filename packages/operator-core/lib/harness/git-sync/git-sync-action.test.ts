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
 *     skip the tick (back-pressure, partial acquisitions released); exhausted
 *     workspace contention → skip after bounded retry; an UNKNOWN extra name →
 *     skip with a loud log (never auto-registered); lock INFRA error → proceed
 *     UNLOCKED (fail-open); every fire uses a distinct lock
 *     owner so cron/manual fires cannot coalesce; long runs refresh every held
 *     lease before its TTL; locks released after the run — success, error, and
 *     throw.
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
// WI-5960: NOT mocked — the real implementation, so the invariant test below
// pins the ACTUAL cross-module agreement (a mock would just assert against
// itself and could drift silently alongside a real-code regression).
import { resourceLockDomain, workspaceScopedLockDomain } from '../../agent-tools/locks/coordination-domain';

// --- mocks (factories only close over these; nothing dereferenced at hoist time) --
const tryAcquireResourceMock = vi.fn(async (_tx: unknown, _opts: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> => ({ ok: true }));
const tryReleaseResourceMock = vi.fn(async (_tx: unknown, _opts: Record<string, unknown>): Promise<{ ok: boolean }> => ({ ok: true }));
vi.mock('../../agent-tools/locks/su-lock-store', () => ({
  tryAcquireResource: (...a: unknown[]) => tryAcquireResourceMock(a[0], a[1] as Record<string, unknown>),
  tryReleaseResource: (...a: unknown[]) => tryReleaseResourceMock(a[0], a[1] as Record<string, unknown>),
}));

const liveLockedPathsMock = vi.fn(async (): Promise<string[]> => []);
vi.mock('../../agent-tools/locks/live-lock-paths', () => ({
  liveLockedPaths: () => liveLockedPathsMock(),
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
let ambientRegistryProjects: Array<Record<string, unknown>> | null = null;
const loadHarnessRegistryMock = vi.fn(async (workspaceId?: string) => ({
  projects: workspaceId ? registryProjects : ambientRegistryProjects ?? registryProjects,
}));
vi.mock('../../harness-registry', () => ({
  loadHarnessRegistry: (workspaceId?: string) => loadHarnessRegistryMock(workspaceId),
  // EI-9039 — the same class this file's own comment on getBootedHarnessMock
  // warns about, arriving by a different route: p2p/revocation-reaper
  // top-level-imports this export and is reached transitively, so it resolves
  // against THIS partial mock and its absence kills collection with an error
  // that names revocation-reaper.ts and looks unrelated to git-sync.
  deregisterEphemeralForeignHarness: vi.fn(async () => false),
}));

let potGitMode: 'legacy' | 'bridged' | 'p2p-only' = 'legacy';
vi.mock('./hive-git-mode', () => ({
  getPotGitMode: async () => potGitMode,
}));

// Real dirs for the gate's disk checks (path exists / has .git).
const tmpRoot = mkdtempSync(join(tmpdir(), 'git-sync-action-'));
const repoDir = join(tmpRoot, 'repo');
const noGitDir = join(tmpRoot, 'norepo');
mkdirSync(join(repoDir, '.git'), { recursive: true });
mkdirSync(noGitDir, { recursive: true });
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const runGitSyncMock = vi.fn(async (_slug: string, _opts: Record<string, unknown>): Promise<GitSyncOutcome> => ({ status: 'nothing', oversized: [], contentErrors: [], strandedSubmodules: [] }));
// The stash-check sweep (checkForNewStashes) also imports discoverSubmodulesRecursive
// from this module — without it on the mock, its best-effort catch console.warns and
// vitest-fail-on-console reds every test whose tick reaches the sweep (EI-14928 class:
// a mock missing a newly-consumed export). Empty submodule list → the sweep scans only
// the (mkdtemp) super repo, finds no stashes, and no-ops.
vi.mock('./run-git-sync', () => ({
  runGitSync: (...a: unknown[]) => runGitSyncMock(a[0] as string, a[1] as Record<string, unknown>),
  discoverSubmodulesRecursive: async (): Promise<string[]> => [],
  listStashEntries: async (): Promise<unknown[]> => [],
  newStashEntries: (): unknown[] => [],
  // EI-19449313204576061 added age-awareness to the sweep; a full factory mock only
  // exposes what it lists, so these must be here even though the empty-stash paths
  // below never reach them (the EI-14928 class this mock's header already warns about).
  partitionStashEntriesByAge: (): { recent: unknown[]; preExisting: unknown[] } => ({ recent: [], preExisting: [] }),
  describeStashAge: (): string => 'unknown age',
  STASH_RECENT_WINDOW_MS: 24 * 60 * 60 * 1000,
  // The action also pulls these for its bounded git plumbing; the sweep paths
  // exercised here never reach them with empty stash/submodule sets.
  runGitBounded: async () => ({ code: 0, stdout: '', stderr: '' }),
  gitTimeoutMsFor: () => 30_000,
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
/** EI-18799539619330782: every tagged-template READ, with its interpolated values —
 *  needed to assert the reads are tenant-scoped, not just the writes. */
const templateCalls: Array<{ text: string; values: unknown[] }> = [];

const fakeSql = Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]> => {
    const text = strings.join('?');
    templateCalls.push({ text, values });
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
// Spread the real module so pure exports (e.g. `generated`) survive the mock —
// a minimal stub breaks at collection when a transitive import derefs them (EI-14928).
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fakeSql }),
}));

// importing the action module registers `git-sync` into the system-action registry,
// exactly as production's register-system-actions side-effect import does.
import './git-sync-action';
import {
  fireGitSyncNow,
  isResolverInFlight,
  acquireWithContentionRetry,
  formatOwnHeadPublishedLine,
  isIntegratorActorAdmitted,
  mergeAttributionRosters,
  isGenericLockIntent,
} from './git-sync-action';
import { intentToSubject, DEFAULT_GIT_SYNC_SUBJECT } from './git-sync-attribution';
import type { OwnHeadPublishTickOutcome } from '../../sync/pot-git/own-head-publish';

describe('isIntegratorActorAdmitted — canonical signer membership gate (WI-38968)', () => {
  it('admits only an exact device pubkey present in the Pot roster', () => {
    expect(isIntegratorActorAdmitted('device-b', ['device-a', 'device-b'])).toBe(true);
    expect(isIntegratorActorAdmitted('device-c', ['device-a', 'device-b'])).toBe(false);
  });

  it('never treats an empty actor or empty roster as admitted', () => {
    expect(isIntegratorActorAdmitted('', ['device-a'])).toBe(false);
    expect(isIntegratorActorAdmitted('device-a', [])).toBe(false);
  });
});
import { getSystemAction, getSystemActionEntry, type SystemActionCtx } from '../routines/system-actions';

// --- helpers over the captured PG writes ------------------------------------------

/** ALL JSONB patches applied to the routine's metadata, in order (breadcrumb included).
 *
 *  EI-18799539619330782: patchRoutineMetadata's params are `[slug, workspaceId, patch]`
 *  — the patch is params[2], NOT params[1] (which is now the tenant scope). */
const allRoutinePatches = (): Array<Record<string, unknown>> =>
  unsafeCalls
    .filter((c) => c.text.includes('UPDATE harness_shared.routines'))
    .map((c) => JSON.parse(String(c.params[2])) as Record<string, unknown>);

/** EI-18799539619330782: the workspace_id every routine-metadata UPDATE was scoped to.
 *  An unscoped UPDATE is unbounded across tenants sharing an install_slug. */
const routineUpdateWorkspaceIds = (): unknown[] =>
  unsafeCalls.filter((c) => c.text.includes('UPDATE harness_shared.routines')).map((c) => c.params[1]);

/** WI-1416: the `fire_started_at` breadcrumb patched at the very top of every fire. */
const fireBreadcrumbs = (): Array<Record<string, unknown>> =>
  allRoutinePatches().filter((p) => 'fire_started_at' in p);

/** JSONB patches applied to the routine's metadata (recordOutcome + resolver markers) —
 *  the WI-1416 fire_started_at breadcrumb and the stash-check's per-tick
 *  known_stash_shas baseline excluded so outcome assertions stay focused. */
const routinePatches = (): Array<Record<string, unknown>> =>
  allRoutinePatches().filter((p) => !('fire_started_at' in p) && !('known_stash_shas' in p));

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
  strandedSubmodules: [],
};
const conflictOutcome: GitSyncOutcome = {
  status: 'conflict',
  conflicts: [{ scope: 'libs/generic/sync', conflictedFiles: ['src/a.ts', 'src/b.ts'] }],
  errors: [],
  pushed: ['libs/papercusp'],
  merged: [],
  oversized: [],
  contentErrors: [],
  strandedSubmodules: [],
};
const errorOutcome: GitSyncOutcome = {
  status: 'error',
  errors: [{ scope: 'superproject', message: 'push failed: HTTP 500' }],
  pushed: [],
  merged: [],
  oversized: [],
  contentErrors: [],
  strandedSubmodules: [],
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
  strandedSubmodules: [],
};

const action = getSystemAction('git-sync')!;

beforeEach(() => {
  tryAcquireResourceMock.mockReset();
  tryReleaseResourceMock.mockReset();
  liveLockedPathsMock.mockReset();
  liveLockedPathsMock.mockResolvedValue([]);
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
  templateCalls.length = 0;
  txQueries.length = 0;
  registryProjects = [{ slug: 'papercup', path: repoDir }];
  ambientRegistryProjects = null;
  loadHarnessRegistryMock.mockClear();
  potGitMode = 'legacy';
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
    runGitSyncMock.mockResolvedValue({ status: 'nothing', oversized: [], contentErrors: [], strandedSubmodules: [] });

    await action(ctx);

    const first = allRoutinePatches()[0];
    expect(first).toEqual({ fire_started_at: expect.any(Number) });
  });

  it('stamps the breadcrumb even on an ineligible (skipped) tick — a gate-stalled fire is still visible', async () => {
    registryProjects = []; // no registry entry → no_path skip
    await action(ctx);
    expect(fireBreadcrumbs()).toEqual([{ fire_started_at: expect.any(Number) }]);
    expect(routinePatches()[0]).toMatchObject({
      last_status: 'skipped',
      local_sync_status: 'skipped',
      last_skip_reason: 'no_path',
    });
  });

  it('a COMPLETED tick resets reaped_count to 0 (recordOutcome) — the reaper counter reads as CONSECUTIVE reaps', async () => {
    runGitSyncMock.mockResolvedValue(syncedOutcome);

    await action(ctx);
    expect(routinePatches()[0]).toMatchObject({ last_status: 'synced', reaped_count: 0 });
  });

  it('returns the typed pipeline outcome to the on-demand fire seam', async () => {
    runGitSyncMock.mockResolvedValue(syncedOutcome);

    const result = await fireGitSyncNow(ctx.installSlug, ctx.workspaceId);

    expect(result).toMatchObject({ status: 'synced', headSha: syncedOutcome.headSha, pushed: syncedOutcome.pushed });
  });

  it('scopes every registry read and runs the exact path pinned by a manual fire when an ambient sibling exists', async () => {
    const canonicalRepo = join(tmpRoot, 'canonical-repo');
    const ambientSibling = join(tmpRoot, 'ambient-sibling');
    mkdirSync(join(canonicalRepo, '.git'), { recursive: true });
    mkdirSync(join(ambientSibling, '.git'), { recursive: true });
    registryProjects = [{ slug: 'papercup', path: canonicalRepo }];
    ambientRegistryProjects = [{ slug: 'papercup', path: ambientSibling }];
    runGitSyncMock.mockResolvedValue({ status: 'nothing', oversized: [], contentErrors: [], strandedSubmodules: [] });

    await fireGitSyncNow('papercup', 'ws-42', canonicalRepo);

    expect(runGitSyncMock).toHaveBeenCalledWith('papercup', expect.objectContaining({ repoPath: canonicalRepo }));
    expect(loadHarnessRegistryMock).toHaveBeenCalled();
    expect(loadHarnessRegistryMock.mock.calls.every(([workspaceId]) => workspaceId === 'ws-42')).toBe(true);
    expect(runGitSyncMock).not.toHaveBeenCalledWith(
      'papercup',
      expect.objectContaining({ repoPath: ambientSibling }),
    );
  });
});

/**
 * EI-18799539619330782 — routine-metadata access is TENANT-SCOPED.
 *
 * `harness_shared.routines` is keyed on (workspace_id, install_slug, target_role), and
 * `install_slug` is NOT unique across workspaces. Every read/write here used to filter on
 * `install_slug = $slug AND target_role = 'system:git-sync'` ALONE, which means:
 *   - the two UPDATEs were UNBOUNDED — with N workspaces holding the same install slug, one
 *     tick overwrote all N tenants' metadata with this tenant's state; and
 *   - the reads used `LIMIT 1` with no ORDER BY, so WHICH tenant's row came back was arbitrary.
 * That metadata is what `bootstrap.ok` / `bootstrap.converged` are read from, so the damage
 * surfaces as a corrupted release trust-surface on exactly the federated multi-workspace
 * install this ships to. This is the same failure shape already proven in WI-5125.
 *
 * These tests are the regression guard for the CLASS, not for one call site: they assert over
 * EVERY routines statement a tick issues, so a newly-added unscoped read or write fails here
 * rather than silently reintroducing cross-tenant access.
 */
describe('EI-18799539619330782: git-sync routine-metadata access is tenant-scoped', () => {
  const routineReads = () => templateCalls.filter((c) => c.text.includes('harness_shared.routines'));
  const routineWrites = () => unsafeCalls.filter((c) => c.text.includes('UPDATE harness_shared.routines'));

  /*
   * Driven across EVERY tick outcome on purpose. A plain `synced` tick never reaches
   * `resolverInFlight` / `contentFixerInFlight` — those reads sit behind the conflict and
   * content-error paths. Proven, not assumed: reverting both a read AND the write predicate
   * made ONLY the write assertion fire on a synced-only run, i.e. a synced-only guard would
   * have let an unscoped conflict-path read straight through.
   */
  it.each([
    ['synced', syncedOutcome],
    ['conflict', conflictOutcome],
    ['error', errorOutcome],
    ['content-error', contentErrorOutcome],
  ] as const)(
    'scopes EVERY routines read AND write to the ticking workspace on a %s tick — a peer tenant sharing the install_slug cannot be read or clobbered',
    async (_label, outcome) => {
      runGitSyncMock.mockResolvedValue(outcome);
      // The conflict / content-error paths legitimately warn (resolver + fixer dispatch);
      // this suite runs vitest-fail-on-console, so silence it. We assert on the SQL, not
      // on the logging, which those paths' own dedicated tests already cover.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        // A DIFFERENT workspace than the suite default ('ws-42'), so a hardcoded or
        // defaulted scope cannot pass this by coincidence.
        await action({ ...ctx, workspaceId: 'ws-99' });

        // Guard the guard: if a refactor stops issuing routines statements entirely,
        // the per-statement loops below would vacuously pass.
        expect(routineReads().length).toBeGreaterThan(0);
        expect(routineWrites().length).toBeGreaterThan(0);

        for (const read of routineReads()) {
          expect(read.text).toContain('workspace_id =');
          expect(read.values).toContain('ws-99');
        }
        for (const write of routineWrites()) {
          // params are [slug, workspaceId, patch] — the predicate binds $2.
          expect(write.text).toContain('workspace_id = $2');
          expect(write.params[1]).toBe('ws-99');
        }
      } finally {
        warn.mockRestore();
      }
    },
  );

  it('binds the scope from the tick context, not a constant — a second tenant scopes to ITS own workspace', async () => {
    runGitSyncMock.mockResolvedValue(syncedOutcome);

    await action({ ...ctx, workspaceId: 'ws-tenant-b' });

    expect(routineWrites().length).toBeGreaterThan(0);
    expect(routineWrites().map((w) => w.params[1])).toEqual(routineWrites().map(() => 'ws-tenant-b'));
    // and nothing leaked the other tenant's id into the scope position
    expect(routineWrites().map((w) => w.params[1])).not.toContain('ws-42');
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

  it('SKIPS after workspace-lock contention exhausts retries — it never runs unlocked', async () => {
    vi.useFakeTimers();
    try {
      const contention = Object.assign(
        new Error('workspace "ws-42" contended (pg 57014: lock/statement timeout)'),
        { name: 'WorkspaceContendedError', pgCode: '57014' },
      );
      tryAcquireResourceMock.mockRejectedValue(contention);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const running = fireGitSyncNow('papercup', 'ws-42');
      await vi.advanceTimersByTimeAsync(6_000);
      const outcome = await running;

      expect(outcome).toEqual({
        status: 'skipped',
        reason: 'lock_contended',
        blockedOn: 'git-sync:papercup',
      });
      expect(tryAcquireResourceMock).toHaveBeenCalledTimes(4); // initial + 3 bounded retries
      expect(runGitSyncMock).not.toHaveBeenCalled();
      expect(appendPipelineEventMock).not.toHaveBeenCalled();
      expect(routinePatches()).toEqual([]);
      expect(releasedResources()).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('lock contended after retries'));
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
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
      ttlSec: 600,
    });
    expect((tryAcquireResourceMock.mock.calls[0][1] as { owner: string }).owner).toMatch(/^system:git-sync:[0-9a-f-]+$/);
    // ONLY the per-slug name is auto-registered (idempotent ON CONFLICT DO NOTHING);
    // the extras are a human-registered coordination surface
    expect(registeredResources()).toEqual(['git-sync:papercup']);
    expect(txQueries.find((q) => q.text.includes('agent_resource_registry'))?.text)
      .toContain('ON CONFLICT (resource) DO NOTHING');
    expect(releasedResources()).toEqual(['libs-papercusp-submodule', 'git-sync', 'git-sync:papercup']);
  });

  it('EI-20744916065879285: passes live file-lock paths to the pure pipeline as protected exclusions', async () => {
    const protectedPaths = ['packages/operator-core/lib/harness/git-sync/run-git-sync.ts', 'libs/subA/subA.txt'];
    liveLockedPathsMock.mockResolvedValue(protectedPaths);
    runGitSyncMock.mockResolvedValue(syncedOutcome);

    await action(ctx);

    expect(liveLockedPathsMock).toHaveBeenCalledOnce();
    expect(runGitSyncMock.mock.calls[0]?.[1]).toMatchObject({ excludePaths: protectedPaths });
  });

  it('gives overlapping cron/manual fires distinct owners so the second fire backs off', async () => {
    let firstRunStarted!: () => void;
    const firstRunStartedPromise = new Promise<void>((resolve) => {
      firstRunStarted = resolve;
    });
    let releaseFirstRun!: () => void;
    const releaseFirstRunPromise = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    let activeOwner: string | null = null;
    tryAcquireResourceMock.mockImplementation(async (_tx, opts) => {
      const { resource, owner } = opts as { resource: string; owner: string };
      if (resource === 'git-sync:papercup') {
        if (activeOwner === null) activeOwner = owner;
        else if (activeOwner !== owner) return { ok: false, reason: 'held_exclusive' };
      }
      return { ok: true };
    });
    tryReleaseResourceMock.mockImplementation(async (_tx, opts) => {
      const { owner } = opts as { owner: string };
      if (owner === activeOwner) activeOwner = null;
      return { ok: true };
    });
    runGitSyncMock.mockImplementationOnce(async () => {
      firstRunStarted();
      await releaseFirstRunPromise;
      return syncedOutcome;
    });

    const first = action(ctx);
    await firstRunStartedPromise;
    const second = action(ctx);
    await second;

    // The second fire sees a foreign exclusive owner and never reaches the git
    // pipeline. A constant `system:git-sync` owner would incorrectly refresh
    // the first lease and make this assertion fail.
    expect(runGitSyncMock).toHaveBeenCalledTimes(1);
    const owners = tryAcquireResourceMock.mock.calls
      .filter(([, opts]) => (opts as { resource: string }).resource === 'git-sync:papercup')
      .map(([, opts]) => (opts as { owner: string }).owner);
    expect(owners).toHaveLength(2);
    expect(new Set(owners).size).toBe(2);
    expect(owners.every((owner) => /^system:git-sync:[0-9a-f-]+$/.test(owner))).toBe(true);

    releaseFirstRun();
    await first;
  });

  it('EI-20224276977835463: refreshes every held lease during a long run and stops refreshing before release', async () => {
    vi.useFakeTimers();
    try {
      let runStarted!: () => void;
      const runStartedPromise = new Promise<void>((resolve) => {
        runStarted = resolve;
      });
      let finishRun!: () => void;
      const finishRunPromise = new Promise<void>((resolve) => {
        finishRun = resolve;
      });
      runGitSyncMock.mockImplementationOnce(async () => {
        runStarted();
        await finishRunPromise;
        return syncedOutcome;
      });

      const running = action(ctx);
      await runStartedPromise;

      const initialResources = ['git-sync:papercup', 'git-sync', 'libs-papercusp-submodule'];
      expect(acquiredResources()).toEqual(initialResources);
      const initialOwner = (tryAcquireResourceMock.mock.calls[0][1] as { owner: string }).owner;

      await vi.advanceTimersByTimeAsync(60_000);

      expect(acquiredResources()).toEqual([...initialResources, ...initialResources]);
      for (const [, opts] of tryAcquireResourceMock.mock.calls.slice(3)) {
        expect(opts).toMatchObject({
          owner: initialOwner,
          mode: 'exclusive',
          ttlSec: 600,
        });
      }

      finishRun();
      await running;
      expect(releasedResources()).toEqual([...initialResources].reverse());

      const callsAfterRelease = tryAcquireResourceMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(tryAcquireResourceMock).toHaveBeenCalledTimes(callsAfterRelease);
    } finally {
      vi.useRealTimers();
    }
  });

  // WI-5960: the routine acquires `git-sync:<slug>` under `ctx.workspaceId || '*'`
  // (asserted as 'ws-42' above) — an agent's own `locks:acquire_resource {
  // resource: 'git-sync:<slug>' }` (the su playbook's documented tree-pause
  // mechanism) MUST land in that exact same domain, or its exclusive hold is
  // invisible to this routine's conflict check and git-sync commits straight
  // through it (observed live 2026-07-26: 6 commits landed during a held,
  // un-expired exclusive hold — coordination-domain.ts's `resourceLockDomain`/
  // `workspaceScopedLockDomain` is the fix). This pins the two sides of that
  // contract against EACH OTHER so a future edit to either side's fallback
  // (`|| '*'` here, `activeWorkspaceId() || '*'` there) can't silently diverge
  // without failing a test — set the SAME env var the routine's `ctx.workspaceId`
  // models, and assert coordination-domain.ts resolves to the identical domain.
  it('WI-5960: the acquired coordinationDomain for git-sync:<slug> agrees with coordination-domain.ts\'s own resourceLockDomain/workspaceScopedLockDomain', async () => {
    const savedEnv = process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_WORKSPACE_ID = 'ws-42'; // mirrors ctx.workspaceId used above
    try {
      runGitSyncMock.mockResolvedValue(syncedOutcome);
      await action(ctx);

      const acquiredDomain = (tryAcquireResourceMock.mock.calls[0][1] as { coordinationDomain: string })
        .coordinationDomain;
      expect(acquiredDomain).toBe('ws-42');
      // The exact invariant an su's locks:acquire_resource relies on: resolving
      // the SAME resource name through coordination-domain.ts's own logic must
      // land in the domain the routine actually acquired under.
      expect(resourceLockDomain('git-sync:papercup')).toBe(acquiredDomain);
      expect(workspaceScopedLockDomain()).toBe(acquiredDomain);
    } finally {
      if (savedEnv === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
      else process.env.PAPERCUSP_WORKSPACE_ID = savedEnv;
    }
  });

  it('a harness with NO extra_lock_resources acquires only its own per-slug resource', async () => {
    registryProjects = [{ slug: 'otherapp', path: repoDir }];
    runGitSyncMock.mockResolvedValue({ status: 'nothing', oversized: [], contentErrors: [], strandedSubmodules: [] });

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
      repoPath: repoDir,
      config: expect.objectContaining({ push: true, pushSubmodules: true }),
      deletionGuard: true,
      diffSubjects: true, // WI-38594: flag-driven (mock getFlag defaults true)
      step: expect.any(Function),
    });

    // { last_synced_at, last_status, head_sha } + the EI-18 counters on the metadata
    expect(routinePatches()).toEqual([
      expect.objectContaining({
        last_status: 'synced',
        local_sync_status: 'synced',
        last_synced_at: expect.any(Number),
        last_skip_reason: null,
        last_skipped_at: null,
        head_sha: 'abc123def456',
        local_sync_head_sha: 'abc123def456',
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
    // The strand clear (EI-20402093158205519) rides between them on its OWN phase: it is
    // deliberately NOT counter-gated, so a MEASURED-clean census clears on every status.
    expect(escalationClears()).toEqual([['git-sync-conflict'], ['git-sync-strand'], ['git-sync-error']]);
    const clears = unsafeCalls.filter((c) => c.text.includes('SET escalation = NULL'));
    expect(clears.map((c) => c.params[2])).toEqual(['git-sync', 'git-sync-strand', 'git-sync']); // phase
    expect(escalationUpserts()).toEqual([]);

    // no resolver business on a clean tick
    expect(resolveLaunchTargetForEventMock).not.toHaveBeenCalled();
    expect(loopbackFetchMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();

    // P-003 doc-freshness sweep rides a real sync, with the pre-sync HEAD
    expect(runDocSweepMock).toHaveBeenCalledExactlyOnceWith({
      harnessSlug: 'papercup',
      workspaceId: 'ws-42',
      repoRoot: repoDir,
      prevSha: 'prev-sha-000',
      headSha: 'abc123def456',
    });
  });

  it("a 'nothing' pass also clears escalations but records no head_sha and runs no doc sweep", async () => {
    runGitSyncMock.mockResolvedValue({ status: 'nothing', oversized: [], contentErrors: [], strandedSubmodules: [] });

    await action(ctx);

    const [patch] = routinePatches();
    expect(patch).toMatchObject({
      last_status: 'nothing',
      local_sync_status: 'nothing',
      consecutive_error_ticks: 0,
      consecutive_content_error_ticks: 0,
    });
    expect(patch).not.toHaveProperty('head_sha');
    expect(patch).not.toHaveProperty('local_sync_head_sha');
    // + the strand clear on its own phase (measured-clean census, not counter-gated).
    expect(escalationClears()).toEqual([['git-sync-conflict'], ['git-sync-strand'], ['git-sync-error']]);
    expect(runDocSweepMock).not.toHaveBeenCalled();
    expect(appendPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'git_sync', status: 'nothing' }));
  });

  it('maps the routine trigger_config onto the pipeline config', async () => {
    runGitSyncMock.mockResolvedValue({ status: 'nothing', oversized: [], contentErrors: [], strandedSubmodules: [] });

    await action({
      ...ctx,
      triggerConfig: {
        push: false,
        push_submodules: false,
        pushSubmoduleOrigins: false,
        branch: 'staging',
        remote: 'upstream',
        max_blob_bytes: 1024,
      },
    });

    expect(runGitSyncMock).toHaveBeenCalledWith('papercup', {
      repoPath: repoDir,
      config: {
        push: false,
        pushSubmodules: false,
        pushSubmoduleOrigins: false,
        branch: 'staging',
        remote: 'upstream',
        maxBlobBytes: 1024,
      },
      deletionGuard: true,
      diffSubjects: true, // WI-38594: flag-driven (mock getFlag defaults true)
      step: expect.any(Function),
    });
  });

  it.each(['bridged', 'p2p-only'] as const)(
    "EI-20232774599730947: %s mode makes the superproject truly commit-only while preserving submodule-origin sync",
    async (mode) => {
      potGitMode = mode;
      registryProjects = [{ slug: 'papercup', path: repoDir, hive_slug: 'papercup' }];
      runGitSyncMock.mockResolvedValue({ status: 'nothing', oversized: [], contentErrors: [], strandedSubmodules: [] });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await action(ctx);
      } finally {
        log.mockRestore();
      }

      expect(runGitSyncMock).toHaveBeenCalledWith('papercup', expect.objectContaining({
        config: expect.objectContaining({
          push: false,
          pushSubmoduleOrigins: true,
          reconcileSuperprojectOrigin: false,
          bridgeContainedReleaseMainOnCommitOnly: mode === 'bridged',
        }),
      }));
    },
  );

  it('EI-20232774599730947: a pre-seeded P2P member stays superproject commit-only and honors its explicit submodule-origin push', async () => {
    potGitMode = 'bridged';
    registryProjects = [{ slug: 'papercup', path: repoDir, hive_slug: 'papercup' }];
    runGitSyncMock.mockResolvedValue({ status: 'nothing', oversized: [], contentErrors: [], strandedSubmodules: [] });

    await action({
      ...ctx,
      triggerConfig: { push: false, pushSubmoduleOrigins: true },
    });

    expect(runGitSyncMock).toHaveBeenCalledWith('papercup', expect.objectContaining({
      config: expect.objectContaining({
        push: false,
        pushSubmoduleOrigins: true,
        reconcileSuperprojectOrigin: false,
      }),
    }));
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
    // a conflict tick clears no CONFLICT/ERROR escalation (the resolver clears those by
    // producing a clean pass). The strand clear is orthogonal and does fire: the census
    // measured clean, and a strand is independent of whether the merge succeeded.
    expect(escalationClears()).toEqual([['git-sync-strand']]);

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

  it('EI-20336929607862174: a fresh foreign-instance resolver marker suppresses cross-process overlap', async () => {
    runGitSyncMock.mockResolvedValue(conflictOutcome);
    // A different instance may be another healthy operator process sharing this
    // routine row. Freshness + status, not instance equality, owns liveness.
    resolverRows = [{ lr: { status: 'dispatched', at: Date.now() - 60_000, instance: 'other-live-operator' } }];

    await action(ctx);

    expect(loopbackFetchMock).not.toHaveBeenCalled();
    expect(routinePatches().some((p) => 'last_resolver' in p)).toBe(false);
    expect(appendPipelineEventMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'merge_resolver' }),
    );
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

  it('EI-20336929607862174: a fresh DIFFERENT-instance marker is still in flight (shared multi-process dedup)', () => {
    expect(isResolverInFlight({ status: 'dispatched', at: NOW - 60_000, instance: 'other-live-operator' }, NOW, ME)).toBe(true);
    // A genuinely orphaned writer is released by the bounded TTL, never by guessing
    // liveness from process-instance inequality.
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
    // an error tick must NOT clear an open conflict escalation either — only the strand
    // row (own phase/kind, measured-clean census) clears on an error tick.
    expect(escalationClears()).toEqual([['git-sync-strand']]);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(loopbackFetchMock).not.toHaveBeenCalled();
  });

  it('clears a prior conflict escalation when the merge completed before a push error', async () => {
    runGitSyncMock.mockResolvedValue({
      ...errorOutcome,
      mergeCompleted: ['superproject'],
    });
    counterRows = [{ et: 0, lo: [] }];

    await action(ctx);

    // The push still failed, but the producer proved the fetch+merge stage completed
    // without conflicts. Retire only the conflict row plus the independently measured
    // strand row; do not require a misleading `synced` outcome.
    expect(escalationClears()).toEqual([['git-sync-conflict'], ['git-sync-strand']]);
    expect(routinePatches()[0]).toMatchObject({
      last_merge_completed: ['superproject'],
      last_merge_completed_at: expect.any(Number),
    });
    expect(appendPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'git_sync',
        status: 'error',
        detail: expect.objectContaining({ mergeCompleted: ['superproject'] }),
      }),
    );
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
    // (the strand row still clears — own phase/kind, measured-clean census).
    expect(resolveLaunchTargetForEventMock).not.toHaveBeenCalled();
    expect(loopbackFetchMock).not.toHaveBeenCalled();
    expect(escalationClears()).toEqual([['git-sync-strand']]);

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

  it('WI-37471: an unsafe-deletion offender gets an escalate-only kickoff, never "fix the syntax"', async () => {
    runGitSyncMock.mockResolvedValue({
      ...contentErrorOutcome,
      contentErrors: [
        {
          scope: 'superproject',
          file: 'packages/operator-core/lib/retired-module.ts',
          detectorKey: 'unsafe-deletion',
          error: 'deleting this file would break a still-live import — still imported (relative) by: packages/operator-core/lib/caller.ts. Either restore this file, or finish the deletion by removing the import(s) from the listed file(s) first.',
          fixerRole: 'content-fixer',
        },
      ],
    });
    counterRows = [{ et: 0, lo: [], ct: 0 }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    expect(loopbackFetchMock).toHaveBeenCalledTimes(1);
    const [, init] = loopbackFetchMock.mock.calls[0];
    const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
    // must steer the fixer to escalate this detectorKey, and must NOT claim it's a syntax fix
    expect(body.kickoff).toContain('unsafe-deletion');
    expect(body.kickoff).toContain('escalate');
    expect(body.kickoff).not.toContain('Fix ONLY the syntax so each passes its detector');
    warn.mockRestore();
  });

  it('a mixed batch (mdx + unsafe-deletion) still gets the detector-aware kickoff, not the plain syntax-fix text', async () => {
    runGitSyncMock.mockResolvedValue({
      ...contentErrorOutcome,
      contentErrors: [
        ...contentErrorOutcome.contentErrors,
        {
          scope: 'superproject',
          file: 'packages/operator-core/lib/retired-module.ts',
          detectorKey: 'unsafe-deletion',
          error: 'deleting this file would break a still-live import — still imported (relative) by: packages/operator-core/lib/caller.ts. Either restore this file, or finish the deletion by removing the import(s) from the listed file(s) first.',
          fixerRole: 'content-fixer',
        },
      ],
    });
    counterRows = [{ et: 0, lo: [], ct: 0 }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    const [, init] = loopbackFetchMock.mock.calls[0];
    const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
    expect(body.kickoff).toContain('unsafe-deletion');
    expect(body.kickoff).not.toContain('Fix ONLY the syntax so each passes its detector');
    warn.mockRestore();
  });

  it('does NOT dispatch a second content-fixer while another live operator instance owns the fresh marker', async () => {
    runGitSyncMock.mockResolvedValue(contentErrorOutcome);
    counterRows = [{ et: 0, lo: [], ct: 1 }];
    // A content-fixer recorded 1 min ago by another live operator process has not
    // settled. Instance inequality must never overlap a second 6-GiB agent scope.
    contentFixerRows = [{ lr: { status: 'dispatched', at: Date.now() - 60_000, instance: 'other-live-operator' } }];

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

describe('EI-20402093158205519 stranded-submodule census (git-sync-strand)', () => {
  /** Strand escalation upserts — their OWN phase, never the conflict/content rows. */
  const strandUpserts = () => escalationUpserts().filter((u) => u.params[1] === 'git-sync-strand');
  /** Strand escalation clears — the UPDATE ... SET escalation = NULL on our phase. */
  const strandClears = () =>
    unsafeCalls.filter((c) => c.text.includes('SET escalation = NULL') && c.params[2] === 'git-sync-strand');

  /** A tick that synced the visible tree while two unregistered submodules held work. */
  const strandedOutcome: GitSyncOutcome = {
    ...syncedOutcome,
    strandedSubmodules: [
      { path: 'libs/papergrid', trackedFiles: 2, files: ['grid-core/src/RichGrid.tsx', 'grid-core/src/index.ts'] },
      { path: 'libs/sync', trackedFiles: 1, files: ['package.json'] },
    ],
  };

  beforeEach(() => {
    counterRows = [{ et: 0, lo: [], ct: 0 }];
  });

  it('a strand tick writes the escalation on its OWN phase, naming the files and the fix', async () => {
    runGitSyncMock.mockResolvedValue(strandedOutcome);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    const ups = strandUpserts();
    expect(ups).toHaveLength(1);
    expect(ups[0].text).toContain('INSERT INTO harness_shared.harness_escalations');
    expect(ups[0].params[1]).toBe('git-sync-strand');
    expect(ups[0].body).toMatchObject({
      kind: 'git-sync-strand',
      harness_slug: 'papercup',
      stranded_submodule_count: 2,
      stranded_file_count: 3,
    });
    // The body must name the FILES, not just a count: the failure mode is an agent
    // believing an edit landed, so a reader has to see WHICH edits did not.
    expect(ups[0].body.submodules).toEqual([
      { path: 'libs/papergrid', tracked_files: 2, files: ['grid-core/src/RichGrid.tsx', 'grid-core/src/index.ts'] },
      { path: 'libs/sync', tracked_files: 1, files: ['package.json'] },
    ]);
    // ...and the actionable fix, not just the diagnosis.
    expect(String(ups[0].body.detail)).toContain('git submodule init');
    warn.mockRestore();
  });

  it('a MEASURED-clean tick ([]) clears the strand escalation (own phase + kind)', async () => {
    runGitSyncMock.mockResolvedValue(syncedOutcome); // strandedSubmodules: []

    await action(ctx);

    const clears = strandClears();
    expect(clears).toHaveLength(1);
    expect(clears[0].params[3]).toEqual(['git-sync-strand']);
    expect(strandUpserts()).toEqual([]);
  });

  it('an UNMEASURED tick (null) neither writes NOR clears — an unmeasured pass must not retire a live warning', async () => {
    // This is the design decision the nullable type exists to enforce (see
    // GitSyncOutcome.strandedSubmodules). `null` = the census did not RUN; collapsing it
    // into `[]` would let a pass that measured NOTHING silently retire a real strand
    // warning — the exact silence the whole field exists to break. If a future refactor
    // drops the tri-state, this is the test that fails.
    runGitSyncMock.mockResolvedValue({ ...syncedOutcome, strandedSubmodules: null });

    await action(ctx);

    expect(strandUpserts()).toEqual([]);
    expect(strandClears()).toEqual([]);
  });

  it('a strand rides ALONGSIDE a conflict — separate phase rows, neither clobbering the other', async () => {
    // A strand must not make the pass fail, and must not contend for the 'git-sync' row a
    // merge-resolver may be reading. Both rows are written, on their own phases.
    runGitSyncMock.mockResolvedValue({
      ...conflictOutcome,
      strandedSubmodules: [{ path: 'libs/papergrid', trackedFiles: 1, files: ['grid-core/src/RichGrid.tsx'] }],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    const phases = escalationUpserts().map((u) => u.params[1]);
    expect(phases).toContain('git-sync');
    expect(phases).toContain('git-sync-strand');
    // The strand write targets ONLY its own phase row.
    expect(strandUpserts()).toHaveLength(1);
    // ...and does not clear the conflict row it rode in with.
    expect(strandClears()).toEqual([]);
    warn.mockRestore();
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

describe('EI-17 deletion-guard kill-switch flag', () => {
  const runGitSyncOpts = (): { deletionGuard?: unknown } =>
    runGitSyncMock.mock.calls[0][1] as { deletionGuard?: unknown };

  it('flag ON (default): runGitSync runs with the deletion guard active', async () => {
    runGitSyncMock.mockResolvedValue(syncedOutcome);

    await action(ctx);

    expect(runGitSyncOpts().deletionGuard).toBe(true);
    expect(getFlagMock).toHaveBeenCalledWith('papercusp-git-sync-deletion-guard', 'papercup');
  });

  it('flag OFF (kill-switch): runGitSync runs with the deletion guard disabled — commits as before this plan', async () => {
    getFlagMock.mockImplementation(async (key: string) => key !== 'papercusp-git-sync-deletion-guard');
    runGitSyncMock.mockResolvedValue(syncedOutcome);

    await action(ctx);

    expect(runGitSyncOpts().deletionGuard).toBe(false);
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

// EI-19341838904344665 recurrence guard: the own-head "published" log line used to
// name `outcome.headSha` (the worktree head JUDGED this tick, current by
// construction) rather than `outcome.publishedSha` (what actually became
// servable) — a false, authoritative-looking line that produced two OPPOSITE
// wrong diagnoses from two separate agents during the 2026-08-02 freeze.
describe('formatOwnHeadPublishedLine (EI-19341838904344665)', () => {
  const baseOutcome: OwnHeadPublishTickOutcome = {
    ran: true,
    changed: true,
    branch: 'staging',
    headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    priorSha: null,
    refused: null,
    exemptedFindings: [],
    errors: [],
  };

  it('names publishedSha, never headSha, as what was published', () => {
    const line = formatOwnHeadPublishedLine('papercusp', {
      ...baseOutcome,
      publishedSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      backlogRemains: false,
    });
    expect(line).toContain('published staging@bbbbbbbbbbbb');
    expect(line).not.toContain('aaaaaaaaaaaa'); // the worktree head must NOT appear as "published"
  });

  // The exact live-incident shape: the namespace ref had advanced only to a sha
  // five days older than the worktree head — publishedSha trails headSha by a lot.
  it('says BACKLOG REMAINS and names the worktree head separately when backlogRemains is true', () => {
    const line = formatOwnHeadPublishedLine('papercusp', {
      ...baseOutcome,
      publishedSha: '31a771a131a771a131a771a131a771a131a771a1',
      headSha: '66908db5bf66908db5bf66908db5bf66908db5bf',
      backlogRemains: true,
    });
    expect(line).toBe(
      '[git-sync] papercusp: own-head published staging@31a771a131a7 into own namespace ' +
        '(BACKLOG REMAINS; worktree head 66908db5bf66)',
    );
  });

  it('says "published nothing" rather than a stale sha when publishedSha is absent', () => {
    const line = formatOwnHeadPublishedLine('papercusp', {
      ...baseOutcome,
      publishedSha: null,
      backlogRemains: false,
    });
    expect(line).toBe('[git-sync] papercusp: own-head published staging@nothing into own namespace');
  });

  it('omits the backlog note entirely when caught up (no dangling parenthetical)', () => {
    const line = formatOwnHeadPublishedLine('papercusp', {
      ...baseOutcome,
      publishedSha: 'cccccccccccccccccccccccccccccccccccccccc',
      backlogRemains: false,
    });
    expect(line).not.toContain('BACKLOG REMAINS');
    expect(line).not.toContain('(');
  });
});

describe("WI-37668: the lock hook's sentinel intent never becomes a commit subject", () => {
  // The per-edit lock hook acquires with intent `PreToolUse:<tool>` (pretooluse-locks-acquire.sh
  // :752) and locks:acquire persists that verbatim into the edit ledger. Measured 2026-08-10:
  // 3,180 of ~3,260 rows in a 24h window (97.5%) carry exactly that sentinel. Because it is
  // NON-EMPTY, intentToSubject would render it as the commit subject for nearly every attributed
  // commit on the fleet-wide hot path — strictly worse than the single auto-commit message.
  const entry = (agent: string, intent: string | undefined, files = ['packages/a.ts']) => ({
    agent,
    intent,
    files,
    workItems: [] as string[],
    planSlug: undefined,
    sessionId: undefined,
  });

  it("REGRESSION GUARD: a PreToolUse sentinel is replaced by the agent's DECLARED intent", () => {
    const merged = mergeAttributionRosters(
      [entry('su-1', 'PreToolUse:Edit')],
      [entry('su-1', 'WI-37668: fix derived attribution scoping', [])],
    );
    // Falsifiable: pre-fix this asserted value was the raw 'PreToolUse:Edit'.
    expect(merged[0].intent).toBe('WI-37668: fix derived attribution scoping');
    expect(merged[0].intent).not.toMatch(/PreToolUse/);
  });

  it('a sentinel with NO declared intent yields undefined ⇒ the DEFAULT subject, never the sentinel', () => {
    const merged = mergeAttributionRosters([entry('su-2', 'PreToolUse:Write')], []);
    expect(merged[0].intent).toBeUndefined();
    // The point of the whole guard: the subject degrades to today's message, not a leaked hook name.
    expect(intentToSubject(merged[0].intent, 'su · su-2')).toBe(DEFAULT_GIT_SYNC_SUBJECT);
  });

  it('a REAL declared ledger intent is preserved verbatim (the fix must not flatten good data)', () => {
    const real = 'P-004: per-agent commit attribution';
    const merged = mergeAttributionRosters([entry('su-3', real)], [entry('su-3', 'other')]);
    expect(merged[0].intent).toBe(real);
  });

  it('the ledger keeps FILE authority — presence is consulted for the SUBJECT only', () => {
    const merged = mergeAttributionRosters(
      [entry('su-4', 'PreToolUse:Edit')],
      [entry('su-4', 'declared work', ['packages/z.ts'])],
    );
    // Ledger entry stays first (attributionMapForRepo is first-wins) and keeps its own files.
    expect(merged[0].files).toEqual(['packages/a.ts']);
    expect(merged[0].intent).toBe('declared work');
    // Presence still appended, so it can fill files the ledger window missed.
    expect(merged[1].files).toEqual(['packages/z.ts']);
  });

  it("does not borrow a DIFFERENT agent's intent", () => {
    const merged = mergeAttributionRosters(
      [entry('su-5', 'PreToolUse:Edit')],
      [entry('su-OTHER', "someone else's work")],
    );
    expect(merged[0].intent).toBeUndefined();
  });

  it('LIVE-CAUGHT BUG: recovers the intent of an agent that declared NO files (the presence roster drops it)', () => {
    // Measured on the real hot path 2026-08-10: loadAttributionRoster filters presence to
    // `files.length > 0`, but the ledger exists precisely to attribute agents who never declared
    // files — so deriving the intent map from the FILTERED roster recovered nothing and every
    // subject fell to the default. The map must span ALL live agents, which is why it is passed in.
    const declaredIntents = new Map([['su-6', 'Resume P-001 code half: rename goal-pot surface']]);
    const merged = mergeAttributionRosters(
      [entry('su-6', 'PreToolUse:Edit')],
      [], // presence roster is EMPTY — su-6 declared no current_files
      declaredIntents,
    );
    expect(merged[0].intent).toBe('Resume P-001 code half: rename goal-pot surface');
  });

  it('an explicit intent map takes precedence over deriving from the presence array', () => {
    const merged = mergeAttributionRosters(
      [entry('su-7', 'PreToolUse:Edit')],
      [entry('su-7', 'stale roster intent')],
      new Map([['su-7', 'authoritative intent']]),
    );
    expect(merged[0].intent).toBe('authoritative intent');
  });

  it('isGenericLockIntent treats blank and both hook phases as unusable', () => {
    for (const bad of ['', '   ', 'PreToolUse:Edit', 'PreToolUse:Write', 'PostToolUse:Edit', 'pretooluse:multiedit']) {
      expect(isGenericLockIntent(bad)).toBe(true);
    }
    for (const good of ['WI-1: real work', 'fix the thing']) {
      expect(isGenericLockIntent(good)).toBe(false);
    }
  });
});
