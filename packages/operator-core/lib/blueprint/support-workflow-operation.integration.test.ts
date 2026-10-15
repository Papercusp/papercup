import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Sql } from 'postgres';
import postgres from 'postgres';
import { compileAgentSpecification, BlueprintSchema } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { projectBlueprintToPg } from './project-to-pg';
import { readAcceptedBlueprintDirectWorkItem } from './operation-admission';
import { submitBlueprintOperation } from './operation-service';
import { validateSupportOperationResult } from './support-workflow-case';
import { supportToEngineeringOperation } from './support-workflow-operation';
import { getWorkItem } from '../work-items';
import { runWithWorkspace } from '../workspace-als';
import { writeOperatorState } from '../operator-state-pg';
import { readActiveOperationWorkerClaimBinding } from './operation-worker-binding';
import { prepareSupportOperationNativeLaunch } from './support-workflow-native-launch';
import { createInferenceGateway } from '../inference-gateway/gateway';
import { createFailoverPool } from '../inference-gateway/account-failover';
import { codexCliResponsesBody, codexCliResponsesCompletionSse } from '../inference-gateway/codex-cli-bridge';
import type { RunningGatewayService } from '../inference-gateway/launch';
import { hermeticEnv } from '../../../../apps/operator/vitest-shims/psu-pty-temp-dir';
import { currentBenchOpenAiInputContract } from '../external-bench/current-su';
import { defineHostedAllocation, readHostedAllocationReport, settleHostedAllocation } from '../auth/hosted/billing/allocation-store';
import { readSupportOperationBudgetBinding, recordSupportWorkflowOutcome, reserveSupportOperationAttempt,
  supportOperationReservationId } from './support-workflow-budget';
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
let reviewerId: string;
let documentId: string;
let listId: string;
let revision: string;
let specificationArtifact: ReturnType<typeof compileAgentSpecification>;
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
  const [reviewer] = await db.adminSql<{ id: string }[]>`INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`support-reviewer-${crypto.randomUUID()}`}, 'Distinct support reviewer') RETURNING id`;
  reviewerId = reviewer!.id;
  await db.adminSql`INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${workspaceId}, ${harnessSlug}, ${Buffer.from([0])}, 'support-test-key', 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING`;
  await createPersonalGrant(db.adminSql, { workspaceId, userId, principalType: 'agent-role', principalId: role,
    scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner' });
  const provider = { provider: 'slack', providerUserId: 'T1:EMPLOYEE' };
  await mapProviderIdentity(db.adminSql, workspaceId, { ...provider, userId, mappedBy: 'owner' });
  await mapProviderIdentity(db.adminSql, workspaceId, { provider: 'slack', providerUserId: 'T1:REVIEWER',
    userId: reviewerId, mappedBy: 'owner' });
  const list = await upsertPermissionList(db.adminSql, workspaceId, { source: 'slack', sourceRef: 'T1:CSUPPORT' });
  listId = list.id;
  await replacePermissionListMembers(db.adminSql, workspaceId, listId, [provider]);
  await upsertOrganizationDocuments(db.adminSql, workspaceId, listId, [{ source: 'slack', kind: 'message',
    dedupeKey: 'support-case-cobalt', externalId: 'T1:CSUPPORT:123', title: 'Cobalt support',
    text: 'The cobalt roadmap needs a reproducible engineering handoff.',
    metadata: { permalink: 'https://support.example/internal/cobalt' } }]);
  const [document] = await db.adminSql<{ id: string }[]>`SELECT id FROM harness_shared.documents
    WHERE workspace_id = ${workspaceId} AND dedupe_key = 'support-case-cobalt'`;
  documentId = document!.id;
  const operation = supportToEngineeringOperation({ id: 'support-to-engineering', version: '1', role,
    identity: { kind: 'identity', ref: 'support-worker', revision: '1', contentHash: 'b'.repeat(64) },
    accountableOwner: 'engineering-owner', reviewerPrincipals: [reviewerId],
    allowedSources: ['slack'], allowedActions: ['prepare-handoff'], maximumCostMicros: 100_000,
    model: { mode: 'exact', models: ['gpt-6.1-sol'], effort: 'medium', onUnavailable: 'fail' },
    funding: { organization: { controlWorkspaceId: workspaceId, organizationId: 'synthetic-support-org' },
      allocationId: 'synthetic-support-project', month: '2026-10' },
    native: { model: 'gpt-6.1-sol', effort: 'medium', account: 'auto', payer: 'api-key',
      inputTokenCeiling: 1000, outputTokenCeiling: 100,
      inputTokenCeilingSourceSha256: currentBenchOpenAiInputContract('gpt-6.1-sol', 1000),
      // Synthetic frozen rates for admission-only tests; no provider is called.
      inputUsdPerMillion: 1, cachedInputUsdPerMillion: 1, cacheWriteUsdPerMillion: 1, outputUsdPerMillion: 2 } });
  const nativeOperation = structuredClone(operation);
  nativeOperation.id = 'support-native-joint';
  nativeOperation.policy.supportCase!.funding = {
    organization: { controlWorkspaceId: workspaceId, organizationId: 'synthetic-native-joint-org' },
    allocationId: 'synthetic-native-joint-project', month: '2026-10',
  };
  Object.assign(nativeOperation.policy.supportCase!.native!, {
    inputUsdPerMillion: 30, cachedInputUsdPerMillion: 30, cacheWriteUsdPerMillion: 30,
    outputUsdPerMillion: 100,
  });
  const source = BlueprintSchema.parse({ id: harnessSlug, grants: {}, workItem: { kind: 'task' }, roles: [{ id: role }],
    spine: { edges: { DONE: { to: 'done' } } }, dependencies: { tools: ['blueprint:read-private-input'] },
    operations: [operation, nativeOperation] });
  const specification = compileAgentSpecification({ source });
  expect(specification.configuration.grants).toBeDefined();
  specificationArtifact = specification;
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

  it('requires both employee and distinct allowlisted reviewer live corpus access before disclosing a result', async () => {
    const handle = await submit('reviewer-disclosure');
    if (handle.target.kind !== 'work-item') throw new Error('support fixture requires a work item');
    const workItemId = handle.target.id;
    const item = await runWithWorkspace(workspaceId, () => getWorkItem(workItemId, harnessSlug));
    if (!item) throw new Error('accepted support fixture is missing');
    const { operation, pin } = await readAcceptedBlueprintDirectWorkItem(db.adminSql, workspaceId, item);
    expect(reviewerId).not.toBe(userId);
    expect(operation.acceptance.businessReview?.reviewerPrincipals).toContain(reviewerId);
    const output = { supportCaseId: 'case-cobalt', summary: 'Cited internal support handoff',
      reproduction: ['Open the synthetic case'], checklist: ['Confirm the failure'],
      suggestedRole: 'engineering', citations: [{ id: documentId, source: 'slack', externalId: 'T1:CSUPPORT:123' }] };
    const read = () => validateSupportOperationResult(db.adminSql, workspaceId, operation, pin, output, reviewerId);
    const employee = { provider: 'slack', providerUserId: 'T1:EMPLOYEE' };
    const reviewer = { provider: 'slack', providerUserId: 'T1:REVIEWER' };
    try {
      // A decision allowlist is neither a personal grant nor a source ACL.
      await expect(read()).rejects.toThrow(/reviewer source access was refused/);
      await createPersonalGrant(db.adminSql, { workspaceId, userId: reviewerId, principalType: 'agent-role',
        principalId: role, scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner' });
      await expect(read()).rejects.toThrow(/unavailable|revoked/);
      await replacePermissionListMembers(db.adminSql, workspaceId, listId, [employee, reviewer]);
      await expect(read()).resolves.toMatchObject({ ...output, citations: [{ ...output.citations[0],
        sourceUrl: 'https://support.example/internal/cobalt' }] });
      expect(output.citations[0]).not.toHaveProperty('sourceUrl');

      await db.adminSql`UPDATE harness_shared.personal_grants SET revoked_at = now()
        WHERE workspace_id = ${workspaceId} AND user_id = ${reviewerId}::uuid`;
      await expect(read()).rejects.toThrow(/reviewer source access was refused/);
      await createPersonalGrant(db.adminSql, { workspaceId, userId: reviewerId, principalType: 'agent-role',
        principalId: role, scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner' });
      // Reviewer access must not hide the submitting employee's later revocation.
      await replacePermissionListMembers(db.adminSql, workspaceId, listId, [reviewer]);
      await expect(read()).rejects.toThrow(/unavailable|revoked/);
    } finally {
      await replacePermissionListMembers(db.adminSql, workspaceId, listId, [employee]);
    }
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

describe('support native launch with applied PostgreSQL authority and funding', () => {
  it('runs installed Codex through SRT, rechecks live authority after counting, and preserves the allowance on listener restart', async () => {
    // Only the provider's HTTP boundary is synthetic. Admission, applied worker
    // lookup, source ACLs, account/credential readers and allocation CAS are real.
    await createPersonalGrant(db.adminSql, { workspaceId, userId, principalType: 'agent-role', principalId: role,
      scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner' });
    const employee = { provider: 'slack', providerUserId: 'T1:EMPLOYEE' };
    await replacePermissionListMembers(db.adminSql, workspaceId, listId, [employee]);
    const handle = await submit('native-joint', { operationId: 'support-native-joint' });
    if (handle.target.kind !== 'work-item') throw new Error('native fixture requires a work item');
    const workItemId = handle.target.id;
    const item = await runWithWorkspace(workspaceId, () => getWorkItem(workItemId, harnessSlug));
    if (!item) throw new Error('native fixture admission is missing');
    const { operation, pin } = await readAcceptedBlueprintDirectWorkItem(db.adminSql, workspaceId, item);
    const funding = operation.policy.supportCase!.funding!;
    await db.adminSql.begin(async tx => {
      for (const [allocationId, parentAllocationId, level] of [
        [funding.organization.organizationId, null, 'organization'],
        [funding.allocationId, funding.organization.organizationId, 'project'],
      ] as const) {
        expect((await defineHostedAllocation(tx as unknown as Sql, { ...funding, allocationId,
          level, parentAllocationId, costClass: 'model', capMicros: 100_000, maxUnreconciledMicros: 100_000,
          evidenceRef: 'synthetic:native-joint', recordedBy: 'fixture' })).outcome).toBe('created');
      }
      // Production admits model holds only against a project leaf. Catch a
      // malformed funding fixture before paying the native launch setup cost.
      const report = await readHostedAllocationReport(tx as unknown as Sql, funding);
      expect(report.byCostClass.model.allocations.find(allocation => allocation.allocationId === funding.allocationId)?.level).toBe('project');
    });
    const ownerId = `role-support-native-${crypto.randomUUID()}`;
    const appliedRevision = { specificationRevision: revision, stateRevision: 'native-joint-applied' };
    const acceptedOperation = { kind: 'blueprint-operation-worker', workItemId,
      operationId: operation.id, specificationRevision: revision, pin,
      identity: { ref: 'support-worker', revision: '1', contentHash: 'b'.repeat(64) },
      requiredTools: ['blueprint:read-private-input'] };
    const launchSpec = { workspaceId, harnessSlug, role, ...appliedRevision,
      specificationArtifact, acceptedOperation };
    const activation = { schemaVersion: 1,
      attribution: { actorId: ownerId, principalId: ownerId, sessionId: ownerId },
      desired: appliedRevision, prepared: null, applied: appliedRevision, status: 'applied' };
    const [session] = await db.adminSql<{ id: number }[]>`INSERT INTO harness_shared.adv_sessions
      (workspace_id, mode, agent, coord_owner_id, role, launch_spec)
      VALUES (${workspaceId}, 'console', 'codex', ${ownerId}, ${role}, ${db.adminSql.json(JSON.parse(JSON.stringify(launchSpec)))})
      RETURNING id`;
    const sessionId = session!.id;
    await db.adminSql`INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, control_state)
      VALUES (${ownerId}, ${workspaceId}, ${db.adminSql.json({ activation })})`;
    await db.adminSql`UPDATE harness_shared.work_items SET taken_by = ${ownerId}
      WHERE workspace_id = ${workspaceId} AND feature_id = ${workItemId}`;
    const active = await readActiveOperationWorkerClaimBinding(workspaceId, ownerId);
    if (active.status !== 'bound') throw new Error(JSON.stringify(active));
    expect(await readSupportOperationBudgetBinding(workspaceId, ownerId)).not.toBeNull();

    const root = mkdtempSync('/tmp/support-native-funded-');
    const codexHome = join(root, 'codex-home'); mkdirSync(codexHome);
    const credentialName = 'PAPERCUSP_TEST_SUPPORT_NATIVE_BEARER';
    vi.stubEnv(credentialName, 'synthetic-support-native-bearer');
    await writeOperatorState('operator_account_pool', { accounts: [{ id: 'synthetic-support', provider: 'codex',
      credentialRef: `env:${credentialName}` }] }, workspaceId);
    const originalFetch = globalThis.fetch;
    let onCount: (() => Promise<void>) | undefined;
    let counts = 0;
    // Fail closed for every non-local target except this exact synthetic count
    // endpoint. The installed client can reach only the private SRT gateway.
    vi.stubGlobal('fetch', (async (target, init) => {
      const url = String(target);
      if (url === 'https://api.openai.com/v1/responses/input_tokens') {
        counts++;
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-support-native-bearer');
        await onCount?.();
        return new Response(JSON.stringify({ object: 'response.input_tokens', input_tokens: 10 }), {
          headers: { 'content-type': 'application/json', 'x-request-id': 'synthetic-support-count' },
        });
      }
      if (new URL(url).hostname !== '127.0.0.1') throw new Error('unexpected external fixture request');
      return originalFetch(target, init);
    }) as typeof fetch);
    const bodies: string[] = [];
    const listen = (server: http.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1',
      () => resolve((server.address() as { port: number }).port)));
    const upstream = http.createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      bodies.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({ model: 'gpt-6.1-sol',
        text: 'SUPPORT_FUNDED_NATIVE_RECEIPT', inputTokens: 10, outputTokens: 1 })));
    });
    const operator = http.createServer((_req, res) => res.end('fixture-operator'));
    const [upstreamPort, operatorPort] = await Promise.all([listen(upstream), listen(operator)]);
    let gateway: ReturnType<typeof createInferenceGateway> | undefined;
    let route: Awaited<ReturnType<typeof prepareSupportOperationNativeLaunch>>;
    let child: ReturnType<typeof spawn> | undefined;
    const attempts: Array<Record<string, unknown>> = [];
    const start = async () => {
      route = await prepareSupportOperationNativeLaunch({ workspaceId, ownerId, sessionId,
        agent: 'codex', checkout: root, accepted: active.binding }, async options => {
        gateway = createInferenceGateway({ accountId: 'synthetic-support', token: async () => 'synthetic-support-native-bearer',
          codexPool: createFailoverPool([{ accountId: 'synthetic-support', token: async () => 'synthetic-support-native-bearer' }]),
          carryTrial: { ...options.carryTrial!, async authorizeAttempt(attempt) {
            // Retain the final synthetic request shape for an actionable failure
            // without recording either the private route or provider credential.
            const body = JSON.parse(attempt.body);
            attempts.push({ transport: attempt.transport, target: attempt.target, accountId: attempt.accountId,
              bodyKeys: Object.keys(body), model: body.model, reasoning: body.reasoning,
              maxOutputTokens: body.max_output_tokens,
              toolTypes: Array.isArray(body.tools) ? body.tools.map((tool: { type?: string }) => tool.type) : null });
            return options.carryTrial!.authorizeAttempt(attempt);
          } },
          fetchImpl: async (target, init) => {
            expect(String(target)).toBe('https://api.openai.com/v1/responses');
            return originalFetch(`http://127.0.0.1:${upstreamPort}/v1/responses`, init);
          },
          requestOutcomeStore: { record: async () => {}, report: async () => ({ rows: [], total: 0,
            byOutcome: { ok: 0, 'client-error': 0, 'upstream-429': 0, 'upstream-error': 0, shed: 0,
              cancelled: 0, 'gateway-error': 0, unclassified: 0 }, firstRequestTimestampMs: null,
            lastFinalizedAtMs: null, truncated: false, retentionMs: 0 }) },
          requestAbsorbMs: 0, selfHeal: { enabled: false } });
        return { port: await gateway.listen(0), stop: () => gateway!.close() } as RunningGatewayService;
      });
      return JSON.parse(route!.envelopeEnv.PAPERCUSP_SCOPED_INFERENCE_GATEWAY!) as { baseURL: string; token: string };
    };
    try {
      let privateRoute = await start();
      const args = ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
        '-m', 'gpt-6.1-sol', ...Object.entries({ model_reasoning_effort: 'medium',
          'model_providers.papercusp-codex-gateway.request_max_retries': 0,
          'model_providers.papercusp-codex-gateway.stream_max_retries': 0,
          'features.apps': false, 'features.hooks': false, web_search: 'disabled',
        }).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
        'Return the local synthetic support receipt.'];
      const env = hermeticEnv({ ...route!.envelopeEnv, PAPERCUSP_AGENT: 'codex', CODEX_HOME: codexHome,
        PAPERCUSP_SID: `test-support-funded-${root.split('/').at(-1)}`, PAPERCUSP_PSU_HEADLESS: '1',
        PAPERCUSP_PSU_PTY: '1', PAPERCUSP_MCP_PROXY: '0', PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${operatorPort}` });
      const preloadDir = join(codexHome, 'fixture-preloads'); mkdirSync(preloadDir);
      for (const name of ['committed-source-loader.mjs', 'vitest-startup-trace.mjs']) {
        const original = fileURLToPath(new URL(`../../../../scripts/lib/${name}`, import.meta.url));
        const staged = join(preloadDir, name); writeFileSync(staged, readFileSync(original));
        env.NODE_OPTIONS = (env.NODE_OPTIONS ?? '').split(pathToFileURL(original).href)
          .join(pathToFileURL(staged).href).split(original).join(staged);
      }
      env.PAPERCUSP_COMMITTED_SOURCE_GIT = '/usr/bin/git';
      const launcher = fileURLToPath(new URL('../../../../apps/operator/scripts/psu-launcher.mjs', import.meta.url));
      const fixture = join(root, 'launcher-fixture.mjs');
      writeFileSync(fixture, `import { runWrapper, applyScopedNativeGateway } from ${JSON.stringify(launcher)};\n` +
        'applyScopedNativeGateway(process.env);\n' +
        `runWrapper({wrapperBin:'codex',args:${JSON.stringify(args)},cwd:${JSON.stringify(root)},preserveCwd:true,` +
        'envelopeEnv:process.env,reportSessionEndedImpl:async()=>{},onSpawn:()=>{}});\n');
      child = spawn(process.execPath, [fixture], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout!.on('data', b => { output += b; }); child.stderr!.on('data', b => { output += b; });
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => { child!.kill('SIGKILL'); reject(new Error(output.slice(-4000))); }, 30_000);
        child!.once('error', error => { clearTimeout(timer); reject(error); });
        child!.once('close', value => { clearTimeout(timer); resolve(value); });
      });
      expect(code, JSON.stringify({ output, counts, attempts, upstreamSends: bodies.length })).toBe(0);
      expect(output).not.toContain('COMMITTED_SOURCE substituted');
      expect(output).toContain('SUPPORT_FUNDED_NATIVE_RECEIPT');
      expect(bodies, output).toHaveLength(1);
      expect(JSON.parse(bodies[0]!)).toMatchObject({ model: 'gpt-6.1-sol', reasoning: { effort: 'medium' }, max_output_tokens: 100 });
      const request = async () => {
        const response = await originalFetch(`${privateRoute.baseURL}/v1/responses`, { method: 'POST',
          headers: { authorization: `Bearer ${privateRoute.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-6.1-sol', reasoning: { effort: 'medium' }, input: 'synthetic support' }) });
        await response.text(); return response.status;
      };
      const reservations = () => db.adminSql<{ body: { maximumCostMicros: number; bodySha256: string } }[]>`
        SELECT body FROM harness_shared.coord_event_log WHERE workspace_id = ${workspaceId}
          AND surface = 'blueprint-operation' AND writer_key = ${`receipt:${handle.receiptId}`}
          AND body->>'kind' = 'native-budget-reservation'`;
      expect(await reservations()).toEqual([{ body: expect.objectContaining({ maximumCostMicros: 40_000,
        bodySha256: createHash('sha256').update(bodies[0]!).digest('hex') }) }]);
      // Revoking the employee while provider counting is awaited must prevent
      // both the reservation and the final upstream send.
      const initialCounts = counts;
      onCount = async () => { await replacePermissionListMembers(db.adminSql, workspaceId, listId, []); };
      expect(await request()).toBe(403);
      expect(counts).toBe(initialCounts + 1);
      expect(bodies).toHaveLength(1); expect(await reservations()).toHaveLength(1);
      onCount = undefined;
      expect(await request()).toBe(403); expect(counts).toBe(initialCounts + 1);
      await replacePermissionListMembers(db.adminSql, workspaceId, listId, [employee]);
      onCount = async () => { await db.adminSql`UPDATE harness_shared.work_items SET taken_by = 'replacement-worker'
        WHERE workspace_id = ${workspaceId} AND feature_id = ${workItemId}`; };
      expect(await request()).toBe(403); expect(bodies).toHaveLength(1); expect(await reservations()).toHaveLength(1);
      onCount = undefined;
      await db.adminSql`UPDATE harness_shared.work_items SET taken_by = ${ownerId}
        WHERE workspace_id = ${workspaceId} AND feature_id = ${workItemId}`;
      onCount = async () => { await db.adminSql`UPDATE harness_shared.adv_sessions SET ended_at = now()
        WHERE id = ${sessionId} AND workspace_id = ${workspaceId}`; };
      expect(await request()).toBe(403); expect(bodies).toHaveLength(1); expect(await reservations()).toHaveLength(1);
      onCount = undefined;
      await db.adminSql`UPDATE harness_shared.adv_sessions SET ended_at = NULL
        WHERE id = ${sessionId} AND workspace_id = ${workspaceId}`;
      await route!.stop();
      privateRoute = await start();
      expect(await request()).toBe(200); expect(bodies).toHaveLength(2);
      await route!.stop();
      privateRoute = await start();
      expect(await request()).toBe(403); expect(bodies).toHaveLength(2);
      expect((await reservations()).map(row => row.body.maximumCostMicros)).toEqual([40_000, 40_000]);
      const report = await db.adminSql.begin(tx => readHostedAllocationReport(tx as unknown as Sql, funding));
      expect(report.byCostClass.model).toMatchObject({ committedMicros: 100_000, unreconciledMicros: 100_000 });
    } finally {
      if (child && child.exitCode === null) child.kill('SIGKILL');
      await route!?.stop(); await gateway?.close();
      await Promise.all([upstream, operator].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
      vi.unstubAllGlobals(); vi.unstubAllEnvs();
      await replacePermissionListMembers(db.adminSql, workspaceId, listId, [employee]);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
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
    const racePools = Array.from({ length: 4 }, () =>
      postgres(db.adminDsn, { max: 1, prepare: false, onnotice: () => {} }));
    let arrived = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const requests = Array.from({ length: 4 }, () => request(40_000));
    try {
      // A ReservedSql has no begin(). Use real pools, and establish four
      // distinct connections before the barrier so the transaction race is
      // neither an interface cast nor accidental max:1 pool serialization.
      const backends = await Promise.all(racePools.map(pool => pool<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`));
      expect(new Set(backends.map(rows => rows[0]!.pid)).size).toBe(requests.length);
      const results = await Promise.all(requests.map(async (r, index) => {
        if (++arrived === requests.length) release();
        await gate;
        return reserveSupportOperationAttempt(racePools[index]!, r);
      }));
      expect(results.filter(Boolean)).toHaveLength(2);
      expect(await reserveSupportOperationAttempt(racePools[0]!, requests[results.indexOf(true)]!)).toBe(false);
    } finally { await Promise.all(racePools.map(pool => pool.end())); }
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
