import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cleanupOwnedTestState } from '../../../scripts/lib/with-test-pg-cleanup.mjs';

describe('private PostgreSQL independent cleanup', () => {
  function fixture(failedStop?: 'child' | 'profile' | 'pg') {
    const dataDir = mkdtempSync(join(tmpdir(), 'pg-cleanup-fence-'));
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'runtime-cleanup-fence-'));
    writeFileSync(join(dataDir, 'evidence'), 'private pg');
    writeFileSync(join(runtimeRoot, 'evidence'), 'private runtime');
    const calls: string[] = [];
    const stages: { stage: string; [key: string]: unknown }[] = [];
    const failure = new Error('injected ' + failedStop + ' exit fence failure');
    const stop = async (name: string) => {
      calls.push(name);
      expect(existsSync(dataDir)).toBe(true);
      expect(existsSync(runtimeRoot)).toBe(true);
      await Promise.resolve();
      if (name === failedStop) throw failure;
    };
    const resources = { child: { pid: 1 }, childLifetime: { terminate: () => stop('child') },
      profileProcess: { pid: 2 }, profileLifetime: { terminate: () => stop('profile') },
      pg: { stop: () => stop('pg') }, dataDir, runtimeRoot, isolatedRuntime: true,
      cleanupStage: async (stage: string, detail = {}) => { stages.push({ stage, ...detail }); },
      observePrivatePgStop: () => { calls.push('observe'); return () => { calls.push('observation-stopped'); }; } };
    return { resources, calls, stages, failure, dispose: () => {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(runtimeRoot, { recursive: true, force: true });
    } };
  }

  it.each(['child', 'profile', 'pg'] as const)(
    'attempts every owned stop and retains private state after an unverified %s exit', async failedStop => {
      const f = fixture(failedStop);
      try {
        let error: unknown;
        try { await cleanupOwnedTestState(f.resources); } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(AggregateError);
        if (!(error instanceof AggregateError)) throw new Error('cleanup did not reject with its stop failures');
        expect(error.message).toContain('unverified resource stops');
        expect(error.errors).toHaveLength(1);
        expect(error.errors[0].cause).toBe(f.failure);
        expect(f.calls).toEqual(['child', 'profile', 'observe', 'pg', 'observation-stopped']);
        expect(existsSync(join(f.resources.dataDir, 'evidence'))).toBe(true);
        expect(existsSync(join(f.resources.runtimeRoot, 'evidence'))).toBe(true);
        expect(f.stages).toContainEqual(expect.objectContaining({ stage: 'private-state-retained',
          runtimeRemoved: false, pgDataRemoved: false }));
        expect(f.stages.some(row => row.stage === 'complete' || row.stage === 'remove-private-state')).toBe(false);
      } finally { f.dispose(); }
    });

  it('removes owned private state only after every stop succeeds', async () => {
    const f = fixture();
    try {
      await cleanupOwnedTestState(f.resources);
      expect(f.calls).toEqual(['child', 'profile', 'observe', 'pg', 'observation-stopped']);
      expect(existsSync(f.resources.dataDir)).toBe(false);
      expect(existsSync(f.resources.runtimeRoot)).toBe(false);
      expect(f.stages.at(-1)).toEqual({ stage: 'complete', runtimeRemoved: true, pgDataRemoved: true });
    } finally { f.dispose(); }
  });

  it.each([false, true])('fences detached managed tasks before private PG removal (fails=%s)', async fails => {
    const f = fixture();
    try {
      const resources = { ...f.resources, stopManagedTasks: async () => {
        f.calls.push('managed-tasks');
        expect(existsSync(f.resources.dataDir)).toBe(true);
        expect(existsSync(f.resources.runtimeRoot)).toBe(true);
        if (fails) throw new Error('private task scope still populated');
      } };
      if (fails) {
        await expect(cleanupOwnedTestState(resources)).rejects.toThrow(/unverified resource stops/);
        expect(existsSync(f.resources.dataDir)).toBe(true);
        expect(existsSync(f.resources.runtimeRoot)).toBe(true);
      } else {
        await cleanupOwnedTestState(resources);
        expect(existsSync(f.resources.dataDir)).toBe(false);
      }
      expect(f.calls).toEqual(['child', 'profile', 'managed-tasks', 'observe', 'pg', 'observation-stopped']);
    } finally { f.dispose(); }
  });

  it.each(['start', 'child-group-stop', 'child-group-stopped', 'child-group-stop-error'])(
    'isolates cleanup instrumentation: a rejected %s receipt cannot skip owned stops', async failedStage => {
      const f = fixture(failedStage === 'child-group-stop-error' ? 'child' : undefined);
      const receiptFailure = new Error('injected receipt failure at ' + failedStage);
      try {
        const resources = { ...f.resources, cleanupStage: async (stage: string, detail = {}) => {
          await f.resources.cleanupStage(stage, detail);
          if (stage === failedStage) throw receiptFailure;
        } };
        let error: unknown;
        try { await cleanupOwnedTestState(resources); } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(AggregateError);
        if (!(error instanceof AggregateError)) throw new Error('cleanup did not aggregate receipt failure');
        expect(error.errors.some(failure => failure.cause === receiptFailure)).toBe(true);
        if (failedStage === 'child-group-stop-error') {
          expect(error.errors.some(failure => failure.cause === f.failure)).toBe(true);
        }
        expect(f.calls).toEqual(['child', 'profile', 'observe', 'pg', 'observation-stopped']);
        expect(existsSync(join(f.resources.dataDir, 'evidence'))).toBe(true);
        expect(existsSync(join(f.resources.runtimeRoot, 'evidence'))).toBe(true);
      } finally { f.dispose(); }
    });

  it.each(['observe-start', 'observe-stop', 'health'])(
    'isolates cleanup instrumentation: a failed %s cannot skip private PG stop', async failedPhase => {
      const f = fixture();
      const observationFailure = new Error('injected observation failure at ' + failedPhase);
      try {
        const resources = { ...f.resources,
          pg: { ...f.resources.pg, health: () => {
            if (failedPhase === 'health') throw observationFailure;
            return null;
          } },
          observePrivatePgStop: () => {
            const stop = f.resources.observePrivatePgStop();
            if (failedPhase === 'observe-start') throw observationFailure;
            return () => { stop(); if (failedPhase === 'observe-stop') throw observationFailure; };
          } };
        let error: unknown;
        try { await cleanupOwnedTestState(resources); } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(AggregateError);
        if (!(error instanceof AggregateError)) throw new Error('cleanup did not aggregate observation failure');
        expect(error.errors.some(failure => failure.cause === observationFailure)).toBe(true);
        expect(f.calls).toEqual(['child', 'profile', 'observe', 'pg',
          ...(failedPhase === 'observe-start' ? [] : ['observation-stopped'])]);
        expect(existsSync(join(f.resources.dataDir, 'evidence'))).toBe(true);
        expect(existsSync(join(f.resources.runtimeRoot, 'evidence'))).toBe(true);
      } finally { f.dispose(); }
    });

  it('awaits cleanup instrumentation already in flight before removing private evidence', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finishPg!: () => void;
    let finishReceipt!: () => void;
    const pgWaiting = new Promise<void>(resolve => { finishPg = resolve; });
    const receiptWaiting = new Promise<void>(resolve => { finishReceipt = resolve; });
    const receiptFailure = new Error('delayed periodic receipt rejected');
    let settled = false;
    const cleanup = cleanupOwnedTestState({ ...f.resources,
      pg: { stop: async () => { await f.resources.pg.stop(); await pgWaiting; } },
      cleanupStage: async (stage, detail) => {
        await f.resources.cleanupStage(stage, detail);
        if (stage === 'pg-stop-waiting') { await receiptWaiting; throw receiptFailure; }
      } }).finally(() => { settled = true; });
    void cleanup.catch(() => {});
    try {
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.stages.some(row => row.stage === 'pg-stop-waiting')).toBe(true);
      finishPg();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(existsSync(join(f.resources.dataDir, 'evidence'))).toBe(true);
      finishReceipt();
      await expect(cleanup).rejects.toMatchObject({ errors: [expect.objectContaining({ cause: receiptFailure })] });
      expect(f.calls).toEqual(['child', 'profile', 'observe', 'pg', 'observation-stopped']);
      expect(existsSync(join(f.resources.runtimeRoot, 'evidence'))).toBe(true);
    } finally {
      finishPg(); finishReceipt();
      await cleanup.catch(() => {});
      vi.useRealTimers();
      f.dispose();
    }
  });
});
