/**
 * Orchestration behavior of the `system:git-sync` routine action
 * (app-wide-test-coverage-2026-06-05 P-007). The pure pipeline (run-git-sync)
 * and the escalation decision core (git-sync-escalation) have their own suites;
 * THIS suite pins the live wiring around them:
 *
 *   - P-009/P-006 lock discipline (git-sync-any-hive: PER-SLUG resources): the
 *     tick acquires shared `git-sync` (the workspace-wide restart barrier), then
 *     `git-sync:<slug>` (auto-registered in the same txn) plus the routine's
 *     `trigger_config.extra_lock_resources` (papercup: the legacy `git-sync` +
 *     `libs-papercusp-submodule` back-off names; the legacy global name is
 *     filtered from the exclusive extras). Peer-held lock → skip the tick
 *     (back-pressure, partial acquisitions released); exhausted workspace
 *     contention → skip after bounded retry; an UNKNOWN extra name → skip with
 *     a loud log (never auto-registered); lock INFRA error → proceed UNLOCKED
 *     (fail-open); every fire uses a distinct lock owner so cron/manual fires
 *     cannot coalesce; long runs refresh every held lease in its mode before its
 *     TTL; locks released after the run — success, error, and throw.
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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { GitSyncOutcome, RunGitSyncOpts } from './run-git-sync';
import { configureScheduledRegistry, resetScheduledRegistry, type TimerHandle } from '@papercusp/scheduled-registry';
// WI-5960: NOT mocked — the real implementation, so the invariant test below
// pins the ACTUAL cross-module agreement (a mock would just assert against
// itself and could drift silently alongside a real-code regression).
import { resourceLockDomain, workspaceScopedLockDomain } from '../../agent-tools/locks/coordination-domain';

// --- mocks (factories only close over these; nothing dereferenced at hoist time) --
// These tests exercise routine orchestration, with no real hive or bare store.
// The real PG + Git generation seam is covered by signed-context-store.integration.test.ts.
vi.mock('../../hive-store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getHiveBySlug: async () => ({ pubkeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }),
}));
vi.mock('../../sync/pot-git/signed-context-store', () => ({
  resolveStoreProtocolContext: async ({ scope }: { scope: { hive_id: string; repo_key: string } }) => ({
    ...scope,
    store_generation: 'sg2-1-' + 'a'.repeat(40),
  }),
}));
// Production now awaits the existing lazy-boot recovery when no serving handle
// is discoverable. Keep this orchestration suite hermetic: legacy cases that
// are not about serving recovery should receive the same fast unavailable
// state they asserted before WI-10000734, never boot a real local substrate.
// The focused recovery cases below inject their own successful/failed seams.
vi.mock('../../sync/hyperbee/boot-all', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/hyperbee/boot-all')>()),
  getBootedHarness: () => null,
  bootSingleHarness: async () => ({ state: 'failed', error: 'test fixture has no serving handle' }),
}));
vi.mock('../../sync/hyperbee/substrate-booted-handles-pg', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/hyperbee/substrate-booted-handles-pg')>()),
  getPgGitServingCapability: async () => ({
    status: 'absent',
    retryable: true,
    reason: 'test fixture has no serving advertisement',
  }),
}));
const tryAcquireResourceMock = vi.fn(
  async (
    _tx: unknown,
    _opts: Record<string, unknown>,
  ): Promise<{ ok: boolean; reason?: string; holders?: unknown[] }> => ({ ok: true }),
);
const tryReleaseResourceMock = vi.fn(
  async (_tx: unknown, _opts: Record<string, unknown>): Promise<{ ok: boolean; released?: number }> => ({ ok: true }),
);
const releaseAllResourcesForOwnerMock = vi.fn(async (_tx: unknown, _coordinationDomain: string, _owner: string) => ({
  released: 3,
  exclusiveResources: [],
  waiters: {},
}));
const heldResourcesByOwner = new Map<string, string[]>();
const releaseTrace: string[] = [];
const readResourceQueueMock = vi.fn(async (_tx: unknown, _opts: Record<string, unknown>) => ({
  holders: [] as Array<Record<string, unknown>>,
  draining: false,
  queue: [] as Array<Record<string, unknown>>,
}));
const clearResourceExclusiveQueueMock = vi.fn(
  async (_tx: unknown, _coordinationDomain: string, _resource: string, _owner: string) => undefined,
);
const clearResourceWaiterMock = vi.fn(
  async (_tx: unknown, _coordinationDomain: string, _resource: string, _owner: string) => undefined,
);
vi.mock('../../agent-tools/locks/su-lock-store', () => ({
  tryAcquireResource: async (...a: unknown[]) => {
    const opts = a[1] as { owner: string; resource: string };
    const result = await tryAcquireResourceMock(a[0], opts);
    if (result.ok) {
      const held = heldResourcesByOwner.get(opts.owner) ?? [];
      if (!held.includes(opts.resource)) held.push(opts.resource);
      heldResourcesByOwner.set(opts.owner, held);
    }
    return result;
  },
  tryReleaseResource: async (...a: unknown[]) => {
    const opts = a[1] as { owner: string; resource?: string };
    if (opts.resource) releaseTrace.push(opts.resource);
    const result = await tryReleaseResourceMock(a[0], opts);
    if (opts.resource) {
      const held = heldResourcesByOwner.get(opts.owner) ?? [];
      heldResourcesByOwner.set(
        opts.owner,
        held.filter((resource) => resource !== opts.resource),
      );
    }
    return result;
  },
  releaseAllResourcesForOwner: async (...a: unknown[]) => {
    const owner = a[2] as string;
    const held = heldResourcesByOwner.get(owner) ?? [];
    const result = await releaseAllResourcesForOwnerMock(a[0], a[1] as string, owner);
    // A failed bulk transaction leaves every row intact; only trace the reverse
    // release order after the mocked transaction commits successfully.
    releaseTrace.push(...[...held].reverse());
    heldResourcesByOwner.delete(owner);
    return result;
  },
  readResourceQueue: (...a: unknown[]) => readResourceQueueMock(a[0], a[1] as Record<string, unknown>),
  clearResourceExclusiveQueue: (...a: unknown[]) =>
    clearResourceExclusiveQueueMock(a[0], a[1] as string, a[2] as string, a[3] as string),
  clearResourceWaiter: (...a: unknown[]) =>
    clearResourceWaiterMock(a[0], a[1] as string, a[2] as string, a[3] as string),
}));

const liveLockHoldingsMock = vi.fn(async (): Promise<Array<{ path: string; owner: string; intent: string }>> => []);
const liveLockHoldingsStrictMock = vi.fn(
  async (): Promise<Array<{ path: string; owner: string; intent: string }>> => [],
);
vi.mock('../../agent-tools/locks/live-lock-paths', () => ({
  liveLockHoldings: () => liveLockHoldingsMock(),
  liveLockHoldingsStrict: () => liveLockHoldingsStrictMock(),
}));

// inWorkspaceTxn hands the callback a CALLABLE tagged-template fake tx — the lock
// store is mocked anyway, but the P-006 auto-register INSERT runs through the tx
// itself, so record those queries.
const txQueries: Array<{ text: string; values: unknown[] }> = [];
type FakeTx = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
const recordingTx: FakeTx = (strings, ...values) => {
  txQueries.push({ text: strings.join('?'), values });
  return Promise.resolve([]);
};
/** Swappable so one test can make a specific in-txn statement FAIL without
 *  re-mocking the module (WI-562584: a failed registry declaration must not
 *  cost the commit). Restored in beforeEach. */
let fakeTxImpl: FakeTx = recordingTx;
const fakeTx: FakeTx = (strings, ...values) => fakeTxImpl(strings, ...values);
const workspaceTxnCalls: Array<{ coordinationDomain: string; owner: string }> = [];
// EI-22078335832051825: the session half of the dead-holder reclaim. Mocked so
// no test here reaches the presence store / liveness oracle; the adapter's own
// rails are pinned in locks/ended-session-owners.test.ts. Default: nobody is
// dead — every existing held_exclusive expectation keeps its pre-fix meaning.
vi.mock('../../agent-tools/locks/ended-session-owners', () => ({
  endedSessionOwners: vi.fn(async (_owners: readonly string[]): Promise<ReadonlySet<string>> => new Set<string>()),
}));
vi.mock('../../agent-tools/locks/in-workspace-txn', () => ({
  inWorkspaceTxn: (coordinationDomain: string, owner: string, fn: (tx: unknown) => unknown) => {
    workspaceTxnCalls.push({ coordinationDomain, owner });
    return fn(fakeTx);
  },
}));

// Harness registry (P-008 gate): configurable per test; default = an eligible
// papercup entry pointing at a real on-disk repo dir (the gate stats the path).
let registryProjects: Array<Record<string, unknown>> = [];
let ambientRegistryProjects: Array<Record<string, unknown>> | null = null;
const loadHarnessRegistryMock = vi.fn(async (workspaceId?: string) => ({
  projects: workspaceId ? registryProjects : (ambientRegistryProjects ?? registryProjects),
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
// These orchestration tests model the background-worker owner by default. Do
// not inherit PAPERCUSP_BACKGROUND_WORKERS=0 from a request-only test runner:
// that would make every fire stop at the new production guard before reaching
// the behavior each test is intended to cover. The dedicated refusal test
// below flips to `0` and restores this baseline in its finally block.
const savedBackgroundWorkers = process.env.PAPERCUSP_BACKGROUND_WORKERS;
afterAll(() => {
  if (savedBackgroundWorkers === undefined) delete process.env.PAPERCUSP_BACKGROUND_WORKERS;
  else process.env.PAPERCUSP_BACKGROUND_WORKERS = savedBackgroundWorkers;
  rmSync(tmpRoot, { recursive: true, force: true });
});

const runGitSyncMock = vi.fn(
  async (_slug: string, _opts: Record<string, unknown>): Promise<GitSyncOutcome> => ({
    status: 'nothing',
    dirtyPathCount: 0,
    committedCount: 0,
    oversized: [],
    contentErrors: [],
    strandedSubmodules: [],
  }),
);
const runGitBoundedMock = vi.fn(async (..._args: unknown[]) => ({ code: 0, stdout: '', stderr: '' }));
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
  runGitBounded: (...args: unknown[]) => runGitBoundedMock(...args),
  gitTimeoutMsFor: () => 30_000,
  DEFAULT_MAX_BLOB_BYTES: 95 * 1024 * 1024,
  DEFAULT_MAX_COMMIT_TOTAL_BYTES: 250 * 1024 * 1024,
}));

type CompletionSettlementScope = {
  installSlug: string;
  workspaceId: string;
  repositoryRoot: string;
};
type CompletionSettlementProgress = {
  signal: AbortSignal;
  onProgress: (progress: { completed: number; total: number; featureId: string }) => void | Promise<void>;
};
const reconcileProposedCompletionsAtCommitMock = vi.fn(
  async (_commitSha: string, _scope: CompletionSettlementScope, _progress: CompletionSettlementProgress) => ({
    inspected: 0,
    upgraded: [],
    residual: 0,
    unreadable: [],
  }),
);
vi.mock('./completion-settlement-reconciler', () => ({
  reconcileProposedCompletionsAtCommit: (
    commitSha: string,
    scope: CompletionSettlementScope,
    progress: CompletionSettlementProgress,
  ) => reconcileProposedCompletionsAtCommitMock(commitSha, scope, progress),
}));

const runDependencyGenerationPrebuildMock = vi.fn(async (_request: Record<string, unknown>) => 'ready');
const enqueueDependencyPrebuildMock = vi.fn(async (_request: Record<string, unknown>) => true);
const recoverQueuedDependencyPrebuildMock = vi.fn(async (_target: Record<string, unknown>) => 'none');
vi.mock('../../release/dependency-generation-prebuild', () => ({
  runDependencyGenerationPrebuild: (request: Record<string, unknown>) => runDependencyGenerationPrebuildMock(request),
  enqueueDependencyPrebuild: (request: Record<string, unknown>) => enqueueDependencyPrebuildMock(request),
  recoverQueuedDependencyPrebuild: (target: Record<string, unknown>) => recoverQueuedDependencyPrebuildMock(target),
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

const emitGitSyncLockRetryEventMock = vi.fn();
const emitGitSyncCommittedEventMock = vi.fn();
vi.mock('./git-sync-events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./git-sync-events')>()),
  emitGitSyncLockRetryEvent: (...a: unknown[]) => emitGitSyncLockRetryEventMock(...a),
  emitGitSyncCommittedEvent: (...a: unknown[]) => emitGitSyncCommittedEventMock(...a),
}));

const INVOKE_URL = 'http://127.0.0.1:3070/api/agents/invoke?role=merge-resolver';
const CONTENT_FIX_URL = 'http://127.0.0.1:3070/api/agents/invoke?role=content-fixer';
const resolveLaunchTargetForEventMock = vi.fn(
  async (
    event: string,
    _opts: Record<string, unknown>,
  ): Promise<{ blueprintId: string; role: string; url: string } | null> =>
    event === 'git-sync:content-error'
      ? { blueprintId: 'content-fix', role: 'content-fixer', url: CONTENT_FIX_URL }
      : { blueprintId: 'merge-resolution', role: 'merge-resolver', url: INVOKE_URL },
);
vi.mock('../../blueprint/launch-blueprint', () => ({
  resolveLaunchTargetForEvent: (...a: unknown[]) =>
    resolveLaunchTargetForEventMock(a[0] as string, a[1] as Record<string, unknown>),
}));

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
const loopbackFetchMock = vi.fn(
  async (_url: string, _init?: Record<string, unknown>): Promise<FakeResponse> => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, exitCode: 0, timedOut: false }),
  }),
);
vi.mock('../../loopback-fetch', () => ({
  loopbackFetch: (...a: unknown[]) => loopbackFetchMock(a[0] as string, a[1] as Record<string, unknown>),
  describeFetchError: (error: unknown) => {
    const base = error instanceof Error ? error.message : String(error);
    const cause = (error as { cause?: { code?: string; message?: string } } | null)?.cause;
    if (!cause?.code || base.includes(cause.code)) return base;
    const detail = cause.message && cause.message !== base ? `: ${cause.message}` : '';
    return `${base} (${cause.code}${detail})`;
  },
}));

const sendMessageMock = vi.fn(async (_id: unknown, _msg: Record<string, unknown>): Promise<unknown> => ({ ok: true }));
vi.mock('../../agent-tools/coordination/messages', () => ({
  sendMessage: (...a: unknown[]) => sendMessageMock(a[0], a[1] as Record<string, unknown>),
}));

const upsertConditionWorkItemMock = vi.fn(async (conditionKey: string, _input: Record<string, unknown>) => ({
  conditionKey,
  id: 'WI-CONTENT-TEST',
  created: true,
}));
vi.mock('../../coord/condition-upsert', () => ({
  upsertConditionWorkItem: (...a: unknown[]) =>
    upsertConditionWorkItemMock(a[0] as string, a[1] as Record<string, unknown>),
}));

// Lazily imported by the action (best-effort doc-freshness sweep) — mock so the
// dynamic import never pulls the real docs machinery.
const captureHeadShaMock = vi.fn(async (_slug: string): Promise<string | null> => 'prev-sha-000');
const enqueueDocSweepMock = vi.fn((_input: Record<string, unknown>): void => {});
vi.mock('../docs/sweep-after-sync', () => ({
  captureHeadSha: (...a: unknown[]) => captureHeadShaMock(a[0] as string),
  enqueueDocFreshnessSweepAfterSync: (...a: unknown[]) => enqueueDocSweepMock(a[0] as Record<string, unknown>),
}));

// --- fake PG: the org `sql` is used as a tagged template (reads) + `.unsafe` (writes).
type Row = Record<string, unknown>;
/** Rows returned for the resolverInFlight read (`metadata->'last_resolver'`). */
let resolverRows: Array<{ lr: { status?: string; at?: number; instance?: string } | null }> = [];
/** Rows returned for the contentFixerInFlight read (`metadata->'last_content_fixer'`). */
let contentFixerRows: Array<{ lr: { status?: string; at?: number; instance?: string } | null }> = [];
/** Claimed values returned by the atomic content-fixer marker CAS. */
let contentFixerClaimResults: boolean[] = [];
/** Rows returned for the EI-18 + content counters read, including the prior offender signature. */
let counterRows: Array<{ et: number; lo: string[] | null; ct?: number; cs?: string | null }> = [];
/** One-shot setup failures injected at the exact post-lock boundaries under test. */
let rejectUnsafeAtCall: number | null = null;
let unsafeCallCount = 0;
/** One-shot routine activity-write failure keyed by the marker phase under test. */
let rejectGitSyncActivityPhaseOnce: string | null = null;
let rejectTemplateOnce: Error | null = null;
/** Every `sql.unsafe(text, params)` write, in order. */
const unsafeCalls: Array<{ text: string; params: unknown[] }> = [];
/** EI-18799539619330782: every tagged-template READ, with its interpolated values —
 *  needed to assert the reads are tenant-scoped, not just the writes. */
const templateCalls: Array<{ text: string; values: unknown[] }> = [];

