/** Standalone rollback orchestration (D-008). */
import { describe, it, expect } from 'vitest';
import { executeRollback } from './rollback';
import type { DeployDeps, SnapshotInfo } from './deploy';
import { releaseConfig } from './release-config';

function deps(over: Partial<DeployDeps> = {}): { deps: DeployDeps; calls: string[] } {
  const calls: string[] = [];
  const d: DeployDeps = {
    withDrain: async (fn) => {
      calls.push('drain');
      return fn();
    },
    snapshot: async () => null,
    runSetup: async (sha) => {
      calls.push(`setup:${sha.slice(0, 4)}`);
    },
    migrate: async () => ({ appliedCount: 0, totalKnown: 0, applied: [], sqlDir: '' }),
    restart: async () => {
      calls.push('restart');
    },
    health: async () => ({ healthy: true, attempts: 1, elapsedMs: 1 }),
    verifyPaths: async () => ({ ok: true, failures: [] }),
    restoreSnapshot: async () => {
      calls.push('restore');
    },
    broadcast: async () => {
      calls.push('broadcast');
    },
    log: () => {},
    ...over,
  };
  return { deps: d, calls };
}

const cfg = releaseConfig();

describe('executeRollback', () => {
  it('reverts code + restores snapshot + restarts', async () => {
    const { deps: d, calls } = deps();
    const snap: SnapshotInfo = { snapshotId: 1, kopiaSnapshotId: 'k' };
    const r = await executeRollback(cfg, d, { toSha: '1111111111', fromSha: '2222222222', snapshot: snap, lockfileChanged: false });
    expect(r.ok).toBe(true);
    expect(r.restoredSnapshot).toBe(true);
    expect(calls).toEqual(['drain', 'setup:1111', 'restore', 'restart', 'broadcast']);
  });

  it('code-only rollback skips snapshot restore', async () => {
    const { deps: d, calls } = deps();
    const r = await executeRollback(cfg, d, { toSha: '1111111111', fromSha: '2222222222', snapshot: null, lockfileChanged: false });
    expect(r.ok).toBe(true);
    expect(r.restoredSnapshot).toBe(false);
    expect(calls).not.toContain('restore');
  });

  it('reports failure loudly when post-rollback health is bad', async () => {
    const { deps: d } = deps({ health: async () => ({ healthy: false, attempts: 1, elapsedMs: 1, error: 'down' }) });
    const r = await executeRollback(cfg, d, { toSha: '1111111111', fromSha: null, snapshot: null, lockfileChanged: false });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/health/);
  });
});
