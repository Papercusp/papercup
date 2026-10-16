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
const { writeHostedEntitlementAuthority } = await import('../auth/hosted-entitlement-store');
const { admitHostedLifecycleJob, HostedLifecyclePlacementError, recordHostedPoolObservation, completeHostedPoolReuse } =
  await import('./hosted-lifecycle-store');
const { beginWorkspaceHostOperation, readWorkspaceHostDestroyTarget, upsertWorkspaceHostResourceCheckpoint,
  readWorkspaceHostResourceCheckpoints } = await import('./observability-store');

const migration = fileURLToPath(new URL('../../../../libs/papercusp/libs/db/sql/1522-workspace-host-pool-admission.sql', import.meta.url));
const migrationSql = readFileSync(existsSync(migration) ? migration : `${migration}.DRAFT`, 'utf8');
const incarnationMigration = fileURLToPath(new URL('../../../../libs/papercusp/libs/db/sql/1523-workspace-host-resource-incarnation.sql', import.meta.url));
const incarnationSql = readFileSync(existsSync(incarnationMigration) ? incarnationMigration : `${incarnationMigration}.DRAFT`, 'utf8');
const authorityMigration = fileURLToPath(new URL('../../../../libs/papercusp/libs/db/sql/1524-hosted-entitlement-authority.sql', import.meta.url));
const authoritySql = readFileSync(authorityMigration, 'utf8');
const scope = { kind: 'project', id: 'pool-project' };
const release = {
  version: 'pool-v1', bundleSha256: 'a'.repeat(64), signingKeySha256: 'b'.repeat(64),
  protocolVersion: 'workspace-host-bootstrap-v1', schemaVersion: '1522',
};

