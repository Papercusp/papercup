import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import postgres from 'postgres';
import { compileAgentSpecification, BlueprintSchema } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { projectBlueprintToPg } from './project-to-pg';
import { submitBlueprintOperation } from './operation-service';
import { supportToEngineeringOperation } from './support-workflow-operation';
import { currentBenchOpenAiInputContract } from '../external-bench/current-su';
import { defineHostedAllocation, readHostedAllocationReport, settleHostedAllocation } from '../auth/hosted/billing/allocation-store';
import { recordSupportWorkflowOutcome, reserveSupportOperationAttempt, supportOperationReservationId } from './support-workflow-budget';
import { createPersonalGrant } from '../personal-vault/store';
import { ORGANIZATION_CORPUS_SCOPE, mapProviderIdentity, replacePermissionListMembers,
  upsertOrganizationDocuments, upsertPermissionList } from '../data-sources/documents-corpus';

const connection = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: connection.sql }),
}));

const workspaceId = 'support-operation-test';
const harnessSlug = 'support-operation';
const role = 'support-worker';
let db: OrgTestDb;
let userId: string;
let documentId: string;
let listId: string;
let revision: string;
const selection = () => ({ supportCaseId: 'case-cobalt', approvedRevision: revision,
  documentIds: [documentId], query: 'cobalt roadmap', requestedAction: 'prepare-handoff' });
const submit = (requestKey: string, overrides: Record<string, unknown> = {},
  principal = { kind: 'user', trust: 'verified', slug: userId, workspaceId }) => submitBlueprintOperation(db.adminSql, {
    workspaceId, harnessSlug, callerId: `${userId}/employee`, operationId: 'support-to-engineering',
    requestKey, expectedSpecificationRevision: revision, input: selection(), ...overrides,
  }, { principal });

