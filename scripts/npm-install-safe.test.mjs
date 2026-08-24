import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cacheVerifyArgs,
  publishDependencyGeneration,
  verifyNpmCache,
} from './npm-install-safe.mjs';

test('cacheVerifyArgs preserves an explicit npm cache path', () => {
  assert.deepEqual(cacheVerifyArgs(['dedupe', '--cache', '/tmp/npm-cache']), [
    'cache',
    'verify',
    '--cache',
    '/tmp/npm-cache',
  ]);
  assert.deepEqual(cacheVerifyArgs(['--cache=/tmp/npm-cache', 'install']), [
    'cache',
    'verify',
    '--cache=/tmp/npm-cache',
  ]);
  assert.deepEqual(cacheVerifyArgs(['install']), ['cache', 'verify']);
});

test('verifyNpmCache invokes npm cache verify in the target repo and returns its status', () => {
  const calls = [];
  const env = { NPM_CONFIG_CACHE: '/tmp/npm-cache' };
  const status = verifyNpmCache({
    repoRoot: '/tmp/papercusp-test-repo',
    npmArgs: ['dedupe', '--cache', '/tmp/explicit-cache'],
    env,
    runNpm: (...args) => {
      calls.push(args);
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, [
    [
      'npm',
      ['cache', 'verify', '--cache', '/tmp/explicit-cache'],
      {
        cwd: '/tmp/papercusp-test-repo',
        stdio: 'inherit',
        env,
      },
    ],
  ]);
});

test('verifyNpmCache returns a failure status without hiding npm cache errors', () => {
  assert.equal(
    verifyNpmCache({
      runNpm: () => ({ status: 7 }),
    }),
    7,
  );
});

test('publishDependencyGeneration invokes the shared atomic publisher after install verification', () => {
  const calls = [];
  const env = { PATH: '/bin' };
  const status = publishDependencyGeneration({
    repoRoot: '/tmp/papercusp-test-repo',
    env,
    runPublisher: (...args) => {
      calls.push(args);
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'bash');
  assert.match(calls[0][1][0], /dependency-generation\.sh$/);
  assert.deepEqual(calls[0][1].slice(1), [
    '--integration',
    '/tmp/papercusp-test-repo',
  ]);
  assert.deepEqual(calls[0][2], {
    cwd: '/tmp/papercusp-test-repo',
    stdio: 'inherit',
    env,
  });
});

test('publishDependencyGeneration preserves an explicit emergency skip', () => {
  let called = false;
  assert.equal(
    publishDependencyGeneration({
      env: { PAPERCUSP_SKIP_DEP_GENERATION: '1' },
      runPublisher: () => {
        called = true;
        return { status: 0 };
      },
    }),
    0,
  );
  assert.equal(called, false);
});
