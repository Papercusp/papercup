/** P-534: the real admission transaction, concurrency, fencing and RLS in a throwaway PG. */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import type { AdmitHostedLifecycleJobInput, HostedPoolObservation } from './hosted-lifecycle-store';

const h = vi.hoisted(() => ({ sql: null as any }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  withWorkspace: async <T>(workspaceId: string, run: (tx: any) => Promise<T>) =>
    h.sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return run(tx);
    }),
}));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));

const { createOrgTestDb } = await import('../../test/_org-test-db');
const { admitHostedLifecycleJob, HostedLifecyclePlacementError, recordHostedPoolObservation, completeHostedPoolReuse } =
  await import('./hosted-lifecycle-store');
const { beginWorkspaceHostOperation, readWorkspaceHostDestroyTarget } = await import('./observability-store');

const migration = fileURLToPath(new URL('../../../../libs/papercusp/libs/db/sql/1522-workspace-host-pool-admission.sql', import.meta.url));
const migrationSql = readFileSync(existsSync(migration) ? migration : `${migration}.DRAFT`, 'utf8');
const scope = { kind: 'project', id: 'pool-project' };
const release = {
  version: 'pool-v1', bundleSha256: 'a'.repeat(64), signingKeySha256: 'b'.repeat(64),
  protocolVersion: 'workspace-host-bootstrap-v1', schemaVersion: '1522',
};

