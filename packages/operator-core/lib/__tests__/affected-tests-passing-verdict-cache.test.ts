import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildPassingTaskVerdictIdentity,
  decidePassingTaskVerdict,
  emptyPassingTaskVerdictCache,
  formatPassingTaskVerdictSummary,
  hashDependencyFileSet,
  mergePassingTaskVerdictUpdates,
  namespacePassingTaskVerdictDecision,
  PASSING_TASK_VERDICT_CACHE_MAX_GROUPS,
  PASSING_TASK_VERDICT_CROSS_RUN_GROUP,
  PC_HEAVY_VOLATILE_IDENTITY_ENV,
  passingTaskVerdictCacheEntry,
  passingTaskVerdictCrossRunIdentityEnvironment,
  passingTaskVerdictDependencyProvenance,
  passingTaskVerdictIdentityEnvironment,
  passingTaskVerdictEntry,
  readPassingTaskVerdictCache,
  shouldStorePassingTaskVerdict,
  writePassingTaskVerdictCacheAtomic,
} from '../../../../scripts/lib/passing-task-verdict-cache.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS_SRC = readFileSync(resolve(REPO_ROOT, 'scripts/affected-tests.mjs'), 'utf8').replaceAll(
  '"',
  "'",
);
const GREEN_CHECKPOINT_SRC = readFileSync(resolve(REPO_ROOT, 'apps/operator/lib/release/green-checkpoint.ts'), 'utf8');
// D-007 pins which npm scripts opt into reuse, so the script table is part of the contract.
const PACKAGE_JSON = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};

const identity = (overrides: Record<string, unknown> = {}) =>
  buildPassingTaskVerdictIdentity({
    taskKey: '@papercusp/web :: test',
    command: { cmd: 'npm', argv: ['run', 'test'], cwd: '/checkpoint' },
    environment: { CI: '1', VITEST_MAX_FORKS: '2' },
    gateConfig: { retry: true, timeoutMs: 1000 },
    dependencyHash: 'dep-a',
    ...overrides,
  });

