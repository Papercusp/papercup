import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildPureLaneShardArgs,
  resolvePureLaneShardCount,
  runPureLaneShards,
} from '../../../scripts/run-vitest-pure-lane.mjs';

const REPO_ROOT = resolve(__dirname, '../../..');
const PACKAGE_JSON = resolve(REPO_ROOT, 'packages/operator-core/package.json');
const PC_HEAVY = resolve(REPO_ROOT, 'scripts/pc-heavy.sh');

type PackageManifest = {
  scripts?: Record<string, string>;
};

const scripts = (JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as PackageManifest).scripts ?? {};

describe('operator-core test-lane admission', () => {
  it.each([
    ['test:lane-pure', 'PC_TEST_LANE=pure ../../scripts/pc-heavy.sh -- node ../../scripts/run-vitest-pure-lane.mjs'],
    ['test:lane-stateful', 'PC_TEST_LANE=stateful ../../scripts/pc-heavy.sh -- vitest run --passWithNoTests'],
  ])('%s routes the full lane through pc-heavy', (scriptName, expected) => {
    const command = scripts[scriptName];

    expect(command, `${scriptName} must remain declared`).toBeTruthy();
    expect(command).toBe(expected);
  });

  it('keeps the shared wrapper executable from the workspace package directory', () => {
    expect(existsSync(PC_HEAVY)).toBe(true);
    expect(statSync(PC_HEAVY).mode & 0o111).not.toBe(0);
  });

  it('derives sequential shard count from the live file census and worker cap', () => {
    expect(resolvePureLaneShardCount({ VITEST_MAX_WORKERS: '2' }, 3606)).toBe(3);
    expect(resolvePureLaneShardCount({ VITEST_MAX_FORKS: '1' }, 3606)).toBe(5);
    expect(resolvePureLaneShardCount({ VITEST_MAX_WORKERS: '8' }, 3606)).toBe(1);
    expect(resolvePureLaneShardCount({}, 3606)).toBe(1);
    expect(resolvePureLaneShardCount({ VITEST_MAX_WORKERS: '2' }, 7200)).toBe(5);
  });

  it('preserves caller flags while owning the final Vitest shard selector', () => {
    expect(buildPureLaneShardArgs(1, 2, ['--no-passWithNoTests', '--reporter=default'])).toEqual([
      'run',
      '--passWithNoTests',
      '--no-passWithNoTests',
      '--reporter=default',
      '--shard=1/2',
    ]);
    expect(() => buildPureLaneShardArgs(1, 2, ['--shard=2/2'])).toThrow(/owns Vitest sharding/);
  });

  it('runs shards sequentially, drains all of them, and preserves the first failure', async () => {
    const calls: string[][] = [];
    let active = 0;
    let maxActive = 0;
    const code = await runPureLaneShards({
      env: { VITEST_MAX_WORKERS: '3' },
      forwardedArgs: ['--no-passWithNoTests'],
      stderr: { write: () => true },
      run: async (args) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        calls.push(args);
        await Promise.resolve();
        active -= 1;
        return calls.length === 1 ? 134 : 0;
      },
    });

    expect(maxActive).toBe(1);
    expect(calls.map((args) => args.at(-1))).toEqual(['--shard=1/2', '--shard=2/2']);
    expect(code).toBe(134);
  });
});
