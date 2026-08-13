import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildPassingTaskVerdictIdentity,
  decidePassingTaskVerdict,
  emptyPassingTaskVerdictCache,
  hashDependencyFileSet,
  mergePassingTaskVerdictUpdates,
  passingTaskVerdictEntry,
  readPassingTaskVerdictCache,
  writePassingTaskVerdictCacheAtomic,
} from '../../../../scripts/lib/passing-task-verdict-cache.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS_SRC = readFileSync(resolve(REPO_ROOT, 'scripts/affected-tests.mjs'), 'utf8');
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
      const next = mergePassingTaskVerdictUpdates(emptyPassingTaskVerdictCache(), update);
      writePassingTaskVerdictCacheAtomic(path, next, 'nonce');
      expect(readPassingTaskVerdictCache(path)).toEqual({ cache: next, reason: 'cache-ready' });
      expect(readdirSync(dir)).toEqual(['cache.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gate wiring safety contract', () => {
  it('enables reuse only under the green checkpoint and leaves downstream assurance after the suite', () => {
    expect(AFFECTED_TESTS_SRC).toContain("process.env.GREEN_CHECKPOINT === '1'");
    const suite = GREEN_CHECKPOINT_SRC.indexOf('const r = await exec(cmd, args');
    const postSuite = GREEN_CHECKPOINT_SRC.indexOf('runPostSuiteLegs(', suite);
    expect(suite).toBeGreaterThan(-1);
    expect(postSuite).toBeGreaterThan(suite);
  });
});
