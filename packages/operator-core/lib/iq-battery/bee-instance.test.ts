/**
 * bee-instance.test.ts — the P-001 runInstance await/terminal-mapping logic (Apiary gen-0).
 *
 * Pure unit coverage of `makeBeeRunInstance` with a fake clock + injected spawn/poll effects —
 * zero spawn, zero spend. Proves the terminal-state mapping the battery depends on: a real run
 * (done/failed) returns a handle to be scored; an invalid end (cancelled/reaped/timeout) throws so
 * the orchestrator records it `errored` and continues.
 */
import { describe, it, expect } from 'vitest';
import { makeBeeRunInstance, type BeeRunDeps, type SpawnOnceResult } from './bee-instance';
import type { BeekeeperRunInput } from './beekeeper-runner';
import type { CorpusCase } from './corpus';
import type { InstanceBootSpec } from './instance-manifest';

const CFG = { timeoutMs: 1000, pollMs: 100 };

const CASE = { id: 'c-1', variant: 'fix-injected-bug', title: 't', prompt: 'fix the bug' } as unknown as CorpusCase;
const SPEC = {
  manifest: { instanceId: 'inst', workspaceId: 'w', codeSha: 'sha', createdAt: new Date() },
  instanceUrl: 'mock://x',
} as InstanceBootSpec;
const INPUT: BeekeeperRunInput = { case: CASE, repeat: 0, instanceSpec: SPEC };

/** A fake clock that advances on each `sleep`, plus a scripted `pollStatus` sequence. */
function fakeDeps(opts: {
  spawnResult?: SpawnOnceResult;
  statuses: Array<string | null>;
  cost?: number;
}): BeeRunDeps {
  let pollIdx = 0;
  const clock = { t: 0 };
  return {
    spawn: async () => opts.spawnResult ?? { ok: true, spawnId: 's-bee-1', error: null },
    pollStatus: async () => {
      const s = opts.statuses[Math.min(pollIdx, opts.statuses.length - 1)];
      pollIdx += 1;
      return s;
    },
    loadCost: async () => opts.cost ?? 0,
    sleep: async (ms: number) => {
      clock.t += ms;
    },
    now: () => clock.t,
  };
}

describe('makeBeeRunInstance — terminal mapping', () => {
  it('a bee that reaches done → returns a handle keyed to the spawn id, with cost', async () => {
    const run = makeBeeRunInstance(CFG, fakeDeps({ statuses: ['running', 'running', 'done'], cost: 0.05 }));
    const handle = await run(INPUT);
    expect(handle.instanceId).toBe('s-bee-1');
    expect(handle.instanceUrl).toBe('bee://s-bee-1');
    expect(handle.targetSlug).toBe('fix-injected-bug');
    expect(handle.costUsd).toBe(0.05);
  });

  it('a bee that FAILS the case → still returns a handle (a scoreable failure, not a runInstance error)', async () => {
    const run = makeBeeRunInstance(CFG, fakeDeps({ statuses: ['running', 'failed'] }));
    const handle = await run(INPUT);
    expect(handle.instanceId).toBe('s-bee-1');
  });

  it('a cancelled bee → throws (invalid run, re-runnable)', async () => {
    const run = makeBeeRunInstance(CFG, fakeDeps({ statuses: ['cancelled'] }));
    await expect(run(INPUT)).rejects.toThrow(/invalid run/);
  });

  it('a reaped bee (host died) → throws (invalid run)', async () => {
    const run = makeBeeRunInstance(CFG, fakeDeps({ statuses: ['reaped'] }));
    await expect(run(INPUT)).rejects.toThrow(/invalid run/);
  });

  it('a bee that never reaches a terminal state → throws on timeout', async () => {
    const run = makeBeeRunInstance(CFG, fakeDeps({ statuses: ['running'] }));
    await expect(run(INPUT)).rejects.toThrow(/did not reach a terminal state/);
  });

  it('a rejected spawn → throws before polling', async () => {
    const run = makeBeeRunInstance(
      CFG,
      fakeDeps({ spawnResult: { ok: false, spawnId: null, error: 'over ceiling' }, statuses: [] }),
    );
    await expect(run(INPUT)).rejects.toThrow(/spawn rejected/);
  });

  it('tolerates a not-yet-visible row (null status) before the terminal state', async () => {
    const run = makeBeeRunInstance(CFG, fakeDeps({ statuses: [null, null, 'done'] }));
    const handle = await run(INPUT);
    expect(handle.instanceId).toBe('s-bee-1');
  });
});
