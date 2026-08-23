import assert from 'node:assert/strict';
import test from 'node:test';

import { cacheVerifyArgs, verifyNpmCache } from './npm-install-safe.mjs';

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