const fakeSql = Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]> => {
    const text = strings.join('?');
    templateCalls.push({ text, values });
    if (rejectTemplateOnce) {
      const error = rejectTemplateOnce;
      rejectTemplateOnce = null;
      return Promise.reject(error);
    }
    if (text.includes("'last_content_fixer'")) return Promise.resolve(contentFixerRows as unknown as Row[]);
    if (text.includes("'last_resolver'")) return Promise.resolve(resolverRows as unknown as Row[]);
    if (text.includes('consecutive_error_ticks')) return Promise.resolve(counterRows as unknown as Row[]);
    return Promise.resolve([]);
  },
  {
    unsafe: (text: string, params: unknown[] = []): Promise<Row[]> => {
      unsafeCalls.push({ text, params });
      unsafeCallCount += 1;
      if (rejectUnsafeAtCall === unsafeCallCount) {
        rejectUnsafeAtCall = null;
        return Promise.reject(new Error('injected setup metadata write failure'));
      }
      if (rejectGitSyncActivityPhaseOnce && text.includes('UPDATE harness_shared.routines')) {
        try {
          const patch = JSON.parse(String(params[2])) as {
            git_sync_activity?: { phase?: string };
          };
          if (patch.git_sync_activity?.phase === rejectGitSyncActivityPhaseOnce) {
            rejectGitSyncActivityPhaseOnce = null;
            return Promise.reject(new Error('injected terminal activity metadata write failure'));
          }
        } catch {
          // Unrelated writes are not candidates for this phase-targeted failure.
        }
      }
      if (text.includes('RETURNING true AS claimed')) {
        const claimed = contentFixerClaimResults.length > 0 ? contentFixerClaimResults.shift() : true;
        return Promise.resolve([{ claimed }] as Row[]);
      }
      return Promise.resolve([]);
    },
  },
);
/**
 * EI-21065771379277001: `sql.begin` — assigned AFTER construction because referencing
 * `fakeSql` inside its own `Object.assign` initializer is a circular self-reference
 * (same shape as operator-state-pg.test.ts / operator-rate-limit.test.ts).
 *
 * WHY A FAKE NEEDS IT AT ALL. Production's org client is a real postgres.js client, so
 * transactional call sites legitimately reach for `.begin` — here, the announce latch's
 * per-key advisory lock (`stampAnnouncementsFired`, events/await/store.ts). A fake that
 * offered only the tagged template + `.unsafe` made that call throw `sql.begin is not a
 * function`. The emit path catches it FAIL-SOFT and `console.warn`s ("never break the
 * emit"), and `vitest-fail-on-console` then turns that warn into a failure of whatever
 * test merely TOUCHED an announced event — here `git-sync:committed` — with no assertion
 * of its own being wrong. That is why 27 tests in this file went red at once without any
 * of them changing.
 *
 * The tx is the same tagged template: these suites assert on `templateCalls`/`unsafeCalls`,
 * and a single-connection fake needs no isolation to model that faithfully. The latch's
 * two statements target `event_awaits` / `pg_advisory_xact_lock`, so they do not disturb
 * the `harness_shared.routines` filters the tenant-scoping assertions use.
 */
(fakeSql as unknown as { begin: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T> }).begin = <T>(
  cb: (tx: unknown) => Promise<T>,
): Promise<T> => cb(fakeSql);
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
  GitSyncActionTimeoutError,
  parseGitSyncOwnerPid,
  formatOwnHeadPublishedLine,
  formatOwnHeadPublishSkipLine,
  isIntegratorActorAdmitted,
  mergeAttributionRosters,
  isGenericLockIntent,
  runWithGitSyncPerInstallLease,
  resolveGitServingStateWithBootRecovery,
  GIT_SYNC_HISTORY_EXCLUDED_PATHS_CAP,
} from './git-sync-action';
import { endedSessionOwners } from '../../agent-tools/locks/ended-session-owners';
import { intentToSubject, DEFAULT_GIT_SYNC_SUBJECT } from './git-sync-attribution';

const endedSessionOwnersMock = vi.mocked(endedSessionOwners);
import type { OwnHeadPublishTickOutcome } from '../../sync/pot-git/own-head-publish';
import type { GitServingRequest, GitServingState } from '../../sync/pot-git/serving-capability';

describe('WI-10000734 omitted serving-handle recovery', () => {
  const request: GitServingRequest = {
    workspaceId: 'ws-serving-recovery',
    installSlug: 'papercusp',
    potHomeSlug: 'papercusp',
    scope: { hive_id: 'stable-hive', repo_key: 'gh-1223568103' },
  };

  const ready = (): GitServingState => {
    const now = Date.now();
    return {
      status: 'ready',
      capability: {
        ...request,
        v: 1,
        runtimeId: 'recovered-runtime',
        identity: { devicePubkeyBase64: 'device', githubUserId: 42, keychainId: 'keychain' },
        context: { ...request.scope, store_generation: `sg2-1-${'a'.repeat(40)}` },
        issuedAtMs: now,
        expiresAtMs: now + 30_000,
      },
    };
  };

  it('awaits the coalesced lazy boot and immediately uses the newly registered local handle', async () => {
    let handle: { getGitServingCapability(request: GitServingRequest): Promise<GitServingState> } | null = null;
    const bootSingleHarness = vi.fn(async () => {
      handle = { getGitServingCapability: async () => ready() };
      return { state: 'booted' as const };
    });
    const getPgGitServingCapability = vi.fn(async () => ({
      status: 'absent' as const,
      retryable: true as const,
      reason: 'serving handle omitted from owner snapshot',
    }));

    const result = await resolveGitServingStateWithBootRecovery(request, {
      getBootedHarness: () => handle,
      bootSingleHarness,
      getPgGitServingCapability,
    });

    expect(result).toMatchObject({
      status: 'ready',
      capability: { runtimeId: 'recovered-runtime', identity: { devicePubkeyBase64: 'device' } },
    });
    expect(bootSingleHarness).toHaveBeenCalledExactlyOnceWith('ws-serving-recovery', 'papercusp');
    expect(getPgGitServingCapability).toHaveBeenCalledTimes(1);
  });

  it('preserves the exact lazy-boot failure instead of collapsing it to no_device_identity', async () => {
    const result = await resolveGitServingStateWithBootRecovery(request, {
      getBootedHarness: () => null,
      bootSingleHarness: async () => ({
        state: 'failed',
        error: 'substrate routing unavailable: migration 1142 failed',
      }),
      getPgGitServingCapability: async () => ({
        status: 'absent',
        retryable: true,
        reason: 'serving handle omitted from owner snapshot',
      }),
    });

    expect(result).toEqual({
      status: 'unknown',
      retryable: true,
      reason: 'lazy serving recovery failed: substrate routing unavailable: migration 1142 failed',
    });
  });
});

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

/**
 * EI-18804080252964845: a JSONB bind read out of a captured write, by index.
 *
 * These indices are a copy of a truth the SQL owns, so a param reorder moves them
 * (EI-18799539619330782 moved the routine patch from params[1] to params[2]). A bare
 * `JSON.parse` then fails as `SyntaxError: Unexpected token 'w'` from inside a `.map`,
 * which names neither the reader nor the cause. Fail with both instead.
 */
const jsonParam = (label: string, params: unknown[], index: number): Record<string, unknown> => {
  const raw = params[index];
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    throw new Error(
      `${label}: params[${index}] is not JSON (param shape changed?). Got ${JSON.stringify(String(raw))}; ` +
        `params=${JSON.stringify(params.map((p) => String(p)))}`,
    );
  }
};

/** ALL JSONB patches applied to the routine's metadata, in order (breadcrumb included).
 *
 *  EI-18799539619330782: patchRoutineMetadata's params are `[slug, workspaceId, patch]`
 *  — the patch is params[2], NOT params[1] (which is now the tenant scope). */
const allRoutinePatches = (): Array<Record<string, unknown>> =>
  unsafeCalls
    .filter((c) => c.text.includes('UPDATE harness_shared.routines'))
    .map((c) => jsonParam('routine metadata patch', c.params, 2));

/** EI-18799539619330782: the workspace_id every routine-metadata UPDATE was scoped to.
 *  An unscoped UPDATE is unbounded across tenants sharing an install_slug. */
const routineUpdateWorkspaceIds = (): unknown[] =>
  unsafeCalls.filter((c) => c.text.includes('UPDATE harness_shared.routines')).map((c) => c.params[1]);

/** WI-1416: the `fire_started_at` breadcrumb patched at the very top of every fire. */
const fireBreadcrumbs = (): Array<Record<string, unknown>> => allRoutinePatches().filter((p) => 'fire_started_at' in p);

/** JSONB patches applied to the routine's metadata (recordOutcome + resolver markers) —
 *  the WI-1416 fire_started_at breadcrumb and the stash-check's per-tick
 *  known_stash_shas baseline excluded so outcome assertions stay focused. */
const routinePatches = (): Array<Record<string, unknown>> =>
  allRoutinePatches().filter(
    (p) => !('fire_started_at' in p) && !('known_stash_shas' in p) && !('git_sync_activity' in p),
  );

/** The optional fourth bind is the completed-tick history entry. */
const routineHistoryEntries = (): Array<Record<string, unknown>> =>
  unsafeCalls
    .filter((c) => c.text.includes("'git_sync_history'"))
    .map((c) => jsonParam('routine history entry', c.params, 3));

/** EI-21049559233457671: the whole-fire marker is intentionally asserted separately
 * from the local-stage outcome patch. */
const gitSyncActivityPatches = (): Array<Record<string, unknown>> =>
  allRoutinePatches()
    .filter((p) => 'git_sync_activity' in p)
    .map((p) => p.git_sync_activity as Record<string, unknown>);

/** Escalation upserts (conflict + error kinds), with the parsed body. */
const escalationUpserts = (): Array<{ text: string; params: unknown[]; body: Record<string, unknown> }> =>
  unsafeCalls
    .filter((c) => c.text.includes('INSERT INTO harness_shared.harness_escalations'))
    .map((c) => ({ text: c.text, params: c.params, body: jsonParam('escalation upsert', c.params, 2) }));

/** Escalation clears — each entry is the `kinds` array passed to the UPDATE. */
const escalationClears = (): string[][] =>
  unsafeCalls.filter((c) => c.text.includes('SET escalation = NULL')).map((c) => c.params[3] as string[]);

const releasedResources = (): string[] => releaseTrace;

const acquiredResources = (): string[] =>
  tryAcquireResourceMock.mock.calls.map(([, o]) => (o as { resource: string }).resource);

const acquiredLockModes = (): string[] =>
  tryAcquireResourceMock.mock.calls.map(([, o]) => (o as { mode: string }).mode);

/** Resource names auto-registered via the in-txn agent_resource_registry INSERT (P-006).
 *  Matched on INSERT specifically: the same txn also UPDATEs that table to declare the
 *  workspace coordination domain for every lock-set member (WI-562584), and an
 *  unqualified table match would silently fold those in as "registrations". */
const registeredResources = (): string[] =>
  txQueries.filter((q) => /INSERT\s+INTO\s+agent_resource_registry/i.test(q.text)).map((q) => q.values[0] as string);

/** Resource names whose registry row this tick stamped with the WORKSPACE coordination
 *  domain (WI-562584) — the declaration an agent's `resourceLockDomain()` reads back so
 *  it acquires in the SAME domain this action holds the resource in. */
const workspaceDomainStampedResources = (): string[] =>
  txQueries
    .filter((q) => /UPDATE\s+agent_resource_registry/i.test(q.text) && q.text.includes('coordination_domain_kind'))
    .map((q) => q.values[0] as string);

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
  dirtyPathCount: 4,
  committedCount: 2,
  headSha: 'abc123def456',
  pushed: ['libs/generic/sync', 'superproject'],
  merged: ['superproject'],
  oversized: [],
  contentErrors: [],
  strandedSubmodules: [],
};
const conflictOutcome: GitSyncOutcome = {
  status: 'conflict',
  dirtyPathCount: 3,
  committedCount: 1,
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
  dirtyPathCount: 2,
  committedCount: 0,
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
  dirtyPathCount: 2,
  committedCount: 1,
  headSha: 'def789',
  pushed: ['superproject'],
  merged: [],
  oversized: [],
  contentErrors: [
    {
      scope: 'superproject',
      file: 'apps/operator-docs/src/content/docs/x.mdx',
      detectorKey: 'mdx',
      error: 'MDX compile error at line 7: closing tag for `<date>`',
      fixerRole: 'content-fixer',
    },
  ],
  strandedSubmodules: [],
};

const action = getSystemAction('git-sync')!;

/** Spawn + reap a child so the stale-holder regression uses a PID guaranteed to
 * be dead by the time the git-sync acquire attempts its reclaim. */
function definitelyDeadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const pid = child.pid;
    if (!pid) {
      reject(new Error('spawn returned no pid'));
      return;
    }
    child.once('exit', () => resolve(pid));
    child.once('error', reject);
  });
}

