import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildPureLaneShardArgs,
  resolvePureLaneShardCount,
  runPureLaneShards,
  runVitestProcess,
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

  it('bounds each Vitest coordinator by file census independently of its worker cap', () => {
    expect(resolvePureLaneShardCount({ VITEST_MAX_WORKERS: '2' }, 3606)).toBe(5);
    expect(resolvePureLaneShardCount({ VITEST_MAX_FORKS: '1' }, 3606)).toBe(5);
    expect(resolvePureLaneShardCount({ VITEST_MAX_WORKERS: '8' }, 3606)).toBe(5);
    expect(resolvePureLaneShardCount({}, 3606)).toBe(5);
    expect(resolvePureLaneShardCount({ VITEST_MAX_WORKERS: '2' }, 7200)).toBe(10);
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
      pureFileCount: 3606,
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
    expect(calls.map((args) => args.at(-1))).toEqual([
      '--shard=1/5', '--shard=2/5', '--shard=3/5', '--shard=4/5', '--shard=5/5',
    ]);
    expect(code).toBe(134);
  });

  it('runs the real shard child inside the canonical governed execution lifetime', async () => {
    const child = new EventEmitter() as EventEmitter & { pid: number };
    child.pid = 4242;
    const attached: number[] = [];
    const spawned: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    let governedOptions: Record<string, unknown> | null = null;
    const admittedEnv = {
      PAPERCUSP_WORKSPACE: 'workspace-test',
      PAPERCUSP_ADMISSION_CONTEXT: '{"receiptId":"receipt-1"}',
    };

    const result = runVitestProcess(['run', '--shard=1/2'], {
      env: { PAPERCUSP_WORKSPACE: 'workspace-test', VITEST_MAX_WORKERS: '2' },
      spawnProcess: ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        spawned.push({ command, args, env: options.env });
        queueMicrotask(() => child.emit('close', 0, null));
        return child;
      }) as never,
      createSampler: (() => ({
        attach: (pid: number) => attached.push(pid),
        stop: () => ({ cpuWeight: 0.5, memoryBytes: 1024, diskBytes: 0, fileDescriptors: 4 }),
      })) as never,
      runGovernedTestProcess: (async (options: Record<string, unknown>, run: Function) => {
        governedOptions = options;
        return run({ receiptId: 'receipt-1' }, admittedEnv, { inherited: false });
      }) as never,
    });

    await expect(result).resolves.toBe(0);
    expect(governedOptions).toMatchObject({
      namespace: 'vitest-pure-lane-shard',
      payloadRef: 'test:lane-pure',
      workspaceId: 'workspace-test',
    });
    expect(governedOptions).toHaveProperty('settle');
    expect(attached).toEqual([4242]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toEqual(['run', '--shard=1/2']);
    expect(spawned[0].env.PAPERCUSP_ADMISSION_CONTEXT).toContain('receipt-1');
  });
});
