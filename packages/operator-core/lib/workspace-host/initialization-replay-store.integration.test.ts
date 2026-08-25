/**
 * initialization-replay-store.integration.test.ts — the durable workspace-host initialization
 * replay store against REAL Postgres (testcontainer), exercising REAL RLS.
 *
 * harness_shared.workspace_host_initialization_steps is RLS-enabled with a
 * `workspace_id = current_setting('app.workspace_id')` policy (migration 955, matching the
 * posture migration 887 gave its six sibling tables). The store runs through
 * `withWorkspace(ws, cb)`, i.e. as the RLS-SUBJECT harness_app role, so withWorkspace is mocked
 * to open an appSql transaction that sets the GUC — the canonical pattern from
 * test/_org-test-db.ts. Isolation is therefore enforced by REAL policies, not by a WHERE clause.
 *
 * The property under test is the one the contract actually demands of this seam: runOnce() either
 * returns the prior receipt for a completed identity, or owns and persists EXACTLY ONE execution.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ appSql: null as any }));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  withWorkspace: async <T>(ws: string, cb: (tx: unknown) => Promise<T>): Promise<T> =>
    h.appSql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      return cb(tx);
    }),
}));

const {
  createWorkspaceHostInitializationReplayStore,
  WorkspaceHostInitializationReplayConflictError,
  WorkspaceHostInitializationReplayInFlightError,
} = await import('./initialization-replay-store');
const { createOrgTestDb } = await import('../../test/_org-test-db');

let n = 0;
const freshWs = () => `wh_ws_${++n}_${randomBytes(2).toString('hex')}`;
const freshKey = () => `step_${++n}_${randomBytes(3).toString('hex')}`;
const fingerprint = (seed: string) =>
  seed.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, 'a');

describe('workspace-host initialization replay store (real PG + real RLS)', () => {
  let db: OrgTestDb;

  /** Seed the FK chain (connection -> host) a step row requires. */
  async function seedHost(workspaceId: string): Promise<string> {
    const connectionId = `conn_${randomBytes(3).toString('hex')}`;
    const hostId = `host_${randomBytes(3).toString('hex')}`;
    await db.adminSql`
      INSERT INTO harness_shared.workspace_host_connections (
        workspace_id, id, target, label, credential_ref
      ) VALUES (${workspaceId}, ${connectionId}, 'gcp', 'test connection', 'cloudCredentialRef:test')
    `;
    await db.adminSql`
      INSERT INTO harness_shared.workspace_hosts (
        workspace_id, id, name, connection_id, target, scope_label, region, size, image,
        disk_gib, network, desired_state, observed_state
      ) VALUES (
        ${workspaceId}, ${hostId}, 'test host', ${connectionId}, 'gcp', 'test-project',
        'us-central1', 'e2-standard-4', 'papercusp-host-v1', 64, 'default', 'running', 'running'
      )
    `;
    return hostId;
  }

  function storeFor(workspaceId: string, hostId: string, opts: Partial<{
    leaseOwner: string;
    leaseTtlMs: number;
    now: () => Date;
  }> = {}) {
    return createWorkspaceHostInitializationReplayStore({
      workspaceId,
      hostId,
      leaseOwner: opts.leaseOwner ?? 'controller-a',
      ...(opts.leaseTtlMs === undefined ? {} : { leaseTtlMs: opts.leaseTtlMs }),
      ...(opts.now === undefined ? {} : { now: opts.now }),
    });
  }

  const receipt = (stepId: string, evidence?: Record<string, unknown>) => ({
    stepId,
    status: 'succeeded' as const,
    observedAt: '2026-08-25T16:00:00.000Z',
    ...(evidence ? { publicEvidence: evidence } : {}),
  });

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.appSql = db.appSql;
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('executes the closure once and persists the receipt', async () => {
    const ws = freshWs();
    const hostId = await seedHost(ws);
    const store = storeFor(ws, hostId);
    const key = freshKey();
    let calls = 0;

    const got = await store.runOnce({ idempotencyKey: key, stepFingerprint: fingerprint('ab') }, async () => {
      calls += 1;
      return receipt('create-workspace', { workspacePath: '/srv/papercusp' });
    });

    expect(calls).toBe(1);
    expect(got).toMatchObject({ stepId: 'create-workspace', status: 'succeeded' });

    const rows = await db.adminSql`
      SELECT status, step_id, lease_owner, public_evidence
        FROM harness_shared.workspace_host_initialization_steps
       WHERE workspace_id = ${ws} AND idempotency_key = ${key}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'succeeded', step_id: 'create-workspace' });
    // The lease is surrendered on success, so nothing looks in-flight afterwards.
    expect(rows[0].lease_owner).toBeNull();
    expect(rows[0].public_evidence).toEqual({ workspacePath: '/srv/papercusp' });
  });

  it('replays the stored receipt WITHOUT re-executing the closure', async () => {
    const ws = freshWs();
    const hostId = await seedHost(ws);
    const store = storeFor(ws, hostId);
    const key = freshKey();
    const fp = fingerprint('bc');
    let calls = 0;

    const first = await store.runOnce({ idempotencyKey: key, stepFingerprint: fp }, async () => {
      calls += 1;
      return receipt('clone-repository', { revision: 'abc123' });
    });

    // A second controller instance, as after a restart — the durable row is the only shared state.
    const second = await storeFor(ws, hostId, { leaseOwner: 'controller-b' }).runOnce(
      { idempotencyKey: key, stepFingerprint: fp },
      async () => {
        calls += 1;
        return receipt('clone-repository', { revision: 'SHOULD-NOT-RUN' });
      },
    );

    expect(calls).toBe(1);
    expect(second).toEqual(first);
    expect(second.publicEvidence).toEqual({ revision: 'abc123' });
  });

  it('refuses a reused idempotency key carrying a different step fingerprint', async () => {
    const ws = freshWs();
    const hostId = await seedHost(ws);
    const store = storeFor(ws, hostId);
    const key = freshKey();

    await store.runOnce({ idempotencyKey: key, stepFingerprint: fingerprint('cd') }, async () =>
      receipt('bind-credential'),
    );

    let ran = false;
    await expect(
      store.runOnce({ idempotencyKey: key, stepFingerprint: fingerprint('ef') }, async () => {
        ran = true;
        return receipt('bind-credential');
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostInitializationReplayConflictError);
    // The whole point: it must fail rather than hand back the other step's receipt.
    expect(ran).toBe(false);
  });

  it('refuses to execute while another controller holds a LIVE lease', async () => {
    const ws = freshWs();
    const hostId = await seedHost(ws);
    const key = freshKey();
    const fp = fingerprint('12');

    // controller-a claims and is still working (closure never resolves during this assertion).
    let release: () => void = () => {};
    const inFlight = storeFor(ws, hostId, { leaseOwner: 'controller-a' }).runOnce(
      { idempotencyKey: key, stepFingerprint: fp },
      () => new Promise((resolve) => {
        release = () => resolve(receipt('verify-initialization'));
      }),
    );
    // Let the claim transaction commit before the competing controller looks.
    await vi.waitFor(async () => {
      const rows = await db.adminSql`
        SELECT 1 FROM harness_shared.workspace_host_initialization_steps
         WHERE workspace_id = ${ws} AND idempotency_key = ${key} AND status = 'running'
      `;
      expect(rows).toHaveLength(1);
    });

    let ran = false;
    await expect(
      storeFor(ws, hostId, { leaseOwner: 'controller-b' }).runOnce(
        { idempotencyKey: key, stepFingerprint: fp },
        async () => {
          ran = true;
          return receipt('verify-initialization');
        },
      ),
    ).rejects.toBeInstanceOf(WorkspaceHostInitializationReplayInFlightError);
    expect(ran).toBe(false);

    release();
    await inFlight;
  });

  it('reclaims a lease stranded by a crashed controller', async () => {
    const ws = freshWs();
    const hostId = await seedHost(ws);
    const key = freshKey();
    const fp = fingerprint('34');

    // Simulate a crashed controller: a running row whose lease already expired.
    await db.adminSql`
      INSERT INTO harness_shared.workspace_host_initialization_steps (
        workspace_id, idempotency_key, host_id, step_fingerprint, status,
        lease_owner, lease_expires_at
      ) VALUES (
        ${ws}, ${key}, ${hostId}, ${fp}, 'running',
        'dead-controller', ${new Date(Date.now() - 60_000).toISOString()}
      )
    `;

    let calls = 0;
    const got = await storeFor(ws, hostId, { leaseOwner: 'controller-b' }).runOnce(
      { idempotencyKey: key, stepFingerprint: fp },
      async () => {
        calls += 1;
        return receipt('import-workspace');
      },
    );

    expect(calls).toBe(1);
    expect(got.stepId).toBe('import-workspace');
  });

  it('releases the claim when the closure throws, so a later attempt can run', async () => {
    const ws = freshWs();
    const hostId = await seedHost(ws);
    const store = storeFor(ws, hostId);
    const key = freshKey();
    const fp = fingerprint('56');

    await expect(
      store.runOnce({ idempotencyKey: key, stepFingerprint: fp }, async () => {
        throw new Error('host unreachable');
      }),
    ).rejects.toThrow('host unreachable');

    // A failed attempt must not leave a row that wedges every retry.
    const stranded = await db.adminSql`
      SELECT 1 FROM harness_shared.workspace_host_initialization_steps
       WHERE workspace_id = ${ws} AND idempotency_key = ${key}
    `;
    expect(stranded).toHaveLength(0);

    const got = await store.runOnce({ idempotencyKey: key, stepFingerprint: fp }, async () =>
      receipt('pair-workspace'),
    );
    expect(got.stepId).toBe('pair-workspace');
  });

  it('isolates rows by workspace under real RLS', async () => {
    const wsA = freshWs();
    const wsB = freshWs();
    const hostA = await seedHost(wsA);
    const hostB = await seedHost(wsB);
    const key = freshKey();
    const fp = fingerprint('78');

    await storeFor(wsA, hostA).runOnce({ idempotencyKey: key, stepFingerprint: fp }, async () =>
      receipt('create-workspace', { owner: 'A' }),
    );

    // Same idempotency key in a different workspace must NOT see A's receipt — it is a
    // different row entirely, and the RLS policy is what proves it.
    let calls = 0;
    const bResult = await storeFor(wsB, hostB).runOnce(
      { idempotencyKey: key, stepFingerprint: fp },
      async () => {
        calls += 1;
        return receipt('create-workspace', { owner: 'B' });
      },
    );

    expect(calls).toBe(1);
    expect(bResult.publicEvidence).toEqual({ owner: 'B' });
  });
});