beforeEach(() => {
  process.env.PAPERCUSP_BACKGROUND_WORKERS = '1';
  tryAcquireResourceMock.mockReset();
  tryReleaseResourceMock.mockReset();
  releaseAllResourcesForOwnerMock.mockReset();
  releaseAllResourcesForOwnerMock.mockResolvedValue({ released: 3, exclusiveResources: [], waiters: {} });
  heldResourcesByOwner.clear();
  releaseTrace.length = 0;
  workspaceTxnCalls.length = 0;
  readResourceQueueMock.mockReset();
  readResourceQueueMock.mockResolvedValue({ holders: [], draining: false, queue: [] });
  clearResourceExclusiveQueueMock.mockReset();
  clearResourceExclusiveQueueMock.mockResolvedValue(undefined);
  clearResourceWaiterMock.mockReset();
  clearResourceWaiterMock.mockResolvedValue(undefined);
  liveLockHoldingsMock.mockReset();
  liveLockHoldingsMock.mockResolvedValue([]);
  liveLockHoldingsStrictMock.mockReset();
  liveLockHoldingsStrictMock.mockResolvedValue([]);
  runGitSyncMock.mockReset();
  runGitBoundedMock.mockReset().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
  reconcileProposedCompletionsAtCommitMock.mockReset();
  reconcileProposedCompletionsAtCommitMock.mockResolvedValue({
    inspected: 0,
    upgraded: [],
    residual: 0,
    unreadable: [],
  });
  runDependencyGenerationPrebuildMock.mockReset();
  runDependencyGenerationPrebuildMock.mockResolvedValue('ready');
  endedSessionOwnersMock.mockReset();
  endedSessionOwnersMock.mockResolvedValue(new Set<string>());
  enqueueDependencyPrebuildMock.mockReset();
  enqueueDependencyPrebuildMock.mockResolvedValue(true);
  recoverQueuedDependencyPrebuildMock.mockReset();
  recoverQueuedDependencyPrebuildMock.mockResolvedValue('none');
  appendPipelineEventMock.mockReset();
  emitGitSyncLockRetryEventMock.mockReset();
  emitGitSyncCommittedEventMock.mockReset();
  resolveLaunchTargetForEventMock.mockReset();
  loopbackFetchMock.mockReset();
  sendMessageMock.mockReset();
  upsertConditionWorkItemMock.mockReset();
  upsertConditionWorkItemMock.mockImplementation(async (conditionKey) => ({
    conditionKey,
    id: 'WI-CONTENT-TEST',
    created: true,
  }));
  captureHeadShaMock.mockReset();
  enqueueDocSweepMock.mockReset();
  getFlagMock.mockReset();
  // content-guard defaults ON; derived-attribution (P-004) defaults OFF — mirror the real
  // defaults so the runGitSync-opts assertions don't see a loadRoster added.
  getFlagMock.mockImplementation(async (key: string) => key !== 'papercusp-git-sync-derived-attribution');
  resolverRows = [];
  contentFixerRows = [];
  contentFixerClaimResults = [true];
  counterRows = [];
  unsafeCalls.length = 0;
  templateCalls.length = 0;
  txQueries.length = 0;
  fakeTxImpl = recordingTx;
  rejectUnsafeAtCall = null;
  unsafeCallCount = 0;
  rejectGitSyncActivityPhaseOnce = null;
  rejectTemplateOnce = null;
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
    runGitSyncMock.mockResolvedValue({
      status: 'nothing',
      dirtyPathCount: 0,
      committedCount: 0,
      oversized: [],
      contentErrors: [],
      strandedSubmodules: [],
    });

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

  it('EI-21647996938145436: records the loaded process/build identity with every outcome', async () => {
    runGitSyncMock.mockResolvedValue(syncedOutcome);

    await action(ctx);

    const identity = routinePatches()[0]?.loaded_build_identity as Record<string, unknown>;
    expect(identity).toMatchObject({
      pid: process.pid,
      instance: expect.any(String),
      version: expect.any(String),
      recorded_at: expect.any(Number),
    });
    // `sha` is nullable for an identity-less runtime, but the key itself is
    // mandatory so readers never confuse omission with an unobserved identity.
    expect(identity).toHaveProperty('sha');
  });

  it('returns the typed pipeline outcome to the on-demand fire seam', async () => {
    runGitSyncMock.mockResolvedValue(syncedOutcome);

    const result = await fireGitSyncNow(ctx.installSlug, ctx.workspaceId);

    expect(result).toMatchObject({ status: 'synced', headSha: syncedOutcome.headSha, pushed: syncedOutcome.pushed });
  });

  it('refuses every on-demand fire on a request-only host before the git-sync pipeline starts', async () => {
    const priorBackgroundWorkers = process.env.PAPERCUSP_BACKGROUND_WORKERS;
    process.env.PAPERCUSP_BACKGROUND_WORKERS = '0';
    try {
      await expect(fireGitSyncNow(ctx.installSlug, ctx.workspaceId)).rejects.toThrow(
        /on-demand fire refused on request-only host/,
      );
      expect(runGitSyncMock).not.toHaveBeenCalled();
      expect(unsafeCalls).toHaveLength(0);
    } finally {
      if (priorBackgroundWorkers === undefined) delete process.env.PAPERCUSP_BACKGROUND_WORKERS;
      else process.env.PAPERCUSP_BACKGROUND_WORKERS = priorBackgroundWorkers;
    }
  });

  it('settles against the canonical emitted checkout root, not the install slug', async () => {
    const alias = join(tmpRoot, 'repo-alias');
    symlinkSync(repoDir, alias);
    registryProjects = [{ slug: 'papercup', path: alias }];
    runGitSyncMock.mockResolvedValue(syncedOutcome);

    await action(ctx);

    expect(reconcileProposedCompletionsAtCommitMock).toHaveBeenCalledWith(
      syncedOutcome.headSha,
      {
        installSlug: 'papercup',
        workspaceId: 'ws-42',
        repositoryRoot: realpathSync(repoDir),
      },
      expect.objectContaining({ signal: expect.anything(), onProgress: expect.any(Function) }),
    );
  });

  it('bounds a progressing completion-settlement pass and aborts its remaining work', async () => {
    const priorBudget = process.env.PAPERCUSP_GIT_SYNC_COMPLETION_SETTLEMENT_BUDGET_MS;
    process.env.PAPERCUSP_GIT_SYNC_COMPLETION_SETTLEMENT_BUDGET_MS = '35';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let observedSignal: AbortSignal | undefined;
    reconcileProposedCompletionsAtCommitMock.mockImplementationOnce(async (_sha, _scope, { signal, onProgress }) => {
      observedSignal = signal;
      // Returned, not awaited: an awaited never-settling promise infers Promise<void>,
      // which the mock's settlement-result return type rejects (TS2345).
      return new Promise<never>((_resolve, reject) => {
        let completed = 0;
        const progress = setInterval(() => {
          completed += 1;
          void onProgress({ completed, total: 200, featureId: `WI-${completed}` });
        }, 1);
        signal.addEventListener(
          'abort',
          () => {
            clearInterval(progress);
            reject(signal.reason ?? new Error('settlement aborted'));
          },
          { once: true },
        );
      });
    });
    runGitSyncMock.mockResolvedValue(syncedOutcome);

    try {
      await action(ctx);

      expect(reconcileProposedCompletionsAtCommitMock).toHaveBeenCalledOnce();
      expect(observedSignal?.aborted).toBe(true);
      expect(emitGitSyncCommittedEventMock).toHaveBeenCalledWith(
        syncedOutcome.headSha,
        expect.objectContaining({ scope: expect.any(Object) }),
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('remaining candidates will be retried on a later fire'));
    } finally {
      warn.mockRestore();
      if (priorBudget === undefined) delete process.env.PAPERCUSP_GIT_SYNC_COMPLETION_SETTLEMENT_BUDGET_MS;
      else process.env.PAPERCUSP_GIT_SYNC_COMPLETION_SETTLEMENT_BUDGET_MS = priorBudget;
    }
  }, 2_000);

  it('persists count-bearing completion-settlement progress for routine health readers', async () => {
    runGitSyncMock.mockResolvedValue(syncedOutcome);
    reconcileProposedCompletionsAtCommitMock.mockImplementationOnce(async (_sha, _scope, progress) => {
      await progress.onProgress({ completed: 2, total: 7, featureId: 'WI-42476' });
      return { inspected: 7, upgraded: [], residual: 0, unreadable: [] };
    });

    await action(ctx);

    expect(gitSyncActivityPatches()).toContainEqual(
      expect.objectContaining({
        active: true,
        phase: 'completion-settlement',
        settlement_progress: {
          completed: 2,
          total: 7,
          feature_id: 'WI-42476',
        },
      }),
    );
  });

  it('scopes every registry read and runs the exact path pinned by a manual fire when an ambient sibling exists', async () => {
    const canonicalRepo = join(tmpRoot, 'canonical-repo');
    const ambientSibling = join(tmpRoot, 'ambient-sibling');
    mkdirSync(join(canonicalRepo, '.git'), { recursive: true });
    mkdirSync(join(ambientSibling, '.git'), { recursive: true });
    registryProjects = [{ slug: 'papercup', path: canonicalRepo }];
    ambientRegistryProjects = [{ slug: 'papercup', path: ambientSibling }];
    runGitSyncMock.mockResolvedValue({
      status: 'nothing',
      dirtyPathCount: 0,
      committedCount: 0,
      oversized: [],
      contentErrors: [],
      strandedSubmodules: [],
    });

    await fireGitSyncNow('papercup', 'ws-42', canonicalRepo);

    expect(runGitSyncMock).toHaveBeenCalledWith('papercup', expect.objectContaining({ repoPath: canonicalRepo }));
    expect(loadHarnessRegistryMock).toHaveBeenCalled();
    expect(loadHarnessRegistryMock.mock.calls.every(([workspaceId]) => workspaceId === 'ws-42')).toBe(true);
    expect(runGitSyncMock).not.toHaveBeenCalledWith('papercup', expect.objectContaining({ repoPath: ambientSibling }));
  });
});

