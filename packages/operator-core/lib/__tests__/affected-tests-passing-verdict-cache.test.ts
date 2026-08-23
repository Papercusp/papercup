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
  PASSING_TASK_VERDICT_CACHE_MAX_GROUPS,
  passingTaskVerdictCacheEntry,
  passingTaskVerdictIdentityEnvironment,
  passingTaskVerdictEntry,
  readPassingTaskVerdictCache,
  writePassingTaskVerdictCacheAtomic,
} from '../../../../scripts/lib/passing-task-verdict-cache.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS_SRC = readFileSync(resolve(REPO_ROOT, 'scripts/affected-tests.mjs'), 'utf8').replaceAll(
  '"',
  "'",
);
const GREEN_CHECKPOINT_SRC = readFileSync(resolve(REPO_ROOT, 'apps/operator/lib/release/green-checkpoint.ts'), 'utf8');

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
});

describe('dependency-closure hashing and persistence', () => {
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
  it('enables reuse only under the green checkpoint and leaves downstream assurance after the suite', () => {
    expect(AFFECTED_TESTS_SRC).toContain("process.env.GREEN_CHECKPOINT === '1'");
    expect(AFFECTED_TESTS_SRC).toContain('passingTaskVerdictIdentityEnvironment(childEnv)');
    expect(AFFECTED_TESTS_SRC).toContain('formatPassingTaskVerdictSummary(');
    const suite = GREEN_CHECKPOINT_SRC.indexOf('const r = await exec(cmd, args');
    const postSuite = GREEN_CHECKPOINT_SRC.indexOf('runPostSuiteLegs(', suite);
    expect(suite).toBeGreaterThan(-1);
    expect(postSuite).toBeGreaterThan(suite);
  });
});
