import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';
import { BlueprintSchema, compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { projectBlueprintToPg } from '../../../packages/operator-core/lib/blueprint/project-to-pg';
import { supportToEngineeringOperation } from '../../../packages/operator-core/lib/blueprint/support-workflow-operation';
import { currentBenchOpenAiInputContract } from '../../../packages/operator-core/lib/external-bench/current-su';
import { defineHostedAllocation } from '../../../packages/operator-core/lib/auth/hosted/billing/allocation-store';
import { createPersonalGrant } from '../../../packages/operator-core/lib/personal-vault/store';
import { ORGANIZATION_CORPUS_SCOPE, mapProviderIdentity, replacePermissionListMembers,
  upsertOrganizationDocuments, upsertPermissionList } from '../../../packages/operator-core/lib/data-sources/documents-corpus';

/** This is test input, never worker-completion/model evidence or acceptance. */
export async function seedSupportWorkflowNativeFixture(sql: Sql, input: {
  workspaceId: string;
  harnessSlug?: string;
}) {
  const { workspaceId } = input;
  if (!/^verify-tauri-isolated-[a-zA-Z0-9-]+$/.test(workspaceId))
    throw new Error('Support native fixture requires a verify-tauri-isolated workspace');
  // The maintained native rig has its own data directory; the conventional PG
  // guard uses createOrgTestDb's private, randomly named clone. An env flag or
  // workspace label alone is not proof that the SQL connection is throwaway.
  const [database] = await sql<{ name: string; directory: string }[]>`SELECT current_database() AS name,
    current_setting('data_directory') AS directory`;
  if (!database || (!/^org_[a-f0-9]{12}$/.test(database.name)
    && !/\/verify-tauri-headless\.[^/]+\/isolated-pgdata(?:\/|$)/.test(database.directory)))
    throw new Error('Support native fixture requires the maintained isolated PostgreSQL database');

  const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const harnessSlug = input.harnessSlug ?? `support-native-${nonce}`;
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(harnessSlug)) throw new Error('Invalid fixture harness slug');
  const role = 'support-worker';
  const operationId = 'support-to-engineering';
  const supportCaseId = `case-cobalt-${nonce}`;
  const documentTitle = `Cobalt support ${nonce}`;
  const query = 'cobalt roadmap';
  const externalId = `T1:CSUPPORT:${nonce}`;
  const sourceUrl = `https://support.example/internal/${supportCaseId}`;
  const funding = { organization: { controlWorkspaceId: workspaceId, organizationId: `synthetic-support-org-${nonce}` },
    allocationId: `synthetic-support-project-${nonce}`, month: new Date().toISOString().slice(0, 7) };

  return sql.begin(async tx => {
    const client = tx as unknown as Sql;
    const actors = {} as Record<'employee' | 'reviewer' | 'admin', { id: string; username: string; password: string }>;
    for (const actor of ['employee', 'reviewer', 'admin'] as const) {
      const username = `p012-${actor}-${nonce}`;
      const password = randomUUID();
      const [user] = await tx<{ id: string }[]>`INSERT INTO harness_shared.users (username, display_name, password_hash)
        VALUES (${username}, ${`Native support ${actor}`}, crypt(${password}, gen_salt('bf'))) RETURNING id`;
      if (!user) throw new Error('Fixture user was not created');
      actors[actor] = { id: user.id, username, password };
    }
    await tx`INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
      VALUES (${workspaceId}, ${harnessSlug}, ${Buffer.from([0])}, 'synthetic-native-support', 0)`;
    const identities = {
      employee: { provider: 'slack', providerUserId: `T1:EMPLOYEE:${nonce}` },
      reviewer: { provider: 'slack', providerUserId: `T1:REVIEWER:${nonce}` },
    };
    for (const actor of ['employee', 'reviewer'] as const) {
      // The operation worker and the existing GUI tool caller are independent
      // grant principals. The source ACL still restricts both to these users.
      for (const principalId of [role, 'operator']) await createPersonalGrant(client, { workspaceId,
        userId: actors[actor].id, principalType: 'agent-role', principalId,
        scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: actors.admin.id });
      await mapProviderIdentity(client, workspaceId, { ...identities[actor], userId: actors[actor].id,
        mappedBy: actors.admin.id });
    }
    const list = await upsertPermissionList(client, workspaceId, { source: 'slack', sourceRef: `T1:CSUPPORT:${nonce}` });
    await replacePermissionListMembers(client, workspaceId, list.id, Object.values(identities));
    await upsertOrganizationDocuments(client, workspaceId, list.id, [{ source: 'slack', kind: 'message',
      dedupeKey: supportCaseId, externalId, title: documentTitle,
      text: 'The cobalt roadmap needs a reproducible engineering handoff.', metadata: { permalink: sourceUrl } }]);
    const [document] = await tx<{ id: string }[]>`SELECT id FROM harness_shared.documents
      WHERE workspace_id=${workspaceId} AND dedupe_key=${supportCaseId}`;
    if (!document) throw new Error('Fixture source document was not created');
    const operation = supportToEngineeringOperation({ id: operationId, version: '1', role,
      identity: { kind: 'identity', ref: role, revision: '1', contentHash: 'b'.repeat(64) },
      accountableOwner: actors.admin.id, reviewerPrincipals: [actors.reviewer.id],
      allowedSources: ['slack'], allowedActions: ['prepare-handoff'], maximumCostMicros: 100_000,
      model: { mode: 'exact', models: ['gpt-6.1-sol'], effort: 'medium', onUnavailable: 'fail' }, funding,
      native: { model: 'gpt-6.1-sol', effort: 'medium', account: 'auto', payer: 'api-key',
        inputTokenCeiling: 1000, outputTokenCeiling: 100,
        inputTokenCeilingSourceSha256: currentBenchOpenAiInputContract('gpt-6.1-sol', 1000),
        // Synthetic frozen rates and allocation. This helper never sends to a
        // provider and never manufactures an execution or completion receipt.
        inputUsdPerMillion: 30, cachedInputUsdPerMillion: 30, cacheWriteUsdPerMillion: 30, outputUsdPerMillion: 100 } });
    const blueprint = BlueprintSchema.parse({ id: harnessSlug, grants: {}, workItem: { kind: 'task' },
      roles: [{ id: role }], spine: { edges: { DONE: { to: 'done' } } },
      dependencies: { tools: ['blueprint:read-private-input'] }, operations: [operation] });
    const specification = compileAgentSpecification({ source: blueprint });
    await projectBlueprintToPg(client, { workspaceId, harnessSlug, blueprint, specification });
    const department = `synthetic-support-dept-${nonce}`;
    for (const [allocationId, parentAllocationId, level] of [
      [funding.organization.organizationId, null, 'organization'],
      [department, funding.organization.organizationId, 'department'],
      [funding.allocationId, department, 'project'],
    ] as const) {
      const result = await defineHostedAllocation(client, { ...funding, allocationId, parentAllocationId, level,
        costClass: 'model', capMicros: 1_000_000, maxUnreconciledMicros: 100_000,
        evidenceRef: 'synthetic:native-support-fixture', recordedBy: actors.admin.id });
      if (result.outcome !== 'created') throw new Error(`Fixture allocation was refused: ${result.outcome}`);
    }
    return { workspaceId, harnessSlug, operationId, supportCaseId, query, documentTitle,
      documentId: document.id, listId: list.id, externalId, sourceUrl, role, actors, identities,
      approvedRevision: specification.specificationRevision, blueprint, specification, funding,
      input: { supportCaseId, approvedRevision: specification.specificationRevision,
        documentIds: [document.id], query, requestedAction: 'prepare-handoff' } };
  });
}