describe('passing affected-task verdict identity', () => {
  it('is stable across object key order and hits only on a complete identity match', () => {
    const first = identity();
    const same = identity({
      environment: { VITEST_MAX_FORKS: '2', CI: '1' },
      gateConfig: { timeoutMs: 1000, retry: true },
    });
    expect(same).toEqual(first);
    expect(
      decidePassingTaskVerdict({
        enabled: true,
        cacheRead: { reason: 'cache-ready' },
        entry: passingTaskVerdictEntry(first, 'then'),
        identity: same,
      }),
    ).toEqual({ hit: true, reason: 'identity-match' });
  });

  it.each([
    ['command', { command: { cmd: 'npm', argv: ['run', 'test:changed'], cwd: '/checkpoint' } }, 'command-changed'],
    ['environment', { environment: { CI: '1', VITEST_MAX_FORKS: '1' } }, 'environment-changed'],
    ['gate config', { gateConfig: { retry: false, timeoutMs: 1000 } }, 'gate-config-changed'],
    ['implementation', { implementationVersion: 'v-next' }, 'implementation-version-changed'],
    ['dependency closure', { dependencyHash: 'dep-b' }, 'dependency-closure-changed'],
  ])('reports an operator-visible %s miss reason', (_label, overrides, reason) => {
    const prior = identity();
    expect(
      decidePassingTaskVerdict({
        enabled: true,
        cacheRead: { reason: 'cache-ready' },
        entry: passingTaskVerdictEntry(prior),
        identity: identity(overrides),
      }),
    ).toEqual({ hit: false, reason });
  });

  it('treats missing, corrupt, and incomplete provenance as misses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-verdict-cache-read-'));
    const path = join(dir, 'cache.json');
    try {
      expect(readPassingTaskVerdictCache(path).reason).toBe('cache-file-missing');
      writeFileSync(path, '{broken');
      expect(readPassingTaskVerdictCache(path).reason).toBe('cache-corrupt');
      expect(
        decidePassingTaskVerdict({
          enabled: true,
          cacheRead: { reason: 'cache-ready' },
          identity: null,
        }),
      ).toEqual({ hit: false, reason: 'provenance-incomplete' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the initial proof group only for cache identity while preserving the verifier child env', () => {
    const childEnvironment = {
      CI: '1',
      PAPERCUSP_TEST_RUN_GROUP: 'verifier-run',
      AFFECTED_TASK_VERDICT_PROOF_GROUP: 'initial-run',
    };
    const normalized = passingTaskVerdictIdentityEnvironment(childEnvironment);

    expect(normalized).toEqual({
      environment: {
        CI: '1',
        PAPERCUSP_TEST_RUN_GROUP: 'initial-run',
      },
      proofGroupApplied: true,
      cacheGroup: 'initial-run',
    });
    expect(childEnvironment).toEqual({
      CI: '1',
      PAPERCUSP_TEST_RUN_GROUP: 'verifier-run',
      AFFECTED_TASK_VERDICT_PROOF_GROUP: 'initial-run',
    });

    const prior = identity({ environment: normalized.environment });
    expect(
      decidePassingTaskVerdict({
        enabled: true,
        cacheRead: { reason: 'cache-ready' },
        entry: passingTaskVerdictEntry(prior),
        identity: identity({
          environment: passingTaskVerdictIdentityEnvironment(childEnvironment).environment,
        }),
      }),
    ).toEqual({ hit: true, reason: 'identity-match' });
  });

  it('ignores per-attempt pc-heavy transport state while keeping the shared proof identity', () => {
    const normalizeAttempt = (suffix: string) =>
      passingTaskVerdictIdentityEnvironment({
        CI: '1',
        AFFECTED_TASK_VERDICT_PROOF_GROUP: 'bounded-series',
        PC_HEAVY_PREEMPT_READY_FILE: `/tmp/ready-${suffix}`,
        PC_HEAVY_PREEMPT_RESULT_FILE: `/tmp/result-${suffix}`,
        PC_HEAVY_CALLER_PID: suffix === 'a' ? '100' : '200',
        PC_HEAVY_CALLER_START_TICKS: suffix === 'a' ? '1000' : '2000',
        PC_HEAVY_PREEMPT_NOTIFY_FD: suffix === 'a' ? '11' : '14',
      });

    expect(normalizeAttempt('a')).toEqual(normalizeAttempt('b'));
    expect(normalizeAttempt('a')).toEqual({
      environment: { CI: '1', PAPERCUSP_TEST_RUN_GROUP: 'bounded-series' },
      proofGroupApplied: true,
      cacheGroup: 'bounded-series',
    });
  });

  it('leaves missing or malformed proof state fail-closed on the verifier run identity', () => {
    const prior = identity({
      environment: { CI: '1', PAPERCUSP_TEST_RUN_GROUP: 'initial-run' },
    });
    for (const proof of [undefined, { corrupt: true }]) {
      const childEnvironment = {
        CI: '1',
        PAPERCUSP_TEST_RUN_GROUP: 'verifier-run',
        ...(proof === undefined
          ? {}
          : { AFFECTED_TASK_VERDICT_PROOF_GROUP: proof }),
      };
      const normalized = passingTaskVerdictIdentityEnvironment(childEnvironment);
      expect(normalized.proofGroupApplied).toBe(false);
      expect(
        decidePassingTaskVerdict({
          enabled: true,
          cacheRead: { reason: 'cache-ready' },
          entry: passingTaskVerdictEntry(prior),
          identity: identity({ environment: normalized.environment }),
        }),
      ).toEqual({ hit: false, reason: 'environment-changed' });
    }
  });

  it('renders bounded hit/miss counts and reasons for the composite verdict', () => {
    expect(
      formatPassingTaskVerdictSummary(
        [
          { status: 'hit', reason: 'identity-match' },
          { status: 'miss', reason: 'environment-changed' },
          { status: 'miss', reason: 'dependency-closure-changed' },
          { status: 'miss', reason: 'environment-changed' },
        ],
        { proofGroupApplied: true, cacheGroup: 'initial-run' },
      ),
    ).toBe(
      'AFFECTED_TASK_CACHE_SUMMARY hits=1 misses=3 proofIdentity=initial-run group=53ef7ff1e88c ' +
        'reasons={"dependency-closure-changed":1,"environment-changed":2,"identity-match":1}',
    );
  });

  it('namespaces cache decisions on both hits and misses', () => {
    expect(namespacePassingTaskVerdictDecision({ hit: true, reason: 'identity-match' }, 'cross-run')).toEqual({
      hit: true,
      reason: 'cross-run:identity-match',
    });
    expect(namespacePassingTaskVerdictDecision({ hit: false, reason: 'no-prior-verdict' }, 'cross-run')).toEqual({
      hit: false,
      reason: 'cross-run:no-prior-verdict',
    });
  });
});