beforeAll(async () => {
  db = await createOrgTestDb();
  connection.sql = db.adminSql;
  const [user] = await db.adminSql<{ id: string }[]>`INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`support-employee-${crypto.randomUUID()}`}, 'Support employee') RETURNING id`;
  userId = user!.id;
  await db.adminSql`INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${workspaceId}, ${harnessSlug}, ${Buffer.from([0])}, 'support-test-key', 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING`;
  await createPersonalGrant(db.adminSql, { workspaceId, userId, principalType: 'agent-role', principalId: role,
    scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner' });
  const provider = { provider: 'slack', providerUserId: 'T1:EMPLOYEE' };
  await mapProviderIdentity(db.adminSql, workspaceId, { ...provider, userId, mappedBy: 'owner' });
  const list = await upsertPermissionList(db.adminSql, workspaceId, { source: 'slack', sourceRef: 'T1:CSUPPORT' });
  listId = list.id;
  await replacePermissionListMembers(db.adminSql, workspaceId, listId, [provider]);
  await upsertOrganizationDocuments(db.adminSql, workspaceId, listId, [{ source: 'slack', kind: 'message',
    dedupeKey: 'support-case-cobalt', externalId: 'T1:CSUPPORT:123', title: 'Cobalt support',
    text: 'The cobalt roadmap needs a reproducible engineering handoff.' }]);
  const [document] = await db.adminSql<{ id: string }[]>`SELECT id FROM harness_shared.documents
    WHERE workspace_id = ${workspaceId} AND dedupe_key = 'support-case-cobalt'`;
  documentId = document!.id;
  const operation = supportToEngineeringOperation({ id: 'support-to-engineering', version: '1', role,
    identity: { kind: 'identity', ref: 'support-worker', revision: '1', contentHash: 'b'.repeat(64) },
    accountableOwner: 'engineering-owner', reviewerPrincipals: ['engineering-reviewer'],
    allowedSources: ['slack'], allowedActions: ['prepare-handoff'], maximumCostMicros: 100_000,
    model: { mode: 'exact', models: ['gpt-6.1-sol'], effort: 'medium', onUnavailable: 'fail' },
    funding: { organization: { controlWorkspaceId: workspaceId, organizationId: 'synthetic-support-org' },
      allocationId: 'synthetic-support-project', month: '2026-10' },
    native: { model: 'gpt-6.1-sol', effort: 'medium', account: 'auto', payer: 'api-key',
      inputTokenCeiling: 1000, outputTokenCeiling: 100,
      inputTokenCeilingSourceSha256: currentBenchOpenAiInputContract('gpt-6.1-sol', 1000),
      // Synthetic frozen rates for admission-only tests; no provider is called.
      inputUsdPerMillion: 1, cachedInputUsdPerMillion: 1, cacheWriteUsdPerMillion: 1, outputUsdPerMillion: 2 } });
  const source = BlueprintSchema.parse({ id: harnessSlug, workItem: { kind: 'task' }, roles: [{ id: role }],
    spine: { edges: { DONE: { to: 'done' } } }, dependencies: { tools: ['blueprint:read-private-input'] },
    operations: [operation] });
  const specification = compileAgentSpecification({ source });
  revision = specification.specificationRevision;
  await projectBlueprintToPg(db.adminSql, { workspaceId, harnessSlug,
    blueprint: source, specification });
}, 120_000);
afterAll(async () => db?.cleanup(), 120_000);

describe('selected support operation admission', () => {
  it('admits one revision-pinned receipt with only server-read content in the private store', async () => {
    const handle = await submit('employee-case');
    expect(handle).toMatchObject({ workspaceId, harnessSlug, operationId: 'support-to-engineering',
      specificationRevision: revision, target: { kind: 'work-item' } });
    expect(await submit('employee-case')).toEqual(handle);
    const [content] = await db.adminSql<{ content_text: string }[]>`SELECT content_text
      FROM harness_shared.blueprint_operation_private_inputs WHERE workspace_id = ${workspaceId}
      AND request_key = 'employee-case'`;
    expect(JSON.parse(content!.content_text)).toMatchObject({ supportCaseId: 'case-cobalt',
      documents: [{ id: documentId, source: 'slack', externalId: 'T1:CSUPPORT:123',
        snippet: expect.stringContaining('cobalt roadmap') }] });
    const [item] = await db.adminSql<{ payload: unknown }[]>`SELECT payload FROM harness_shared.work_items
      WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
      AND feature_id = ${handle.target.kind === 'work-item' ? handle.target.id : ''}`;
    expect(item).toBeDefined();
    expect(JSON.stringify(item!.payload)).not.toContain('needs a reproducible');
  });

  it('refuses forged context, source writes, employee content and unapproved revisions before admission', async () => {
    for (const principal of [
      { kind: 'pi', trust: 'verified', slug: userId, workspaceId },
      { kind: 'user', trust: 'unverified', slug: userId, workspaceId },
      { kind: 'user', trust: 'verified', slug: userId, workspaceId: 'other-workspace' },
    ]) await expect(submit('forged-principal', {}, principal)).rejects.toThrow(/principal/);
    await expect(submit('source-write', { input: { ...selection(), requestedAction: 'publish' } })).rejects.toThrow(/outside/);
    await expect(submit('forged-content', { privateInput: { documents: [] } })).rejects.toThrow(/server-read/);
    await expect(submit('stale-revision', { expectedSpecificationRevision: 'a'.repeat(64) })).rejects.toThrow(/revision/);
    const [count] = await db.adminSql<{ n: number }[]>`SELECT count(*)::int AS n
      FROM harness_shared.blueprint_operation_invocations WHERE workspace_id = ${workspaceId}
      AND request_key IN ('forged-principal', 'source-write', 'forged-content', 'stale-revision')`;
    expect(count!.n).toBe(0);
  });

  it('refuses an inaccessible selected document and a revoked live grant without a new receipt', async () => {
    await replacePermissionListMembers(db.adminSql, workspaceId, listId, []);
    await expect(submit('revoked-source')).rejects.toThrow(/revoked/);
    await db.adminSql`UPDATE harness_shared.personal_grants SET revoked_at = now()
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId}::uuid`;
    await expect(submit('revoked-grant')).rejects.toThrow(/no_live_grant/);
    const [count] = await db.adminSql<{ n: number }[]>`SELECT count(*)::int AS n
      FROM harness_shared.blueprint_operation_invocations WHERE workspace_id = ${workspaceId}
      AND request_key IN ('revoked-source', 'revoked-grant')`;
    expect(count!.n).toBe(0);
  });
});

describe('support operation durable native funding (synthetic; no provider sends)', () => {
  it('serializes attempts across connections/restarts and retains unknown outcome costs and ancestor limits', async () => {
    // Restore this synthetic fixture's grant after the preceding hostile ACL test.
    await createPersonalGrant(db.adminSql, { workspaceId, userId, principalType: 'agent-role', principalId: role,
      scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner' });
    await replacePermissionListMembers(db.adminSql, workspaceId, listId, [{ provider: 'slack', providerUserId: 'T1:EMPLOYEE' }]);
    const funding = { organization: { controlWorkspaceId: workspaceId, organizationId: 'synthetic-support-org' },
      allocationId: 'synthetic-support-project', month: '2026-10' };
    await db.adminSql.begin(async tx => {
      for (const [allocationId, parentAllocationId, level, maximum] of [
        ['synthetic-support-org', null, 'organization', 1_000_000],
        ['synthetic-support-dept', 'synthetic-support-org', 'department', 150_000],
        [funding.allocationId, 'synthetic-support-dept', 'project', 1_000_000],
      ] as const) {
        expect((await defineHostedAllocation(tx as unknown as Sql, { organization: funding.organization,
          allocationId, parentAllocationId, level, costClass: 'model', month: funding.month,
          capMicros: 1_000_000, maxUnreconciledMicros: maximum,
          evidenceRef: 'synthetic:A-8:internal-simulation', recordedBy: 'fixture' })).outcome).toBe('created');
      }
    });
    const handle = await submit('native-budget-race');
    const request = (maximum: number) => ({ handle, funding, operationMaximumMicros: 100_000,
      attemptId: crypto.randomUUID(), attemptMaximumMicros: maximum, bodySha256: 'c'.repeat(64) });
    // A distinct, wide pool plus a connection barrier makes this a real race.
    // The fixture's normal max:2 pool must not serialize it accidentally.
    const wide = postgres(db.adminDsn, { max: 4, prepare: false, onnotice: () => {} });
    let arrived = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const requests = Array.from({ length: 4 }, () => request(40_000));
    try {
      const results = await Promise.all(requests.map(r => wide.reserve().then(async connection => {
        try {
          if (++arrived === requests.length) release();
          await gate;
          return await reserveSupportOperationAttempt(connection as unknown as Sql, r);
        } finally { connection.release(); }
      })));
      expect(results.filter(Boolean)).toHaveLength(2);
      expect(await reserveSupportOperationAttempt(wide, requests[results.indexOf(true)]!)).toBe(false);
    } finally { await wide.end(); }
    // A new pool has no process-local allowance state from the race.
    const restarted = postgres(db.adminDsn, { max: 2, prepare: false, onnotice: () => {} });
    try {
      expect(await reserveSupportOperationAttempt(restarted, request(20_000))).toBe(true);
      expect(await reserveSupportOperationAttempt(restarted, request(1))).toBe(false);
      await restarted.begin(async tx => recordSupportWorkflowOutcome(tx as unknown as Sql, {
        handle, funding, decision: 'accept', reviewerPrincipal: 'engineering-reviewer', evidenceRef: 'synthetic:review:unknown',
      }));
      let report = await restarted.begin(tx => readHostedAllocationReport(tx as unknown as Sql, funding));
      expect(report.byCostClass.model).toMatchObject({ committedMicros: 100_000, unreconciledMicros: 100_000 });
      expect(report.outcomes[0]).toMatchObject({ acceptedWithUnknownCost: 1, costPerAcceptedOutcomeMicros: null,
        reviewEffortUnknown: 1, reworkUnknown: 1, evidenceClasses: ['internal-simulation'] });
      await restarted.begin(async tx => {
        expect((await settleHostedAllocation(tx as unknown as Sql, { organization: funding.organization,
          reservationId: supportOperationReservationId(handle), costSource: 'provider-billed', providerFinal: true,
          costMicros: 23_000, observedAtMs: Date.now(), evidenceRef: 'synthetic:provider-final' })).outcome).toBe('settled');
        await recordSupportWorkflowOutcome(tx as unknown as Sql, { handle, funding, decision: 'accept',
          reviewerPrincipal: 'engineering-reviewer', evidenceRef: 'synthetic:review:known' });
      });
      report = await restarted.begin(tx => readHostedAllocationReport(tx as unknown as Sql, funding));
      expect(report.outcomes[0]).toMatchObject({ outcomes: 1, acceptedWithUnknownCost: 0,
        acceptedResultCostMicros: 23_000, costPerAcceptedOutcomeMicros: 23_000 });
      const second = await submit('native-budget-second'), third = await submit('native-budget-third');
      expect(await reserveSupportOperationAttempt(restarted, { ...request(40_000), handle: second })).toBe(true);
      expect(await reserveSupportOperationAttempt(restarted, { ...request(40_000), handle: third })).toBe(false);
      report = await restarted.begin(tx => readHostedAllocationReport(tx as unknown as Sql, funding));
      expect(report.byCostClass.model).toMatchObject({ committedMicros: 123_000, unreconciledMicros: 100_000 });
    } finally { await restarted.end(); }
  }, 30_000);
});
