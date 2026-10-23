import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContentEquivalence } from './conformance-test-content';

describe('conformance immutable dependency content', () => {
  let root: string;
  let recordedSha: string;
  const file = 'packages/unit/guard.test.ts';
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path: string, body: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conformance-content-'));
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    write('package.json', JSON.stringify({ workspaces: ['packages/*', 'libs/*'] }));
    write('package-lock.json', '{}');
    write('packages/unit/package.json', JSON.stringify({ name: '@fixture/unit', dependencies: { '@fixture/dependency': '*' } }));
    write(file, 'export const passing = true;');
    write('packages/unit/source.ts', 'export const answer = 1;');
    write('libs/dependency/package.json', JSON.stringify({ name: '@fixture/dependency' }));
    write('libs/dependency/source.ts', 'export const input = 1;');
    write('libs/test-config/package.json', JSON.stringify({ name: '@fixture/test-config' }));
    write('libs/test-config/src/vitest-config.ts', "import './setup';");
    write('libs/test-config/src/setup.ts', 'export const setup = 1;');
    write('libs/test-config/src/lane-split.ts', 'export const lane = 1;');
    write('scripts/affected-tests.mjs', "import './runner.mjs';");
    write('scripts/runner.mjs', 'export const runner = 1;');
    write('scripts/pc-heavy.sh', '#!/bin/sh\ntrue\n');
    recordedSha = commit();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('accepts unchanged semantic inputs across an unrelated commit, using immutable bytes despite dirty disk', async () => {
    write('docs/note.md', 'unrelated');
    const currentSha = commit();
    write('packages/unit/source.ts', 'dirty disk must never become committed proof');
    expect(await createTestContentEquivalence(root)({ file, recordedSha, currentSha }))
      .toEqual({ equivalent: true, reason: 'canonical semantic dependency closure matches' });
  });

  it.each([
    'packages/unit/source.ts', file, 'libs/dependency/source.ts',
    'package-lock.json', 'scripts/runner.mjs', 'libs/test-config/src/setup.ts',
    'packages/unit/new-input.ts',
  ])('invalidates changed source, membership, dependencies, or shared oracle: %s', async path => {
    write(path, 'export const changed = 2;');
    const currentSha = commit();
    expect(await createTestContentEquivalence(root)({ file, recordedSha, currentSha }))
      .toMatchObject({ equivalent: false, reason: 'semantic dependency closure changed' });
  });

  it('invalidates removal of a dependency instead of narrowing the old proof to the new graph', async () => {
    write('packages/unit/package.json', JSON.stringify({ name: '@fixture/unit' }));
    const currentSha = commit();
    expect(await createTestContentEquivalence(root)({ file, recordedSha, currentSha })).toMatchObject({ equivalent: false });
  });

  it('refuses an unresolved shared import graph, absent commits and unknown test identity', async () => {
    write('scripts/runner.mjs', "import './missing.mjs';");
    const currentSha = commit();
    const compare = createTestContentEquivalence(root);
    expect(await compare({ file, recordedSha, currentSha })).toMatchObject({ equivalent: false,
      reason: expect.stringContaining('shared-input-module-graph') });
    expect(await compare({ file, recordedSha: 'f'.repeat(40), currentSha })).toMatchObject({ equivalent: false });
    expect(await compare({ file: '../unknown.test.ts', recordedSha, currentSha })).toMatchObject({ equivalent: false });
  });

  it('reads pinned submodule inputs from Git objects and rejects changed submodule content', async () => {
    const dependency = mkdtempSync(join(tmpdir(), 'conformance-dependency-'));
    try {
      for (const args of [['init', '-q'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid']]) {
        execFileSync('git', args, { cwd: dependency });
      }
      writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: '@fixture/dependency' }));
      writeFileSync(join(dependency, 'source.ts'), 'export const dependency = 1;');
      execFileSync('git', ['add', '.'], { cwd: dependency });
      execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: dependency });
      git('rm', '-qr', 'libs/dependency');
      git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', dependency, 'libs/dependency');
      const first = commit();
      write('docs/note.md', 'unrelated');
      const second = commit();
      expect(await createTestContentEquivalence(root)({ file, recordedSha: first, currentSha: second }))
        .toMatchObject({ equivalent: true });
      writeFileSync(join(dependency, 'source.ts'), 'export const dependency = 2;');
      execFileSync('git', ['commit', '-qam', 'changed'], { cwd: dependency });
      const next = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dependency, encoding: 'utf8' }).trim();
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'fetch', '-q'], { cwd: join(root, 'libs/dependency') });
      execFileSync('git', ['checkout', '-q', next], { cwd: join(root, 'libs/dependency') });
      expect(await createTestContentEquivalence(root)({ file, recordedSha: first, currentSha: commit() }))
        .toMatchObject({ equivalent: false });
    } finally { rmSync(dependency, { recursive: true, force: true }); }
  });
});
