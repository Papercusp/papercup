/**
 * su-locks — acquire / read / heartbeat / release / validation smoke.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-029.
 * Migrated from apps/operator/scripts/su-locks-smoke.ts.
 *
 * Single end-to-end probe: bootstrap → acquire 3 paths → read queue
 * → conflicting acquire → heartbeat → release → empty queue → path
 * validation. .skipIf(!live) when DB unreachable.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureBootstrap, getTxPool, normalizePaths,
  tryAcquire, tryRelease, tryHeartbeat,
  readQueue, _resetForTests,
} from '../su-lock-store';
import { inWorkspaceTxn } from '../in-workspace-txn';
import { liveLockHoldingsStrict } from '../live-lock-paths';

async function dbLive(): Promise<boolean> {
  try {
    const sql = getTxPool();
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

describe('su-locks smoke', async () => {
  const live = await dbLive();

  it.skipIf(!live)('end-to-end: bootstrap → acquire → conflict → heartbeat → release', async () => {
    await ensureBootstrap();

    const ws = 'smoke-test-ws-' + Date.now();
    const owner = 'smoke-agent-a';

    const r1 = await inWorkspaceTxn(ws, owner, (tx) => tryAcquire(tx, {
      coordinationDomain: ws, owner, ownerLabel: 'smoke:a',
      paths: normalizePaths(['libs/foo.ts', 'libs/bar.ts', 'apps/baz.ts']),
      intent: 'smoke test acquire', ttlSec: 60,
    }));
    expect(r1.ok).toBe(true);

    const sql = getTxPool();
    const q1 = await readQueue(sql, { coordinationDomain: ws });
    expect(q1.active_locks.length).toBe(3);

    // Conflicting acquire by different owner should be busy.
    const r2 = await inWorkspaceTxn(ws, 'smoke-agent-b', (tx) => tryAcquire(tx, {
      coordinationDomain: ws, owner: 'smoke-agent-b', ownerLabel: 'smoke:b',
      paths: normalizePaths(['libs/foo.ts', 'libs/qux.ts']),
      intent: 'smoke test conflict', ttlSec: 60,
    }));
    expect(r2.ok).toBe(false);

    const h = await inWorkspaceTxn(ws, owner, (tx) =>
      tryHeartbeat(tx, ws, owner, (r1 as { lock_id: string }).lock_id, 120),
    );
    expect(h.extended).toBe(true);

    const rel = await inWorkspaceTxn(ws, owner, (tx) => tryRelease(tx, {
      coordinationDomain: ws, owner, lockId: (r1 as { lock_id: string }).lock_id,
    }));
    expect(rel.released.length).toBe(3);

    const q2 = await readQueue(sql, { coordinationDomain: ws });
    expect(q2.active_locks.length).toBe(0);

    await _resetForTests();
  });

  it.skipIf(!live)('EI-276489: released submodule edit is absent from the git-sync lock census', async () => {
    await ensureBootstrap();

    const temp = mkdtempSync(join(tmpdir(), 'ei-276489-submodule-lock-'));
    const superproject = join(temp, 'papercusp');
    const submodule = join(superproject, 'libs', 'papercusp');
    mkdirSync(join(superproject, '.git'), { recursive: true });
    writeFileSync(join(superproject, '.git', 'HEAD'), 'ref: refs/heads/staging\n');
    mkdirSync(submodule, { recursive: true });
    writeFileSync(join(submodule, '.git'), 'gitdir: ../../.git/modules/libs/papercusp\n');

    const submoduleDomain = realpathSync(submodule);
    const filePath = 'packages/orchestrator/src/managed-capability-effectiveness.ts';
    const owner = `smoke-agent-ei-276489-${Date.now()}-${process.pid}`;
    let lockId: string | undefined;

    try {
      const acquired = await inWorkspaceTxn(submoduleDomain, owner, (tx) => tryAcquire(tx, {
        coordinationDomain: submoduleDomain,
        owner,
        ownerLabel: 'smoke:ei276489',
        paths: normalizePaths([filePath]),
        intent: 'EI-276489 submodule apply_patch lifecycle',
        ttlSec: 60,
      }));
      if (!acquired.ok) throw new Error('expected the submodule edit lock to be granted');
      lockId = acquired.lock_id;

      const held = await liveLockHoldingsStrict();
      expect(held).toContainEqual(expect.objectContaining({
        path: filePath,
        owner,
        coordinationDomain: submoduleDomain,
      }));

      const released = await inWorkspaceTxn(submoduleDomain, owner, (tx) => tryRelease(tx, {
        coordinationDomain: submoduleDomain,
        owner,
        lockId: lockId!,
      }));
      expect(released.released).toContain(filePath);
      lockId = undefined;

      const queue = await readQueue(getTxPool(), {
        coordinationDomain: submoduleDomain,
        paths: [filePath],
      });
      expect(queue.active_locks).toEqual([]);

      // git-sync's lock refresh reads liveLockHoldingsStrict; once this physical
      // submodule identity is absent, the file-lock gate no longer excludes it.
      const gitSyncCensus = await liveLockHoldingsStrict();
      expect(gitSyncCensus.filter((holding) =>
        holding.owner === owner
        && holding.path === filePath
        && holding.coordinationDomain === submoduleDomain,
      )).toEqual([]);
    } finally {
      if (lockId) {
        await inWorkspaceTxn(submoduleDomain, owner, (tx) => tryRelease(tx, {
          coordinationDomain: submoduleDomain,
          owner,
          lockId: lockId!,
        }));
      }
      await _resetForTests();
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('path validation rejects absolute and parent paths', () => {
    expect(() => normalizePaths(['/abs/path'])).toThrow();
    expect(() => normalizePaths(['../etc/passwd'])).toThrow();
  });
});