describe('dependency-closure hashing and persistence', () => {
  it('keeps integration tasks non-reusable in resumable runs', () => {
    expect(
      passingTaskVerdictDependencyProvenance({
        root: '/unused',
        taskKey: '@papercusp/operator-core :: test:integration',
        script: 'test:integration',
        workspaceName: '@papercusp/operator-core',
        workspaces: new Map(),
        trackedScan: { files: ['package.json'], unscannedPresent: [] },
        repoWideTaskKeys: new Set(),
      }),
    ).toEqual({
      ok: false,
      reason: 'provenance-incomplete:external-integration-task',
    });
  });

  it('binds paths, bytes, modes/symlink targets, and refuses enumeration gaps', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-verdict-content-'));
    try {
      mkdirSync(join(root, 'pkg'));
      writeFileSync(join(root, 'pkg', 'a.ts'), 'one');
      symlinkSync('a.ts', join(root, 'pkg', 'link.ts'));
      const first = hashDependencyFileSet({
        root,
        files: ['pkg/link.ts', 'pkg/a.ts'],
      });
      expect(first.ok).toBe(true);
      writeFileSync(join(root, 'pkg', 'a.ts'), 'two');
      const second = hashDependencyFileSet({
        root,
        files: ['pkg/a.ts', 'pkg/link.ts'],
      });
      if (!first.ok || !second.ok) throw new Error('test fixture should be hashable');
      expect(second.hash).not.toBe(first.hash);
      expect(
        hashDependencyFileSet({
          root,
          files: ['pkg/a.ts'],
          unavailable: ['libs/unavailable'],
        }),
      ).toEqual({
        ok: false,
        reason: 'provenance-incomplete:unscanned-submodule:libs/unavailable',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('atomically replaces a complete cache and preserves updates merged over a fresh read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-verdict-cache-write-'));
    const path = join(dir, 'cache.json');
    try {
      const update = { ['@papercusp/web :: test']: passingTaskVerdictEntry(identity(), 'now') };
      const next = mergePassingTaskVerdictUpdates(
        emptyPassingTaskVerdictCache(),
        'proof-a',
        update,
        '2026-08-23T00:00:00.000Z',
      );
      writePassingTaskVerdictCacheAtomic(path, next, 'nonce');
      expect(readPassingTaskVerdictCache(path)).toEqual({ cache: next, reason: 'cache-ready' });
      expect(passingTaskVerdictCacheEntry(next, 'proof-a', '@papercusp/web :: test')).toEqual(
        update['@papercusp/web :: test'],
      );
      expect(readdirSync(dir)).toEqual(['cache.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retains independent proof groups and bounds old groups without cross-overwrite', () => {
    let cache = emptyPassingTaskVerdictCache();
    for (let i = 0; i < PASSING_TASK_VERDICT_CACHE_MAX_GROUPS + 2; i++) {
      cache = mergePassingTaskVerdictUpdates(
        cache,
        `proof-${i}`,
        { [`task-${i}`]: passingTaskVerdictEntry(identity({ taskKey: `task-${i}` })) },
        new Date(i * 1_000).toISOString(),
      );
    }
    expect(Object.keys(cache.groups)).toHaveLength(PASSING_TASK_VERDICT_CACHE_MAX_GROUPS);
    expect(cache.groups['proof-0']).toBeUndefined();
    expect(cache.groups['proof-1']).toBeUndefined();
    expect(passingTaskVerdictCacheEntry(cache, 'proof-2', 'task-2')).toBeDefined();
    expect(passingTaskVerdictCacheEntry(cache, 'proof-33', 'task-33')).toBeDefined();
  });
});

describe('gate wiring safety contract', () => {
  it('enables reuse only for a green checkpoint or an explicit bounded resume series', () => {
    expect(AFFECTED_TESTS_SRC).toContain("process.env.GREEN_CHECKPOINT === '1'");
    expect(AFFECTED_TESTS_SRC).toContain("process.env.AFFECTED_TASK_VERDICT_RESUME === '1'");
    expect(AFFECTED_TESTS_SRC).toContain('passingTaskVerdictIdentityEnvironment(childEnv)');
    expect(AFFECTED_TESTS_SRC).toContain('formatPassingTaskVerdictSummary(');
  });

  it('persists a validated clean first pass from the task-settlement callback', () => {
    const persist = AFFECTED_TESTS_SRC.indexOf('function persistCleanFirstPassTaskVerdict(');
    const pool = AFFECTED_TESTS_SRC.indexOf('const initialPool = await runBudgetedTaskShards');
    expect(persist).toBeGreaterThan(-1);
    expect(persist).toBeLessThan(pool);
    expect(AFFECTED_TESTS_SRC).toContain('onTaskSettled: persistCleanFirstPassTaskVerdict');
    expect(AFFECTED_TESTS_SRC).not.toContain('taskVerdictCacheUpdates');
  });

  it('leaves downstream assurance after the suite', () => {
    const suite = GREEN_CHECKPOINT_SRC.indexOf('const r = await exec(cmd, args');
    const postSuite = GREEN_CHECKPOINT_SRC.indexOf('runPostSuiteLegs(', suite);
    expect(suite).toBeGreaterThan(-1);
    expect(postSuite).toBeGreaterThan(suite);
  });
});

// EI-21577710345620735 — cross-run reuse.
//
// The per-run group deliberately confines reuse to ONE gate run, which is why a red gate re-tests
// the ~100 tasks that already passed: their proof exists but is filed under last run's group and
// is unreachable. These tests pin BOTH halves of the fix, and the second half matters more than
// the first: reuse that fires when it must not is a gate that certifies unverified code.
describe('cross-run passing-task verdict reuse', () => {
  const crossRunIdentity = (
    environment: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ) =>
    buildPassingTaskVerdictIdentity({
      taskKey: '@papercusp/web :: test',
      command: { cmd: 'npm', argv: ['run', 'test'], cwd: '/checkpoint' },
      gateConfig: { retry: true, timeoutMs: 1000 },
      dependencyHash: 'dep-a',
      ...overrides,
      environment: passingTaskVerdictCrossRunIdentityEnvironment(environment).environment,
    });

  const runA = {
    CI: '1',
    AFFECTED_BASE: 'a2d69cef',
    PAPERCUSP_TEST_RUN_GROUP: 'run-A',
    VITEST_MAX_FORKS: '8',
    VITEST_MAX_WORKERS: '8',
    VITEST_MAX_THREADS: '8',
  };
  // Same tree, next hourly fire: new run group, and a different fork allocation because the box
  // was busier. Neither says anything about what the task exercised.
  const runB = {
    ...runA,
    PAPERCUSP_TEST_RUN_GROUP: 'run-B',
    VITEST_MAX_FORKS: '4',
    VITEST_MAX_WORKERS: '4',
    VITEST_MAX_THREADS: '4',
  };

  it('resolves to one stable group so run N+1 can reach run N proof', () => {
    expect(passingTaskVerdictCrossRunIdentityEnvironment(runA).cacheGroup).toBe(
      PASSING_TASK_VERDICT_CROSS_RUN_GROUP,
    );
    expect(passingTaskVerdictCrossRunIdentityEnvironment(runB).cacheGroup).toBe(
      PASSING_TASK_VERDICT_CROSS_RUN_GROUP,
    );
  });

  // Without this the feature is INERT, and inert is the failure mode that does not announce
  // itself: every lookup simply misses and the gate looks exactly as deadlocked as before.
  it('ignores run group and fork allocation, so an unchanged task hits in the next run', () => {
    expect(crossRunIdentity(runB).fingerprint).toBe(crossRunIdentity(runA).fingerprint);
    expect(
      decidePassingTaskVerdict({
        enabled: true,
        cacheRead: { reason: 'cache-ready' },
        entry: passingTaskVerdictEntry(crossRunIdentity(runA)),
        identity: crossRunIdentity(runB),
      }),
    ).toMatchObject({ hit: true });
  });

  // The falsifiability controls. Each asserts a MISS: if any of these ever hits, the gate is
  // reusing a verdict that no longer describes the code under test.
  it('MISSES when a dependency byte changed — the property the gate rests on', () => {
    const proven = crossRunIdentity(runA, { dependencyHash: 'dep-a' });
    const changed = crossRunIdentity(runB, { dependencyHash: 'dep-a-MUTATED' });
    expect(changed.fingerprint).not.toBe(proven.fingerprint);
    expect(
      decidePassingTaskVerdict({
        enabled: true,
        cacheRead: { reason: 'cache-ready' },
        entry: passingTaskVerdictEntry(proven),
        identity: changed,
      }),
    ).toMatchObject({ hit: false });
  });

  it('MISSES when the command, gate config, or AFFECTED_BASE changed', () => {
    const proven = crossRunIdentity(runA);
    expect(crossRunIdentity(runB, { command: { cmd: 'npm', argv: ['run', 'test:integration'] } }).fingerprint).not.toBe(
      proven.fingerprint,
    );
    expect(crossRunIdentity(runB, { gateConfig: { retry: false, timeoutMs: 1000 } }).fingerprint).not.toBe(
      proven.fingerprint,
    );
    // When the gate finally goes green the pin advances, so every task re-runs exactly once.
    expect(crossRunIdentity({ ...runB, AFFECTED_BASE: 'newgreen' }).fingerprint).not.toBe(proven.fingerprint);
  });

  it('MISSES on an unfamiliar environment variable rather than assuming it is irrelevant', () => {
    expect(crossRunIdentity({ ...runB, SOME_NEW_TOGGLE: '1' }).fingerprint).not.toBe(
      crossRunIdentity(runA).fingerprint,
    );
  });

  // The cap is an LRU written for disposable per-run groups. The cross-run group is the one whose
  // entire value is surviving into later runs, and evicting it degrades silently to "no reuse".
  it('never evicts the cross-run group under the MAX_GROUPS cap', () => {
    let cache = emptyPassingTaskVerdictCache();
    cache = mergePassingTaskVerdictUpdates(
      cache,
      PASSING_TASK_VERDICT_CROSS_RUN_GROUP,
      { '@papercusp/web :: test': passingTaskVerdictEntry(crossRunIdentity(runA)) },
      '2020-01-01T00:00:00.000Z', // deliberately the OLDEST entry in the cache
    );
    for (let i = 0; i < PASSING_TASK_VERDICT_CACHE_MAX_GROUPS + 5; i += 1) {
      cache = mergePassingTaskVerdictUpdates(
        cache,
        `run-${i}`,
        { '@papercusp/web :: test': passingTaskVerdictEntry(identity()) },
        `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      );
    }
    expect(Object.keys(cache.groups)).toContain(PASSING_TASK_VERDICT_CROSS_RUN_GROUP);
    expect(
      passingTaskVerdictCacheEntry(cache, PASSING_TASK_VERDICT_CROSS_RUN_GROUP, '@papercusp/web :: test'),
    ).toBeDefined();
  });

  it('is wired into affected-tests.mjs on both the lookup and the store path', () => {
    expect(AFFECTED_TESTS_SRC).toContain('passingTaskVerdictCrossRunIdentityEnvironment(childEnv)');
    // The store must reach the cross-run group, or run N+1 has nothing to read.
    expect(AFFECTED_TESTS_SRC).toContain('PASSING_TASK_VERDICT_CROSS_RUN_GROUP');
    expect(AFFECTED_TESTS_SRC).toContain('__crossRunCacheIdentity');
  });

  it('keeps cross-run miss instrumentation instead of reporting only fallback hits', () => {
    expect(AFFECTED_TESTS_SRC).toContain('cacheDecision = namespacePassingTaskVerdictDecision(');
    expect(AFFECTED_TESTS_SRC).not.toContain('if (crossRunDecision.hit)');
  });
});

// D-007 (plan gate-stop-chasing-the-tip-2026-08-19, WI-572013) — the owner selected behavior B:
// the ROOT ordinary `npm test` reuses previously clean whole-task verdicts across local runs,
// under the SAME complete identity contract the gate uses. Two properties are pinned here, and
// the second is the load-bearing one: widening WHICH commands may reuse must not widen WHAT is
// reusable. Every miss rule above still applies unchanged to a local run.
describe('D-007 root `npm test` local cross-run reuse', () => {
  // Bound the persist function by its real closing brace, not a magic byte count: a fixed slice
  // silently stops covering the tail of the function as comments/code are added, which turns
  // these guards into false greens exactly when the function is being edited.
  const persistFnSource = (): string => {
    const start = AFFECTED_TESTS_SRC.indexOf('function persistCleanFirstPassTaskVerdict(');
    expect(start).toBeGreaterThan(-1);
    const end = AFFECTED_TESTS_SRC.indexOf('\n}\n', start);
    expect(end).toBeGreaterThan(start);
    return AFFECTED_TESTS_SRC.slice(start, end);
  };
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  it('opts the root test script into resumable execution', () => {
    // The whole feature is inert without this: TASK_VERDICT_CACHE_ENABLED gates on
    // GREEN_CHECKPOINT or AFFECTED_TASK_VERDICT_RESUME, and an ordinary local run sets neither.
    expect(PACKAGE_JSON.scripts?.test).toContain('AFFECTED_TASK_VERDICT_RESUME=1');
    expect(PACKAGE_JSON.scripts?.test).toContain('scripts/affected-tests.mjs');
  });

  it('keeps D-007 scope: related/all sweeps and direct file runs stay fresh', () => {
    // D-007 scopes reuse to the root affected-tests command ONLY. These have different selection
    // or execution semantics, so a proof taken under one is not a proof for another.
    for (const name of ['test:related', 'test:all', 'test:all:integration', 'test:file']) {
      expect(PACKAGE_JSON.scripts?.[name]).not.toContain('AFFECTED_TASK_VERDICT_RESUME=1');
    }
  });

  it('routes a local run with no proof group to the stable cross-run group', () => {
    // Root `npm test` sets no PC_HEAVY_RETRY_PREEMPTIONS, so pc-heavy returns before its
    // proof-group export and the run legitimately has none. That is the local path.
    expect(AFFECTED_TESTS_SRC).toContain('const TASK_VERDICT_LOCAL_CROSS_RUN_ONLY =');
    expect(AFFECTED_TESTS_SRC).toContain('PASSING_TASK_VERDICT_CROSS_RUN_GROUP');
    // It must reuse the EXISTING cross-run identity, never mint a shared child run group.
    expect(AFFECTED_TESTS_SRC).toContain('passingTaskVerdictCrossRunIdentityEnvironment(childEnv)');
  });

  it('stays fail-closed: a green checkpoint never takes the local path', () => {
    // D-007: "never while GREEN_CHECKPOINT is active (a gate without proof state must stay
    // fail-closed)". The gate must keep its caller-supplied per-run boundary.
    const local = AFFECTED_TESTS_SRC.indexOf('const TASK_VERDICT_LOCAL_CROSS_RUN_ENABLED =');
    expect(local).toBeGreaterThan(-1);
    const clause = AFFECTED_TESTS_SRC.slice(local, local + 220);
    expect(clause).toContain("process.env.AFFECTED_TASK_VERDICT_RESUME === '1'");
    expect(clause).toContain("process.env.GREEN_CHECKPOINT !== '1'");
  });

  it('reports the local run as cross-run scope rather than current-run', () => {
    // Without cacheScope the summary reads proofIdentity=current-run for a run whose whole
    // purpose is reuse ACROSS runs — an observability lie that hides whether B is live.
    expect(AFFECTED_TESTS_SRC).toContain('cacheScope: TASK_VERDICT_CACHE_SCOPE');
    expect(formatPassingTaskVerdictSummary([{ status: 'hit', reason: 'cross-run:hit' }], {
      proofGroupApplied: false,
      cacheGroup: PASSING_TASK_VERDICT_CROSS_RUN_GROUP,
      cacheScope: 'cross-run',
    })).toContain('proofIdentity=cross-run');
  });

  // REGRESSION (WI-572013): the store path's else-branch referenced `perRunMerged`, a binding the
  // function does not declare. Because the body is wrapped in a catch, the ReferenceError was
  // swallowed and reported as `status=failed`, so reuse degraded to "nothing is ever stored" —
  // outwardly identical to "reuse is on, nothing was reusable". Two guards: the dead binding is
  // gone, and the catch now re-throws programmer errors so the class cannot be silent again.
  it('does not reference an undeclared binding on the store path', () => {
    // Strip comments first: this guard is about CODE. Prose that merely NAMES the dead binding
    // (including the regression note left at the fix site) must not trip it.
    const body = stripComments(persistFnSource());
    const used = body.includes('perRunMerged');
    const declared = /(?:const|let|var)\s+perRunMerged\b/.test(body);
    // Either the binding is absent entirely, or it is genuinely declared before use.
    expect(used && !declared).toBe(false);
  });

  it('reports a programmer error loudly instead of degrading to silent no-reuse', () => {
    const body = persistFnSource();
    expect(body).toContain('error instanceof ReferenceError');
    expect(body).toContain('error instanceof TypeError');
    expect(body).toContain('taskVerdictPersistDefects.push(');
    expect(body).toContain('status=defect');
    // And it must be surfaced where the cache is already reported, not only per-task on stderr.
    expect(AFFECTED_TESTS_SRC).toContain('AFFECTED_TASK_CACHE_DEFECTS count=');
  });

  // A persist-path defect costs REUSE, never correctness: the suite simply does more work. This
  // callback is awaited inside runBudgetedTasks' try/catch, which re-throws
  // (budgeted-task-scheduler.mjs), so throwing here would abort the whole suite and turn a lost
  // optimization into a gate outage that blocks every agent's deploys. Loud, counted, NOT fatal.
  it('never aborts the suite from the settlement callback', () => {
    const body = stripComments(persistFnSource());
    expect(body).not.toContain('throw ');
    // The scheduler contract this depends on: settlement is awaited inside a re-throwing catch.
    const scheduler = readFileSync(resolve(REPO_ROOT, 'scripts/lib/budgeted-task-scheduler.mjs'), 'utf8');
    expect(scheduler).toContain('await onTaskSettled(scheduled)');
  });

  // Widening the ENTRY POINT must not widen the ADMISSION RULE. These re-assert, against the
  // real decision function, that a local-shaped run still misses on the things D-007 enumerates.
  it('still misses on a dependency-closure change in a local run', () => {
    const cache = mergePassingTaskVerdictUpdates(
      emptyPassingTaskVerdictCache(),
      PASSING_TASK_VERDICT_CROSS_RUN_GROUP,
      { '@papercusp/web :: test': passingTaskVerdictEntry(identity({ dependencyHash: 'dep-a' })) },
    );
    const decide = (dependencyHash: string) =>
      decidePassingTaskVerdict({
        enabled: true,
        cacheRead: { reason: 'cache-ready' },
        entry: passingTaskVerdictCacheEntry(
          cache,
          PASSING_TASK_VERDICT_CROSS_RUN_GROUP,
          '@papercusp/web :: test',
        ),
        identity: identity({ dependencyHash }),
      });
    expect(decide('dep-a').hit).toBe(true);
    // One byte anywhere in the closure changed => execute. This is the property B rests on.
    expect(decide('dep-b').hit).toBe(false);
  });

  it('still refuses to store a failed or absorbed local task', () => {
    const base = {
      enabled: true,
      cacheStatus: 'miss',
      initialStatus: 0,
      finalStatus: 0,
      absorptionRan: false,
      identity: identity(),
    };
    expect(shouldStorePassingTaskVerdict(base)).toBe(true);
    expect(shouldStorePassingTaskVerdict({ ...base, initialStatus: 1 })).toBe(false);
    expect(shouldStorePassingTaskVerdict({ ...base, finalStatus: 1 })).toBe(false);
    expect(shouldStorePassingTaskVerdict({ ...base, absorptionRan: true })).toBe(false);
    expect(shouldStorePassingTaskVerdict({ ...base, identity: null })).toBe(false);
    // A cache HIT must never be re-stored: that would refresh a proof nothing re-verified.
    expect(shouldStorePassingTaskVerdict({ ...base, cacheStatus: 'hit' })).toBe(false);
  });
});

// EI-21748784988454958. The whole cross-run feature was INERT in production and every test above
// still passed, because they build environments by hand and none of them contained the variable
// that actually breaks it. `pc-heavy.sh` exports PC_HEAVY_ADMISSION_ID="pc-heavy-$$-$(date +%s%N)"
// into every child, the identity hashes the COMPLETE environment minus a hand-written strip list,
// and that list did not name it — so `environment` differed on EVERY invocation. Root `npm test`
// (package.json:175) and the green-checkpoint gate both run under pc-heavy, so NEITHER could ever
// hit. The observable symptom is indistinguishable from "the cache is working and nothing was
// reusable", which is why it survived so long.
describe('pc-heavy per-invocation variables are excluded from the cache identity', () => {
  const PC_HEAVY_SRC = readFileSync(resolve(REPO_ROOT, 'scripts/pc-heavy.sh'), 'utf8');

  const identityFor = (environment: Record<string, unknown>) =>
    buildPassingTaskVerdictIdentity({
      taskKey: '@papercusp/web :: test',
      command: { cmd: 'npm', argv: ['run', 'test'], cwd: '/repo' },
      gateConfig: { retry: true, timeoutMs: 1000 },
      dependencyHash: 'dep-a',
      environment: passingTaskVerdictCrossRunIdentityEnvironment(environment).environment,
    });

  // A realistic child environment for two separate `npm test` invocations on an UNCHANGED tree.
  const invocationOne = {
    CI: '1',
    AFFECTED_BASE: 'a2d69cef',
    PAPERCUSP_TEST_RUN_GROUP: 'run-A',
    PC_HEAVY_ADMISSION_ID: 'pc-heavy-2582689-1787966068993715006',
    PC_HEAVY_PSI_FINALIZATION_FILE: '/tmp/pc-heavy-ready/finalization.aBc123',
    PC_HEAVY_PREEMPT_START_FILE: '/tmp/pc-heavy-slots/scratch/start.xY9z01',
  };
  const invocationTwo = {
    ...invocationOne,
    PAPERCUSP_TEST_RUN_GROUP: 'run-B',
    PC_HEAVY_ADMISSION_ID: 'pc-heavy-2599104-1787967914220388311',
    PC_HEAVY_PSI_FINALIZATION_FILE: '/tmp/pc-heavy-ready/finalization.Qq77Zz',
    PC_HEAVY_PREEMPT_START_FILE: '/tmp/pc-heavy-slots/scratch/start.Kj4m22',
  };

  it('hits across two invocations of the real root `npm test` environment', () => {
    expect(identityFor(invocationTwo).fingerprint).toBe(identityFor(invocationOne).fingerprint);
  });

  it.each([
    'PC_HEAVY_ADMISSION_ID',
    'PC_HEAVY_PSI_FINALIZATION_FILE',
    'PC_HEAVY_PREEMPT_START_FILE',
  ])('a new %s alone does not invalidate the identity', (name) => {
    const changed = { ...invocationOne, [name]: 'something-entirely-different' };
    expect(identityFor(changed).fingerprint).toBe(identityFor(invocationOne).fingerprint);
  });

  // The strip must stay MINIMAL. Blanket-wiping PC_HEAVY_* would also pass every test above while
  // silently discarding variables that DO change what a task exercises.
  it('does not blanket-strip PC_HEAVY_*: a stable wrapper variable still counts', () => {
    // PC_HEAVY_ADMISSION_DIR is "$_dir/psi-admissions" off PC_HEAVY_DIR/XDG_RUNTIME_DIR
    // (pc-heavy.sh:1381,2772) — stable across invocations, so it is NOT volatile and stays hashed.
    const moved = { ...invocationOne, PC_HEAVY_ADMISSION_DIR: '/somewhere/else/psi-admissions' };
    const base = { ...invocationOne, PC_HEAVY_ADMISSION_DIR: '/run/user/1000/pc-heavy-slots/psi-admissions' };
    expect(identityFor(moved).fingerprint).not.toBe(identityFor(base).fingerprint);
  });

  // ---- the DERIVED guard: pc-heavy.sh owns this truth, so read it rather than restating it ----
  //
  // Resolve one level of indirection: `PC_HEAVY_X="$_local"` is only volatile if some assignment
  // to `_local` is. Returns the set of names whose value reaches a per-invocation expression.
  //
  // Deliberately matches an assignment with OR WITHOUT `export`. pc-heavy also injects variables
  // as a command prefix — `PC_HEAVY_PREEMPT_RESULT_FILE="$_pc_heavy_retry_result_file" \` at
  // pc-heavy.sh:3250 — which reaches the child exactly like an export but matches no `export`
  // pattern. An `export`-only derivation silently under-reported that one.
  //
  // The bias is intentional: this errs toward OVER-inclusion. Naming a variable that never
  // reaches the child is harmless (deleting an absent key is a no-op), whereas missing one that
  // does is precisely the bug this whole block exists to prevent.
  const volatileExportedNames = (): string[] => {
    const VOLATILE = /\$\$|\$RANDOM|\$BASHPID|\bdate\s+\+%s|\bmktemp\b|_scratch_mktemp\b/;
    const localAssignments = new Map<string, string[]>();
    for (const m of PC_HEAVY_SRC.matchAll(/^\s*(?:local\s+)?(_[A-Za-z0-9_]+)=(.*)$/gm)) {
      const [, name, rhs] = m;
      localAssignments.set(name, [...(localAssignments.get(name) ?? []), rhs]);
    }
    const found = new Set<string>();
    for (const m of PC_HEAVY_SRC.matchAll(/^\s*(?:export\s+)?(PC_HEAVY_[A-Z0-9_]+)=(.*)$/gm)) {
      const [, name, rhs] = m;
      if (VOLATILE.test(rhs)) {
        found.add(name);
        continue;
      }
      for (const ref of rhs.matchAll(/\$\{?(_[A-Za-z0-9_]+)\b/g)) {
        if ((localAssignments.get(ref[1]) ?? []).some((v) => VOLATILE.test(v))) found.add(name);
      }
    }
    return [...found].sort();
  };

  // CALIBRATION. Without this the guard below passes vacuously whenever the parser breaks or
  // pc-heavy.sh is restructured — a zero-length derived set matches an empty residue perfectly,
  // and reads exactly like "nothing is volatile". Assert the instrument still finds the variable
  // that caused the bug before trusting anything it says.
  it('the derivation actually detects the known-volatile exports (positive control)', () => {
    const derived = volatileExportedNames();
    // The variable that caused the bug: a plain `export NAME=` with an inline $$ / date +%s%N.
    expect(derived).toContain('PC_HEAVY_ADMISSION_ID');
    // Indirect + command-prefix form: injected without `export` (pc-heavy.sh:3250) and volatile
    // only through `_pc_heavy_retry_result_file` -> `_pc_heavy_scratch_mktemp` (:3147). This
    // pins BOTH the no-export branch and the one level of local-variable resolution; an
    // export-only or non-resolving derivation drops it and fails here.
    expect(derived).toContain('PC_HEAVY_PREEMPT_RESULT_FILE');
    expect(derived.length).toBeGreaterThanOrEqual(4);
  });

  it('every per-invocation export pc-heavy.sh makes is stripped from the identity', () => {
    const unstripped = volatileExportedNames().filter(
      (name) => !PC_HEAVY_VOLATILE_IDENTITY_ENV.includes(name),
    );
    expect(unstripped).toEqual([]);
  });

  // FALSIFIABILITY CONTROL, kept permanently rather than proven once by mutating the shared tree.
  // The guard above is only worth having if it FAILS on an incomplete list, and "expect([]) passes"
  // is equally consistent with a guard that can never fail. This replays the exact pre-fix list and
  // asserts the same comparison rejects it — so a future refactor that quietly defeats the
  // derivation breaks HERE instead of going green while production reuse is dead again.
  it('the same comparison rejects the pre-fix strip list (control)', () => {
    const PRE_FIX_LIST = [
      'PC_HEAVY_PREEMPT_READY_FILE',
      'PC_HEAVY_PREEMPT_RESULT_FILE',
      'PC_HEAVY_CALLER_PID',
      'PC_HEAVY_CALLER_START_TICKS',
      'PC_HEAVY_PREEMPT_NOTIFY_FD',
    ];
    const unstripped = volatileExportedNames().filter((name) => !PRE_FIX_LIST.includes(name));
    expect(unstripped).toContain('PC_HEAVY_ADMISSION_ID');
    expect(unstripped.length).toBeGreaterThan(0);
  });

  // Belt and braces on the mechanism itself: prove the strip list is what does the work, by
  // checking each named variable really is absent from the hashed clone.
  it('removes every listed variable from the identity clone but not the real child env', () => {
    const environment = Object.fromEntries(
      PC_HEAVY_VOLATILE_IDENTITY_ENV.map((n) => [n, 'per-invocation-value']),
    );
    const { environment: clone } = passingTaskVerdictIdentityEnvironment(environment);
    expect(Object.keys(clone)).toEqual([]);
    // The input object is never mutated — the child still receives its real plumbing.
    expect(environment.PC_HEAVY_ADMISSION_ID).toBe('per-invocation-value');
  });
});