describe('hosted pool admission (real Postgres + workspace RLS)', () => {
  let db: OrgTestDb;
  const organizations = new Map<string, string>();
  const grants = new Map<string, { userId: string; revision: number }>();
  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.appSql;
    await db.adminSql.unsafe(migrationSql);
    await db.adminSql.unsafe(migrationSql); // additive migration remains replayable
    await db.adminSql.unsafe(incarnationSql);
    await db.adminSql.unsafe(incarnationSql); // allocation identity migration is replayable too
    await db.adminSql.unsafe(authoritySql);
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); });

  const fresh = () => `pool-${randomUUID()}`;
  const organization = (ws: string, id: string) => organizations.get(`${ws}:${id}`)!;
  async function allowance(organizationId: string, quotas: Record<string, number> = {}, budget = 1000000,
    effectiveUntil = '2099-01-01T00:00:00Z') {
    let g = grants.get(organizationId);
    if (!g) {
      g = { userId: randomUUID(), revision: 0 };
      await db.adminSql`INSERT INTO papercusp_auth.hosted_entitlements (organization_id, user_id, kind, source)
        VALUES (${organizationId}::uuid, ${g.userId}::uuid, 'hosted-free', 'self_signup')`;
      grants.set(organizationId, g);
    }
    const record = { source: 'migration', actor: { kind: 'service', principalId: 'service:pool-fixture' },
      auditReceiptId: 'audit:pool-fixture-bundle', effectiveFrom: '2026-01-01T00:00:00Z', effectiveUntil };
    g.revision = await writeHostedEntitlementAuthority({ organizationId, userId: g.userId, kind: 'hosted-free',
      expectedRevision: g.revision, authority: { schemaVersion: 1,
        bundles: [{ schemaVersion: 1, bundleId: 'pool-fixture', bundleVersion: 1, record,
          entitlements: { allowedProviders: ['gcp'], limits: { workspaces: 100, members: 100 },
            browserAccess: { pty: true, files: true }, supportTier: 'trial', rolloutFlags: {},
            quotas: { 'pool.hosts': 100, 'pool.cpu-millicores': 1000000, 'pool.memory-mib': 1000000, ...quotas },
            budgets: { 'pool.cost.usd.minor': budget } } }],
        assignments: [{ schemaVersion: 1, assignmentId: `fixture:${organizationId}`, organizationId,
          bundleId: 'pool-fixture', bundleVersion: 1,
          record: { ...record, auditReceiptId: 'audit:pool-fixture-assignment' } }], overrides: [] } },
    run => db.appSql.begin(async tx => {
      await tx.unsafe('SET LOCAL ROLE hosted_service');
      return run(tx as any);
    }) as any);
  }
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
  async function customer(ws: string, id: string, hostId = `${id}-placeholder`, organizationId = randomUUID()) {
    organizations.set(`${ws}:${id}`, organizationId);
    if (!grants.has(organizationId)) await allowance(organizationId);
    await host(ws, hostId, { placeholder: true });
    await db.adminSql`
      INSERT INTO harness_shared.customer_workspaces
        (workspace_id, id, organization_id, workspace_host_id, display_name, state,
         created_by_principal_kind, created_by_principal_id, billing_owner_kind, billing_owner_id,
         tenant_concurrency_limit, provider_concurrency_limit, monthly_lifecycle_budget_cents)
      VALUES (${ws}, ${id}, ${organizationId}, ${hostId}, ${id}, 'active', 'user', 'test-user',
        'organization', ${organizationId}, 1, 8, 10000)`;
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

  it('refuses missing or revoked authority before rebinding a warm VM and replays an existing receipt after revocation', async () => {
    const ws = fresh();
    await customer(ws, 'authority');
    await host(ws, 'warm');
    const org = organization(ws, 'authority');
    const request = input(ws, 'authority');
    const receipt = await admitHostedLifecycleJob(request);
    expect(receipt.resourceAdmission).toMatchObject({ authorityRevision: 1, bundleId: 'pool-fixture',
      requested: { hosts: 1, cpuMillicores: 4000, memoryMiB: 8192 },
      auditReceiptIds: ['audit:pool-fixture-bundle', 'audit:pool-fixture-assignment'] });
    await db.adminSql`UPDATE papercusp_auth.hosted_entitlements SET authority = NULL,
      authority_revision = authority_revision + 1 WHERE organization_id = ${org}::uuid`;
    expect(await admitHostedLifecycleJob(request)).toEqual({ ...receipt, created: false });
    await customer(ws, 'missing');
    await host(ws, 'warm-2');
    await db.adminSql`UPDATE papercusp_auth.hosted_entitlements SET authority = NULL,
      authority_revision = authority_revision + 1 WHERE organization_id = ${organization(ws, 'missing')}::uuid`;
    await expect(admitHostedLifecycleJob(input(ws, 'missing'))).rejects.toThrow('entitlement_authority_missing');
    const [bound] = await db.adminSql`SELECT workspace_host_id FROM harness_shared.customer_workspaces
      WHERE workspace_id = ${ws} AND id = 'missing'`;
    expect(bound.workspace_host_id).toBe('missing-placeholder');
    expect(await operations(ws)).toHaveLength(1);
  });

  it('counts actual selected VM size rather than its lower requested minimum and rolls back on quota rejection', async () => {
    const ws = fresh();
    await customer(ws, 'larger');
    await host(ws, 'warm');
    await allowance(organization(ws, 'larger'), { 'pool.cpu-millicores': 2000 });
    await expect(admitHostedLifecycleJob(input(ws, 'larger'))).rejects.toThrow('quota_exceeded:pool.cpu-millicores');
    expect(await operations(ws)).toHaveLength(0);
    const [bound] = await db.adminSql`SELECT workspace_host_id FROM harness_shared.customer_workspaces
      WHERE workspace_id = ${ws} AND id = 'larger'`;
    expect(bound.workspace_host_id).toBe('larger-placeholder');
  });

  it('refuses authority that expires while pooled admission waits for the organization lock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T08:00:00Z'));
    let admission!: Promise<{ error?: unknown }>;
    const ws = fresh();
    try {
      await customer(ws, 'expiry');
      await host(ws, 'warm');
      const org = organization(ws, 'expiry');
      await allowance(org, {}, 1000000, '2026-10-16T08:00:01Z');
      await db.adminSql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`hosted-entitlement:organization:${org}`}, 0))`;
        const [{ pid }] = await tx`SELECT pg_backend_pid() AS pid`;
        admission = admitHostedLifecycleJob(input(ws, 'expiry')).then(() => ({}), error => ({ error }));
        await expect.poll(async () => {
          const [row] = await db.adminSql`SELECT EXISTS (
            SELECT 1 FROM pg_locks waiting JOIN pg_locks held
              ON held.locktype = waiting.locktype AND held.classid = waiting.classid AND held.objid = waiting.objid
             WHERE held.pid = ${pid} AND held.granted AND NOT waiting.granted) AS blocked`;
          return row.blocked;
        }).toBe(true);
        vi.setSystemTime(new Date('2026-10-16T08:00:01Z'));
      });
      expect((await admission).error).toBeInstanceOf(Error);
      expect(String((await admission).error)).toContain('hosted_pool_entitlement_no_active_assignment');
      expect(await operations(ws)).toHaveLength(0);
      const [bound] = await db.adminSql`SELECT workspace_host_id FROM harness_shared.customer_workspaces
        WHERE workspace_id = ${ws} AND id = 'expiry'`;
      expect(bound.workspace_host_id).toBe('expiry-placeholder');
    } finally {
      await admission;
      vi.useRealTimers();
    }
  });

  it('counts pending capacity across a deleted directory and its replacement before either VM exists', async () => {
    const ws = fresh();
    const org = randomUUID();
    await customer(ws, 'one', undefined, org);
    await allowance(org, { 'pool.hosts': 1 });
    await admitHostedLifecycleJob({ ...input(ws, 'one'), action: 'provision' });
    await db.adminSql`UPDATE harness_shared.customer_workspaces SET state = 'deleted', deleted_at = now() WHERE workspace_id = ${ws} AND id = 'one'`;
    await customer(ws, 'two', undefined, org);
    await expect(admitHostedLifecycleJob({ ...input(ws, 'two'), action: 'provision' }))
      .rejects.toThrow('quota_exceeded:pool.hosts');
    expect(await operations(ws)).toHaveLength(1);
  });

  it('applies changed authority and organization-wide committed budgets without deleting retained work', async () => {
    const ws = fresh();
    const org = randomUUID();
    await customer(ws, 'one', undefined, org);
    await allowance(org, {}, 150);
    await admitHostedLifecycleJob({ ...input(ws, 'one'), action: 'provision' });
    await db.adminSql`UPDATE harness_shared.customer_workspaces SET state = 'deleted', deleted_at = now() WHERE workspace_id = ${ws} AND id = 'one'`;
    await customer(ws, 'two', undefined, org);
    await expect(admitHostedLifecycleJob({ ...input(ws, 'two'), action: 'provision' })).rejects.toThrow('budget_exceeded');
    await allowance(org, {}, 1000);
    const admitted = await admitHostedLifecycleJob({ ...input(ws, 'two'), action: 'provision' });
    expect(admitted.resourceAdmission).toMatchObject({ authorityRevision: 3,
      pending: { hosts: 1, cpuMillicores: 2000, memoryMiB: 4096 },
      budget: { committedMinor: 100, requestedMinor: 100 } });
    expect(await operations(ws)).toHaveLength(2);
    expect(await db.adminSql`SELECT id FROM harness_shared.customer_workspaces WHERE workspace_id = ${ws}`).toHaveLength(2);
  });

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

  it('round-trips provider allocation identity through durable checkpoints and a later operation target read', async () => {
    const ws = fresh();
    await customer(ws, 'allocation', 'owned');
    await db.adminSql`INSERT INTO harness_shared.workspace_host_operations (workspace_id, id, host_id, action, status)
      VALUES (${ws}, 'allocation-operation', 'owned', 'provision', 'running')`;
    const resource = { target: 'gcp', kind: 'disk', providerId: 'reusable-name', parentProviderId: 'pool-project',
      zone: 'us-central1-a', incarnationId: '1234567890123456789' };
    const checkpoint = { logicalKey: 'create-data-disk', state: 'applied' as const, attempts: 1, providerResource: resource };
    await upsertWorkspaceHostResourceCheckpoint({ workspaceId: ws, hostId: 'owned', operationId: 'allocation-operation', checkpoint });
    expect((await readWorkspaceHostResourceCheckpoints(ws, 'owned', 'allocation-operation'))[0]?.providerResource).toEqual(resource);
    expect((await readWorkspaceHostDestroyTarget(ws, 'owned'))?.resources[0]?.resource).toEqual(resource);
    // A changed allocation replaces the old identity; missing identity remains unknown.
    await upsertWorkspaceHostResourceCheckpoint({ workspaceId: ws, hostId: 'owned', operationId: 'allocation-operation',
      checkpoint: { ...checkpoint, providerResource: { ...resource, incarnationId: '9876543210' } } });
    expect((await readWorkspaceHostDestroyTarget(ws, 'owned'))?.resources[0]?.resource.incarnationId).toBe('9876543210');
    const { incarnationId: _removed, ...unknownAllocation } = resource;
    await upsertWorkspaceHostResourceCheckpoint({ workspaceId: ws, hostId: 'owned', operationId: 'allocation-operation',
      checkpoint: { ...checkpoint, providerResource: unknownAllocation } });
    expect((await readWorkspaceHostResourceCheckpoints(ws, 'owned', 'allocation-operation'))[0]?.providerResource).not.toHaveProperty('incarnationId');
    expect((await readWorkspaceHostDestroyTarget(ws, 'owned'))?.resources[0]?.resource).not.toHaveProperty('incarnationId');
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

  async function stoppedOwner(ws: string, customerId = 'sleeper', hostId = 'owned', organizationId = randomUUID()) {
    const priorId = customerId === 'sleeper' ? 'prior' : `prior-${customerId}`;
    const volumeId = `volume-${customerId}`;
    await customer(ws, customerId, hostId, organizationId);
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET desired_state = 'stopped', observed_state = 'stopped',
      pool_observation = ${JSON.stringify(observation())}::jsonb, health_status = NULL, health_attested_at = NULL
      WHERE workspace_id = ${ws} AND id = ${hostId}`;
    await db.adminSql`INSERT INTO harness_shared.workspace_host_operations (workspace_id, id, host_id, action, status)
      VALUES (${ws}, ${priorId}, ${hostId}, 'provision', 'succeeded')`;
    await db.adminSql`INSERT INTO harness_shared.workspace_host_resources
      (workspace_id, host_id, logical_key, operation_id, state, kind, provider_id)
      VALUES (${ws}, ${hostId}, 'create-data-disk', ${priorId}, 'applied', 'disk', ${volumeId})`;
    return observation({ observedAtMs: Date.now(), cleanAttestationRef: null,
      stoppedOwner: { customerWorkspaceId: customerId, dataVolumeId: volumeId } });
  }

  it.each(['pool.cpu-millicores', 'pool.memory-mib'] as const)(
    'reserves %s for a pending stopped-owner start across directory replacement', async quota => {
      const ws = fresh();
      const org = randomUUID();
      const proof = await stoppedOwner(ws, 'sleeper', 'owned', org);
      await recordHostedPoolObservation({ workspaceId: ws, hostId: 'owned', controllerId: 'controller-a', observation: proof });
      await allowance(org, { [quota]: quota === 'pool.cpu-millicores' ? 4000 : 8192 });
      const wake = await admitHostedLifecycleJob(input(ws, 'sleeper', 'owned'));
      expect(wake.resourceAdmission).toMatchObject({
        allocated: { hosts: 1, cpuMillicores: 0, memoryMiB: 0 },
        requested: { hosts: 0, cpuMillicores: 4000, memoryMiB: 8192 },
      });
      await db.adminSql`UPDATE harness_shared.customer_workspaces SET state = 'deleted', deleted_at = now()
        WHERE workspace_id = ${ws} AND id = 'sleeper'`;
      await customer(ws, 'replacement', undefined, org);
      await expect(admitHostedLifecycleJob({ ...input(ws, 'replacement'), action: 'provision' }))
        .rejects.toThrow(`quota_exceeded:${quota}`);
      expect((await operations(ws)).filter(row => row.id.startsWith('op-'))).toHaveLength(1);
    });

  it('moves a stopped-owner start from pending to allocated compute without double charging', async () => {
    const ws = fresh();
    const org = randomUUID();
    const proof = await stoppedOwner(ws, 'sleeper', 'owned', org);
    await recordHostedPoolObservation({ workspaceId: ws, hostId: 'owned', controllerId: 'controller-a', observation: proof });
    await allowance(org, { 'pool.cpu-millicores': 6000, 'pool.memory-mib': 12288 });
    await admitHostedLifecycleJob(input(ws, 'sleeper', 'owned'));
    await db.adminSql`UPDATE harness_shared.customer_workspaces SET state = 'deleted', deleted_at = now()
      WHERE workspace_id = ${ws} AND id = 'sleeper'`;
    await customer(ws, 'replacement', undefined, org);
    const replacement = { ...input(ws, 'replacement'), action: 'provision' as const };
    const receipt = await admitHostedLifecycleJob(replacement);
    expect(receipt.resourceAdmission).toMatchObject({
      allocated: { hosts: 1, cpuMillicores: 0, memoryMiB: 0 },
      pending: { hosts: 0, cpuMillicores: 4000, memoryMiB: 8192 },
    });
    // Release the second reservation, then observe the first actual VM starting.
    await db.adminSql`UPDATE harness_shared.workspace_host_operations SET status = 'failed'
      WHERE workspace_id = ${ws} AND id = ${receipt.operationId}`;
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET observed_state = 'running'
      WHERE workspace_id = ${ws} AND id = 'owned'`;
    const running = await admitHostedLifecycleJob({ ...replacement, operationId: 'replacement-after-running' });
    expect(running.resourceAdmission).toMatchObject({
      allocated: { hosts: 1, cpuMillicores: 4000, memoryMiB: 8192 },
      pending: { hosts: 0, cpuMillicores: 0, memoryMiB: 0 },
    });
  });

  it('queues a normally stopped owner until measured proof exists, then reserves exactly one same-data wake', async () => {
    const ws = fresh();
    const proof = await stoppedOwner(ws);
    await host(ws, 'spare');
    const request = input(ws, 'sleeper', 'owned');
    await expect(admitHostedLifecycleJob(request)).rejects.toBeInstanceOf(HostedLifecyclePlacementError);
    await recordHostedPoolObservation({ workspaceId: ws, hostId: 'owned', controllerId: 'controller-a', observation: proof });
    const results = await Promise.all([admitHostedLifecycleJob(request), admitHostedLifecycleJob(request)]);
    expect(results.map(value => value.created).sort()).toEqual([false, true]);
    expect(results[0]).toMatchObject({ hostId: 'owned', placement: { kind: 'start' } });
    expect((await operations(ws)).filter(value => value.id !== 'prior')).toHaveLength(1);
  });

  it.each(['unhealthy', 'foreign-customer', 'wrong-disk', 'running', 'new-fence', 'reserved'])(
    'rejects stopped proof after %s changes before record', async change => {
      const ws = fresh();
      const proof = await stoppedOwner(ws);
      if (change === 'unhealthy') await db.adminSql`UPDATE harness_shared.workspace_hosts SET health_status = 'degraded' WHERE workspace_id = ${ws}`;
      if (change === 'foreign-customer') proof.stoppedOwner!.customerWorkspaceId = 'foreign';
      if (change === 'wrong-disk') proof.stoppedOwner!.dataVolumeId = 'foreign-disk';
      if (change === 'running') await db.adminSql`UPDATE harness_shared.workspace_hosts SET desired_state = 'running', observed_state = 'running' WHERE workspace_id = ${ws}`;
      if (change === 'new-fence') await db.adminSql`UPDATE harness_shared.workspace_hosts SET controller_fence = 8 WHERE workspace_id = ${ws}`;
      if (change === 'reserved') await db.adminSql`INSERT INTO harness_shared.workspace_host_operations (workspace_id, id, host_id, action, status) VALUES (${ws}, 'competing', 'owned', 'start', 'queued')`;
      await expect(recordHostedPoolObservation({ workspaceId: ws, hostId: 'owned', controllerId: 'controller-a', observation: proof }))
        .rejects.toThrow('fenced_or_stale');
    });

  it('does not use stopped proof after its timestamp, disk, controller fence or observed state changes', async () => {
    for (const change of ['stale', 'disk', 'fence', 'running', 'unhealthy']) {
      const ws = fresh();
      const proof = await stoppedOwner(ws);
      await recordHostedPoolObservation({ workspaceId: ws, hostId: 'owned', controllerId: 'controller-a', observation: proof });
      if (change === 'stale') await db.adminSql`UPDATE harness_shared.workspace_hosts SET pool_observation = jsonb_set(pool_observation, '{observedAtMs}', '1'::jsonb) WHERE workspace_id = ${ws}`;
      if (change === 'disk') await db.adminSql`UPDATE harness_shared.workspace_host_resources SET provider_id = 'other' WHERE workspace_id = ${ws}`;
      if (change === 'fence') await db.adminSql`UPDATE harness_shared.workspace_hosts SET controller_fence = 8 WHERE workspace_id = ${ws}`;
      if (change === 'running') await db.adminSql`UPDATE harness_shared.workspace_hosts SET observed_state = 'running' WHERE workspace_id = ${ws}`;
      if (change === 'unhealthy') await db.adminSql`UPDATE harness_shared.workspace_hosts SET health_status = 'degraded' WHERE workspace_id = ${ws}`;
      await expect(admitHostedLifecycleJob(input(ws, 'sleeper', 'owned'))).rejects.toBeInstanceOf(HostedLifecyclePlacementError);
    }
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
      await tx`SELECT set_config('app.organization_id', ${organization(ws, 'a')}, true), set_config('app.workspace_id', 'a', true)`;
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