describe('hosted pool admission (real Postgres + workspace RLS)', () => {
  let db: OrgTestDb;
  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.appSql;
    await db.adminSql.unsafe(migrationSql);
    await db.adminSql.unsafe(migrationSql); // additive migration remains replayable
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); });

  const fresh = () => `pool-${randomUUID()}`;
  function observation(overrides: Partial<HostedPoolObservation> = {}): HostedPoolObservation {
    return {
      generation: 1, desiredRevision: 1, controllerFence: 7, scope, zone: 'us-central1-a', architecture: 'x86_64',
      runtimeBundleSha256: release.bundleSha256, size: { cpuCount: 4, memoryMiB: 8192 },
      observedAtMs: Date.now() - 100, cleanAttestationRef: 'provider:verified-empty-generation-1', ...overrides,
    };
  }
  async function host(ws: string, id: string, options: { placeholder?: boolean; observation?: HostedPoolObservation; state?: string } = {}) {
    await db.adminSql`
      INSERT INTO harness_shared.workspace_host_connections
        (workspace_id, id, target, label, credential_ref, status)
      VALUES (${ws}, 'pool-connection', 'gcp', 'pool integration', 'test://no-provider-calls', 'connected')
      ON CONFLICT DO NOTHING`;
    const o = options.placeholder ? null : options.observation ?? observation();
    await db.adminSql`
      INSERT INTO harness_shared.workspace_hosts
        (workspace_id, id, name, connection_id, target, scope_label, region, size, image,
         disk_gib, network, desired_state, observed_state, desired_spec, host_generation,
         controller_id, controller_fence, runtime_release, pool_observation, health_status, health_attested_at,
         desired_revision, observed_revision)
      VALUES (${ws}, ${id}, ${id}, 'pool-connection', 'gcp', 'pool-project', 'us-central1',
        'test-4', 'test-image', 256, 'default', 'running', ${options.placeholder ? 'provisioning' : options.state ?? 'running'},
        ${JSON.stringify({ scope, zone: 'us-central1-a' })}::jsonb, 1, 'controller-a', 7,
        ${JSON.stringify(release)}::jsonb, ${o ? JSON.stringify(o) : null}::jsonb,
        ${options.placeholder ? null : 'healthy'}, now(), 1, 1)`;
  }
  async function customer(ws: string, id: string, hostId = `${id}-placeholder`) {
    await host(ws, hostId, { placeholder: true });
    await db.adminSql`
      INSERT INTO harness_shared.customer_workspaces
        (workspace_id, id, organization_id, workspace_host_id, display_name, state,
         created_by_principal_kind, created_by_principal_id, billing_owner_kind, billing_owner_id,
         tenant_concurrency_limit, provider_concurrency_limit, monthly_lifecycle_budget_cents)
      VALUES (${ws}, ${id}, ${`org-${id}`}, ${hostId}, ${id}, 'active', 'user', 'test-user',
        'organization', ${`org-${id}`}, 1, 8, 10000)`;
    return hostId;
  }
  function input(ws: string, customerId: string, hostId = `${customerId}-placeholder`): AdmitHostedLifecycleJobInput {
    return {
      workspaceId: ws, customerWorkspaceId: customerId, hostId, providerTarget: 'gcp', action: 'start',
      actorId: 'test-user', operationId: `op-${customerId}`, riskTier: 'moderate', approvalStatus: 'not-required',
      estimate: { cents: 100, currency: 'USD', source: 'test-catalog', evidenceRef: 'test://catalog', estimatedAt: new Date().toISOString() },
      pool: {
        scope, region: 'us-central1', zone: 'us-central1-a', architecture: 'x86_64',
        runtimeBundleSha256: release.bundleSha256, dataVolumeId: `volume-${customerId}`,
        minimum: { cpuCount: 2, memoryMiB: 4096 }, maxObservationAgeMs: 60_000,
      },
    };
  }
  async function operations(ws: string) {
    return db.adminSql`SELECT id, host_id, admission_receipt FROM harness_shared.workspace_host_operations WHERE workspace_id = ${ws}`;
  }

  it('reads the durable tenant from the exact persisted host binding under workspace RLS', async () => {
    const ws = fresh();
    const foreignWs = fresh();
    await customer(ws, 'customer-1', 'same-host-name');
    await customer(foreignWs, 'customer-2', 'same-host-name');
    await expect(readWorkspaceHostDestroyTarget(ws, 'same-host-name')).resolves.toMatchObject({
      id: 'same-host-name', hostedCustomerWorkspaceId: 'customer-1',
    });
    await expect(readWorkspaceHostDestroyTarget(foreignWs, 'same-host-name')).resolves.toMatchObject({
      id: 'same-host-name', hostedCustomerWorkspaceId: 'customer-2',
    });
  });

  it('reserves and binds once on concurrent duplicate wake, even with tenant cap one', async () => {
    const ws = fresh();
    await customer(ws, 'a');
    await host(ws, 'warm');
    const request = input(ws, 'a');
    const results = await Promise.all([admitHostedLifecycleJob(request), admitHostedLifecycleJob(request)]);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ hostId: 'warm', placement: expect.objectContaining({ kind: 'assign-warm' }) })]));
    expect(await operations(ws)).toHaveLength(1);
    const [bound] = await db.adminSql`SELECT workspace_host_id FROM harness_shared.customer_workspaces WHERE workspace_id = ${ws} AND id = 'a'`;
    expect(bound.workspace_host_id).toBe('warm');
  });

  it('reserves a fresh provision on its placeholder and replays before quota checks', async () => {
    const ws = fresh();
    const hostId = await customer(ws, 'new');
    const request = { ...input(ws, 'new'), action: 'provision' as const };
    const receipt = await admitHostedLifecycleJob(request);
    expect(receipt).toMatchObject({ created: true, hostId, placement: { kind: 'provision' } });
    expect(await admitHostedLifecycleJob(request)).toEqual({ ...receipt, created: false });
    expect(await operations(ws)).toHaveLength(1);
    await expect(admitHostedLifecycleJob({ ...request, operationId: 'second-provision' }))
      .rejects.toThrow('tenant concurrency limit reached');
  });

  it('lets exactly one of two customers reserve the last warm VM', async () => {
    const ws = fresh();
    await customer(ws, 'a');
    await customer(ws, 'b');
    await host(ws, 'warm');
    const results = await Promise.allSettled([admitHostedLifecycleJob(input(ws, 'a')), admitHostedLifecycleJob(input(ws, 'b'))]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(HostedLifecyclePlacementError);
    expect(refused.reason.placement.kind).toBe('queue');
    expect(await operations(ws)).toHaveLength(1);
  });

  it('hands the same admission row to its fenced controller without losing the receipt or charging twice', async () => {
    const ws = fresh();
    await customer(ws, 'handoff');
    await host(ws, 'warm');
    const request = { ...input(ws, 'handoff'), action: 'provision' as const,
      request: { hostId: 'warm', action: 'start' } };
    const receipt = await admitHostedLifecycleJob(request);
    expect(receipt).toMatchObject({ action: 'start', hostId: 'warm' });
    const controller = {
      workspaceId: ws, operationId: receipt.operationId, hostId: receipt.hostId,
      action: 'start' as const, status: 'running' as const, desiredRevision: 2,
      request: { sourceHostId: 'warm', plan: { id: 'controller-resolved-plan' } },
      controllerAuthority: { controllerId: 'controller-a', fence: 7 },
      hostedAdmission: { customerWorkspaceId: 'handoff', actorId: request.actorId, request: request.request },
    };
    await expect(beginWorkspaceHostOperation({ ...controller,
      hostedAdmission: { ...controller.hostedAdmission, actorId: 'other-user' } })).rejects.toThrow('different');
    await beginWorkspaceHostOperation(controller);
    await beginWorkspaceHostOperation(controller);
    const [row] = await db.adminSql`SELECT status, controller_id, admission_receipt, estimated_cost_cents FROM harness_shared.workspace_host_operations WHERE workspace_id = ${ws} AND id = ${receipt.operationId}`;
    expect(row).toMatchObject({ status: 'running', controller_id: 'controller-a', estimated_cost_cents: 100 });
    expect(row.admission_receipt.result).toEqual(receipt);
    expect(await operations(ws)).toHaveLength(1);
    expect(await admitHostedLifecycleJob(request)).toEqual({ ...receipt, created: false });
  });

  it.each(['succeeded', 'failed'])('never reassigns a previously admitted VM after its binding moves (%s)', async status => {
    const ws = fresh();
    await customer(ws, 'previous');
    await customer(ws, 'next');
    await host(ws, 'warm');
    await admitHostedLifecycleJob(input(ws, 'previous'));
    await db.adminSql`
      UPDATE harness_shared.workspace_host_operations SET status = ${status}, customer_workspace_id = NULL
       WHERE workspace_id = ${ws} AND id = 'op-previous'`;
    // Replacement moves the directory pointer; the old VM may still carry the
    // previous tenant's IAM/credentials/routes even with no registered data disk.
    await db.adminSql`
      UPDATE harness_shared.customer_workspaces SET workspace_host_id = 'previous-placeholder'
       WHERE workspace_id = ${ws} AND id = 'previous'`;
    const [unchangedHost] = await db.adminSql`
      SELECT host_generation, controller_fence, pool_observation->>'cleanAttestationRef' AS clean_ref
        FROM harness_shared.workspace_hosts WHERE workspace_id = ${ws} AND id = 'warm'`;
    expect(unchangedHost).toMatchObject({ host_generation: 1, controller_fence: 7,
      clean_ref: 'provider:verified-empty-generation-1' });
    await expect(admitHostedLifecycleJob(input(ws, 'next'))).rejects.toMatchObject({
      placement: { kind: 'queue', rejected: expect.arrayContaining([
        expect.objectContaining({ hostId: 'warm', reasons: expect.arrayContaining(['unclean']) }),
      ]) },
    });
    expect(await operations(ws)).toHaveLength(1);
    const [next] = await db.adminSql`
      SELECT workspace_host_id FROM harness_shared.customer_workspaces WHERE workspace_id = ${ws} AND id = 'next'`;
    expect(next.workspace_host_id).toBe('next-placeholder');
  });

  it.each(['initialize', 'restore', 'upgrade', 'repair'])('does not treat an unbound %s guest as clean warm capacity', async action => {
    const ws = fresh();
    await customer(ws, 'next');
    await host(ws, 'used');
    await db.adminSql`
      INSERT INTO harness_shared.workspace_host_operations (workspace_id, id, host_id, action, status)
      VALUES (${ws}, 'old-guest-operation', 'used', ${action}, 'failed')`;
    await expect(admitHostedLifecycleJob(input(ws, 'next'))).rejects.toMatchObject({
      placement: { kind: 'queue', rejected: expect.arrayContaining([
        expect.objectContaining({ hostId: 'used', reasons: expect.arrayContaining(['unclean']) }),
      ]) },
    });
    expect(await operations(ws)).toHaveLength(1);
  });

  it('still assigns a clean never-assigned VM with only its fresh provision operation', async () => {
    const ws = fresh();
    await customer(ws, 'next');
    await host(ws, 'fresh-warm');
    await db.adminSql`
      INSERT INTO harness_shared.workspace_host_operations (workspace_id, id, host_id, action, status)
      VALUES (${ws}, 'fresh-provision', 'fresh-warm', 'provision', 'succeeded')`;
    await expect(admitHostedLifecycleJob(input(ws, 'next'))).resolves.toMatchObject({
      placement: { kind: 'assign-warm', hostId: 'fresh-warm' },
    });
  });

  it.each(['generation', 'desired-revision'])('refuses controller handoff after the reserved host %s changes', async kind => {
    const ws = fresh();
    await customer(ws, 'stale');
    await host(ws, 'warm');
    const request = { ...input(ws, 'stale'), request: { hostId: 'warm', action: 'start' } };
    const receipt = await admitHostedLifecycleJob(request);
    if (kind === 'generation') await db.adminSql`UPDATE harness_shared.workspace_hosts SET host_generation = 2 WHERE workspace_id = ${ws} AND id = 'warm'`;
    else await db.adminSql`UPDATE harness_shared.workspace_hosts SET desired_revision = 2 WHERE workspace_id = ${ws} AND id = 'warm'`;
    await expect(beginWorkspaceHostOperation({
      workspaceId: ws, operationId: receipt.operationId, hostId: receipt.hostId,
      action: 'start', status: 'running', desiredRevision: 2, request: { plan: 'resolved' },
      controllerAuthority: { controllerId: 'controller-a', fence: 7 },
      hostedAdmission: { customerWorkspaceId: 'stale', actorId: request.actorId, request: request.request },
    })).rejects.toThrow('stale');
    const [row] = await db.adminSql`SELECT status, controller_id FROM harness_shared.workspace_host_operations WHERE workspace_id = ${ws} AND id = ${receipt.operationId}`;
    expect(row).toEqual({ status: 'queued', controller_id: null });
  });

  it('completes a running customer VM reuse without acquiring a provider controller, and refuses stale replay', async () => {
    const ws = fresh();
    await customer(ws, 'reuse', 'owned');
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET observed_state = 'running', pool_observation = ${JSON.stringify(observation())}::jsonb, health_status = 'healthy', health_attested_at = now() WHERE workspace_id = ${ws} AND id = 'owned'`;
    await db.adminSql`INSERT INTO harness_shared.workspace_host_operations (workspace_id, id, host_id, action, status) VALUES (${ws}, 'prior', 'owned', 'provision', 'succeeded')`;
    await db.adminSql`INSERT INTO harness_shared.workspace_host_resources (workspace_id, host_id, logical_key, operation_id, state, kind, provider_id) VALUES (${ws}, 'owned', 'create-data-disk', 'prior', 'applied', 'disk', 'volume-reuse')`;
    const receipt = await admitHostedLifecycleJob(input(ws, 'reuse', 'owned'));
    expect(receipt).toMatchObject({ placement: { kind: 'reuse' }, hostDesiredRevision: 1 });
    await completeHostedPoolReuse(ws, receipt);
    await completeHostedPoolReuse(ws, receipt);
    const [row] = await db.adminSql`SELECT status, controller_id FROM harness_shared.workspace_host_operations WHERE workspace_id = ${ws} AND id = ${receipt.operationId}`;
    expect(row).toEqual({ status: 'succeeded', controller_id: null });
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET desired_revision = 2, observed_revision = 2 WHERE workspace_id = ${ws} AND id = 'owned'`;
    await expect(completeHostedPoolReuse(ws, receipt)).rejects.toThrow('fenced_or_stale');
  });

  it('rejects a changed input reusing an operation id without charging or rebinding', async () => {
    const ws = fresh();
    await customer(ws, 'a');
    await host(ws, 'warm');
    const request = input(ws, 'a');
    await admitHostedLifecycleJob(request);
    await expect(admitHostedLifecycleJob({ ...request, actorId: 'different-actor' })).rejects.toThrow('hosted_lifecycle_operation_conflict');
    expect(await operations(ws)).toHaveLength(1);
  });

  it('reserves a volume for only one customer even when another warm VM remains', async () => {
    const ws = fresh();
    await customer(ws, 'a');
    await customer(ws, 'b');
    await host(ws, 'warm-1');
    await host(ws, 'warm-2');
    const first = input(ws, 'a');
    const second = input(ws, 'b');
    second.pool!.dataVolumeId = first.pool!.dataVolumeId;
    const results = await Promise.allSettled([admitHostedLifecycleJob(first), admitHostedLifecycleJob(second)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await operations(ws)).toHaveLength(1);
  });

  it('fails budget admission before changing a tenant binding or reserving a VM', async () => {
    const ws = fresh();
    await customer(ws, 'a');
    await host(ws, 'warm');
    const request = input(ws, 'a');
    request.estimate.cents = 10001;
    await expect(admitHostedLifecycleJob(request)).rejects.toThrow('admission rejected');
    expect(await operations(ws)).toHaveLength(0);
    const [bound] = await db.adminSql`SELECT workspace_host_id FROM harness_shared.customer_workspaces WHERE workspace_id = ${ws} AND id = 'a'`;
    expect(bound.workspace_host_id).toBe('a-placeholder');
  });

  it('cannot reuse capacity observed before a desired-revision change', async () => {
    const ws = fresh();
    await customer(ws, 'a');
    await host(ws, 'warm');
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET desired_revision = 2 WHERE workspace_id = ${ws} AND id = 'warm'`;
    await expect(admitHostedLifecycleJob(input(ws, 'a'))).rejects.toBeInstanceOf(HostedLifecyclePlacementError);
    await expect(recordHostedPoolObservation({ workspaceId: ws, hostId: 'warm', controllerId: 'controller-a', observation: observation({ desiredRevision: 2 }) })).rejects.toThrow('fenced_or_stale');
    expect(await operations(ws)).toHaveLength(0);
  });

  it('queues an unhealthy existing data owner instead of routing around it to a warm VM', async () => {
    const ws = fresh();
    await customer(ws, 'a', 'owned');
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET observed_state = 'running', pool_observation = ${JSON.stringify(observation())}::jsonb, health_status = 'degraded', health_attested_at = now() WHERE workspace_id = ${ws} AND id = 'owned'`;
    await db.adminSql`INSERT INTO harness_shared.workspace_host_operations (workspace_id, id, host_id, action, status) VALUES (${ws}, 'prior', 'owned', 'provision', 'succeeded')`;
    await db.adminSql`INSERT INTO harness_shared.workspace_host_resources (workspace_id, host_id, logical_key, operation_id, state, kind, provider_id) VALUES (${ws}, 'owned', 'create-data-disk', 'prior', 'applied', 'disk', 'volume-a')`;
    await host(ws, 'warm');
    try { await admitHostedLifecycleJob(input(ws, 'a', 'owned')); throw new Error('unexpected admission'); }
    catch (error) {
      expect(error).toBeInstanceOf(HostedLifecyclePlacementError);
      expect((error as InstanceType<typeof HostedLifecyclePlacementError>).placement).toMatchObject({ kind: 'queue', reason: 'existing-tenant-needs-reconciliation' });
    }
    expect((await operations(ws)).map((row) => row.id)).toEqual(['prior']);
  });

  it('does not reserve a host from another RLS workspace', async () => {
    const ws = fresh();
    const foreign = fresh();
    await customer(ws, 'a');
    await host(foreign, 'warm');
    await expect(admitHostedLifecycleJob(input(ws, 'a'))).rejects.toBeInstanceOf(HostedLifecyclePlacementError);
    expect(await operations(ws)).toHaveLength(0);
    const visible = await db.appSql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      return tx`SELECT id FROM harness_shared.workspace_hosts WHERE workspace_id = ${foreign}`;
    });
    expect(visible).toHaveLength(0);
  });

  it('keeps pool evidence controller-only and preserves same-control-plane tenant RLS', async () => {
    const ws = fresh();
    await customer(ws, 'a');
    await customer(ws, 'b');
    await host(ws, 'warm');
    await host(ws, 'unassigned');
    await admitHostedLifecycleJob(input(ws, 'a'));
    const asCustomer = <T>(run: (tx: any) => Promise<T>) => db.adminSql.begin(async (tx: any) => {
      await tx`SET LOCAL ROLE hosted_app`;
      await tx`SELECT set_config('app.organization_id', 'org-a', true), set_config('app.workspace_id', 'a', true)`;
      return run(tx);
    });
    const visible = await asCustomer((tx) => tx`SELECT id FROM harness_shared.workspace_hosts WHERE workspace_id = ${ws} ORDER BY id`) as Array<{ id: string }>;
    // Stable-id tie breaking chooses 'unassigned'; the customer sees only that binding.
    expect(visible.map((row) => row.id)).toEqual(['unassigned']);
    await expect(asCustomer((tx) => tx`UPDATE harness_shared.workspace_hosts SET pool_observation = '{}'::jsonb WHERE workspace_id = ${ws} AND id = 'unassigned'`)).rejects.toThrow('controller_evidence_required');
    await expect(asCustomer((tx) => tx`UPDATE harness_shared.workspace_host_operations SET admission_receipt = '{}'::jsonb WHERE workspace_id = ${ws} AND id = 'op-a'`)).rejects.toThrow('controller_evidence_required');
    const foreign = await asCustomer((tx) => tx`UPDATE harness_shared.workspace_hosts SET pool_observation = '{}'::jsonb WHERE workspace_id = ${ws} AND id = 'b-placeholder' RETURNING id`);
    expect(foreign).toEqual([]);
    await expect(db.adminSql`UPDATE harness_shared.workspace_host_operations SET admission_receipt = '{}'::jsonb WHERE workspace_id = ${ws} AND id = 'op-a'`).rejects.toThrow('receipt_immutable');
  });

  it('fences stale controller observations and accepts only a newer matching observation', async () => {
    const ws = fresh();
    await host(ws, 'warm');
    const o = observation({ observedAtMs: Date.now() - 10 });
    await recordHostedPoolObservation({ workspaceId: ws, hostId: 'warm', controllerId: 'controller-a', observation: o });
    await expect(recordHostedPoolObservation({ workspaceId: ws, hostId: 'warm', controllerId: 'controller-a', observation: o })).rejects.toThrow('fenced_or_stale');
    await expect(recordHostedPoolObservation({ workspaceId: ws, hostId: 'warm', controllerId: 'old-controller', observation: { ...o, observedAtMs: Date.now() } })).rejects.toThrow('fenced_or_stale');
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET controller_fence = 8 WHERE workspace_id = ${ws} AND id = 'warm'`;
    await customer(ws, 'a');
    await expect(admitHostedLifecycleJob(input(ws, 'a'))).rejects.toBeInstanceOf(HostedLifecyclePlacementError);
    expect(await operations(ws)).toHaveLength(0);
  });
});