describe('P-004 dependency-generation prebuild handoff', () => {
  it('queues the exact published candidate only after the whole git-sync action is terminal', async () => {
    const candidate = 'a'.repeat(40);
    runGitSyncMock.mockResolvedValue({ ...syncedOutcome, headSha: candidate });
    const priorToolingRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;
    process.env.PAPERCUSP_INTEGRATION_ROOT = tmpRoot;
    try {
      await action(ctx);
    } finally {
      if (priorToolingRoot === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
      else process.env.PAPERCUSP_INTEGRATION_ROOT = priorToolingRoot;
    }

    expect(gitSyncActivityPatches().at(-1)).toMatchObject({
      active: false,
      phase: 'complete',
      outcome_status: 'synced',
    });
    expect(runDependencyGenerationPrebuildMock).toHaveBeenCalledOnce();
    expect(enqueueDependencyPrebuildMock).toHaveBeenCalledOnce();
    expect(enqueueDependencyPrebuildMock).toHaveBeenCalledWith({
      workspaceId: ctx.workspaceId,
      installSlug: ctx.installSlug,
      candidate,
      integrationRoot: repoDir,
      toolingRoot: tmpRoot,
      queuedAtMs: expect.any(Number),
    });
    expect(runDependencyGenerationPrebuildMock).toHaveBeenCalledWith({
      workspaceId: ctx.workspaceId,
      installSlug: ctx.installSlug,
      candidate,
      integrationRoot: repoDir,
      toolingRoot: tmpRoot,
      queuedAtMs: expect.any(Number),
    });
  });

  it('does not queue a candidate after a conflict outcome', async () => {
    runGitSyncMock.mockResolvedValue(conflictOutcome);
    const priorToolingRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;
    process.env.PAPERCUSP_INTEGRATION_ROOT = tmpRoot;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await action(ctx);
    } finally {
      warn.mockRestore();
      if (priorToolingRoot === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
      else process.env.PAPERCUSP_INTEGRATION_ROOT = priorToolingRoot;
    }

    expect(runDependencyGenerationPrebuildMock).not.toHaveBeenCalled();
    expect(enqueueDependencyPrebuildMock).not.toHaveBeenCalled();
  });

  it('recovers a queued handoff on a later tick without consulting the ambient tooling root', async () => {
    runGitSyncMock.mockResolvedValue({
      status: 'nothing',
      dirtyPathCount: 0,
      committedCount: 0,
      oversized: [],
      contentErrors: [],
      strandedSubmodules: [],
    });
    recoverQueuedDependencyPrebuildMock.mockResolvedValue('ready');

    await action(ctx);
    expect(recoverQueuedDependencyPrebuildMock).toHaveBeenCalledWith({
      workspaceId: ctx.workspaceId,
      installSlug: ctx.installSlug,
    });
    expect(enqueueDependencyPrebuildMock).not.toHaveBeenCalled();
  });

  it('does not publish terminal activity until the queued handoff write resolves', async () => {
    const candidate = 'c'.repeat(40);
    runGitSyncMock.mockResolvedValue({ ...syncedOutcome, headSha: candidate });
    const priorToolingRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;
    process.env.PAPERCUSP_INTEGRATION_ROOT = tmpRoot;
    let releaseHandoff!: (value: boolean) => void;
    enqueueDependencyPrebuildMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          releaseHandoff = resolve;
        }),
    );
    try {
      const pending = action(ctx);
      await vi.waitFor(() => expect(releaseHandoff).toBeTypeOf('function'));
      expect(
        gitSyncActivityPatches().some((activity) => activity.phase === 'complete' && activity.active === false),
      ).toBe(false);
      releaseHandoff(true);
      await pending;
      expect(
        gitSyncActivityPatches().some((activity) => activity.phase === 'complete' && activity.active === false),
      ).toBe(true);
    } finally {
      if (priorToolingRoot === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
      else process.env.PAPERCUSP_INTEGRATION_ROOT = priorToolingRoot;
    }
  });

  it('records an inactive error marker when the final terminal activity write rejects', async () => {
    runGitSyncMock.mockResolvedValue(syncedOutcome);
    rejectGitSyncActivityPhaseOnce = 'complete';

    await expect(action(ctx)).rejects.toThrow('injected terminal activity metadata write failure');

    // The failed complete write is followed by the durable error marker, so a
    // retry cannot mistake the prior post-legs state for an active fire.
    expect(gitSyncActivityPatches().at(-1)).toMatchObject({
      active: false,
      phase: 'error',
      outcome_status: 'synced',
      completed_at: expect.any(Number),
    });
    expect(enqueueDocSweepMock).not.toHaveBeenCalled();
    expect(releasedResources()).toEqual(['libs-papercusp-submodule', 'git-sync:papercup', 'git-sync']);
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
        : { ok: true },
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await action(ctx);

    expect(acquiredResources()).toEqual(['git-sync', 'git-sync:papercup', 'libs-papercusp-submodule']);
    // The routine did not run Git or append a pipeline event, but it MUST replace any
    // stale prior `synced` outcome with a non-attemptable status. Otherwise the stall
    // watchdog carries the old HEAD-age clock through this skipped fire and emits a
    // false "commits are NOT landing" alarm (EI-22764118395439975).
    expect(runGitSyncMock).not.toHaveBeenCalled();
    expect(appendPipelineEventMock).not.toHaveBeenCalled();
    expect(routinePatches()).toEqual([
      expect.objectContaining({
        last_status: 'skipped',
        local_sync_status: 'skipped',
        last_skip_reason: 'held by agent:peer',
        last_skipped_at: expect.any(Number),
        last_skipped_paths: [],
      }),
    ]);
    expect(fireBreadcrumbs()).toEqual([{ fire_started_at: expect.any(Number) }]);
    expect(captureHeadShaMock).not.toHaveBeenCalled();
    // …and the refused resource gets an owner-scoped late-grant cleanup before
    // the partially-acquired locks are released in reverse order. That cleanup
    // cannot delete the peer row because tryReleaseResource checks `owner`.
    expect(releasedResources()).toEqual(['libs-papercusp-submodule', 'git-sync:papercup', 'git-sync']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('a peer holds libs-papercusp-submodule'));
    log.mockRestore();
  });

  it('names an in-flight git-sync holder instead of calling it a peer', async () => {
    const holder = {
      owner: 'system:git-sync:3063386:026aff27-f42d-4d44-94b8-045f102f989a',
      owner_label: 'git-sync:papercup',
      mode: 'exclusive' as const,
      status: 'held' as const,
      lock_id: 'lock-system-git-sync',
      reason: 'auto-commit papercup',
      acquired_ts: new Date('2026-09-05T13:42:29.066Z'),
      expires_ts: new Date('2026-09-05T13:52:29.066Z'),
      fence_seq: 42,
    };
    tryAcquireResourceMock.mockImplementation(async (_tx, opts) =>
      (opts as { resource: string }).resource === 'libs-papercusp-submodule'
        ? { ok: false, reason: 'held_exclusive', holders: [holder] }
        : { ok: true },
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await action(ctx);

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('an in-flight git-sync auto-commit holds libs-papercusp-submodule'),
      );
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining('a peer holds libs-papercusp-submodule'));
    } finally {
      log.mockRestore();
    }
  });

  it('returns JSON-safe live holders and emits a scoped retry signal for a held lock', async () => {
    const holder = {
      owner: 'su-peer',
      owner_label: 'peer agent',
      mode: 'exclusive' as const,
      status: 'held' as const,
      lock_id: 'lock-1',
      reason: 'manual git work',
      acquired_ts: new Date('2026-08-21T10:00:00.000Z'),
      expires_ts: new Date('2026-08-21T10:10:00.000Z'),
      fence_seq: 42,
    };
    tryAcquireResourceMock.mockImplementation(async (_tx, opts) =>
      (opts as { resource: string }).resource === 'libs-papercusp-submodule'
        ? { ok: false, reason: 'held by agent:peer', holders: [holder] }
        : { ok: true },
    );

    await action(ctx);

    expect(emitGitSyncLockRetryEventMock).toHaveBeenCalledWith(
      'libs-papercusp-submodule',
      'held by agent:peer',
      [
        {
          ...holder,
          acquired_ts: '2026-08-21T10:00:00.000Z',
          expires_ts: '2026-08-21T10:10:00.000Z',
        },
      ],
      { scope: { installSlug: 'papercup', workspaceId: 'ws-42' } },
    );
  });

  // EI-21876778499591361: a TRANSIENT pg contention timeout on the live-lock read used to skip the
  // tick, which stalls commits FLEET-WIDE (observed 2026-08-30: missed_intervals=3, no successful
  // sync for >10min, 34 files stuck). Failing closed is still correct for a genuinely unreadable
  // lock plane — the test below this one is the negative control that pins it, and it asserts the
  // read is attempted exactly ONCE, so this retry must never become unconditional.
  it('rides out a transient pg contention timeout on the live-lock read and still runs the sync', async () => {
    tryAcquireResourceMock.mockResolvedValue({ ok: true });
    const contended = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    // Fails once, then the dip clears. One real 500ms backoff — the first entry of
    // LOCK_CONTENTION_BACKOFFS_MS — rather than mocking the retry we are trying to prove.
    liveLockHoldingsStrictMock.mockRejectedValueOnce(contended).mockResolvedValue([]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await action(ctx);

      expect(liveLockHoldingsStrictMock).toHaveBeenCalledTimes(2);
      // The tick PROCEEDED — this is the whole point; previously it returned skipped.
      expect(runGitSyncMock).toHaveBeenCalled();
      expect(allRoutinePatches()).not.toContainEqual(
        expect.objectContaining({ last_skip_reason: 'live-lock-read-failed' }),
      );
      expect(error).not.toHaveBeenCalledWith(expect.stringContaining('live lock read failed (fail-closed)'));
    } finally {
      error.mockRestore();
    }
  });

  it('fails closed when the live-lock read is unavailable — records the error and releases acquired resources', async () => {
    const lockReadError = new Error('side-DB unreachable');
    tryAcquireResourceMock.mockResolvedValue({ ok: true });
    liveLockHoldingsStrictMock.mockRejectedValue(lockReadError);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await action(ctx);

      expect(liveLockHoldingsStrictMock).toHaveBeenCalledOnce();
      expect(runGitSyncMock).not.toHaveBeenCalled();
      expect(appendPipelineEventMock).not.toHaveBeenCalled();
      expect(emitGitSyncLockRetryEventMock).not.toHaveBeenCalled();
      expect(releasedResources()).toEqual(['libs-papercusp-submodule', 'git-sync:papercup', 'git-sync']);
      expect(allRoutinePatches()).toContainEqual(
        expect.objectContaining({
          last_status: 'skipped',
          local_sync_status: 'skipped',
          last_skip_reason: 'live-lock-read-failed',
          last_skipped_at: expect.any(Number),
          last_lock_read_error: 'side-DB unreachable',
          last_error: 'live lock read failed (fail-closed): side-DB unreachable',
          last_errors: ['live-lock-read: side-DB unreachable'],
        }),
      );
      expect(gitSyncActivityPatches()).toContainEqual(
        expect.objectContaining({
          active: false,
          phase: 'error',
          outcome_status: null,
        }),
      );
      expect(error).toHaveBeenCalledWith(expect.stringContaining('live lock read failed (fail-closed)'));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it('does not emit a retry signal while a held_exclusive peer row is still live', async () => {
    const holder = {
      owner: 'su-peer',
      owner_label: 'peer agent',
      mode: 'exclusive' as const,
      status: 'held' as const,
      lock_id: 'lock-live-peer',
      reason: 'manual git work',
      acquired_ts: new Date('2026-08-21T10:00:00.000Z'),
      expires_ts: new Date('2026-08-21T10:10:00.000Z'),
      fence_seq: 42,
    };
    const sequence: string[] = [];
    let peerRowLive = false;
    tryAcquireResourceMock.mockImplementation(async (_tx, opts) => {
      const resource = (opts as { resource: string }).resource;
      if (resource === 'libs-papercusp-submodule') {
        peerRowLive = true;
        sequence.push('peer-held-refusal');
        return { ok: false, reason: 'held_exclusive', holders: [holder] };
      }
      return { ok: true };
    });
    tryReleaseResourceMock.mockImplementation(async (_tx, opts) => {
      sequence.push(`released:${(opts as { resource: string }).resource}`);
      return { ok: true };
    });
    releaseAllResourcesForOwnerMock.mockImplementation(async () => {
      sequence.push('released-own-lock-set');
      return { released: 2, exclusiveResources: [], waiters: {} };
    });
    emitGitSyncLockRetryEventMock.mockImplementation(() => {
      sequence.push(peerRowLive ? 'retry-event-while-peer-live' : 'retry-event-after-peer-release');
    });

    await action(ctx);

    // Releasing our partial acquisitions cannot release the peer's exclusive row.
    // A retry event here would therefore wake callers into the same no-delta refusal;
    // the resource release/grant path owns the truthful wake instead.
    expect(sequence).toEqual(['peer-held-refusal', 'released:libs-papercusp-submodule', 'released-own-lock-set']);
    expect(peerRowLive).toBe(true);
    expect(emitGitSyncLockRetryEventMock).not.toHaveBeenCalled();
  });

  it('WI-209800: purges queued terminal git-sync fires without disturbing a peer FIFO ticket', async () => {
    const abandonedOwner = 'system:git-sync:12345:returned-fire';
    const peerOwner = 'su-peer-waiter';
    readResourceQueueMock.mockImplementation(async (_tx, opts) => {
      const resource = (opts as { resource: string }).resource;
      return {
        holders: [],
        draining: false,
        queue: resource === 'git-sync:papercup' ? [{ owner: abandonedOwner }, { owner: peerOwner }] : [],
      };
    });
    runGitSyncMock.mockResolvedValue({
      status: 'nothing',
      dirtyPathCount: 0,
      committedCount: 0,
      oversized: [],
      contentErrors: [],
      strandedSubmodules: [],
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await action(ctx);
    } finally {
      error.mockRestore();
    }

    expect(clearResourceExclusiveQueueMock).toHaveBeenCalledWith(
      expect.anything(),
      'ws-42',
      'git-sync:papercup',
      abandonedOwner,
    );
    expect(clearResourceWaiterMock).toHaveBeenCalledWith(
      expect.anything(),
      'ws-42',
      'git-sync:papercup',
      abandonedOwner,
    );
    expect(clearResourceExclusiveQueueMock.mock.calls.some((call) => call[3] === peerOwner)).toBe(false);
    expect(runGitSyncMock).toHaveBeenCalledOnce();
  });

  it('WI-209800: a terminal held_exclusive skip cancels its ticket and releases a late cascade grant', async () => {
    const peerHolder = {
      owner: 'su-live-peer',
      owner_label: 'peer agent',
      mode: 'exclusive' as const,
      status: 'held' as const,
      lock_id: 'peer-lock',
      reason: 'manual work',
      acquired_ts: new Date('2026-08-27T18:00:00.000Z'),
      expires_ts: new Date('2026-08-27T19:00:00.000Z'),
      fence_seq: 7,
    };
    let terminalOwner = '';
    tryAcquireResourceMock.mockImplementation(async (_tx, opts) => {
      const resource = (opts as { resource: string }).resource;
      if (resource !== 'git-sync:papercup') return { ok: true };
      terminalOwner = (opts as { owner: string }).owner;
      return { ok: false, reason: 'held_exclusive', holders: [peerHolder] };
    });

    await action(ctx);

    expect(terminalOwner).toMatch(/^system:git-sync:\d+:[0-9a-f-]+$/);
    expect(clearResourceExclusiveQueueMock).toHaveBeenCalledWith(
      expect.anything(),
      'ws-42',
      'git-sync:papercup',
      terminalOwner,
    );
    expect(clearResourceWaiterMock).toHaveBeenCalledWith(
      expect.anything(),
      'ws-42',
      'git-sync:papercup',
      terminalOwner,
    );
    expect(tryReleaseResourceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        coordinationDomain: 'ws-42',
        resource: 'git-sync:papercup',
        owner: terminalOwner,
      }),
    );
    expect(runGitSyncMock).not.toHaveBeenCalled();
  });

  it('SKIPS after workspace-lock contention exhausts retries — it never runs unlocked', async () => {
    vi.useFakeTimers();
    try {
      const contention = Object.assign(new Error('workspace "ws-42" contended (pg 57014: lock/statement timeout)'), {
        name: 'WorkspaceContendedError',
        pgCode: '57014',
      });
      tryAcquireResourceMock.mockRejectedValue(contention);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const running = fireGitSyncNow('papercup', 'ws-42');
      await vi.advanceTimersByTimeAsync(6_000);
      const outcome = await running;

      expect(outcome).toEqual({
        status: 'skipped',
        reason: 'lock_contended',
        blockedOn: 'git-sync',
      });
      expect(tryAcquireResourceMock).toHaveBeenCalledTimes(4); // initial + 3 bounded retries
      expect(runGitSyncMock).not.toHaveBeenCalled();
      expect(appendPipelineEventMock).not.toHaveBeenCalled();
      expect(routinePatches()).toEqual([
        expect.objectContaining({
          last_status: 'skipped',
          local_sync_status: 'skipped',
          last_skip_reason: 'lock_contended',
          last_skipped_at: expect.any(Number),
          last_skipped_paths: [],
        }),
      ]);
      expect(releasedResources()).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('lock contended after retries'));
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('proceeds UNLOCKED when the lock infra errors (fail-open) — partials released, no release after the run', async () => {
    tryAcquireResourceMock
      .mockResolvedValueOnce({ ok: true }) // shared git-sync barrier acquires…
      .mockRejectedValueOnce(new Error('su-lock DB unreachable')); // …then the infra dies
    runGitSyncMock.mockResolvedValue(syncedOutcome);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lock infra unavailable'));
    // the documented fail-open contract: the sync still RUNS
    expect(runGitSyncMock).toHaveBeenCalledTimes(1);
    expect(appendPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'git_sync', status: 'synced' }),
    );
    // the partial acquisition was released inside acquireLocks; the unlocked run
    // releases nothing afterwards (exactly one release total)
    expect(releasedResources()).toEqual(['git-sync']);
    warn.mockRestore();
  });

  it('acquires shared(git-sync) FIRST, then exclusive per-slug/configured resources, releasing in reverse order', async () => {
    runGitSyncMock.mockResolvedValue(syncedOutcome);

    await action(ctx);

    // papercup regression: shared restart barrier + per-slug name + the
    // non-legacy extra. The legacy `git-sync` extra is not acquired twice.
    expect(acquiredResources()).toEqual(['git-sync', 'git-sync:papercup', 'libs-papercusp-submodule']);
    expect(acquiredLockModes()).toEqual(['shared', 'exclusive', 'exclusive']);
    expect(tryAcquireResourceMock.mock.calls[0][1]).toMatchObject({
      coordinationDomain: 'ws-42',
      resource: 'git-sync',
      mode: 'shared',
      ttlSec: 600,
    });
    expect((tryAcquireResourceMock.mock.calls[0][1] as { owner: string }).owner).toMatch(
      /^system:git-sync:\d+:[0-9a-f-]+$/,
    );
    // ONLY the per-slug name is auto-registered (idempotent ON CONFLICT DO NOTHING);
    // the extras are a human-registered coordination surface
    expect(registeredResources()).toEqual(['git-sync:papercup']);
    expect(txQueries.find((q) => /INSERT\s+INTO\s+agent_resource_registry/i.test(q.text))?.text).toContain(
      'ON CONFLICT (resource) DO NOTHING',
    );
    expect(releasedResources()).toEqual(['libs-papercusp-submodule', 'git-sync:papercup', 'git-sync']);
  });

  it('WI-6500: re-acquires a distinct per-install lease around the bootstrap post-leg', async () => {
    const servingWarning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    potGitMode = 'p2p-only';
    registryProjects = [{ slug: 'papercup', path: repoDir, hive_slug: 'papercup' }];
    runGitSyncMock.mockResolvedValue({
      status: 'nothing',
      dirtyPathCount: 0,
      committedCount: 0,
      oversized: [],
      contentErrors: [],
      strandedSubmodules: [],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await action(ctx);
    } finally {
      log.mockRestore();
    }

    const perInstallAcquires = tryAcquireResourceMock.mock.calls
      .map(([, opts]) => opts as { resource: string; mode: string; owner: string })
      .filter(({ resource }) => resource === 'git-sync:papercup');
    expect(perInstallAcquires).toHaveLength(2);
    expect(servingWarning).toHaveBeenCalledWith(expect.stringContaining('serving unavailable'));
    servingWarning.mockRestore();
    expect(perInstallAcquires.map(({ mode }) => mode)).toEqual(['exclusive', 'exclusive']);
    expect(perInstallAcquires[1]?.owner).not.toBe(perInstallAcquires[0]?.owner);
    expect(releasedResources()).toEqual([
      'libs-papercusp-submodule',
      'git-sync:papercup',
      'git-sync',
      'git-sync:papercup',
    ]);
  });

  it('WI-6500: a refused per-install lease skips its operation instead of running an unlocked writer', async () => {
    tryAcquireResourceMock.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [],
    });
    const operation = vi.fn(async () => 'must-not-run');

    const result = await runWithGitSyncPerInstallLease('papercup', 'ws-42', operation);

    expect(result).toMatchObject({
      state: 'skipped',
      reason: 'held_exclusive',
      blockedOn: 'git-sync:papercup',
    });
    expect(operation).not.toHaveBeenCalled();
    // acquireLocks cancels any stale FIFO ticket / late cascade grant even on
    // a terminal refusal; that cleanup is not a lease the operation held.
    expect(releasedResources()).toEqual(['git-sync:papercup']);
  });

  // WI-562584. The defect this pins: an agent's `resourceLockDomain()` inferred the
  // domain from the resource NAME, so `libs-papercusp-submodule` — which advertises
  // neither the host-global set nor the `git-sync:` prefix — resolved to the caller
  // tree while THIS action holds it in the workspace domain (`cd = workspaceId`).
  // Two disjoint namespaces: the agent's acquire was granted and mutual exclusion
  // silently did not hold. The stamp is what makes the domain KNOWN rather than
  // inferred, and it has to cover the EXTRAS specifically: those are
  // human-registered, so the auto-register INSERT above never touches them.
  it('declares the workspace coordination domain for EVERY lock-set member, extras included', async () => {
    runGitSyncMock.mockResolvedValue(syncedOutcome);

    await action(ctx);

    expect(workspaceDomainStampedResources()).toEqual(['git-sync', 'git-sync:papercup', 'libs-papercusp-submodule']);
    // Every acquire in this tick used the workspace domain — which is precisely what
    // the stamp tells a later reader, so the two cannot drift apart silently.
    for (const [, opts] of tryAcquireResourceMock.mock.calls) {
      expect((opts as { coordinationDomain: string }).coordinationDomain).toBe('ws-42');
    }
    const stamp = txQueries.find((q) => /UPDATE\s+agent_resource_registry/i.test(q.text));
    // Idempotent by construction: a row already declaring 'workspace' is not rewritten,
    // so a per-minute routine does not churn updated_ts on every tick.
    expect(stamp?.text).toContain("coordination_domain_kind IS DISTINCT FROM 'workspace'");
  });

  // The stamp is a DECLARATION for future readers, not a precondition of this
  // acquire — and the agent side already fails closed without it
  // (cross-domain-conflict.ts). A registry write that errors must therefore not
  // cost the commit; if it did, one broken column would stop every harness syncing.
  it('still syncs when the coordination-domain declaration fails', async () => {
    runGitSyncMock.mockResolvedValue(syncedOutcome);
    fakeTxImpl = (strings, ...values) => {
      const text = strings.join('?');
      txQueries.push({ text, values });
      if (/UPDATE\s+agent_resource_registry/i.test(text)) {
        return Promise.reject(new Error('column "coordination_domain_kind" does not exist'));
      }
      return Promise.resolve([]);
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    expect(runGitSyncMock).toHaveBeenCalledTimes(1);
    expect(acquiredResources()).toEqual(['git-sync', 'git-sync:papercup', 'libs-papercusp-submodule']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not declare workspace coordination domain'),
      expect.anything(),
    );
    warn.mockRestore();
  });

  it('skips before the per-slug acquire when dev:restart holds the exclusive shared barrier', async () => {
    tryAcquireResourceMock.mockImplementation(async (_tx, opts) =>
      (opts as { resource: string }).resource === 'git-sync'
        ? { ok: false, reason: 'exclusive_pending', holders: [] }
        : { ok: true },
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await action(ctx);

      expect(acquiredResources()).toEqual(['git-sync']);
      expect(acquiredLockModes()).toEqual(['shared']);
      expect(
        tryAcquireResourceMock.mock.calls.some(
          ([, opts]) => (opts as { resource: string }).resource === 'git-sync:papercup',
        ),
      ).toBe(false);
      expect(runGitSyncMock).not.toHaveBeenCalled();
      expect(releasedResources()).toEqual(['git-sync']);
    } finally {
      log.mockRestore();
    }
  });

  it('EI-22367010504753373: reclaims a terminal correlated resolver on the shared barrier and retries by lock_id', async () => {
    const terminalResolverOwner = 's-invoke-88ee4ec4-32f4-4988-90aa-fb9b38cc49f4';
    const terminalResolverHolder = {
      owner: terminalResolverOwner,
      owner_label: 'merge-resolver',
      mode: 'exclusive' as const,
      status: 'held' as const,
      lock_id: 'resolver-shared-barrier-lock',
      reason: 'merge-resolution git-sync conflict',
      acquired_ts: new Date('2026-09-04T20:00:00.000Z'),
      expires_ts: new Date('2026-09-04T20:10:00.000Z'),
      fence_seq: 12,
    };
    let firstBarrierAttempt = true;
    tryAcquireResourceMock.mockImplementation(async (_tx, opts) => {
      const resource = (opts as { resource: string }).resource;
      if (resource === 'git-sync' && firstBarrierAttempt) {
        firstBarrierAttempt = false;
        return {
          ok: false,
          reason: 'exclusive_pending',
          holders: [terminalResolverHolder],
        };
      }
      return { ok: true };
    });
    endedSessionOwnersMock.mockResolvedValue(new Set([terminalResolverOwner]));
    tryReleaseResourceMock.mockResolvedValue({ ok: true, released: 1 });
    runGitSyncMock.mockResolvedValue(syncedOutcome);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await action(ctx);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(
          `STALE LOCK RECLAIMED — papercup git-sync holder ${terminalResolverOwner} ` +
            '(session ended per the shared liveness oracle)',
        ),
      );
    } finally {
      error.mockRestore();
    }

    expect(endedSessionOwnersMock).toHaveBeenCalledWith([terminalResolverOwner]);
    expect(
      tryReleaseResourceMock.mock.calls.some(
        ([, opts]) =>
          (opts as { owner?: string; lockId?: string }).owner === terminalResolverOwner &&
          (opts as { lockId?: string }).lockId === terminalResolverHolder.lock_id,
      ),
    ).toBe(true);
    const barrierAcquires = tryAcquireResourceMock.mock.calls
      .map(([, opts]) => opts as { resource: string; mode: string })
      .filter(({ resource }) => resource === 'git-sync');
    expect(barrierAcquires).toHaveLength(2);
    expect(barrierAcquires.every(({ mode }) => mode === 'shared')).toBe(true);
    expect(runGitSyncMock).toHaveBeenCalledOnce();
  });

  it('EI-22367010504753373 control: live and opaque shared-barrier holders remain protected', async () => {
    const liveResolverOwner = 'su-live-resolver-session';
    const opaqueResolverOwner = 'merge-resolver-opaque-owner';
    const holders = [
      {
        owner: liveResolverOwner,
        owner_label: 'merge-resolver (live)',
        mode: 'exclusive' as const,
        status: 'held' as const,
        lock_id: 'live-resolver-lock',
        reason: 'merge-resolution git-sync conflict',
        acquired_ts: new Date('2026-09-04T20:00:00.000Z'),
        expires_ts: new Date('2026-09-04T20:10:00.000Z'),
        fence_seq: 13,
      },
      {
        owner: opaqueResolverOwner,
        owner_label: 'opaque resolver',
        mode: 'exclusive' as const,
        status: 'held' as const,
        lock_id: 'opaque-resolver-lock',
        reason: 'merge-resolution git-sync conflict',
        acquired_ts: new Date('2026-09-04T20:00:00.000Z'),
        expires_ts: new Date('2026-09-04T20:10:00.000Z'),
        fence_seq: 14,
      },
    ];
    tryAcquireResourceMock.mockImplementation(async (_tx, opts) =>
      (opts as { resource: string }).resource === 'git-sync'
        ? { ok: false, reason: 'exclusive_pending', holders }
        : { ok: true },
    );
    endedSessionOwnersMock.mockResolvedValue(new Set<string>());
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await action(ctx);
    } finally {
      log.mockRestore();
    }

    expect(endedSessionOwnersMock).toHaveBeenCalledWith([liveResolverOwner, opaqueResolverOwner]);
    expect(
      tryReleaseResourceMock.mock.calls.some(([, opts]) =>
        [liveResolverOwner, opaqueResolverOwner].includes((opts as { owner?: string }).owner ?? ''),
      ),
    ).toBe(false);
    expect(
      tryReleaseResourceMock.mock.calls.some(([, opts]) =>
        ['live-resolver-lock', 'opaque-resolver-lock'].includes((opts as { lockId?: string }).lockId ?? ''),
      ),
    ).toBe(false);
    expect(runGitSyncMock).not.toHaveBeenCalled();
  });

  it('retries transient contention while releasing and completes all releases before the committed event', async () => {
    runGitSyncMock.mockResolvedValue(syncedOutcome);
    const contention = Object.assign(
      new Error('workspace "ws-42" contended while releasing (pg 57014: lock/statement timeout)'),
      { name: 'WorkspaceContendedError', pgCode: '57014' },
    );
    const sequence: string[] = [];
    let releaseAttempts = 0;
    releaseAllResourcesForOwnerMock.mockImplementation(async () => {
      sequence.push('release-lock-set');
      releaseAttempts += 1;
      if (releaseAttempts === 1) throw contention;
      return { released: 3, exclusiveResources: [], waiters: {} };
    });
    emitGitSyncCommittedEventMock.mockImplementation(() => {
      sequence.push('committed-event');
    });

    await action(ctx);

    expect(sequence).toEqual(['release-lock-set', 'release-lock-set', 'committed-event']);
    expect(releaseAllResourcesForOwnerMock).toHaveBeenCalledTimes(2);
    expect(releasedResources()).toEqual(['libs-papercusp-submodule', 'git-sync:papercup', 'git-sync']);
  });

  it('EI-20744916065879285: passes live file-lock paths to the pure pipeline as protected exclusions', async () => {
    const protectedPaths = ['packages/operator-core/lib/harness/git-sync/run-git-sync.ts', 'libs/subA/subA.txt'];
    const protectedHoldings = protectedPaths.map((path, index) => ({
      path,
      owner: `su-lock-holder-${index}`,
      intent: `editing ${path}`,
    }));
    liveLockHoldingsStrictMock.mockResolvedValue(protectedHoldings);
    runGitSyncMock.mockResolvedValue(syncedOutcome);

    await action(ctx);

    expect(liveLockHoldingsStrictMock).toHaveBeenCalledOnce();
    expect(runGitSyncMock.mock.calls[0]?.[1]).toMatchObject({
      excludePaths: protectedPaths,
      liveLockHoldings: protectedHoldings,
    });
  });

  it('EI-22435583452728403: wires a guarded commit-time live-lock refresh into the pure pipeline', async () => {
    const refreshedHoldings = [
      {
        path: 'packages/operator-core/lib/harness/git-sync/run-git-sync.ts',
        owner: 'su-peer',
        intent: 'lock acquired after the initial git-sync census',
      },
    ];
    liveLockHoldingsStrictMock.mockResolvedValueOnce([]).mockResolvedValueOnce(refreshedHoldings);
    let observedRefresh: unknown;
    runGitSyncMock.mockImplementationOnce(async (_slug, opts) => {
      const refresh = opts.refreshLiveLockHoldings as (() => Promise<unknown>) | undefined;
      expect(refresh).toEqual(expect.any(Function));
      observedRefresh = await refresh!();
      return syncedOutcome;
    });

    await action(ctx);

    expect(observedRefresh).toEqual(refreshedHoldings);
    expect(liveLockHoldingsStrictMock).toHaveBeenCalledTimes(2);
  });

  it('P-009 / WI-10002596: a NESTED install maps parent-root lock paths into its own repo root (initial read and refresh)', async () => {
    const parentRepo = join(tmpRoot, 'parent-repo');
    const childRepo = join(parentRepo, 'libs', 'child');
    mkdirSync(join(parentRepo, '.git'), { recursive: true });
    mkdirSync(join(childRepo, '.git'), { recursive: true });
    registryProjects = [
      { slug: 'papercup', path: parentRepo },
      { slug: 'papercup/libs/child', path: childRepo },
    ];
    const held = { path: 'libs/child/src/probe.ts', owner: 'su-prober', intent: 'mutation probe' };
    const elsewhere = { path: 'packages/other.ts', owner: 'su-peer', intent: 'unrelated file in the parent' };
    liveLockHoldingsStrictMock.mockResolvedValue([held, elsewhere]);
    let observedRefresh: unknown;
    runGitSyncMock.mockImplementationOnce(async (_slug, opts) => {
      observedRefresh = await (opts.refreshLiveLockHoldings as () => Promise<unknown>)();
      return {
        status: 'nothing',
        dirtyPathCount: 0,
        committedCount: 0,
        oversized: [],
        contentErrors: [],
        strandedSubmodules: [],
      };
    });

    await fireGitSyncNow('papercup/libs/child', 'ws-42', childRepo);

    // Unmapped, 'libs/child/src/probe.ts' matches nothing inside the child repo and the locked
    // file is committed; mapped, it is excluded as 'src/probe.ts'.
    const mapped = [{ ...held, path: 'src/probe.ts' }];
    expect(runGitSyncMock.mock.calls[0]?.[1]).toMatchObject({ excludePaths: ['src/probe.ts'], liveLockHoldings: mapped });
    expect(observedRefresh).toEqual(mapped);
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
    releaseAllResourcesForOwnerMock.mockImplementation(async (_tx, _cd, owner) => {
      if (owner === activeOwner) activeOwner = null;
      return { released: 3, exclusiveResources: [], waiters: {} };
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
    expect(owners.every((owner) => /^system:git-sync:\d+:[0-9a-f-]+$/.test(owner))).toBe(true);

    releaseFirstRun();
    await first;
  });

  it('EI-20366486129597369: reclaims a dead prior bg-host lock and retries once', async () => {
    const deadPid = await definitelyDeadPid();
    const staleOwner = `system:git-sync:${deadPid}:stale-run`;
    const staleHolder = {
      owner: staleOwner,
      owner_label: 'git-sync:papercup',
      mode: 'exclusive' as const,
      status: 'held' as const,
      lock_id: 'stale-lock-1',
      reason: 'auto-commit papercup',
      acquired_ts: new Date('2026-08-22T05:00:00.000Z'),
      expires_ts: new Date('2026-08-22T05:10:00.000Z'),
      fence_seq: 9,
    };
    let firstAttempt = true;
    tryAcquireResourceMock.mockImplementation(async (_tx, opts) => {
      const resource = (opts as { resource: string }).resource;
      if (resource === 'git-sync:papercup' && firstAttempt) {
        firstAttempt = false;
        return { ok: false, reason: 'held_exclusive', holders: [staleHolder] };
      }
      return { ok: true };
    });
    tryReleaseResourceMock.mockImplementation(async () => ({ ok: true, released: 1 }));
    runGitSyncMock.mockResolvedValue(syncedOutcome);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await action(ctx);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('STALE LOCK RECLAIMED'));
    } finally {
      error.mockRestore();
    }

    expect(parseGitSyncOwnerPid(staleOwner)).toBe(deadPid);
    expect(parseGitSyncOwnerPid('system:git-sync:legacy-uuid')).toBeNull();
    expect(parseGitSyncOwnerPid('release-deploy:123:uuid')).toBeNull();
    expect(tryReleaseResourceMock.mock.calls[0]?.[1]).toMatchObject({
      coordinationDomain: 'ws-42',
      owner: staleOwner,
      lockId: 'stale-lock-1',
    });
    expect(runGitSyncMock).toHaveBeenCalledOnce();
    expect(acquiredResources()).toEqual([
      'git-sync',
      'git-sync:papercup',
      'git-sync:papercup',
      'libs-papercusp-submodule',
    ]);
  });

  /** The filed shape (EI-22078335832051825): an AGENT session's `su-…` lease —
   *  no pid in the owner string, so `parseGitSyncOwnerPid` has nothing to say —
   *  whose session the shared liveness oracle calls `ended`. Pre-fix this sat
   *  until TTL while every tick skipped `held_exclusive`. */
  const endedAgentHolder = {
    owner: 'su-0542551f-ended-agent-session',
    owner_label: 'su · su-05425',
    mode: 'exclusive' as const,
    status: 'held' as const,
    lock_id: 'lock-ended-agent',
    reason: 'mutation probe',
    acquired_ts: new Date('2026-09-01T16:59:00.000Z'),
    expires_ts: new Date('2026-09-01T17:09:25.839Z'),
    fence_seq: 11,
  };

  it('EI-22078335832051825: reclaims an exclusive held by an ENDED agent session (no pid to judge) and retries once', async () => {
    let firstAttempt = true;
    tryAcquireResourceMock.mockImplementation(async (_tx, opts) => {
      const resource = (opts as { resource: string }).resource;
      if (resource === 'git-sync:papercup' && firstAttempt) {
        firstAttempt = false;
        return { ok: false, reason: 'held_exclusive', holders: [endedAgentHolder] };
      }
      return { ok: true };
    });
    tryReleaseResourceMock.mockImplementation(async () => ({ ok: true, released: 1 }));
    endedSessionOwnersMock.mockImplementation(
      async (owners) => new Set(owners.filter((o) => o === endedAgentHolder.owner)),
    );
    runGitSyncMock.mockResolvedValue(syncedOutcome);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await action(ctx);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(
          `STALE LOCK RECLAIMED — papercup git-sync:papercup holder ${endedAgentHolder.owner} (session ended per the shared liveness oracle)`,
        ),
      );
    } finally {
      error.mockRestore();
    }

    expect(parseGitSyncOwnerPid(endedAgentHolder.owner)).toBeNull();
    expect(endedSessionOwnersMock).toHaveBeenCalledTimes(1);
    expect(endedSessionOwnersMock).toHaveBeenCalledWith([endedAgentHolder.owner]);
    // Released by the holder's OWN lock_id — never a bare owner/resource match.
    expect(tryReleaseResourceMock.mock.calls[0]?.[1]).toMatchObject({
      coordinationDomain: 'ws-42',
      owner: endedAgentHolder.owner,
      lockId: endedAgentHolder.lock_id,
    });
    expect(runGitSyncMock).toHaveBeenCalledOnce();
    expect(acquiredResources()).toEqual([
      'git-sync',
      'git-sync:papercup',
      'git-sync:papercup',
      'libs-papercusp-submodule',
    ]);
  });

  it('EI-22078335832051825 control: a LIVE agent session keeps its exclusive — the tick skips, nothing is released', async () => {
    tryAcquireResourceMock.mockImplementation(async (_tx, opts) => {
      const resource = (opts as { resource: string }).resource;
      if (resource === 'git-sync:papercup') {
        return { ok: false, reason: 'held_exclusive', holders: [endedAgentHolder] };
      }
      return { ok: true };
    });
    const releasedLockIds: string[] = [];
    tryReleaseResourceMock.mockImplementation(async (_tx, opts) => {
      const lockId = (opts as { lockId?: string }).lockId;
      if (lockId) releasedLockIds.push(lockId);
      return { ok: true };
    });
    // The oracle was ASKED about the holder and did not condemn it.
    endedSessionOwnersMock.mockResolvedValue(new Set<string>());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await action(ctx);
      expect(error).not.toHaveBeenCalledWith(expect.stringContaining('STALE LOCK RECLAIMED'));
    } finally {
      error.mockRestore();
    }

    expect(endedSessionOwnersMock).toHaveBeenCalledWith([endedAgentHolder.owner]);
    expect(releasedLockIds).not.toContain(endedAgentHolder.lock_id);
    expect(runGitSyncMock).not.toHaveBeenCalled();
  });

  it('WI-2140647: proactively reclaims an orphaned self-owned SHARED git-sync barrier hold (no held_exclusive refusal needed)', async () => {
    // Unlike the two tests above, this hold is never surfaced via a `held_exclusive`
    // refusal — shared coalesces with shared, so tryAcquireResource would happily
    // succeed forever with the stale lease still sitting there. The reclaim here is
    // PROACTIVE: reclaimOrphanedSelfSharedHolds sweeps readResourceQueue's live
    // holders unconditionally before every shared acquire (see its docstring).
    const staleOwner = `system:git-sync:${process.pid}:stale-shared-run`;
    const staleSharedHolder = {
      owner: staleOwner,
      owner_label: 'git-sync:papercup',
      mode: 'shared' as const,
      status: 'held' as const,
      lock_id: 'stale-shared-lock-1',
      reason: 'auto-commit libs/generic/rerank',
      acquired_ts: new Date('2026-09-01T19:06:00.000Z'),
      expires_ts: new Date('2026-09-01T19:16:00.000Z'),
      fence_seq: 7,
    };
    // Only the barrier resource ('git-sync', the mode:'shared' request) carries the
    // stale holder. clearQueuedGitSyncOwners also calls readResourceQueue for every
    // resource (reading .queue, never .holders) — sharing this same conditional mock
    // is safe: it reads .queue:[] for 'git-sync' too, so it sees nothing to purge.
    readResourceQueueMock.mockImplementation(async (_tx, opts) => {
      const resource = (opts as { resource: string }).resource;
      return {
        holders: resource === 'git-sync' ? [staleSharedHolder] : [],
        draining: false,
        queue: [],
      };
    });
    tryReleaseResourceMock.mockResolvedValue({ ok: true, released: 1 });
    runGitSyncMock.mockResolvedValue(syncedOutcome);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await action(ctx);
      expect(error).toHaveBeenCalledWith(
        `[git-sync] ORPHANED SELF SHARED-LEASE RECLAIMED — git-sync holder ${staleOwner} ` +
          '(this process, but no fire here still holds it)',
      );
    } finally {
      error.mockRestore();
    }

    // Released by the holder's OWN lock_id — never a bare owner/resource match.
    expect(tryReleaseResourceMock.mock.calls[0]?.[1]).toMatchObject({
      coordinationDomain: 'ws-42',
      owner: staleOwner,
      lockId: staleSharedHolder.lock_id,
    });
    // No retry needed: the sweep runs BEFORE the acquire, so the barrier is only
    // ever requested once — unlike the exclusive-refusal path's acquire/reclaim/retry.
    expect(runGitSyncMock).toHaveBeenCalledOnce();
    expect(acquiredResources()).toEqual(['git-sync', 'git-sync:papercup', 'libs-papercusp-submodule']);
  });

  it('EI-20224276977835463: refreshes every held lease during a long run and stops refreshing before release', async () => {
    // The scheduled-registry's production/default backend is intentionally inert under
    // Vitest. Inject a deterministic backend for this test instead of opting the
    // production call site into real timers; this exercises the actual heartbeat seam
    // while keeping the callback under direct test control.
    resetScheduledRegistry();
    const timers: Array<{ cb: () => void; ms: number; stopped: boolean; handle: TimerHandle }> = [];
    const timerByHandle = new Map<TimerHandle, (typeof timers)[number]>();
    configureScheduledRegistry({
      setIntervalImpl: (cb, ms) => {
        const handle: TimerHandle = { unref: () => undefined };
        const timer = { cb, ms, stopped: false, handle };
        timers.push(timer);
        timerByHandle.set(handle, timer);
        return handle;
      },
      clearIntervalImpl: (handle) => {
        const timer = timerByHandle.get(handle);
        if (timer) timer.stopped = true;
      },
    });
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

      const initialResources = ['git-sync', 'git-sync:papercup', 'libs-papercusp-submodule'];
      expect(acquiredResources()).toEqual(initialResources);
      const initialOwner = (tryAcquireResourceMock.mock.calls[0][1] as { owner: string }).owner;

      const heartbeatTimer = timers.find((timer) => timer.ms === 60_000);
      expect(heartbeatTimer).toBeDefined();
      heartbeatTimer!.cb();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(acquiredResources()).toEqual([...initialResources, ...initialResources]);
      for (const [, opts] of tryAcquireResourceMock.mock.calls.slice(3)) {
        expect(opts).toMatchObject({ owner: initialOwner, ttlSec: 600 });
      }
      expect(acquiredLockModes().slice(3)).toEqual(['shared', 'exclusive', 'exclusive']);
      // Initial acquisition uses one transaction per resource. The entire
      // three-resource heartbeat adds exactly ONE more, not three.
      expect(workspaceTxnCalls).toHaveLength(4);

      finishRun();
      await running;
      expect(releasedResources()).toEqual([...initialResources].reverse());
      // Cleanup is likewise one owner-scoped bulk transaction.
      expect(workspaceTxnCalls).toHaveLength(5);

      const callsAfterRelease = tryAcquireResourceMock.mock.calls.length;
      expect(heartbeatTimer!.stopped).toBe(true);
      heartbeatTimer!.cb();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(tryAcquireResourceMock).toHaveBeenCalledTimes(callsAfterRelease);
    } finally {
      resetScheduledRegistry();
    }
  });

  it('EI-217286: bounds a stalled pre-runGitSync await, stops the heartbeat, releases leases, and ignores its late settlement', async () => {
    const savedIdle = process.env.PAPERCUSP_GIT_SYNC_ACTION_IDLE_TIMEOUT_MS;
    const savedHard = process.env.PAPERCUSP_GIT_SYNC_ACTION_HARD_TIMEOUT_MS;
    process.env.PAPERCUSP_GIT_SYNC_ACTION_IDLE_TIMEOUT_MS = '25';
    process.env.PAPERCUSP_GIT_SYNC_ACTION_HARD_TIMEOUT_MS = '1000';
    vi.useFakeTimers();
    resetScheduledRegistry();
    const timers: Array<{ cb: () => void; ms: number; stopped: boolean; handle: TimerHandle }> = [];
    const timerByHandle = new Map<TimerHandle, (typeof timers)[number]>();
    configureScheduledRegistry({
      setIntervalImpl: (cb, ms) => {
        const handle: TimerHandle = { unref: () => undefined };
        const timer = { cb, ms, stopped: false, handle };
        timers.push(timer);
        timerByHandle.set(handle, timer);
        return handle;
      },
      clearIntervalImpl: (handle) => {
        const timer = timerByHandle.get(handle);
        if (timer) timer.stopped = true;
      },
    });
    try {
      let flagStarted!: () => void;
      const flagStartedPromise = new Promise<void>((resolve) => {
        flagStarted = resolve;
      });
      let releaseFlag!: (value: boolean) => void;
      const stalledFlag = new Promise<boolean>((resolve) => {
        releaseFlag = resolve;
      });
      getFlagMock.mockImplementationOnce(async () => {
        flagStarted();
        return stalledFlag;
      });

      const running = action(ctx);
      // Attach the rejection handler before advancing the fake clock. Vitest's
      // unhandled-rejection hook runs at the timer turn itself, before a later
      // `await running` would be considered a handler.
      const settled = running.then(
        () => ({ value: undefined as unknown, error: undefined as unknown }),
        (error) => ({ value: undefined as unknown, error }),
      );
      await flagStartedPromise;
      expect(runGitSyncMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30);
      const settledResult = await settled;
      const thrown = settledResult.error;
      expect(thrown).toBeInstanceOf(GitSyncActionTimeoutError);
      expect(thrown).toMatchObject({ phase: 'read-content-guard-flag', timeoutKind: 'idle', timeoutMs: 25 });
      expect(runGitSyncMock).not.toHaveBeenCalled();
      expect(releasedResources()).toEqual(['libs-papercusp-submodule', 'git-sync:papercup', 'git-sync']);
      expect(timers.find((timer) => timer.ms === 60_000)?.stopped).toBe(true);
      expect(gitSyncActivityPatches().at(-1)).toMatchObject({
        active: false,
        phase: 'error',
        outcome_status: null,
      });
      expect(allRoutinePatches()).toContainEqual(
        expect.objectContaining({
          last_status: 'error',
          local_sync_status: 'error',
          last_error: expect.stringContaining('git-sync action timed out'),
        }),
      );

      // The underlying setup promise may eventually resolve, but the guarded
      // await has already rejected and must not let the pipeline resume.
      releaseFlag(true);
      await Promise.resolve();
      await vi.runAllTicks();
      expect(runGitSyncMock).not.toHaveBeenCalled();
    } finally {
      resetScheduledRegistry();
      vi.useRealTimers();
      if (savedIdle === undefined) delete process.env.PAPERCUSP_GIT_SYNC_ACTION_IDLE_TIMEOUT_MS;
      else process.env.PAPERCUSP_GIT_SYNC_ACTION_IDLE_TIMEOUT_MS = savedIdle;
      if (savedHard === undefined) delete process.env.PAPERCUSP_GIT_SYNC_ACTION_HARD_TIMEOUT_MS;
      else process.env.PAPERCUSP_GIT_SYNC_ACTION_HARD_TIMEOUT_MS = savedHard;
    }
  });

  it('lets pending progress refresh an expired idle timer before committing the action timeout', async () => {
    vi.stubEnv('PAPERCUSP_GIT_SYNC_ACTION_IDLE_TIMEOUT_MS', '25');
    vi.stubEnv('PAPERCUSP_GIT_SYNC_ACTION_HARD_TIMEOUT_MS', '500');
    vi.useFakeTimers();
    let start!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    let complete!: (outcome: GitSyncOutcome) => void;
    let signal!: AbortSignal;
    let progress!: () => void;
    runGitSyncMock.mockImplementation(async (_slug, opts) => {
      signal = opts.signal as AbortSignal;
      progress = opts.onProgress as () => void;
      start();
      return new Promise<GitSyncOutcome>((resolve) => { complete = resolve; });
    });
    const running = action(ctx).then((value) => ({ value, error: null }), (error) => ({ value: null, error }));
    try {
      await started;
      await vi.advanceTimersByTimeAsync(25);
      // TIMERS has expired, but pending POLL progress gets a chance before the
      // deferred CHECK verdict. Real OS-pipe ordering is covered by the two
      // local/sidecar process regressions; fake time pins this outer guard.
      expect(signal.aborted).toBe(false);
      progress();
      await vi.advanceTimersByTimeAsync(5);
      expect(signal.aborted).toBe(false);
      complete(syncedOutcome);
      expect((await running).error).toBeNull();
    } finally {
      complete?.(syncedOutcome);
      await running;
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it('EI-217286: aborts an active git run at the hard deadline even while progress keeps resetting idle', async () => {
    const savedIdle = process.env.PAPERCUSP_GIT_SYNC_ACTION_IDLE_TIMEOUT_MS;
    const savedHard = process.env.PAPERCUSP_GIT_SYNC_ACTION_HARD_TIMEOUT_MS;
    process.env.PAPERCUSP_GIT_SYNC_ACTION_IDLE_TIMEOUT_MS = '40';
    process.env.PAPERCUSP_GIT_SYNC_ACTION_HARD_TIMEOUT_MS = '60';
    vi.useFakeTimers();
    resetScheduledRegistry();
    const timers: Array<{ cb: () => void; ms: number; stopped: boolean; handle: TimerHandle }> = [];
    const timerByHandle = new Map<TimerHandle, (typeof timers)[number]>();
    configureScheduledRegistry({
      setIntervalImpl: (cb, ms) => {
        const handle: TimerHandle = { unref: () => undefined };
        const timer = { cb, ms, stopped: false, handle };
        timers.push(timer);
        timerByHandle.set(handle, timer);
        return handle;
      },
      clearIntervalImpl: (handle) => {
        const timer = timerByHandle.get(handle);
        if (timer) timer.stopped = true;
      },
    });
    try {
      let runStarted!: () => void;
      const runStartedPromise = new Promise<void>((resolve) => {
        runStarted = resolve;
      });
      let reportProgress!: () => void;
      let aborted = false;
      runGitSyncMock.mockImplementation(async (_slug, opts) => {
        reportProgress = opts.onProgress as () => void;
        const signal = opts.signal as AbortSignal;
        runStarted();
        return new Promise<GitSyncOutcome>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(signal.reason ?? new Error('aborted'));
            },
            { once: true },
          );
        });
      });

      const running = action(ctx);
      const settled = running.then(
        () => ({ value: undefined as unknown, error: undefined as unknown }),
        (error) => ({ value: undefined as unknown, error }),
      );
      await runStartedPromise;
      expect(reportProgress).toBeTypeOf('function');
      await vi.advanceTimersByTimeAsync(15);
      reportProgress();
      await Promise.resolve();
      await Promise.resolve();
      const heartbeatPatches = gitSyncActivityPatches();
      expect(
        heartbeatPatches.some(
          (activity) =>
            activity.active === true &&
            activity.phase === 'local-sync' &&
            typeof activity.updated_at === 'number' &&
            typeof activity.started_at === 'number' &&
            activity.updated_at > activity.started_at,
        ),
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(15);
      reportProgress();
      // Two progress touches keep the 40ms idle deadline out, but cannot move
      // the independent 60ms hard ceiling.
      await vi.advanceTimersByTimeAsync(40);

      let thrown: unknown;
      thrown = (await settled).error;
      expect(thrown).toBeInstanceOf(GitSyncActionTimeoutError);
      expect(thrown).toMatchObject({ phase: 'run-git-sync', timeoutKind: 'hard', timeoutMs: 60 });
      expect(aborted).toBe(true);
      expect((runGitSyncMock.mock.calls[0]?.[1] as { signal: AbortSignal }).signal.aborted).toBe(true);
      expect(releasedResources()).toEqual(['libs-papercusp-submodule', 'git-sync:papercup', 'git-sync']);
      expect(timers.find((timer) => timer.ms === 60_000)?.stopped).toBe(true);
    } finally {
      resetScheduledRegistry();
      vi.useRealTimers();
      if (savedIdle === undefined) delete process.env.PAPERCUSP_GIT_SYNC_ACTION_IDLE_TIMEOUT_MS;
      else process.env.PAPERCUSP_GIT_SYNC_ACTION_IDLE_TIMEOUT_MS = savedIdle;
      if (savedHard === undefined) delete process.env.PAPERCUSP_GIT_SYNC_ACTION_HARD_TIMEOUT_MS;
      else process.env.PAPERCUSP_GIT_SYNC_ACTION_HARD_TIMEOUT_MS = savedHard;
    }
  });

  it.each(['resolve', 'reject'] as const)('retains repository leases and heartbeat until an aborted Git child settles (%s)', async (settlement) => {
    vi.useFakeTimers();
    vi.stubEnv('PAPERCUSP_GIT_SYNC_ACTION_IDLE_TIMEOUT_MS', '25');
    vi.stubEnv('PAPERCUSP_GIT_SYNC_ACTION_HARD_TIMEOUT_MS', '100');
    resetScheduledRegistry();
    let heartbeat!: () => void;
    let heartbeatStopped = false;
    const handle: TimerHandle = { unref: () => undefined };
    configureScheduledRegistry({
      setIntervalImpl: (cb) => { heartbeat = cb; return handle; },
      clearIntervalImpl: () => { heartbeatStopped = true; },
    });
    let childStarted!: () => void;
    const started = new Promise<void>((resolve) => { childStarted = resolve; });
    let finishChild!: () => void;
    let childSignal!: AbortSignal;
    runGitBoundedMock.mockImplementationOnce(async (...args) => {
      childSignal = (args[3] as { signal: AbortSignal }).signal;
      childStarted();
      await new Promise<void>((resolve) => { finishChild = resolve; });
      if (settlement === 'reject') throw new Error('child exit failure');
      return { code: -1, stdout: '', stderr: 'child exited' };
    });
    runGitSyncMock.mockImplementationOnce(async (_slug, raw) => {
      const opts = raw as unknown as RunGitSyncOpts;
      // Model the pipeline's existing injected/default runner seam on both
      // revisions, so old code reaches the actual premature-release assertion.
      const run = opts.runGit ?? ((args, cwd) => runGitBoundedMock(args, cwd, 30_000, { signal: opts.signal }));
      await run(['commit'], repoDir);
      return syncedOutcome;
    });
    let returned = false;
    const running = action(ctx).then(
      () => { returned = true; return null; },
      (error: unknown) => { returned = true; return error; },
    );
    try {
      await started;
      // Outlive both action deadlines and the 15s DB-cleanup budget: neither
      // timeout is a child-exit receipt, and leases must still be renewed.
      await vi.advanceTimersByTimeAsync(20_100);
      expect(childSignal.aborted).toBe(true);
      expect(returned).toBe(false);
      expect(releasedResources()).toEqual([]);
      expect(heartbeatStopped).toBe(false);
      const acquisitions = acquiredResources().length;
      heartbeat();
      await Promise.resolve();
      await Promise.resolve();
      expect(acquiredResources().length).toBeGreaterThan(acquisitions);
      finishChild();
      expect(await running).toBeInstanceOf(GitSyncActionTimeoutError);
      expect(releasedResources()).toEqual(['libs-papercusp-submodule', 'git-sync:papercup', 'git-sync']);
      expect(heartbeatStopped).toBe(true);
    } finally {
      finishChild?.();
      await running;
      resetScheduledRegistry();
      vi.useRealTimers();
      vi.unstubAllEnvs();
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
  it("WI-5960: the acquired coordinationDomain for git-sync:<slug> agrees with coordination-domain.ts's own resourceLockDomain/workspaceScopedLockDomain", async () => {
    const savedEnv = process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_WORKSPACE_ID = 'ws-42'; // mirrors ctx.workspaceId used above
    try {
      runGitSyncMock.mockResolvedValue(syncedOutcome);
      await action(ctx);

      const acquiredDomain = (
        tryAcquireResourceMock.mock.calls.find(
          ([, opts]) => (opts as { resource: string }).resource === 'git-sync:papercup',
        )?.[1] as { coordinationDomain: string }
      ).coordinationDomain;
      expect(acquiredDomain).toBe('ws-42');
      // The exact invariant an su's locks:acquire_resource relies on: resolving
      // the SAME resource name through coordination-domain.ts's own logic must
      // land in the domain the routine actually acquired under.
      expect(resourceLockDomain('git-sync:papercup')).toBe(acquiredDomain);
      expect(resourceLockDomain('git-sync')).toBe(acquiredDomain);
      expect(workspaceScopedLockDomain()).toBe(acquiredDomain);
    } finally {
      if (savedEnv === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
      else process.env.PAPERCUSP_WORKSPACE_ID = savedEnv;
    }
  });

  it('a harness with NO extra_lock_resources acquires the shared barrier and its own per-slug resource', async () => {
    registryProjects = [{ slug: 'otherapp', path: repoDir }];
    runGitSyncMock.mockResolvedValue({
      status: 'nothing',
      dirtyPathCount: 0,
      committedCount: 0,
      oversized: [],
      contentErrors: [],
      strandedSubmodules: [],
    });

    await action({ ...ctx, installSlug: 'otherapp', triggerConfig: {} });

    expect(acquiredResources()).toEqual(['git-sync', 'git-sync:otherapp']);
    expect(acquiredLockModes()).toEqual(['shared', 'exclusive']);
    expect(registeredResources()).toEqual(['git-sync:otherapp']);
    expect(runGitSyncMock).toHaveBeenCalledTimes(1);
    expect(releasedResources()).toEqual(['git-sync:otherapp', 'git-sync']);
  });

  it('an UNKNOWN extra lock resource SKIPS the tick with a loud warning — and is never auto-registered', async () => {
    tryAcquireResourceMock.mockImplementation(async (_tx, opts) =>
      (opts as { resource: string }).resource === 'my-deploy-lock'
        ? { ok: false, reason: 'unknown_resource' }
        : { ok: true },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action({ ...ctx, triggerConfig: { extra_lock_resources: ['my-deploy-lock'] } });

    expect(runGitSyncMock).not.toHaveBeenCalled();
    expect(appendPipelineEventMock).not.toHaveBeenCalled();
    expect(routinePatches()).toEqual([
      expect.objectContaining({
        last_status: 'skipped',
        local_sync_status: 'skipped',
        last_skip_reason: 'unknown_resource',
        last_skipped_at: expect.any(Number),
        last_skipped_paths: [],
      }),
    ]);
    // the deliberate, human-registered surface: warned about, not auto-registered
    expect(registeredResources()).toEqual(['git-sync:papercup']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"my-deploy-lock" is not registered'));
    // The unknown name cannot have produced a lease, but the terminal-skip
    // cleanup still issues the same owner-scoped no-op release before unwinding
    // the already-held per-slug and shared-barrier resources.
    expect(releasedResources()).toEqual(['my-deploy-lock', 'git-sync:papercup', 'git-sync']);
    warn.mockRestore();
  });

  it('releases the locks even when runGitSync THROWS (the finally), and the error propagates', async () => {
    runGitSyncMock.mockRejectedValue(new Error('git exploded'));

    await expect(action(ctx)).rejects.toThrow('git exploded');

    expect(releasedResources()).toEqual(['libs-papercusp-submodule', 'git-sync:papercup', 'git-sync']);
    // nothing past the run executed
    expect(routinePatches()).toEqual([]);
    expect(appendPipelineEventMock).not.toHaveBeenCalled();
  });

  /** Every setup await after acquisition must leave through the same outer finally. */
  async function expectSetupFailure(errorMessage: string): Promise<void> {
    tryAcquireResourceMock.mockResolvedValue({ ok: true });
    tryReleaseResourceMock.mockResolvedValue({ ok: true });

    await expect(action(ctx)).rejects.toThrow(errorMessage);

    expect(runGitSyncMock).not.toHaveBeenCalled();
    expect(releasedResources()).toEqual(['libs-papercusp-submodule', 'git-sync:papercup', 'git-sync']);
    expect(gitSyncActivityPatches().slice(-1)[0]).toMatchObject({
      active: false,
      phase: 'error',
      outcome_status: null,
    });
  }

  it('releases every resource when the first post-lock activity write rejects', async () => {
    // The first unsafe write is the pre-lock fire breadcrumb; the second is the
    // activity write immediately after acquisition.
    rejectUnsafeAtCall = 2;

    await expectSetupFailure('injected setup metadata write failure');
  });

  it('releases every resource when the post-lock escalation-counter read rejects', async () => {
    rejectTemplateOnce = new Error('injected setup counter read failure');

    await expectSetupFailure('injected setup counter read failure');
  });

  it('releases every resource when the first post-lock feature-flag read rejects', async () => {
    getFlagMock.mockRejectedValueOnce(new Error('injected setup flag read failure'));

    await expectSetupFailure('injected setup flag read failure');
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
      expect.objectContaining({
        last_status: 'skipped',
        last_skip_reason: reason,
        last_skipped_at: expect.any(Number),
      }),
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
  it('records routine metadata, clears BOTH escalation kinds, and queues docs only after terminal activity', async () => {
    runGitSyncMock.mockResolvedValue(syncedOutcome);
    let activityAtDocEnqueue: Record<string, unknown> | undefined;
    enqueueDocSweepMock.mockImplementation(() => {
      activityAtDocEnqueue = gitSyncActivityPatches().at(-1);
    });

    await action(ctx);

    // trigger config defaults flow into the pipeline (+ WI-1416: the checkpoint seam)
    expect(runGitSyncMock).toHaveBeenCalledWith(
      'papercup',
      expect.objectContaining({
        repoPath: repoDir,
        config: expect.objectContaining({ push: true, pushSubmodules: true }),
        deletionGuard: true,
        diffSubjects: true, // WI-38594: flag-driven (mock getFlag defaults true)
        step: expect.any(Function),
      }),
    );

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

    const historyWrites = unsafeCalls.filter((c) => c.text.includes("'git_sync_history'"));
    expect(historyWrites).toHaveLength(1);
    expect(historyWrites[0].text).toContain('jsonb_array_elements');
    expect(historyWrites[0].text).toContain('WITH ORDINALITY');
    expect(historyWrites[0].text).toContain('LIMIT 30');
    expect(routineHistoryEntries()).toEqual([
      expect.objectContaining({
        ts: expect.any(Number),
        status: 'synced',
        dirty_path_count: 4,
        committed_count: 2,
        error: null,
        reaped: false,
      }),
    ]);

    expect(appendPipelineEventMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        workspaceId: 'ws-42',
        installSlug: 'papercup',
        kind: 'git_sync',
        status: 'synced',
        detail: expect.objectContaining({
          headSha: 'abc123def456',
          consecutiveErrorTicks: 0,
          dirtyPathCount: 4,
          committedCount: 2,
        }),
      }),
    );

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

    // P-003 doc-freshness sweep is queued only after every Git post-leg and the
    // terminal activity write, with the pre-sync HEAD preserved for its diff.
    expect(enqueueDocSweepMock).toHaveBeenCalledExactlyOnceWith({
      harnessSlug: 'papercup',
      workspaceId: 'ws-42',
      repoRoot: repoDir,
      prevSha: 'prev-sha-000',
      headSha: 'abc123def456',
    });
    expect(activityAtDocEnqueue).toMatchObject({ active: false, phase: 'complete' });

    expect(gitSyncActivityPatches()).toEqual([
      expect.objectContaining({ active: true, phase: 'local-sync', outcome_status: null }),
      expect.objectContaining({ active: true, phase: 'post-legs', outcome_status: 'synced' }),
      expect.objectContaining({ active: false, phase: 'complete', outcome_status: 'synced' }),
    ]);
  });

  it("a 'nothing' pass also clears escalations but records no head_sha and runs no doc sweep", async () => {
    runGitSyncMock.mockResolvedValue({
      status: 'nothing',
      dirtyPathCount: 0,
      committedCount: 0,
      oversized: [],
      contentErrors: [],
      strandedSubmodules: [],
    });

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
    expect(enqueueDocSweepMock).not.toHaveBeenCalled();
    expect(appendPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'git_sync', status: 'nothing' }),
    );
  });

  it('EI-21096441920219468: records skipped-locked holder provenance in metadata and pipeline detail', async () => {
    const skippedPaths = [
      {
        scope: 'superproject',
        path: 'packages/operator-core/lib/harness/git-sync/run-git-sync.ts',
        owner: 'su-peer',
        intent: 'editing the source half of an atomic change',
      },
      {
        scope: 'superproject',
        path: 'packages/operator-core/lib/harness/git-sync/git-sync-action.test.ts',
        owner: 'su-peer',
        intent: 'adding the action regression coverage',
      },
      {
        scope: 'libs/papercusp',
        path: 'packages/shared.ts',
        owner: 'su-other-peer',
        intent: 'editing the shared helper',
      },
    ];
    runGitSyncMock.mockResolvedValue({
      status: 'skipped-locked',
      dirtyPathCount: 1,
      committedCount: 0,
      skippedPaths,
      oversized: [],
      contentErrors: [],
      strandedSubmodules: [],
    });

    await action(ctx);

    expect(routinePatches()).toContainEqual(
      expect.objectContaining({
        last_status: 'skipped-locked',
        local_sync_status: 'skipped-locked',
        last_skip_reason: 'locked-path',
        last_skipped_at: expect.any(Number),
        last_skipped_paths: skippedPaths,
        last_pushed: [],
        last_merged: [],
      }),
    );
    expect(appendPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'git_sync',
        status: 'skipped-locked',
        detail: expect.objectContaining({ skippedPaths }),
      }),
    );
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    const notices = new Map(
      sendMessageMock.mock.calls.map(([, message]) => {
        const msg = message as { to: string[]; summary: string; body: string; category: string };
        return [msg.to[0], msg];
      }),
    );
    expect(notices.get('su-peer')).toMatchObject({
      to: ['su-peer'],
      category: 'git-sync',
      summary: expect.stringContaining('skipped 2 locked dirty paths'),
      body: expect.stringContaining('locks:release'),
    });
    expect(notices.get('su-peer')?.body).toContain('run-git-sync.ts');
    expect(notices.get('su-peer')?.body).toContain('adding the action regression coverage');
    expect(notices.get('su-other-peer')).toMatchObject({
      to: ['su-other-peer'],
      category: 'git-sync',
      summary: expect.stringContaining('skipped 1 locked dirty path'),
    });
    expect(enqueueDocSweepMock).not.toHaveBeenCalled();
  });

  it('EI-21743795611133311: notifies holders and preserves provenance when unlocked work still syncs', async () => {
    const skippedPaths = [
      {
        scope: 'superproject',
        path: 'packages/operator-core/lib/agent-tools/locks/acquire_resource.test.ts',
        owner: 'su-peer',
        intent: 'finishing the lock-release regression test',
      },
    ];
    runGitSyncMock.mockResolvedValue({ ...syncedOutcome, skippedPaths });

    await action(ctx);

    expect(routinePatches()).toContainEqual(
      expect.objectContaining({
        last_status: 'synced',
        last_skip_reason: 'locked-path',
        last_skipped_at: expect.any(Number),
        last_skipped_paths: skippedPaths,
      }),
    );
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [, notice] = sendMessageMock.mock.calls[0];
    expect(notice).toMatchObject({
      to: ['su-peer'],
      category: 'git-sync',
    });
    expect((notice as { body: string }).body).toContain('unlocked remainder may have synced');
  });

  // P-009 (ex-P-028): last_skipped_paths is overwritten every tick, so the bounded
  // git_sync_history ring must carry what EACH tick withheld.
  it('P-009: records the tick\'s exclusions in its git_sync_history entry, capped per entry', async () => {
    const skippedPaths = Array.from({ length: GIT_SYNC_HISTORY_EXCLUDED_PATHS_CAP + 5 }, (_, i) => ({
      scope: 'superproject',
      path: `src/locked-${i}.ts`,
      owner: 'su-peer',
      intent: 'mid-edit',
    }));
    runGitSyncMock.mockResolvedValue({ ...syncedOutcome, skippedPaths });

    await action(ctx);

    const [entry] = routineHistoryEntries();
    const excluded = entry.excluded as Record<string, unknown>;
    expect(excluded.locked_count).toBe(GIT_SYNC_HISTORY_EXCLUDED_PATHS_CAP + 5);
    expect(excluded.locked_paths).toHaveLength(GIT_SYNC_HISTORY_EXCLUDED_PATHS_CAP);
    expect((excluded.locked_paths as string[])[0]).toBe('superproject:src/locked-0.ts');
    expect(excluded).toMatchObject({ oversized_count: 0, bulk_count: 0, quarantined: [], quarantined_count: 0 });
  });

  it('P-009: a tick that withheld nothing still records an explicit empty exclusion set', async () => {
    runGitSyncMock.mockResolvedValue({ ...syncedOutcome });
    await action(ctx);
    expect(routineHistoryEntries()[0].excluded).toEqual({
      locked_paths: [],
      locked_count: 0,
      oversized_count: 0,
      bulk_count: 0,
      quarantined: [],
      quarantined_count: 0,
    });
  });

  it('EI-21743795611133311: a notification failure never fails the partial git-sync tick', async () => {
    const skippedPaths = [
      {
        scope: 'superproject',
        path: 'packages/operator-core/lib/agent-tools/locks/acquire_resource.test.ts',
        owner: 'su-peer',
        intent: 'finishing the lock-release regression test',
      },
    ];
    runGitSyncMock.mockResolvedValue({ ...syncedOutcome, skippedPaths });
    sendMessageMock.mockRejectedValue(new Error('coordination store unavailable'));

    await expect(action(ctx)).resolves.toBeUndefined();

    expect(runGitSyncMock).toHaveBeenCalledOnce();
    expect(appendPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'git_sync', status: 'synced' }),
    );
    expect(routinePatches()[0]).toMatchObject({
      last_status: 'synced',
      last_skipped_paths: skippedPaths,
    });
  });

  it('maps the routine trigger_config onto the pipeline config', async () => {
    runGitSyncMock.mockResolvedValue({
      status: 'nothing',
      dirtyPathCount: 0,
      committedCount: 0,
      oversized: [],
      contentErrors: [],
      strandedSubmodules: [],
    });

    await action({
      ...ctx,
      triggerConfig: {
        push: false,
        push_submodules: false,
        pushSubmoduleOrigins: false,
        branch: 'staging',
        remote: 'upstream',
        max_blob_bytes: 1024,
        max_commit_total_bytes: 2048,
      },
    });

    expect(runGitSyncMock).toHaveBeenCalledWith(
      'papercup',
      expect.objectContaining({
        repoPath: repoDir,
        config: {
          push: false,
          pushSubmodules: false,
          pushSubmoduleOrigins: false,
          branch: 'staging',
          remote: 'upstream',
          maxBlobBytes: 1024,
          maxCommitTotalBytes: 2048,
        },
        deletionGuard: true,
        diffSubjects: true, // WI-38594: flag-driven (mock getFlag defaults true)
        step: expect.any(Function),
      }),
    );
  });

  it.each(['bridged', 'p2p-only'] as const)(
    'EI-20232774599730947: %s mode makes the superproject truly commit-only while preserving submodule-origin sync',
    async (mode) => {
      const servingWarning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      potGitMode = mode;
      registryProjects = [{ slug: 'papercup', path: repoDir, hive_slug: 'papercup' }];
      runGitSyncMock.mockResolvedValue({
        status: 'nothing',
        dirtyPathCount: 0,
        committedCount: 0,
        oversized: [],
        contentErrors: [],
        strandedSubmodules: [],
      });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await action(ctx);
      } finally {
        log.mockRestore();
      }

      expect(runGitSyncMock).toHaveBeenCalledWith(
        'papercup',
        expect.objectContaining({
          config: expect.objectContaining({
            push: false,
            pushSubmoduleOrigins: true,
            reconcileSuperprojectOrigin: false,
            bridgeContainedReleaseMainOnCommitOnly: mode === 'bridged',
          }),
          beforePush: expect.any(Function),
        }),
      );
      const pushGate = (runGitSyncMock.mock.calls[0][1] as RunGitSyncOpts).beforePush!;
      await expect(pushGate(['push', 'origin', 'HEAD:main'], repoDir)).rejects.toThrow('owning hive key');
      expect(gitSyncActivityPatches().map((activity) => activity.phase)).toEqual([
        'local-sync',
        'post-legs',
        'complete',
      ]);
      expect(gitSyncActivityPatches()[1]).toMatchObject({ active: true, outcome_status: 'nothing' });
      expect(servingWarning).toHaveBeenCalledWith(expect.stringContaining('serving unavailable'));
      servingWarning.mockRestore();
    },
  );

  it('EI-20232774599730947: a pre-seeded P2P member stays superproject commit-only and honors its explicit submodule-origin push', async () => {
    const servingWarning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    potGitMode = 'bridged';
    registryProjects = [{ slug: 'papercup', path: repoDir, hive_slug: 'papercup' }];
    runGitSyncMock.mockResolvedValue({
      status: 'nothing',
      dirtyPathCount: 0,
      committedCount: 0,
      oversized: [],
      contentErrors: [],
      strandedSubmodules: [],
    });

    await action({
      ...ctx,
      triggerConfig: { push: false, pushSubmoduleOrigins: true },
    });
    expect(servingWarning).toHaveBeenCalledWith(expect.stringContaining('serving unavailable'));
    servingWarning.mockRestore();

    expect(runGitSyncMock).toHaveBeenCalledWith(
      'papercup',
      expect.objectContaining({
        config: expect.objectContaining({
          push: false,
          pushSubmoduleOrigins: true,
          reconcileSuperprojectOrigin: false,
        }),
        beforePush: expect.any(Function),
      }),
    );
  });

  // EI-24099226502437988: the own-head leg used to return SILENTLY on its
  // preconditions, so `own_head_publish` froze while fires kept committing and
  // nothing said which exit had fired. These pin that each reachable exit now
  // writes a named `own_head_publish_skip` record and a warn line.
  const ownHeadSkipRecords = (): unknown[] =>
    allRoutinePatches()
      .filter((p) => 'own_head_publish_skip' in p)
      .map((p) => p.own_head_publish_skip);

  it('EI-24099226502437988: a bridged tick whose device actor does not resolve records a named own-head skip', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      potGitMode = 'bridged';
      registryProjects = [{ slug: 'papercup', path: repoDir, hive_slug: 'papercup' }];
      runGitSyncMock.mockResolvedValue({
        status: 'nothing',
        dirtyPathCount: 0,
        committedCount: 0,
        oversized: [],
        contentErrors: [],
        strandedSubmodules: [],
      });

      await action({ ...ctx, triggerConfig: { push: false } });

      expect(ownHeadSkipRecords()).toContainEqual({
        at: expect.any(Number),
        reason: 'no-device-actor',
        detail: expect.stringContaining('resolveHiveGitActor returned null'),
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[git-sync] papercup: own-head publish SKIPPED — no-device-actor'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('EI-24099226502437988: a registry read that fails inside the own-head leg records registry-unreadable, not silence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const originalRegistry = loadHarnessRegistryMock.getMockImplementation();
    try {
      potGitMode = 'bridged';
      registryProjects = [{ slug: 'papercup', path: repoDir, hive_slug: 'papercup' }];
      // The gate and local-sync read the registry normally. Every read after
      // local-sync fails, as a PG connect timeout would under a starved loop.
      runGitSyncMock.mockImplementation(async () => {
        loadHarnessRegistryMock.mockImplementation(async () => {
          throw new Error('timeout exceeded when trying to connect');
        });
        return {
          status: 'nothing',
          dirtyPathCount: 0,
          committedCount: 0,
          oversized: [],
          contentErrors: [],
          strandedSubmodules: [],
        };
      });

      await action({ ...ctx, triggerConfig: { push: false } });

      expect(ownHeadSkipRecords()).toContainEqual({
        at: expect.any(Number),
        reason: 'registry-unreadable',
        detail: 'timeout exceeded when trying to connect',
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[git-sync] papercup: own-head publish SKIPPED — registry-unreadable'),
      );
    } finally {
      if (originalRegistry) loadHarnessRegistryMock.mockImplementation(originalRegistry);
      runGitSyncMock.mockReset();
      warn.mockRestore();
    }
  });

  it('EI-22154166487566939: a stalled post-legs leg (github-bridge) is bounded by its own liveness guard, names the hung leg, and never reaches the terminal complete write', async () => {
    // Regression for a fleet-wide wedge: the post-legs phase (github-bridge,
    // bootstrap, own-head-publish, ref-announce, integrator,
    // ref-announce-post-integrator, worktree-bridge) used to run with ZERO
    // idle/hard-timeout protection — the local-sync liveness guard is stopped in
    // its own finally before this phase begins. A hang in any one leg wedged
    // `phase: 'post-legs'` indefinitely, with `last_status` still reading
    // 'synced' from the tick before. The fix gives post-legs its own
    // independent liveness guard (postLegsLiveness/guardedPostLegs); this test
    // pins that a hang inside the FIRST post-legs leg (github-bridge's
    // `loadHarnessRegistry` await) is bounded, named, and recorded as a
    // terminal error rather than left stuck.
    const savedIdle = process.env.PAPERCUSP_GIT_SYNC_ACTION_IDLE_TIMEOUT_MS;
    const savedHard = process.env.PAPERCUSP_GIT_SYNC_ACTION_HARD_TIMEOUT_MS;
    process.env.PAPERCUSP_GIT_SYNC_ACTION_IDLE_TIMEOUT_MS = '25';
    process.env.PAPERCUSP_GIT_SYNC_ACTION_HARD_TIMEOUT_MS = '1000';
    vi.useFakeTimers();
    resetScheduledRegistry();
    const timers: Array<{ cb: () => void; ms: number; stopped: boolean; handle: TimerHandle }> = [];
    const timerByHandle = new Map<TimerHandle, (typeof timers)[number]>();
    configureScheduledRegistry({
      setIntervalImpl: (cb, ms) => {
        const handle: TimerHandle = { unref: () => undefined };
        const timer = { cb, ms, stopped: false, handle };
        timers.push(timer);
        timerByHandle.set(handle, timer);
        return handle;
      },
      clearIntervalImpl: (handle) => {
        const timer = timerByHandle.get(handle);
        if (timer) timer.stopped = true;
      },
    });
    potGitMode = 'bridged';
    registryProjects = [{ slug: 'papercup', path: repoDir, hive_slug: 'papercup' }];
    try {
      // Local-sync's own runGitSync call must complete NORMALLY — this fix is
      // scoped strictly to legs AFTER local-sync. Flip hangArmed the instant it
      // resolves so the FIRST post-legs await (github-bridge's
      // loadHarnessRegistry — the same established hang-point technique used
      // elsewhere in this file, e.g. EI-18121952237624498) never settles.
      let hangArmed = false;
      runGitSyncMock.mockImplementationOnce(async () => {
        hangArmed = true;
        return {
          status: 'nothing',
          dirtyPathCount: 0,
          committedCount: 0,
          oversized: [],
          contentErrors: [],
          strandedSubmodules: [],
        };
      });
      let bridgeHangStarted!: () => void;
      const bridgeHangStartedPromise = new Promise<void>((resolve) => {
        bridgeHangStarted = resolve;
      });
      loadHarnessRegistryMock.mockImplementation(async (workspaceId?: string) => {
        if (hangArmed) {
          bridgeHangStarted();
          // Deliberately never settles — this is the hang the fix must bound.
          return new Promise<never>(() => {});
        }
        return { projects: workspaceId ? registryProjects : (ambientRegistryProjects ?? registryProjects) };
      });

      const running = action(ctx);
      const settled = running.then(
        () => ({ value: undefined as unknown, error: undefined as unknown }),
        (error) => ({ value: undefined as unknown, error }),
      );

      await bridgeHangStartedPromise;
      // Local-sync completed (and its OWN guard already stopped) before the
      // hang — proves the hang is scoped to a post-legs leg, not local-sync.
      expect(runGitSyncMock).toHaveBeenCalledOnce();
      expect(gitSyncActivityPatches().map((activity) => activity.phase)).toEqual(['local-sync', 'post-legs']);

      await vi.advanceTimersByTimeAsync(30);
      const settledResult = await settled;
      const thrown = settledResult.error;
      expect(thrown).toBeInstanceOf(GitSyncActionTimeoutError);
      expect(thrown).toMatchObject({
        phase: 'git-sync:github-bridge',
        timeoutKind: 'idle',
        timeoutMs: 25,
      });

      // Recorded as a terminal error — never left stuck at 'post-legs', and the
      // pipeline never reaches the terminal 'complete' write.
      const phases = gitSyncActivityPatches().map((activity) => activity.phase);
      expect(phases).not.toContain('complete');
      expect(gitSyncActivityPatches().at(-1)).toMatchObject({
        active: false,
        phase: 'error',
        outcome_status: null,
      });
    } finally {
      resetScheduledRegistry();
      vi.useRealTimers();
      // This test is the only one that overrides loadHarnessRegistryMock's
      // implementation (vs. just inspecting its calls) — restore the module's
      // own default so a later test never inherits an armed, hanging mock.
      loadHarnessRegistryMock.mockImplementation(async (workspaceId?: string) => ({
        projects: workspaceId ? registryProjects : (ambientRegistryProjects ?? registryProjects),
      }));
      if (savedIdle === undefined) delete process.env.PAPERCUSP_GIT_SYNC_ACTION_IDLE_TIMEOUT_MS;
      else process.env.PAPERCUSP_GIT_SYNC_ACTION_IDLE_TIMEOUT_MS = savedIdle;
      if (savedHard === undefined) delete process.env.PAPERCUSP_GIT_SYNC_ACTION_HARD_TIMEOUT_MS;
      else process.env.PAPERCUSP_GIT_SYNC_ACTION_HARD_TIMEOUT_MS = savedHard;
    }
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
    expect(resolveLaunchTargetForEventMock).toHaveBeenCalledExactlyOnceWith('git-sync:conflict', {
      installSlug: 'papercup',
      workspaceId: 'ws-42',
    });
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
        expect.objectContaining({ kind: 'merge_resolver', status: 'ok' }),
      );
    });
    expect(routinePatches()).toContainEqual({
      last_resolver: expect.objectContaining({ status: 'ok', httpStatus: 200 }),
    });

    // sibling submodules that DID push are still recorded (GAP-1)
    expect(routinePatches()[0]).toMatchObject({
      last_status: 'conflict',
      last_pushed: ['libs/papercusp'],
      last_conflicts: ['libs/generic/sync'],
    });
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
    expect(appendPipelineEventMock).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'merge_resolver' }));
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
    expect(
      isResolverInFlight({ status: 'dispatched', at: NOW - 60_000, instance: 'other-live-operator' }, NOW, ME),
    ).toBe(true);
    // A genuinely orphaned writer is released by the bounded TTL, never by guessing
    // liveness from process-instance inequality.
    expect(
      isResolverInFlight({ status: 'dispatched', at: NOW - 2 * WINDOW, instance: 'prior-incarnation' }, NOW, ME),
    ).toBe(false);
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
      }),
    );
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

    // The local result remains `synced`, but the routine headline must expose
    // that the commit was partial and the named file stayed dirty.
    expect(routinePatches()).toContainEqual(
      expect.objectContaining({ last_status: 'quarantined', local_sync_status: 'synced' }),
    );

    // dispatch resolved declaratively from the launch blueprint by the content-error event key
    expect(resolveLaunchTargetForEventMock).toHaveBeenCalledWith('git-sync:content-error', {
      installSlug: 'papercup',
      workspaceId: 'ws-42',
    });
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
        expect.objectContaining({ kind: 'content_fixer', status: 'ok' }),
      );
    });
    expect(routinePatches()).toContainEqual({
      last_content_fixer: expect.objectContaining({ status: 'ok', httpStatus: 200 }),
    });
    warn.mockRestore();
  });

  it('persists the underlying transport code when content-fixer dispatch fails', async () => {
    runGitSyncMock.mockResolvedValue(contentErrorOutcome);
    counterRows = [{ et: 0, lo: [], ct: 0 }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loopbackFetchMock.mockRejectedValueOnce(
      Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' },
      }),
    );

    try {
      await action(ctx);

      const expectedError = 'fetch failed (UND_ERR_SOCKET: other side closed)';
      await vi.waitFor(() => {
        expect(routinePatches()).toContainEqual({
          last_content_fixer: expect.objectContaining({ status: 'error', error: expectedError }),
        });
      });
      expect(appendPipelineEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'content_fixer',
          status: 'error',
          detail: expect.objectContaining({ error: expectedError }),
        }),
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(expectedError));
    } finally {
      warn.mockRestore();
    }
  });

  it('revalidates a repaired offender before dispatch and clears its stale fixer identity', async () => {
    runGitSyncMock.mockResolvedValue(contentErrorOutcome);
    counterRows = [{ et: 0, lo: [], ct: 2 }];
    const repairedFile = join(repoDir, 'apps/operator-docs/src/content/docs/x.mdx');
    mkdirSync(join(repoDir, 'apps/operator-docs/src/content/docs'), { recursive: true });
    writeFileSync(repairedFile, '# repaired\n');

    try {
      await action(ctx);

      expect(loopbackFetchMock).not.toHaveBeenCalled();
      expect(contentUpserts()).toEqual([]);
      expect(
        routinePatches().some(
          (patch) =>
            patch.consecutive_content_error_ticks === 0 &&
            Array.isArray(patch.last_content_errors) &&
            patch.last_content_errors.length === 0 &&
            patch.last_content_fixer === null,
        ),
      ).toBe(true);
    } finally {
      rmSync(repairedFile, { force: true });
    }
  });

  it('atomically coalesces same-signature content-fixer dispatches from concurrent ticks', async () => {
    runGitSyncMock.mockResolvedValue(contentErrorOutcome);
    counterRows = [{ et: 0, lo: [], ct: 0 }];
    // The first caller wins the marker CAS; the concurrent caller loses it even
    // though both read an empty in-flight marker before their claims.
    contentFixerClaimResults = [true, false];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await Promise.all([action(ctx), action(ctx)]);

    expect(loopbackFetchMock).toHaveBeenCalledTimes(1);
    const claims = unsafeCalls.filter((call) => call.text.includes('RETURNING true AS claimed'));
    expect(claims).toHaveLength(2);
    expect(claims[0].params[4]).toBe(claims[1].params[4]);
    expect(claims[0].params[5]).toBe(claims[1].params[5]);
    expect(claims[0].params[5]).toBe('1');
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
          error:
            'deleting this file would break a still-live import — still imported (relative) by: packages/operator-core/lib/caller.ts. Either restore this file, or finish the deletion by removing the import(s) from the listed file(s) first.',
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
          error:
            'deleting this file would break a still-live import — still imported (relative) by: packages/operator-core/lib/caller.ts. Either restore this file, or finish the deletion by removing the import(s) from the listed file(s) first.',
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

  const contentSignature = (errors: GitSyncOutcome['contentErrors']): string =>
    [...new Set(errors.map((e) => `${e.scope}\u001f${e.file}\u001f${e.detectorKey}`))].sort().join('\u001e');

  // EI-24099226502437988: JSONB rejects \u0000, so a NUL anywhere in the outcome patch
  // failed the whole write — and the bridge leg that pushes origin runs after it.
  it('a quarantined signature persists with no NUL byte in any routine metadata write', async () => {
    runGitSyncMock.mockResolvedValue(contentErrorOutcome);
    counterRows = [{ et: 0, lo: [], ct: 0 }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    const NUL = String.fromCharCode(0);
    expect(routinePatches()).toContainEqual(
      expect.objectContaining({ last_content_error_signature: contentSignature(contentErrorOutcome.contentErrors) }),
    );
    for (const p of allRoutinePatches()) expect(JSON.stringify(p)).not.toContain('\\u0000');
    expect(contentSignature(contentErrorOutcome.contentErrors)).not.toContain(NUL);
    warn.mockRestore();
  });

  it('strips a NUL carried in from git output instead of failing the metadata write', async () => {
    const NUL = String.fromCharCode(0);
    const nulError = { ...contentErrorOutcome.contentErrors[0]!, file: `apps/operator-docs/bad${NUL}name.mdx` };
    runGitSyncMock.mockResolvedValue({ ...contentErrorOutcome, contentErrors: [nulError] });
    counterRows = [{ et: 0, lo: [], ct: 0 }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    expect(routinePatches()).toContainEqual(
      expect.objectContaining({ last_content_errors: ['superproject/apps/operator-docs/badname.mdx [mdx]'] }),
    );
    for (const p of allRoutinePatches()) expect(JSON.stringify(p)).not.toContain('\\u0000');
    expect(warn.mock.calls.some(([m]) => String(m).includes('stripped NUL byte(s)'))).toBe(true);
    warn.mockRestore();
  });

  it('after MAX attempts the file is STILL broken → surfaces to a human + STOPS auto-dispatching (P-005)', async () => {
    runGitSyncMock.mockResolvedValue(contentErrorOutcome);
    counterRows = [{ et: 0, lo: [], ct: 4, cs: contentSignature(contentErrorOutcome.contentErrors) }]; // same signature, 4 prior failing ticks
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
    expect(upsertConditionWorkItemMock).toHaveBeenCalledTimes(1);
    expect(upsertConditionWorkItemMock).toHaveBeenCalledWith(
      expect.stringMatching(/^git-sync-content:papercup:[a-f0-9]{24}$/),
      expect.objectContaining({
        kind: 'bug',
        harness: 'papercup',
        workspaceId: 'ws-42',
        createdBy: 'system:git-sync',
      }),
    );
    warn.mockRestore();
  });

  it('a new quarantined signature after the routine streak reaches MAX gets its own fixer budget', async () => {
    const previousError = contentErrorOutcome.contentErrors[0]!;
    const newError = { ...previousError, file: 'apps/operator-docs/src/content/docs/new.mdx' };
    runGitSyncMock.mockResolvedValue({ ...contentErrorOutcome, contentErrors: [newError] });
    counterRows = [{ et: 0, lo: [], ct: 5, cs: contentSignature([previousError]) }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    expect(contentUpserts()[0].body).toMatchObject({ needs_human: false, consecutive_content_error_ticks: 1 });
    expect(loopbackFetchMock).toHaveBeenCalledTimes(1);
    expect(routinePatches()).toContainEqual(
      expect.objectContaining({ last_content_error_signature: contentSignature([newError]) }),
    );
    warn.mockRestore();
  });

  it('does NOT re-broadcast on a failing tick already PAST the threshold (transition-only)', async () => {
    runGitSyncMock.mockResolvedValue(contentErrorOutcome);
    counterRows = [{ et: 0, lo: [], ct: 5, cs: contentSignature(contentErrorOutcome.contentErrors) }]; // same signature, already at MAX last tick
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

describe('WI-10001350 migration-reservation admission wiring', () => {
  it('passes a DB-backed dirty-path checker into the pure git-sync pipeline', async () => {
    runGitSyncMock.mockResolvedValue(syncedOutcome);

    await action(ctx);

    const opts = runGitSyncMock.mock.calls[0]?.[1] as RunGitSyncOpts;
    expect(opts.migrationReservationChecker).toEqual(expect.any(Function));
    const beforeRead = templateCalls.length;
    await expect(opts.migrationReservationChecker!(['README.md'])).resolves.toBeUndefined();
    await expect(opts.migrationReservationChecker!(['libs/db/sql/999-new-migration.sql'])).rejects.toThrow(
      '[migration-reservation-guard] 999-new-migration.sql has no reservation row',
    );
    const migrationReads = templateCalls
      .slice(beforeRead)
      .filter((call) => call.text.includes('migration_reservations'));
    expect(migrationReads).toHaveLength(1);
    expect(migrationReads[0]?.values).toEqual([999]);
  });
});

describe('acquireWithContentionRetry (EI-1720 — transient pg 57014/55P03 is retried, not skipped)', () => {
  const contended = () =>
    Object.assign(new Error('workspace "ws" contended (pg 57014: lock/statement timeout)'), {
      name: 'WorkspaceContendedError',
      pgCode: '57014',
    });

  it('retries on contention then succeeds; backs off between attempts', async () => {
    const slept: number[] = [];
    let n = 0;
    const run = vi.fn(async () => {
      if (n++ < 2) throw contended();
      return { ok: true };
    });
    const r = await acquireWithContentionRetry(run, {
      backoffsMs: [10, 20, 40],
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(r).toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([10, 20]); // two backoffs before the 3rd (successful) attempt
  });

  it('throws the contention error after exhausting retries (next tick retries)', async () => {
    const run = vi.fn(async () => {
      throw contended();
    });
    await expect(acquireWithContentionRetry(run, { backoffsMs: [1, 1], sleep: async () => {} })).rejects.toMatchObject({
      name: 'WorkspaceContendedError',
      pgCode: '57014',
    });
    expect(run).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('does NOT retry a non-contention error (real bug surfaces immediately)', async () => {
    const slept: number[] = [];
    const run = vi.fn(async () => {
      throw new Error('SU-lock DB unreachable');
    });
    await expect(
      acquireWithContentionRetry(run, {
        backoffsMs: [10, 20],
        sleep: async (ms) => {
          slept.push(ms);
        },
      }),
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
describe('formatOwnHeadPublishSkipLine (EI-24099226502437988)', () => {
  it('names the slug, the reason, what the reason means, and that nothing was published', () => {
    expect(formatOwnHeadPublishSkipLine('papercusp', 'no-device-actor', 'resolveHiveGitActor returned null')).toBe(
      '[git-sync] papercusp: own-head publish SKIPPED — no-device-actor: no serving device actor resolved ' +
        '(serving not ready, or no device identity) (resolveHiveGitActor returned null); ' +
        'nothing published this tick, the next tick retries',
    );
  });

  it('omits the detail parenthesis when there is no detail, and caps a long detail at 300 chars', () => {
    expect(formatOwnHeadPublishSkipLine('papercusp', 'no-hive-slug', null)).toBe(
      '[git-sync] papercusp: own-head publish SKIPPED — no-hive-slug: this install names no hive ' +
        '(no hive_slug and not self_repo); nothing published this tick, the next tick retries',
    );
    const line = formatOwnHeadPublishSkipLine('papercusp', 'registry-unreadable', 'x'.repeat(1000));
    expect(line).toContain(`(${'x'.repeat(300)});`);
    expect(line).not.toContain('x'.repeat(301));
  });
});

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
