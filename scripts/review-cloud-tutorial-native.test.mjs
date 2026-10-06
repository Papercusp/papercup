import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { sources, verifySources, speechReady } from './review-cloud-tutorial-native.mjs';

test('healthy existing Speech Dispatcher is accepted by SSIP without spawning or restarting it', () => {
  const calls = [];
  const modules = speechReady({ run(command, args) {
    calls.push({ command, args });
    assert.equal(command, '/usr/bin/python3');
    assert.match(args[1], /SSIPClient/);
    assert.match(args[1], /list_output_modules/);
    return { status: 0, stdout: '["espeak-ng"]' };
  } });
  assert.deepEqual(modules, ['espeak-ng']);
  assert.equal(calls.length, 1);
});

test('unusable daemon, missing module and invalid SSIP reply fail closed before browser review', () => {
  for (const result of [
    { status: 1, stderr: 'connection refused' },
    { status: 0, stdout: '[]' },
    { status: 0, stdout: 'not JSON' },
    { status: null, error: new Error('SSIP deadline') },
  ]) assert.throws(() => speechReady({ run: () => result }));
});

test('source preflight rejects missing scope, duplicate scope, current drift and changed paused fixture', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-at-source-'));
  const current = mkdtempSync(join(tmpdir(), 'native-at-current-'));
  const fixture = 'apps/operator/e2e/cloud-tutorial.spec.ts';
  for (const base of [root, current]) for (const p of [...sources, fixture]) {
    mkdirSync(dirname(join(base, p)), { recursive: true }); writeFileSync(join(base, p), p);
  }
  const manifest = { files: sources.map(path => ({ path, sha256: createHash('sha256').update(path).digest('hex') })) };
  verifySources(root, current, manifest);
  assert.throws(() => verifySources(root, current, { files: manifest.files.slice(1) }), /exactly/);
  assert.throws(() => verifySources(root, current, { files: manifest.files.map(() => manifest.files[0]) }), /exactly/);
  writeFileSync(join(current, sources[0]), 'changed');
  assert.throws(() => verifySources(root, current, manifest), /source drift/);
  writeFileSync(join(current, sources[0]), sources[0]);
  writeFileSync(join(current, fixture), 'changed fixture');
  assert.throws(() => verifySources(root, current, manifest), /fixture source drift/);
});