export type SupportWorkflowNativeFixture = Awaited<ReturnType<typeof seedSupportWorkflowNativeFixture>>;

/** Evaluate INSIDE the owned webview. HttpOnly cookies remain browser-managed.
 * Return only the measured user id; never print fixture passwords or cookies. */
export function supportWorkflowNativeLoginScript(fixture: SupportWorkflowNativeFixture,
  actor: keyof SupportWorkflowNativeFixture['actors']) {
  const { id, username, password } = fixture.actors[actor];
  return `(async () => {
    const workspaceId = ${JSON.stringify(fixture.workspaceId)};
    const response = await fetch('/api/auth/login', { method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-papercusp-workspace': workspaceId },
      body: JSON.stringify(${JSON.stringify({ username, password })}) });
    if (!response.ok) throw new Error('Support actor login refused: ' + response.status);
    const signedIn = await response.json();
    const measured = await fetch('/api/auth/me', { credentials: 'include',
      headers: { 'x-papercusp-workspace': workspaceId } });
    if (!measured.ok) throw new Error('Support actor session read refused');
    const current = await measured.json();
    if (signedIn.user?.id !== ${JSON.stringify(id)} || current.user?.id !== ${JSON.stringify(id)}
      || current.user?.workspace_id !== workspaceId || current.autoLogin !== false)
      throw new Error('Support actor cookie identity did not switch');
    return { userId: current.user.id, workspaceId: current.user.workspace_id, actor: ${JSON.stringify(actor)} };
  })()`;
}
