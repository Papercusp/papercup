import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
});
