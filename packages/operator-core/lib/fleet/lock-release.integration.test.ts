/**
 * lock-release.integration.test.ts — proves the production lock-release effect that
 * transitive cancellation depends on actually frees real file + resource locks in
 * papercusp_su (P0, D-003).
 *
 * Mirrors the su-locks test convention: runs against the live papercusp_su if
 * reachable, else skips (no testcontainer for the side-DB). nursery.integration.test.ts
 * injects a spy for this effect; this test exercises the REAL wiring.
 */
import { describe, it, expect } from 'vitest';
import { getTxPool, _resetForTests } from '../agent-tools/locks/su-lock-store';
import { releaseAllLocksForOwners } from './lock-release';

async function dbLive(): Promise<boolean> {
  try {
    await getTxPool()`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

describe('fleet/lock-release (real papercusp_su)', async () => {
  const live = await dbLive();

  it.skipIf(!live)('releaseAllLocksForOwners frees an owner\'s file + resource locks NOW', async () => {
    const sql = getTxPool();
    const domain = 'fleet-lr-test-' + Date.now();
    const owner = 'cancelled-agent-' + Date.now();

    // Seed: one file lock + one (shared) resource lock owned by the to-be-cancelled agent.
    await sql`
      INSERT INTO agent_file_locks (coordination_domain, path, owner, owner_label, intent, expires_ts)
      VALUES (${domain}, ${'libs/doomed.ts'}, ${owner}, ${'doomed'}, ${'in-flight work'}, ${new Date(Date.now() + 600_000)})`;
    await sql`
      INSERT INTO agent_resource_locks (coordination_domain, resource, owner, owner_label, mode, expires_ts)
      VALUES (${domain}, ${'dev-server'}, ${owner}, ${'doomed'}, ${'shared'}, ${new Date(Date.now() + 600_000)})`;

    const before = await sql<{ n: number }[]>`
      SELECT (SELECT count(*) FROM agent_file_locks WHERE coordination_domain=${domain} AND owner=${owner})
           + (SELECT count(*) FROM agent_resource_locks WHERE coordination_domain=${domain} AND owner=${owner}) AS n`;
    expect(Number(before[0].n)).toBe(2);

    const res = await releaseAllLocksForOwners([{ coordinationDomain: domain, owner }]);
    expect(res.owners).toEqual([owner]);
    expect(res.filePathsReleased).toBe(1);
    expect(res.resourcesReleased).toBe(1);

    const after = await sql<{ n: number }[]>`
      SELECT (SELECT count(*) FROM agent_file_locks WHERE coordination_domain=${domain} AND owner=${owner})
           + (SELECT count(*) FROM agent_resource_locks WHERE coordination_domain=${domain} AND owner=${owner}) AS n`;
    expect(Number(after[0].n)).toBe(0);

    await _resetForTests();
  });

  it.skipIf(!live)('de-dupes targets and is a no-op for an owner holding nothing', async () => {
    const domain = 'fleet-lr-empty-' + Date.now();
    const owner = 'no-locks-' + Date.now();
    const res = await releaseAllLocksForOwners([
      { coordinationDomain: domain, owner },
      { coordinationDomain: domain, owner }, // duplicate
    ]);
    expect(res.owners).toEqual([owner]); // de-duped
    expect(res.filePathsReleased).toBe(0);
    expect(res.resourcesReleased).toBe(0);
    await _resetForTests();
  });

  it('skipped diagnostic when su DB unreachable', () => {
    expect(live ? 'live' : 'offline').toMatch(/^(live|offline)$/);
  });
});
