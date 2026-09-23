/**
 * The production waiting-on source, on real PG. Every other obligation test
 * stubs `waitingOn`, which is how a read through the wrong database shipped:
 * the lock tables live in the locks package's own `papercusp_su` database,
 * and the org pool has no agent_file_locks, so the whole waiting-on section
 * silently came back empty.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { defaultAgentObligationReaderDeps } from './agent-obligation-reader';
import { ensureBootstrap, getTxPool, tryAcquire, tryInsertWaiter } from './agent-tools/locks/su-lock-store';
import { inWorkspaceTxn } from './agent-tools/locks/in-workspace-txn';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const DOMAIN = `vitest-obligation-waiting-on-${RUN}`;
const HOLDER = `su-holder-${RUN}`;
const WAITER = `su-waiter-${RUN}`;
const PATH = 'packages/operator-core/lib/waiting-on-fixture.ts';
let fx: BaselineCoordFixture;

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  await ensureBootstrap();
}, 150_000);

afterAll(async () => {
  const sql = getTxPool();
  await sql`DELETE FROM agent_lock_waiters WHERE coordination_domain = ${DOMAIN}`;
  await sql`DELETE FROM agent_file_locks WHERE coordination_domain = ${DOMAIN}`;
  await fx?.dispose();
});

it('names the holder a queued lock ticket is waiting behind', async () => {
  const held = await inWorkspaceTxn(DOMAIN, HOLDER, (tx) => tryAcquire(tx, {
    coordinationDomain: DOMAIN, owner: HOLDER, ownerLabel: 'holder', paths: [PATH],
    intent: 'hold for the waiting-on read', ttlSec: 120,
  }));
  expect(held.ok).toBe(true);
  const queued = await inWorkspaceTxn(DOMAIN, WAITER, (tx) => tryInsertWaiter(tx, {
    coordinationDomain: DOMAIN, owner: WAITER, ownerLabel: 'waiter', paths: [PATH],
    intent: 'queued behind the holder', ttlSec: 120, maxWaitSec: 120,
  }));
  if (!queued.ok || 'self_granted' in queued) throw new Error('the waiter should queue behind the holder');

  const rows = await defaultAgentObligationReaderDeps().waitingOn('default', WAITER);

  expect(rows).toContainEqual(expect.objectContaining({
    kind: 'lock-queue', path: PATH, holder: HOLDER, holderIntent: 'hold for the waiting-on read',
  }));
});
