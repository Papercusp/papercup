import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPlanContent } from '@papercusp/plan-parser/content-hash';
import { seedPlan, setupPlanPgFixture, type PlanPgFixture } from './agent-tools/plans/__tests__/_pg-tool-fixture';
import { acquireBlindReviewSessionResume, findBlindReviewSessionBinding, recordBlindReviewSessionPost,
  releaseBlindReviewSessionResume, type BlindReviewSessionBinding } from './blind-review-session-bindings';
import { recordBlindReview } from './blind-review-gate';
import { checkRuntimeReviewerAuthority } from './blind-review-runtime-authority';
import { createRuntimeCustodyStore, runtimeCustodyFingerprint, RUNTIME_RESOURCE_KINDS } from './blind-review-runtime-custody';
import { blindReviewerConfinement } from './blind-reviewer-mint';
import { assertMigrationPassesPreApplyLints } from './migration-preapply-lint';
import { authorizeBlindReviewPortBootstrap, finalizeBlindReviewContinuation, finalizeBlindReviewPortCustody,
  lockBlindReviewContinuationScope, reserveBlindReviewContinuation,
  resolveBlindReviewEndpoint, verifyBlindReviewEndpointCaller,
  withAuthenticatedBlindReviewEndpoint } from './blind-review-continuation-custody';
import { reserveBlindReviewNativeAttempt, verifyBlindReviewNativeNoOpen,
  withBlindReviewNativeLaunch, reconcileBlindReviewNativeStart, reserveBlindReviewManagedSuccession,
  withBlindReviewManagedReanchor, type ManagedSuccessionRequest } from './blind-review-continuation-custody';
import { newTaskId, scopeUnitForTask } from './task-manager/types';
import type { PsuPtyHost } from './events/await/psu-pty-discovery';
import { BLIND_GAP_REVIEW_ACTOR, type BlindReviewResumePermit } from './blind-review-session-bindings';
import { Governor } from './resource-governor/admission';
import { PgAdmissionLedgerQueueStore } from './resource-governor/admission-ledger-store';
import { WorkItemAdmissionQueueDriver, type SqlClient } from './resource-governor/queue';
import { beginGovernedExecution } from './resource-governor/execution';
import { allSessionsLiveResolver } from '../test/_admission-ledger-fixture';
import { decideLegacyAdoption, LEGACY_ADOPTION_ACTION, lockLegacyAdoptionAuthorization,
  reserveLegacyAdoption, retainLegacyAdoptionHuman, validateLegacyAdoptionRequest,
  readLegacyAdoptionIndependence, readLegacyAdoptionHistoryAndEffects, readLegacyAdoptionRuntimeAbsence,
  type LegacyAdoptionPayload } from './blind-review-continuation-custody';
import { applyGovernancePolicyChange, chainRevision } from './governance-policy/control';
import { grantDelegation, recordBootstrapDelegation, revokeDelegation } from './governance-policy/authority';
import { loadChainForWorkspace, upsertLayer } from './governance-policy/store';
import { decideSensitiveAction, executeSensitiveAction, executeSensitiveActionInTransaction, getSensitiveAction, prepareSensitiveAction,
  sensitivePayloadHash } from './governance-policy/sensitive-action';

let fx: PlanPgFixture;
const migrationName = '1623-blind-review-continuation-custody.sql.DRAFT';
const migrationBytes = readFileSync(new URL('../../../libs/papercusp/libs/db/sql/' + migrationName, import.meta.url));
const migration = migrationBytes.toString('utf8');
const migrationSha256 = createHash('sha256').update(migrationBytes).digest('hex');
const migrationArtifactDir = process.env.PAPERCUSP_TEST_ARTIFACT_DIR;
const migrationArtifactStem = 'blind-review-continuation-migration-' + randomUUID();
let migrationDatabase: string | null = null;
function migrationFixtureReceipt(event: 'applied' | 'already-present' | 'disposed' | 'cleanup-failed') {
  const receipt = { event, migrationName, sha256: migrationSha256, byteLength: migrationBytes.length,
    runId: process.env.PAPERCUSP_TEST_RUN_GROUP ?? null, database: migrationDatabase,
    scope: 'isolated-plan-pg-fixture', inputFile: migrationArtifactDir
      ? join(migrationArtifactDir, migrationArtifactStem + '.sql') : null };
  if (migrationArtifactDir) appendFileSync(join(migrationArtifactDir, migrationArtifactStem + '.jsonl'),
    JSON.stringify(receipt) + '\n');
  console.log('BLIND_REVIEW_CUSTODY_MIGRATION_FIXTURE ' + JSON.stringify(receipt));
}
beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  // Retain the actual SQL argument, not merely the path observed by fs capture.
  // The decode must be lossless for this digest to identify the bytes sent to PG.
  expect(Buffer.from(migration, 'utf8')).toEqual(migrationBytes);
  const [database] = await fx.admin`SELECT current_database() AS name,
    current_setting('server_encoding') AS server_encoding, current_setting('client_encoding') AS client_encoding`;
  expect(database!.server_encoding).toBe('UTF8');
  expect(database!.client_encoding).toBe('UTF8');
  migrationDatabase = database!.name;
  if (migrationArtifactDir) {
    mkdirSync(migrationArtifactDir, { recursive: true });
    const inputFile = join(migrationArtifactDir, migrationArtifactStem + '.sql');
    writeFileSync(inputFile, migrationBytes, { flag: 'wx' });
    expect(readFileSync(inputFile)).toEqual(migrationBytes);
  }
  const [present] = await fx.admin`SELECT to_regclass('harness_shared.blind_review_continuation_custody') AS name`;
  if (!present!.name) {
    await fx.admin.begin(tx => tx.unsafe(migration));
    migrationFixtureReceipt('applied');
  } else migrationFixtureReceipt('already-present');
  const [runtime] = await fx.admin`SELECT to_regclass('harness_shared.blind_review_runtime_leases') AS name`;
  if (!runtime!.name) await fx.admin.begin(tx => tx.unsafe(readFileSync(new URL(
    '../../../libs/papercusp/libs/db/sql/1578-blind-review-runtime-custody.sql.DRAFT', import.meta.url), 'utf8')));
  const [replacement] = await fx.admin`SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'harness_shared' AND table_name = 'plan_blind_review_sessions' AND column_name = 'attempt_seq'`;
  if (!replacement) await fx.admin.begin(tx => tx.unsafe(readFileSync(
    new URL('../../../libs/papercusp/libs/db/sql/1567-blind-review-replacement-attempts.sql', import.meta.url), 'utf8')));
}, 120_000);
afterAll(async () => {
  if (!fx) return;
  try {
    await fx.dispose();
    migrationFixtureReceipt('disposed');
  } catch (error) {
    migrationFixtureReceipt('cleanup-failed');
    throw error;
  }
});

async function fixture() {
  const key = randomUUID(), ws = fx.workspaceId, owner = 'su-continuation-' + key;
  const slug = 'continuation-' + key, sourceNative = 'source-' + key, targetNative = 'target-' + key;
  const leaseId = randomUUID(), portId = randomUUID();
  const content = `---\ntitle: Continuation\nslug: ${slug}\nstatus: active\n---\n`;
  const planHash = hashPlanContent(content);
  await seedPlan(fx.admin, ws, 'papercusp', slug, content);
  await fx.admin`UPDATE harness_shared.harness_plans SET content_hash = ${planHash}
    WHERE workspace_id = ${ws} AND harness_slug = 'papercusp' AND plan_slug = ${slug}`;
  const [revision] = await fx.admin`INSERT INTO harness_shared.plan_revisions
    (workspace_id, harness_slug, plan_slug, seq, content_hash, content_snapshot, author_kind, author_id, created_at)
    VALUES (${ws}, 'papercusp', ${slug}, 1, ${planHash}, ${content}, 'agent', 'author', ${Date.now()}) RETURNING id`;
  await fx.admin`INSERT INTO harness_shared.plan_audits
    (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind, activation,
     audited_plan_revision_id, audited_plan_revision_seq, audited_plan_content_hash)
    VALUES (${ws}, 'papercusp', ${slug}, 1, 'author', 'activation', '{}', ${revision!.id}, 1, ${planHash})`;
  const confinement = JSON.parse(JSON.stringify(blindReviewerConfinement(slug)));
  const profile = { account: 'auto', headless: true, launchedBy: 'system:blind-gap-review' };
  const [source] = await fx.admin`INSERT INTO harness_shared.adv_sessions
    (workspace_id, mode, coord_owner_id, session_id, agent, launch_spec, ended_at)
    VALUES (${ws}, 'omp', ${owner}, ${sourceNative}, 'claude', ${JSON.stringify({ ...profile, model: 'opus' })}::jsonb,
      clock_timestamp()) RETURNING id`;
  const [target] = await fx.admin`INSERT INTO harness_shared.adv_sessions
    (workspace_id, mode, coord_owner_id, session_id, agent, launch_spec, port_id, port_source_adv_session_id, port_status)
    VALUES (${ws}, 'omp', ${owner}, ${targetNative}, 'codex', ${JSON.stringify({ ...profile, model: 'sol:xhigh' })}::jsonb,
      ${portId}, ${source!.id}, 'pending') RETURNING id`;
  const sourceId = Number(source!.id), targetId = Number(target!.id);
  const metadata = { sourceCoordOwnerId: owner, targetCoordOwnerId: owner, targetNativeSessionId: targetNative,
    bootstrapReceiptCommitted: true, bootstrapReceiptTargetAdvSessionId: targetId, bootstrapRequestHash: 'e'.repeat(64),
    summary: { source: { workspaceId: ws, advSessionId: sourceId, nativeSessionId: sourceNative, backend: 'claude' },
      target: { backend: 'codex' }, hashes: { rendered: 'c'.repeat(64) } },
    persistenceProof: { persisted: true, renderedHash: 'c'.repeat(64), nativeRef: '/managed/' + targetNative + '.jsonl' } };
  await fx.admin`INSERT INTO harness_shared.session_ports
    (id, workspace_id, idempotency_key, protocol_version, source_adv_session_id, target_adv_session_id,
     source_backend, target_backend, target_model, status, source_hash, normalized_hash, rendered_hash, token_hash,
     artifact_path, metadata, expires_at)
    VALUES (${portId}, ${ws}, ${key}, 2, ${sourceId}, ${targetId}, 'claude', 'codex', 'sol:xhigh', 'pending',
      ${'a'.repeat(64)}, ${'b'.repeat(64)}, ${'c'.repeat(64)}, ${'d'.repeat(64)}, '/managed/port',
      ${JSON.stringify(metadata)}::jsonb, clock_timestamp() + interval '10 minutes')`;
  const [binding] = await fx.admin`INSERT INTO harness_shared.plan_blind_review_sessions
    (workspace_id, harness_slug, plan_slug, activation_audit_seq, reviewer_owner_id, adv_session_id,
     native_session_id, launch_parent_owner, account_route, model_spec, confinement_snapshot,
     status, resume_lease_id, resume_lease_expires_at)
    VALUES (${ws}, 'papercusp', ${slug}, 1, ${owner}, ${sourceId}, ${sourceNative}, 'system:blind-gap-review',
      'auto', 'opus', ${JSON.stringify(confinement)}::jsonb, 'resuming', ${leaseId},
      clock_timestamp() + interval '10 minutes') RETURNING id`;
  await fx.admin`INSERT INTO harness_shared.operator_session_confinements (workspace_id, payload, updated_at)
    VALUES (${ws}, '{}', 0) ON CONFLICT (workspace_id) DO NOTHING`;
  await fx.admin`UPDATE harness_shared.operator_session_confinements SET payload = jsonb_set(payload,
    '{sessions}', COALESCE(payload->'sessions', '{}') || ${JSON.stringify({ [owner]: { confinement,
      expiresAt: new Date(Date.now() + 600_000).toISOString() } })}::jsonb) WHERE workspace_id = ${ws}`;
  const input = { workspaceId: ws, bindingId: Number(binding!.id), leaseId, portId };
  const deps = { sql: fx.admin as never, readDeclaration: async () => confinement };
  const read = () => findBlindReviewSessionBinding({ workspaceId: ws, planSlug: slug, activationAuditSeq: 1 }, deps);
  const inScope = async <T>(fn: (tx: never, b: BlindReviewSessionBinding) => Promise<T>) => fx.admin.begin(async tx => {
    const { binding: b } = await lockBlindReviewContinuationScope(tx as never, ws, input.bindingId);
    return fn(tx as never, b);
  });
  const reserve = () => reserveBlindReviewContinuation(input, deps);
  const deliver = async () => {
    await fx.admin`UPDATE harness_shared.session_ports SET status = 'delivered', delivered_at = clock_timestamp() WHERE id = ${portId}`;
    await fx.admin`UPDATE harness_shared.adv_sessions SET port_status = 'delivered' WHERE id = ${targetId}`;
  };
  const finalize = (reservationId: number) => finalizeBlindReviewContinuation({ ...input, reservationId }, deps);
  return { input, deps, read, inScope, reserve, deliver, finalize, sourceId, sourceNative, targetId, targetNative, slug, owner };
}

describe('D011 legacy adoption authenticated request and policy adapter, real PG', () => {
  let policy: LegacyAdoptionPayload['policy'];
  async function adoption(forFence = false) {
    const f = await fixture(), ws = fx.workspaceId, key = randomUUID();
    if (!policy) {
      const root = 'legacy-org-' + key, leaf = 'legacy-ws-' + key;
      await upsertLayer({ layerId: root, level: 'organization', scopeRef: root, parentLayerId: null,
        rules: {}, exceptions: [], actor: 'admin:root', reason: 'isolated adoption fixture' }, fx.admin);
      await upsertLayer({ layerId: leaf, level: 'workspace', scopeRef: ws, parentLayerId: root,
        rules: {}, exceptions: [], actor: 'admin:root', reason: 'isolated adoption fixture' }, fx.admin);
      await recordBootstrapDelegation(fx.admin, { principal: 'admin:root', layerId: root });
      const load = await loadChainForWorkspace(ws, fx.admin);
      if (load.status !== 'ok') throw new Error('fixture policy unavailable');
      policy = { targetLayerId: leaf, authorityLayerId: leaf, baseVersion: 1, chainRevision: chainRevision(load.chain)! };
    }
    const [user] = await fx.admin`INSERT INTO harness_shared.users (username, display_name)
      VALUES (${'legacy-' + key}, 'Isolated adjudicator') RETURNING id`;
    const token = randomUUID(), human = 'user:' + user!.id, preparer = 'su-preparer-' + key;
    await fx.admin`INSERT INTO harness_shared.user_sessions (token, user_id, workspace_id, capabilities, expires_at)
      VALUES (${token}, ${user!.id}, ${ws}, '{}', clock_timestamp() + interval '10 minutes')`;
    const headers = new Headers({ cookie: 'papercusp_session=' + token });
    const grant = async (principal: string, capabilities: string[]) => grantDelegation({
      grantor: 'admin:root', principal, layerId: policy.authorityLayerId, capabilities,
      reason: 'private fixture only', expiresAt: new Date(Date.now() + 600_000) }, fx.admin);
    await grant(preparer, ['prepare']);
    const humanGrant = await grant(human, ['prepare', 'approve']);
    const digest = 'a'.repeat(64), at = new Date().toISOString();
    const payload: LegacyAdoptionPayload = { schema: 'blind-review-legacy-adoption/v1',
      attemptKey: randomUUID(), bootstrapKey: randomUUID(), operationDigest: digest,
      workspaceId: ws, harnessSlug: 'papercusp', planSlug: f.slug, planRevision: 1, planHash: digest,
      activationAuditSeq: 1, bindingId: f.input.bindingId, reviewerOwnerId: f.owner,
      original: { advSessionId: f.sourceId, nativeSessionId: f.sourceNative },
      observed: { advSessionId: f.sourceId, nativeSessionId: f.sourceNative, startedAt: at, endedAt: at,
        lifetimeEvidenceHash: digest }, target: { advSessionId: f.sourceId, nativeSessionId: randomUUID() },
      bindingHistoryHash: digest, outstandingEffectsHash: digest, independenceEvidenceHash: digest,
      confinementHash: digest, profileHash: digest, launchParentOwner: BLIND_GAP_REVIEW_ACTOR, accountRoute: 'auto',
      backend: 'claude', modelSpec: 'opus', activation: { specificationRevision: digest, stateRevision: digest },
      qualification: { apiManifestHash: digest, launcherManifestHash: digest, plannedHostManifestHash: digest,
        executedInputsHash: digest, dependencyManifestHash: digest }, policy, preparedPrincipal: preparer,
      authorizedExecutor: human, bootstrapPiSessionId: 'pi-' + key,
      bootstrapExpiresAt: new Date(Date.now() + 600_000).toISOString(), revocation: 'permanent-root-cutoff-no-reopen' };
    // This producer exercises the actual PG fence protocol. It deliberately
    // supplies NO claim of canonical independence or source qualification.
    const evidence = { bindingHistory: { fixtureOnly: true, bindingId: f.input.bindingId },
      outstandingEffects: { fixtureOnly: true, tasks: [] }, independence: { fixtureOnly: true },
      qualification: payload.qualification };
    if (forFence) {
      const b = (await f.read())!;
      const [revision] = await fx.admin`SELECT seq, content_hash FROM harness_shared.plan_revisions
        WHERE workspace_id = ${ws} AND plan_slug = ${f.slug} ORDER BY seq DESC LIMIT 1`;
      const [n] = await fx.admin`SELECT * FROM harness_shared.adv_sessions WHERE id = ${f.sourceId}`;
      payload.planHash = revision!.content_hash;
      payload.planRevision = Number(revision!.seq);
      payload.confinementHash = sensitivePayloadHash(b.confinementSnapshot);
      payload.profileHash = sensitivePayloadHash({ backend: n!.agent, spec: n!.launch_spec, argv: n!.launch_argv });
      payload.observed.startedAt = n!.started_at.toISOString();
      payload.observed.endedAt = n!.ended_at.toISOString();
      payload.observed.lifetimeEvidenceHash = sensitivePayloadHash({ advSessionId: f.sourceId,
        nativeSessionId: f.sourceNative, startedAt: payload.observed.startedAt, endedAt: payload.observed.endedAt });
      payload.bindingHistoryHash = sensitivePayloadHash(evidence.bindingHistory);
      payload.outstandingEffectsHash = sensitivePayloadHash(evidence.outstandingEffects);
      payload.independenceEvidenceHash = sensitivePayloadHash(evidence.independence);
      await fx.admin`UPDATE harness_shared.plan_blind_review_sessions SET status = 'ready',
        resume_lease_id = NULL, resume_lease_expires_at = NULL WHERE id = ${b.id}`;
    }
    const request = await prepareSensitiveAction({ workspaceId: ws, actionKind: LEGACY_ADOPTION_ACTION,
      ...policy, payload, simulation: { fixtureOnly: true }, preparedBy: preparer, reason: 'isolated policy/provenance control' }, fx.admin);
    const decision = { workspaceId: ws, requestId: request.requestId, decision: 'approve' as const, reason: 'private decision' };
    const approve = () => decideLegacyAdoption(decision, headers, { sql: fx.admin });
    // Scope locks precede request/approval and policy locks, as in the eventual fence.
    const consume = async () => {
      const resolve = await retainLegacyAdoptionHuman(headers, ws);
      return fx.admin.begin(async raw => {
        await lockBlindReviewContinuationScope(raw as never, ws, f.input.bindingId);
        return executeSensitiveActionInTransaction(raw, { requestId: request.requestId, executor: human, requestPrincipal: resolve },
          async (tx, approved) => (await lockLegacyAdoptionAuthorization(tx, approved, resolve)).attemptKey,
          async tx => (await tx<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!.now);
      });
    };
    const reserveInput = { workspaceId: ws, bindingId: f.input.bindingId,
      requestId: request.requestId, expectedPayloadHash: request.payloadHash };
    const reserve = async (readEvidence = async () => evidence) => reserveLegacyAdoption(reserveInput,
      await retainLegacyAdoptionHuman(headers, ws), { sql: fx.admin as never, readEvidence });
    const roots = () => fx.admin`SELECT * FROM harness_shared.blind_review_continuation_custody
      WHERE workspace_id = ${ws} AND binding_id = ${f.input.bindingId} ORDER BY id`;
    return { ...f, payload, request, human, humanGrant, token, headers, decision, approve, consume,
      reserve, reserveInput, roots, evidence };
  }

  async function independenceFixture() {
    const f = await adoption(true), author = 'su-author-' + randomUUID();
    await fx.admin`UPDATE harness_shared.harness_plans SET owner = ${author}
      WHERE workspace_id = ${fx.workspaceId} AND plan_slug = ${f.slug}`;
    await fx.admin`UPDATE harness_shared.plan_revisions SET author_id = ${author}
      WHERE workspace_id = ${fx.workspaceId} AND plan_slug = ${f.slug}`;
    await fx.admin`UPDATE harness_shared.plan_audits SET created_by = ${author}
      WHERE workspace_id = ${fx.workspaceId} AND plan_slug = ${f.slug}`;
    for (const owner of [author, f.payload.preparedPrincipal])
      await fx.admin`INSERT INTO harness_shared.adv_sessions
        (workspace_id, mode, coord_owner_id, session_id, agent, launch_spec, ended_at)
        VALUES (${fx.workspaceId}, 'omp', ${owner}, ${randomUUID()}, 'codex',
          ${JSON.stringify({ launchedBy: 'system:independence-fixture', account: 'auto' })}::jsonb, clock_timestamp())`;
    const measure = (approvers: string[] = []) => f.inScope(tx => readLegacyAdoptionIndependence(tx, f.payload, approvers));
    return { ...f, author, measure };
  }

  async function censusFixture() {
    const f = await adoption(true);
    const census = () => f.inScope(tx => readLegacyAdoptionHistoryAndEffects(tx, f.payload));
    const task = async (id: string, extra: { parent?: string; root?: string; detail?: object; owner?: string;
      state?: string; started?: string; ended?: string | null } = {}) => {
      await fx.admin`INSERT INTO harness_shared.task_ledger
        (task_id, workspace_id, root_task_id, parent_task_id, class, title, launched_by, detail, state, started_at, ended_at)
        VALUES (${id}, ${fx.workspaceId}, ${extra.root ?? id}, ${extra.parent ?? null}, 'agent-session', 'census fixture',
          ${extra.owner ?? 'unattributed'}, ${JSON.stringify(extra.detail ?? {})}::jsonb, ${extra.state ?? 'exited'},
          ${extra.started ?? f.payload.observed.startedAt}, ${extra.ended === undefined ? f.payload.observed.endedAt : extra.ended})`;
    };
    return { ...f, census, task };
  }

  it('retains the original nullable request/election history and timestamp bytes without claiming physical absence', async () => {
    const f = await censusFixture(), measured = await f.census();
    expect(measured.bindingHistory.bindings.find(b => Number(b.id) === f.input.bindingId)).toMatchObject({
      replacement_of: null, attempt_seq: 0, request_key: null, request_hash: null, request_snapshot: null, launch_key: null });
    expect(measured.bindingHistory.audits).toHaveLength(1);
    expect(measured.outstandingEffects.natives.find(n => Number(n.id) === f.sourceId)?.startedAt).toEqual(expect.any(String));
    expect(measured.outstandingEffects.physicalQualification).toBe('required');
    expect(await f.roots()).toHaveLength(0);
    expect(sensitivePayloadHash((await f.census()).bindingHistory)).toBe(sensitivePayloadHash(measured.bindingHistory));
    await fx.admin`UPDATE harness_shared.adv_sessions SET ended_at = ended_at + interval '1 microsecond' WHERE id = ${f.sourceId}`;
    expect(sensitivePayloadHash((await f.census()).outstandingEffects)).not.toBe(sensitivePayloadHash(measured.outstandingEffects));
  });

  it('finds historically unattributed overlapping tasks and their later descendants', async () => {
    const f = await censusFixture(), parent = 'census-' + randomUUID(), child = 'child-' + randomUUID();
    await f.task(parent);
    await f.task(child, { parent, root: parent, started: new Date(Date.parse(f.payload.observed.endedAt) + 60_000).toISOString() });
    const measured = await f.census();
    expect(measured.outstandingEffects.tasks.map(t => t.task_id)).toEqual(expect.arrayContaining([parent, child]));
    expect(measured.outstandingEffects.physicalQualification).toBe('required');
  });

  it.each(['memberResults', 'processHandles'] as const)('follows %s task handles outside the observed lifetime', async field => {
    const f = await censusFixture(), id = 'handle-' + randomUUID();
    await f.task(id, { started: '2001-01-01T00:00:00Z', ended: '2001-01-01T00:01:00Z' });
    await fx.admin`INSERT INTO harness_shared.agent_launch_idempotency
      (workspace_id, idempotency_key, launched_at, launched_by, summary) VALUES
      (${fx.workspaceId}, ${randomUUID()}, 1, 'unattributed',
        ${JSON.stringify({ launchState: 'completed', [field]: { 0: { ownerId: f.owner, taskId: id } } })}::jsonb)`;
    expect((await f.census()).outstandingEffects.tasks.map(t => t.task_id)).toContain(id);
  });

  it('retains an uncertain unassigned recruiter launch rather than interpreting no owner match as no effects', async () => {
    const f = await censusFixture();
    await fx.admin`INSERT INTO harness_shared.agent_launch_idempotency
      (workspace_id, idempotency_key, launched_at, launched_by, summary) VALUES
      (${fx.workspaceId}, ${randomUUID()}, ${Date.parse(f.payload.observed.startedAt)}, ${BLIND_GAP_REVIEW_ACTOR}, '{}')`;
    expect((await f.census()).outstandingEffects.unresolved).toContain('launch-outcome');
  });

  it.each(['pending', 'stranded', 'unaccounted'] as const)('retains %s task uncertainty', async state => {
    const f = await censusFixture(), id = 'uncertain-' + randomUUID();
    await f.task(id, { state, owner: f.owner });
    expect((await f.census()).outstandingEffects.unresolved).toContain('task-outcome');
  });

  it('refuses a changed canonical activation instead of hashing an obsolete election', async () => {
    const f = await censusFixture();
    await fx.admin`UPDATE harness_shared.plan_audits SET audited_plan_content_hash = ${'b'.repeat(64)}
      WHERE workspace_id = ${fx.workspaceId} AND plan_slug = ${f.slug} AND audit_seq = 1`;
    await expect(f.census()).rejects.toThrow('activation_audit_mismatch');
  });

  it('refuses a truncated task census instead of returning an empty or partial absence proof', async () => {
    const f = await censusFixture();
    for (let i = 0; i < 129; i++) await f.task('bounded-' + randomUUID(), { owner: f.owner });
    await expect(f.census()).rejects.toThrow('task effects census incomplete');
  });

  it('reads the canonical author, implementer, user aliases and complete lineage without qualifying source', async () => {
    const f = await independenceFixture(), measured = await f.measure([f.human]);
    expect(measured.independence.authors).toEqual([f.author]);
    expect(measured.independence.implementers).toContain(f.author);
    expect(measured.independence.parties.find(p => p.identity === f.human)?.mapping.kind).toBe('user');
    expect(measured.approvalEvidence.map(p => p.identity)).toEqual([f.human]);
    expect(measured.independence).not.toHaveProperty('qualification');
    expect(sensitivePayloadHash((await f.measure()).independence)).toBe(sensitivePayloadHash(measured.independence));
    expect(await f.roots()).toHaveLength(0);
  });

  it('refuses a missing canonical author instead of accepting an empty independence graph', async () => {
    const f = await independenceFixture();
    await fx.admin`UPDATE harness_shared.harness_plans SET owner = NULL
      WHERE workspace_id = ${fx.workspaceId} AND plan_slug = ${f.slug}`;
    await expect(f.measure()).rejects.toThrow('canonical current author');
  });

  it('refuses an unmapped historical author even when current author and reviewer are known', async () => {
    const f = await independenceFixture();
    await fx.admin`UPDATE harness_shared.plan_revisions SET author_id = 'unknown-historical-author'
      WHERE workspace_id = ${fx.workspaceId} AND plan_slug = ${f.slug}`;
    await expect(f.measure()).rejects.toThrow('identity mapping');
  });

  it('refuses an unverified adjudicator alias', async () => {
    const f = await independenceFixture();
    await expect(f.measure(['user:' + randomUUID()])).rejects.toThrow('identity mapping');
    await expect(f.measure(['admin:operator'])).rejects.toThrow('population');
  });

  it('remeasures revoked historical human aliases and catches the implementer under another identity', async () => {
    const f = await independenceFixture(); await f.measure();
    await fx.admin`INSERT INTO harness_shared.power_user_sessions
      (auth_session_id, workspace_id, user_id, revoked_at)
      VALUES (${f.payload.preparedPrincipal}, ${fx.workspaceId}, ${f.human.slice(5)}, clock_timestamp())`;
    await expect(f.measure()).rejects.toThrow('share an author, implementer or reviewer lineage');
  });

  it('maps a raw canonical user UUID author to the same cookie adjudicator', async () => {
    const f = await independenceFixture();
    await fx.admin`UPDATE harness_shared.harness_plans SET owner = ${f.human.slice(5)}
      WHERE workspace_id = ${fx.workspaceId} AND plan_slug = ${f.slug}`;
    await expect(f.measure()).rejects.toThrow('share an author, implementer or reviewer lineage');
  });

  it('remeasures reviewer launch ancestry instead of treating a changed owner label as independent', async () => {
    const f = await independenceFixture(); await f.measure();
    await fx.admin`UPDATE harness_shared.adv_sessions SET launch_spec = jsonb_set(launch_spec,
      '{launchedBy}', ${JSON.stringify(f.author)}::jsonb) WHERE id = ${f.sourceId}`;
    await expect(f.measure()).rejects.toThrow('share an author, implementer or reviewer lineage');
  });

  it('refuses missing launch provenance rather than proving independence from missing edges', async () => {
    const f = await independenceFixture();
    await fx.admin`UPDATE harness_shared.adv_sessions SET launch_spec = launch_spec - 'launchedBy'
      WHERE workspace_id = ${fx.workspaceId} AND coord_owner_id = ${f.payload.preparedPrincipal}`;
    await expect(f.measure()).rejects.toThrow('launch provenance unavailable');
  });

  it('refuses an oversized authenticated alias census rather than silently dropping identities', async () => {
    const f = await independenceFixture();
    await fx.admin`INSERT INTO harness_shared.power_user_sessions (auth_session_id, workspace_id, user_id)
      SELECT ${f.human} || '-alias-' || n, ${fx.workspaceId}, ${f.human.slice(5)} FROM generate_series(1, 129) n`;
    await expect(f.measure()).rejects.toThrow('alias census incomplete');
  });

  it('refuses a truncated implementer census in the maintained population reader', async () => {
    const f = await independenceFixture();
    await fx.admin`INSERT INTO harness_shared.plan_audits
      (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind, activation)
      SELECT ${fx.workspaceId}, 'papercusp', ${f.slug}, n + 1, ${f.author}, 'completion', '{}'
        FROM generate_series(1, 128) n`;
    await expect(f.measure()).rejects.toThrow('implementer_census_incomplete');
  });

  async function runtimeAbsenceFixture() {
    const f = await adoption(true), leaseId = randomUUID();
    await fx.admin`INSERT INTO harness_shared.blind_review_runtime_leases
      (id, workspace_id, binding_id, activation_audit_seq, replacement_epoch, request_id, request_hash,
       state, receipt_id, admission, expires_at, revoked_at)
      VALUES (${leaseId}, ${fx.workspaceId}, ${f.input.bindingId}, 1, 0, ${randomUUID()}, ${'b'.repeat(64)},
        'released', ${randomUUID()}, '{}', clock_timestamp(), clock_timestamp())`;
    const store = createRuntimeCustodyStore({ sql: fx.admin as never, lifecycleSql: fx.admin as never,
      checkAuthority: async () => false }); // No grant/provisioning in this fixture.
    const identity = { workspaceId: fx.workspaceId, bindingId: f.input.bindingId, activationAuditSeq: 1,
      replacementEpoch: 0, reviewerOwnerId: f.owner, nativeSessionId: f.sourceNative, confinementFingerprint: 'a'.repeat(64) };
    const creator = <T>(run: () => Promise<T>) => store.withLifecycle(identity, leaseId, run);
    const proof = { scopeAbsent: true, creatorStopped: true, absentIntentIds: [] as string[],
      checkedKinds: [...RUNTIME_RESOURCE_KINDS] };
    const measure = (inspect = async () => proof) => f.inScope(tx =>
      readLegacyAdoptionRuntimeAbsence(tx, f.payload, { backend: { inspect } }));
    return { ...f, leaseId, creator, proof, measure };
  }

  it('refuses a live creator on another PG connection before physical inspection', async () => {
    const f = await runtimeAbsenceFixture(); let calls = 0;
    expect(await f.creator(async () => {
      await expect(f.measure(async () => { calls++; return f.proof; })).rejects.toThrow('creator is not fenced');
      return 'held';
    })).toEqual({ acquired: true, value: 'held' });
    expect(calls).toBe(0);
    expect(await f.measure()).toMatchObject({ observations: [{ leaseId: f.leaseId }],
      processQualification: 'required', sourceQualification: 'required' });
  });

  it.each(['commit', 'rollback'] as const)('holds the creator fence through outer %s after inspection returns', async outcome => {
    const f = await runtimeAbsenceFixture(); let created = 0;
    const create = () => f.creator(async () => { created++; return true; });
    const transaction = f.inScope(async tx => {
      await readLegacyAdoptionRuntimeAbsence(tx, f.payload, { backend: { inspect: async () => {
        expect(await create()).toEqual({ acquired: false });
        return f.proof;
      } } });
      expect(await create()).toEqual({ acquired: false }); expect(created).toBe(0);
      if (outcome === 'rollback') throw new Error('outer rollback');
    });
    if (outcome === 'rollback') await expect(transaction).rejects.toThrow('outer rollback');
    else await transaction;
    expect(await create()).toEqual({ acquired: true, value: true }); expect(created).toBe(1);
  });

  it.each(['scope', 'creator', 'kinds', 'intents', 'extra-intent'] as const)(
    'refuses incomplete %s physical evidence despite a released row', async field => {
      const f = await runtimeAbsenceFixture(), resourceId = randomUUID();
      await fx.admin`INSERT INTO harness_shared.blind_review_runtime_resources
        (id, workspace_id, lease_id, kind, slot, ownership_tag)
        VALUES (${resourceId}, ${fx.workspaceId}, ${f.leaseId}, 'process', 'main',
          ${runtimeCustodyFingerprint({ leaseId: f.leaseId, kind: 'process', slot: 'main' })})`;
      const proof = { ...f.proof, absentIntentIds: [resourceId],
        ...(field === 'scope' ? { scopeAbsent: false } : field === 'creator' ? { creatorStopped: false }
          : field === 'kinds' ? { checkedKinds: [] } : field === 'extra-intent'
            ? { absentIntentIds: [resourceId, randomUUID()] } : { absentIntentIds: [] }) };
      await expect(f.measure(async () => proof)).rejects.toThrow('physical absence is not verified');
      expect(await f.creator(async () => true)).toEqual({ acquired: true, value: true });
    });

  it('refuses an unfinished cutoff without physical inspection or repairing its row', async () => {
    const f = await runtimeAbsenceFixture(); let inspected = false;
    await fx.admin`UPDATE harness_shared.blind_review_runtime_leases SET state = 'releasing' WHERE id = ${f.leaseId}`;
    await expect(f.measure(async () => { inspected = true; return f.proof; })).rejects.toThrow('cutoff is not settled');
    expect(inspected).toBe(false);
    expect(await fx.admin`SELECT state FROM harness_shared.blind_review_runtime_leases WHERE id = ${f.leaseId}`)
      .toEqual([{ state: 'releasing' }]);
  });

  it('requires the actual custody transaction for runtime absence', async () => {
    const f = await runtimeAbsenceFixture();
    await expect(readLegacyAdoptionRuntimeAbsence(fx.admin as never, f.payload)).rejects.toThrow('custody transaction');
  });

  it('commits the fence, runtime cutoff, exact lease, replay receipt and consumed request together', async () => {
    const f = await adoption(true), original = await f.read(); await f.approve();
    const leaseId = randomUUID();
    await fx.admin`INSERT INTO harness_shared.blind_review_runtime_leases
      (id, workspace_id, binding_id, activation_audit_seq, replacement_epoch, request_id, request_hash,
       state, receipt_id, admission, expires_at)
      VALUES (${leaseId}, ${fx.workspaceId}, ${f.input.bindingId}, 1, 0, ${randomUUID()}, ${'b'.repeat(64)},
        'ready', ${randomUUID()}, '{}', clock_timestamp() + interval '10 minutes')`;
    const result = await f.reserve(), rows = await f.roots();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_kind: 'legacy-fenced', evidence: { result } });
    expect((await getSensitiveAction(f.request.requestId, fx.admin))!).toMatchObject({ status: 'executed', result });
    expect(await f.read()).toMatchObject({ ...original, status: 'resuming',
      resumeLeaseId: rows[0]!.resume_lease_id, resumeLeaseExpiresAt: result.expiresAt });
    expect(await fx.admin`SELECT state, revoked_at IS NOT NULL AS revoked FROM harness_shared.blind_review_runtime_leases
      WHERE id = ${leaseId}`).toEqual([{ state: 'releasing', revoked: true }]);
    expect(await f.inScope(tx => resolveBlindReviewEndpoint(tx, original!))).toBeNull();
    const [receipt] = await fx.admin`SELECT summary FROM harness_shared.agent_launch_idempotency
      WHERE workspace_id = ${fx.workspaceId} AND idempotency_key = ${'bootstrap-su:' + f.payload.bootstrapKey}`;
    expect(receipt!.summary).toEqual({ legacyAdoption: result, requestId: f.request.requestId, payloadHash: f.request.payloadHash });
  });

  it('returns the same committed receipt on concurrent calls without re-running the evidence producer', async () => {
    const f = await adoption(true); await f.approve(); let calls = 0;
    const read = async () => { calls++; return f.evidence; };
    const results = await Promise.all([f.reserve(read), f.reserve(read)]);
    expect(results[0]).toEqual(results[1]); expect(calls).toBe(1); expect(await f.roots()).toHaveLength(1);
    expect(await f.reserve(async () => { throw new Error('retry must be read-only'); })).toEqual(results[0]);
  });

  it('shows no partial fence on another connection while validation is in progress', async () => {
    const f = await adoption(true); await f.approve();
    let reached!: () => void, release!: () => void;
    const waiting = new Promise<void>(r => { reached = r; }), gate = new Promise<void>(r => { release = r; });
    const run = f.reserve(async () => { reached(); await gate; return f.evidence; });
    try {
      await waiting;
      expect(await f.roots()).toHaveLength(0);
      expect((await getSensitiveAction(f.request.requestId, fx.admin))!.status).toBe('approved');
    } finally { release(); }
    await run;
    expect(await f.roots()).toHaveLength(1);
  });

  it('refuses without an evidence producer instead of treating approval hashes as measurements', async () => {
    const f = await adoption(true); await f.approve();
    await expect(reserveLegacyAdoption(f.reserveInput, await retainLegacyAdoptionHuman(f.headers, fx.workspaceId),
      { sql: fx.admin as never })).rejects.toThrow('evidence reader unavailable');
    expect(await f.roots()).toHaveLength(0);
    expect((await getSensitiveAction(f.request.requestId, fx.admin))!.status).toBe('approved');
  });

  it.each(['bindingHistory', 'outstandingEffects', 'independence', 'qualification'] as const)(
    'cancels stale %s evidence without committing a root or recruiter lease', async field => {
      const f = await adoption(true); await f.approve();
      const changed = { ...f.evidence, [field]: {} };
      await expect(f.reserve(async () => changed as typeof f.evidence)).rejects.toThrow('pins changed');
      expect(await f.roots()).toHaveLength(0);
      expect((await getSensitiveAction(f.request.requestId, fx.admin))!.status).toBe('cancelled');
      expect((await f.read())!.resumeLeaseId).toBeNull();
    });

  it('rolls back the real root and lease when a later replay-receipt insert fails', async () => {
    const f = await adoption(true); await f.approve();
    await fx.admin`INSERT INTO harness_shared.agent_launch_idempotency
      (workspace_id, idempotency_key, launched_at, summary)
      VALUES (${fx.workspaceId}, ${'bootstrap-su:' + f.payload.bootstrapKey}, ${Date.now()}, '{}')`;
    await expect(f.reserve()).rejects.toMatchObject({ code: '23505' });
    expect(await f.roots()).toHaveLength(0); expect((await f.read())!.resumeLeaseId).toBeNull();
    expect((await getSensitiveAction(f.request.requestId, fx.admin))!.status).toBe('approved');
  });

  it('does not repair a missing committed replay receipt or renew a lease on retry', async () => {
    const f = await adoption(true); await f.approve(); const result = await f.reserve();
    await fx.admin`DELETE FROM harness_shared.agent_launch_idempotency WHERE workspace_id = ${fx.workspaceId}
      AND idempotency_key = ${'bootstrap-su:' + f.payload.bootstrapKey}`;
    await expect(f.reserve()).rejects.toThrow('root/result/receipt');
    expect(await f.roots()).toHaveLength(1); expect((await f.read())!.resumeLeaseExpiresAt).toBe(result.expiresAt);
  });

  it('refuses a raw principal closure and a changed approved hash before any fence effects', async () => {
    const f = await adoption(true); await f.approve();
    await expect(reserveLegacyAdoption(f.reserveInput, async () => ({ kind: 'user', slug: f.human.slice(5),
      workspaceId: fx.workspaceId, trust: 'verified', authMethod: 'cookie-session' }) as never,
    { sql: fx.admin as never })).rejects.toThrow('retained adoption cookie');
    await expect(reserveLegacyAdoption({ ...f.reserveInput, expectedPayloadHash: 'f'.repeat(64) },
      await retainLegacyAdoptionHuman(f.headers, fx.workspaceId), { sql: fx.admin as never })).rejects.toThrow('hash differs');
    expect(await f.roots()).toHaveLength(0);
  });

  it('uses actual cookie authentication and stores only server-derived approval provenance', async () => {
    const f = await adoption(), approved = await f.approve();
    expect(approved.approvals[0]!.approver).toBe(f.human);
    const evidence = JSON.parse(approved.approvals[0]!.reason);
    expect(evidence).toMatchObject({ schema: 'blind-review-legacy-adoption-approval/v1',
      requestPayloadHash: f.request.payloadHash, auth: { kind: 'user', workspaceId: fx.workspaceId,
        authMethod: 'cookie-session', trust: 'verified' } });
    expect(approved.approvals[0]!.reason).not.toContain(f.token);
    expect(await f.consume()).toMatchObject({ ok: true, result: f.payload.attemptKey });
    expect((await getSensitiveAction(f.request.requestId, fx.admin))!.status).toBe('executed');
    expect(await f.consume()).toMatchObject({ ok: false, error: { code: 'replayed' } });
    // This unit has no custody effect and cannot manufacture a source/host grant.
    expect(await fx.admin`SELECT id FROM harness_shared.blind_review_continuation_custody
      WHERE binding_id = ${f.input.bindingId}`).toHaveLength(0);
  });

  it.each(['raw actor', 'serialized principal', 'empty loopback headers', 'foreign workspace', 'caller provenance'])(
    'refuses %s without recording a decision', async fault => {
      const f = await adoption();
      const headers = fault === 'raw actor' ? f.human : fault === 'serialized principal'
        ? { kind: 'user', slug: f.human.slice(5), trust: 'verified' }
        : fault === 'empty loopback headers' ? new Headers({ host: 'localhost' }) : f.headers;
      const decision = { ...f.decision, ...(fault === 'foreign workspace' ? { workspaceId: 'foreign-workspace' } : {}),
        ...(fault === 'caller provenance' ? { auth: { kind: 'user' }, approver: f.human } : {}) };
      await expect(decideLegacyAdoption(decision, headers as Headers, { sql: fx.admin })).rejects.toThrow();
      expect((await getSensitiveAction(f.request.requestId, fx.admin))!.approvals).toHaveLength(0);
    });

  it('refuses a generic action even when its payload claims adoption', async () => {
    const f = await adoption();
    expect(() => validateLegacyAdoptionRequest({ ...f.request, actionKind: 'governance-policy-change' })).toThrow('not an exact');
    expect(() => validateLegacyAdoptionRequest({ ...f.request, payload: { ...f.payload, extra: true } })).toThrow('not an exact');
    const changed = { ...f.payload, target: { ...f.payload.target, advSessionId: f.targetId } };
    expect(() => validateLegacyAdoptionRequest({ ...f.request, payload: changed,
      payloadHash: sensitivePayloadHash(changed) })).toThrow('immutable tuple mismatch');
  });

  it.each(['plain text', 'foreign human', 'foreign hash', 'foreign workspace'])(
    'does not consume a generic approval with %s provenance', async fault => {
      const f = await adoption();
      const reason = fault === 'plain text' ? 'approved by admin' : JSON.stringify({
        schema: 'blind-review-legacy-adoption-approval/v1', humanReason: 'fixture',
        requestPayloadHash: fault === 'foreign hash' ? 'b'.repeat(64) : f.request.payloadHash,
        auth: { kind: 'user', slug: fault === 'foreign human' ? 'another' : f.human.slice(5),
          workspaceId: fault === 'foreign workspace' ? 'another' : fx.workspaceId,
          trust: 'verified', authMethod: 'cookie-session' } });
      // Model a legacy/imported approval that bypassed the authenticated adapter.
      // The generic public API must itself refuse to create such a decision.
      await expect(decideSensitiveAction({ requestId: f.request.requestId, approver: f.human,
        decision: 'approve', reason }, fx.admin)).rejects.toMatchObject({ code: 'forbidden' });
      await fx.admin`INSERT INTO harness_shared.sensitive_action_approvals
        (request_id, approver, decision, reason) VALUES (${f.request.requestId}, ${f.human}, 'approve', ${reason})`;
      await fx.admin`UPDATE harness_shared.sensitive_action_requests SET status = 'approved',
        approved_at = clock_timestamp(), execute_by = clock_timestamp() + interval '10 minutes'
        WHERE request_id = ${f.request.requestId}`;
      await expect(f.consume()).rejects.toMatchObject({ code: 'forbidden' });
      expect((await getSensitiveAction(f.request.requestId, fx.admin))!.status).toBe('approved');
    });

  it('rejects a fabricated resolver and rechecks actual cookie revocation before consumption', async () => {
    const f = await adoption(), approved = await f.approve();
    await expect(fx.admin.begin(tx => lockLegacyAdoptionAuthorization(tx as never, approved,
      async () => ({ kind: 'user', slug: f.human.slice(5), workspaceId: fx.workspaceId,
        trust: 'verified', authMethod: 'cookie-session', capabilities: new Set() })))).rejects.toThrow('retained request capability');
    const retained = await retainLegacyAdoptionHuman(f.headers, fx.workspaceId);
    await fx.admin`DELETE FROM harness_shared.user_sessions WHERE token = ${f.token}`;
    await expect(fx.admin.begin(tx => lockLegacyAdoptionAuthorization(tx as never, approved, retained)))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect((await getSensitiveAction(f.request.requestId, fx.admin))!.status).toBe('approved');
  });

  it('rechecks current approve/prepare delegation after authenticated approval', async () => {
    const f = await adoption(); await f.approve();
    await revokeDelegation({ revoker: 'admin:root', delegationId: f.humanGrant.delegationId,
      reason: 'private revocation control' }, fx.admin);
    expect(await f.consume()).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect((await getSensitiveAction(f.request.requestId, fx.admin))!.status).toBe('approved');
  });

  it('refuses generic policy/public execution and fabricated request resolvers before effects', async () => {
    const f = await adoption(); await f.approve();
    let effects = 0;
    await expect(executeSensitiveAction({ requestId: f.request.requestId, executor: f.human },
      async () => ++effects, fx.admin)).rejects.toMatchObject({ code: 'forbidden' });
    const applied = await applyGovernancePolicyChange({ requestId: f.request.requestId }, f.human);
    expect(applied).toMatchObject({ ok: false, code: 'forbidden' });
    await expect(decideSensitiveAction({ requestId: f.request.requestId, approver: f.human,
      decision: 'approve', reason: 'forged transport' }, fx.admin, async () => ({
        kind: 'user', slug: f.human.slice(5), workspaceId: fx.workspaceId, trust: 'verified',
        authMethod: 'cookie-session', capabilities: new Set() }))).rejects.toMatchObject({ code: 'forbidden' });
    expect(effects).toBe(0);
    expect((await getSensitiveAction(f.request.requestId, fx.admin))!.status).toBe('approved');
  });

  it('rolls back effects and the consumed mark when the actual cookie is revoked during execution', async () => {
    const f = await adoption(); await f.approve();
    await fx.admin`CREATE TABLE IF NOT EXISTS harness_shared.legacy_adoption_fixture_effects (request_id text PRIMARY KEY)`;
    const resolve = await retainLegacyAdoptionHuman(f.headers, fx.workspaceId);
    await expect(fx.admin.begin(async raw => {
      await lockBlindReviewContinuationScope(raw as never, fx.workspaceId, f.input.bindingId);
      return executeSensitiveActionInTransaction(raw, { requestId: f.request.requestId, executor: f.human,
        requestPrincipal: resolve }, async (tx, approved) => {
        await lockLegacyAdoptionAuthorization(tx, approved, resolve);
        await tx`INSERT INTO harness_shared.legacy_adoption_fixture_effects VALUES (${f.request.requestId})`;
        // Independent committed revocation while the effect transaction is open.
        await fx.admin`DELETE FROM harness_shared.user_sessions WHERE token = ${f.token}`;
        return 'effect-before-revocation';
      }, async tx => (await tx<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!.now);
    })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await fx.admin`SELECT request_id FROM harness_shared.legacy_adoption_fixture_effects
      WHERE request_id = ${f.request.requestId}`).toHaveLength(0);
    expect((await getSensitiveAction(f.request.requestId, fx.admin))!.status).toBe('approved');
  });
});

describe('blind reviewer continuation custody, real transaction boundaries', () => {
  // D009 storage preparation is deliberately insufficient for operational authority.
  async function legacyStorageFixture() {
    const f = await fixture(), attemptKey = randomUUID();
    const insert = async (kind: string, reservationId: number | null, overrides: {
      targetId?: number; portId?: string | null; attemptKey?: string | null;
    } = {}) => {
      const [row] = await fx.admin`INSERT INTO harness_shared.blind_review_continuation_custody
        (workspace_id, binding_id, reservation_id, event_kind, attempt_key, resume_lease_id,
         source_adv_session_id, target_adv_session_id, port_id, snapshot, evidence)
        VALUES (${f.input.workspaceId}, ${f.input.bindingId}, ${reservationId}, ${kind},
          ${overrides.attemptKey === undefined ? attemptKey : overrides.attemptKey}, ${f.input.leaseId},
          ${f.sourceId}, ${overrides.targetId ?? f.sourceId}, ${overrides.portId ?? null},
          '{"storageFixture":true}'::jsonb, '{}') RETURNING id`;
      return Number(row!.id);
    };
    return { ...f, insert };
  }

  it('stores the D009 legacy event shapes without treating storage as endpoint authority', async () => {
    const f = await legacyStorageFixture(), before = await f.read();
    await fx.admin`UPDATE harness_shared.adv_sessions SET ended_at = NULL WHERE id = ${f.sourceId}`;
    expect(await f.inScope((tx, b) => verifyBlindReviewEndpointCaller(tx, b, f.sourceId))).toBe(true);
    const root = await f.insert('legacy-fenced', null);
    for (const kind of ['legacy-fenced', 'legacy-admitted', 'legacy-settled', 'legacy-revoked']) {
      if (kind !== 'legacy-fenced') await f.insert(kind, root);
      expect(await f.inScope((tx, b) => resolveBlindReviewEndpoint(tx, b))).toBeNull();
      expect(await f.inScope((tx, b) => verifyBlindReviewEndpointCaller(tx, b, f.sourceId))).toBe(false);
    }
    expect(await f.read()).toEqual(before);
    const advs = await fx.admin`SELECT id FROM harness_shared.adv_sessions
      WHERE workspace_id = ${f.input.workspaceId} AND coord_owner_id = ${f.owner} ORDER BY id`;
    expect(advs.map(row => Number(row.id))).toEqual([f.sourceId, f.targetId]);
  });

  it.each(['legacy-fenced', 'legacy-admitted', 'legacy-settled', 'legacy-revoked'])(
    'enforces D009 uniqueness for %s independently of other event kinds', async kind => {
      const f = await legacyStorageFixture(), root = await f.insert('legacy-fenced', null);
      if (kind !== 'legacy-fenced') await f.insert(kind, root);
      await expect(f.insert(kind, kind === 'legacy-fenced' ? null : root)).rejects.toMatchObject({ code: '23505' });
    });

  it.each(['different ADV', 'port', 'missing attempt', 'root parent', 'missing parent'])(
    'rejects a D009 legacy storage row with %s', async fault => {
      const f = await legacyStorageFixture(), root = await f.insert('legacy-fenced', null);
      const kind = fault === 'root parent' ? 'legacy-fenced' : 'legacy-admitted';
      const parent = fault === 'missing parent' ? null : root;
      await expect(f.insert(kind, parent, {
        ...(fault === 'different ADV' ? { targetId: f.targetId } : {}),
        ...(fault === 'port' ? { portId: f.input.portId } : {}),
        ...(fault === 'missing attempt' ? { attemptKey: null } : {}),
      })).rejects.toMatchObject({ code: '23514' });
    });

  it('keeps D009 legacy custody append-only', async () => {
    const f = await legacyStorageFixture(), root = await f.insert('legacy-fenced', null);
    await expect(fx.admin`UPDATE harness_shared.blind_review_continuation_custody
      SET evidence = '{"changed":true}' WHERE id = ${root}`).rejects.toThrow('append-only');
    await expect(fx.admin`DELETE FROM harness_shared.blind_review_continuation_custody
      WHERE id = ${root}`).rejects.toThrow('append-only');
  });

  async function managedFixture() {
    const f = await fixture(), b = (await f.read())!;
    const activation = { status: 'applied', desired: { specificationRevision: 'a'.repeat(64), stateRevision: 'b'.repeat(64) },
      applied: { specificationRevision: 'a'.repeat(64), stateRevision: 'b'.repeat(64) } };
    await fx.admin`UPDATE harness_shared.adv_sessions SET ended_at = NULL,
      launch_spec = launch_spec || ${JSON.stringify(activation.applied)}::jsonb WHERE id = ${f.sourceId}`;
    await fx.admin`UPDATE harness_shared.plan_blind_review_sessions SET status = 'ready',
      resume_lease_id = NULL, resume_lease_expires_at = NULL WHERE id = ${b.id}`;
    await fx.admin`INSERT INTO harness_shared.session_briefs (workspace_id, owner_id, control_state)
      VALUES (${b.workspaceId}, ${f.owner}, ${JSON.stringify({ activation })}::jsonb)`;
    const request: ManagedSuccessionRequest = { requestKey: randomUUID(), ownerId: f.owner, advSessionId: f.sourceId,
      hostPid: 400, hostStartedAt: Date.now() - 1000, hostCodeVersion: 'c'.repeat(64), predecessorPid: 401,
      predecessorGeneration: 3, successorGeneration: 4, sourceNativeSessionId: f.sourceNative,
      successorNativeSessionId: f.targetNative, predecessorExited: true };
    let exited = true;
    const host = { ownerId: f.owner, advSessionId: String(f.sourceId), pid: 400, ptyPid: 401,
      startedAt: request.hostStartedAt, hostCodeVersion: request.hostCodeVersion, childGeneration: 3,
      nativeSessionId: f.sourceNative, command: 'codex', args: [], sock: '/isolated/fake.sock', managedSuccession: request };
    const deps = { ...f.deps, findHost: async () => structuredClone(host),
      processIdentity: (pid: number) => [400, 402].includes(pid) ? 'kernel:' + pid : null,
      exited: () => exited };
    const reserve = () => reserveBlindReviewManagedSuccession(b.workspaceId, request, deps);
    const successor = () => Object.assign(host, { childGeneration: 4, ptyPid: 402, nativeSessionId: f.targetNative });
    const settle = (permit?: Awaited<ReturnType<typeof reserve>>) => fx.admin.begin(async tx =>
      withBlindReviewManagedReanchor(tx as never, { workspaceId: b.workspaceId, advSessionId: f.sourceId,
        nativeSessionId: f.targetNative, ...(permit ? { permit } : {}) }, async () => {
        await tx`UPDATE harness_shared.adv_sessions SET session_id = ${f.targetNative} WHERE id = ${f.sourceId}`;
        return true;
      }, deps));
    const denyBoth = async () => {
      expect(await f.inScope((tx, binding) => resolveBlindReviewEndpoint(tx, binding))).toBeNull();
      expect(await f.inScope((tx, binding) => verifyBlindReviewEndpointCaller(tx, binding, f.sourceId))).toBe(false);
    };
    return { ...f, b, request, host, deps, reserve, successor, settle, denyBoth, setExited: (v: boolean) => { exited = v; } };
  }

  it('managed succession reserves before creation and transfers one native endpoint atomically', async () => {
    const f = await managedFixture();
    const permit = await f.reserve();
    expect(permit).toMatchObject({ bindingId: f.b.id });
    expect(await f.reserve()).toEqual(permit);
    await f.denyBoth();
    await expect(f.settle(permit)).rejects.toThrow('managed_host_unverified');
    f.successor();
    expect(await f.settle(permit)).toBe(true);
    expect(await f.settle(permit)).toBe(true);
    const endpoint = await f.inScope((tx, b) => resolveBlindReviewEndpoint(tx, b));
    expect(endpoint).toMatchObject({ advSessionId: f.sourceId, nativeSessionId: f.targetNative, requiresNativeProof: true });
    const original = await f.read();
    expect(original).toMatchObject({ nativeSessionId: f.sourceNative, advSessionId: f.sourceId, status: 'ready' });
    const [count] = await fx.admin`SELECT count(*)::int AS n FROM harness_shared.blind_review_continuation_custody
      WHERE binding_id = ${f.b.id}`;
    expect(count!.n).toBe(3);
    for (const nativeSessionId of [f.sourceNative, f.targetNative]) {
      const native = { carrier: 'meta:threadId' as const, binding: 'bound' as const, candidateAdvSessionId: f.sourceId,
        valueFingerprint: createHash('sha256').update(nativeSessionId).digest('hex') };
      expect(await f.inScope((tx, b) => verifyBlindReviewEndpointCaller(tx, b, f.sourceId, native)))
        .toBe(nativeSessionId === f.targetNative);
    }
    expect(await f.inScope((tx, b) => verifyBlindReviewEndpointCaller(tx, b, f.sourceId))).toBe(false);
    expect(await checkRuntimeReviewerAuthority(fx.admin as never, { workspaceId: f.b.workspaceId,
      bindingId: f.b.id, activationAuditSeq: 1, replacementEpoch: 0, reviewerOwnerId: f.owner,
      nativeSessionId: f.sourceNative, confinementFingerprint: runtimeCustodyFingerprint(f.b.confinementSnapshot) })).toBe(false);
  });

  it('rejects a legacy report with no reservation instead of rewriting its immutable tuple', async () => {
    const f = await managedFixture(); f.successor();
    await expect(f.settle()).rejects.toThrow('managed_reservation_required');
    const [row] = await fx.admin`SELECT session_id FROM harness_shared.adv_sessions WHERE id = ${f.sourceId}`;
    expect(row!.session_id).toBe(f.sourceNative);
  });

  it.each(['hash-only', 'snapshot-only', 'snapshot-array'] as const)(
    'rejects malformed original request metadata: %s', async fault => {
      const f = await managedFixture();
      // Original attempts permit null metadata at the schema layer. Mixed or
      // malformed pairs must never acquire managed continuation authority.
      await fx.admin`UPDATE harness_shared.plan_blind_review_sessions SET
        request_hash = ${fault === 'snapshot-only' ? null : 'a'.repeat(64)},
        request_snapshot = ${fault === 'hash-only' ? null : JSON.stringify(fault === 'snapshot-array' ? [] : {})}::jsonb
        WHERE id = ${f.b.id}`;
      await expect(f.reserve()).rejects.toThrow('managed_authority_stale');
      const [count] = await fx.admin`SELECT count(*)::int AS n FROM harness_shared.blind_review_continuation_custody
        WHERE binding_id = ${f.b.id}`;
      expect(count!.n).toBe(0);
    });

  it.each(['hash', 'snapshot', 'attempt-shape'] as const)(
    'rejects incomplete replacement metadata even if a damaged store admits it: %s', async fault => {
      const f = await managedFixture();
      // Exercise fail-closed reads of damaged storage without changing shared
      // schema or leaving this private transaction's constraint removed.
      const rollback = new Error('rollback malformed replacement fixture');
      await expect(fx.admin.begin(async tx => {
        await tx`ALTER TABLE harness_shared.plan_blind_review_sessions
          DROP CONSTRAINT plan_blind_review_sessions_attempt_shape_check`;
        await tx`UPDATE harness_shared.plan_blind_review_sessions SET replacement_of = ${f.b.id},
          attempt_seq = ${fault === 'attempt-shape' ? 0 : 1},
          request_hash = ${fault === 'hash' ? null : 'a'.repeat(64)},
          request_snapshot = ${fault === 'snapshot' ? null : '{}'}::jsonb WHERE id = ${f.b.id}`;
        await expect(reserveBlindReviewManagedSuccession(f.b.workspaceId, f.request, { ...f.deps,
          sql: { begin: (run: (value: unknown) => Promise<unknown>) => run(tx) } as never }))
          .rejects.toThrow('managed_authority_stale');
        throw rollback;
      })).rejects.toBe(rollback);
    });

  it('preserves an unchanged native report without creating succession custody', async () => {
    const f = await managedFixture();
    let writes = 0;
    await fx.admin.begin(async tx => withBlindReviewManagedReanchor(tx as never, {
      workspaceId: f.b.workspaceId, advSessionId: f.sourceId, nativeSessionId: f.sourceNative,
    }, async () => { writes++; return false; }, f.deps));
    expect(writes).toBe(1);
    expect(await f.inScope((tx, b) => resolveBlindReviewEndpoint(tx, b)))
      .toMatchObject({ advSessionId: f.sourceId, nativeSessionId: f.sourceNative, continuationId: null });
    const [count] = await fx.admin`SELECT count(*)::int AS n FROM harness_shared.blind_review_continuation_custody
      WHERE binding_id = ${f.b.id}`;
    expect(count!.n).toBe(0);
  });

  it('leaves unbound sessions on the generic native reanchor path', async () => {
    const f = await managedFixture(), owner = 'ordinary-' + randomUUID();
    const [adv] = await fx.admin`INSERT INTO harness_shared.adv_sessions
      (workspace_id, mode, coord_owner_id, session_id, agent, launch_spec)
      VALUES (${f.b.workspaceId}, 'omp', ${owner}, ${f.sourceNative}, 'codex', '{}') RETURNING id`;
    const advSessionId = Number(adv!.id);
    const request = { ...f.request, ownerId: owner, advSessionId };
    // An ordinary session needs neither a recruiter lease nor managed-host proof.
    expect(await reserveBlindReviewManagedSuccession(f.b.workspaceId, request, f.deps)).toBeNull();
    expect(await fx.admin.begin(async tx => withBlindReviewManagedReanchor(tx as never, {
      workspaceId: f.b.workspaceId, advSessionId, nativeSessionId: f.targetNative,
    }, async () => {
      await tx`UPDATE harness_shared.adv_sessions SET session_id = ${f.targetNative} WHERE id = ${advSessionId}`;
      return true;
    }, f.deps))).toBe(true);
    const [row] = await fx.admin`SELECT session_id FROM harness_shared.adv_sessions WHERE id = ${advSessionId}`;
    expect(row!.session_id).toBe(f.targetNative);
    const [count] = await fx.admin`SELECT count(*)::int AS n FROM harness_shared.blind_review_continuation_custody
      WHERE workspace_id = ${f.b.workspaceId} AND target_adv_session_id = ${advSessionId}`;
    expect(count!.n).toBe(0);
  });

  it('serializes competing requests and duplicate settlement callbacks', async () => {
    const f = await managedFixture();
    const results = await Promise.allSettled([f.reserve(), f.reserve()]);
    expect(results.every(r => r.status === 'fulfilled')).toBe(true);
    const permit = (results[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof f.reserve>>>).value;
    expect((results[1] as typeof results[0] & { value: unknown }).value).toEqual(permit);
    const competing = { ...f.request, requestKey: randomUUID() };
    f.host.managedSuccession = competing;
    await expect(reserveBlindReviewManagedSuccession(f.b.workspaceId, competing, f.deps))
      .rejects.toThrow('managed_source_invalid');
    f.host.managedSuccession = f.request; f.successor();
    expect(await Promise.all([f.settle(permit), f.settle(permit)])).toEqual([true, true]);
  });

  it.each(['live-predecessor', 'host-incarnation', 'generation', 'missing-storage'] as const)(
    'refuses unsafe managed admission: %s', async fault => {
      const f = await managedFixture();
      if (fault === 'live-predecessor') f.setExited(false);
      if (fault === 'host-incarnation') f.host.startedAt++;
      if (fault === 'generation') f.host.childGeneration++;
      if (fault === 'missing-storage') {
        // Rename is transaction-local and rolled back, never a shared migration.
        await expect(fx.admin.begin(async tx => {
          await tx`ALTER TABLE harness_shared.blind_review_continuation_custody RENAME TO absent_managed_custody`;
          await reserveBlindReviewManagedSuccession(f.b.workspaceId, f.request, { ...f.deps,
            sql: { begin: (run: (value: unknown) => Promise<unknown>) => run(tx) } as never });
        })).rejects.toThrow('continuation_storage_unavailable');
      } else await expect(f.reserve()).rejects.toThrow('managed_host_unverified');
    });

  it.each(['activation', 'manifest', 'confinement', 'receipt', 'successor', 'generation', 'lease-expired', 'lease-lost'] as const)(
    'keeps both endpoints denied after an uncertain or forged callback: %s', async fault => {
      const f = await managedFixture(), permit = (await f.reserve())!; f.successor();
      if (fault === 'activation') await fx.admin`UPDATE harness_shared.session_briefs
        SET control_state = jsonb_set(control_state, '{activation,status}', '"pending"') WHERE owner_id = ${f.owner}`;
      if (fault === 'manifest') await fx.admin`UPDATE harness_shared.plan_blind_review_sessions
        SET request_snapshot = '{"changed":true}' WHERE id = ${f.b.id}`;
      if (fault === 'confinement') await fx.admin`UPDATE harness_shared.operator_session_confinements
        SET payload = jsonb_set(payload, ${['sessions', f.owner, 'confinement']}, '{}') WHERE workspace_id = ${f.b.workspaceId}`;
      if (fault === 'receipt') permit.receiptId = randomUUID();
      if (fault === 'successor') f.host.nativeSessionId = 'forged-native';
      if (fault === 'generation') f.host.childGeneration++;
      if (fault === 'lease-expired') await fx.admin`UPDATE harness_shared.plan_blind_review_sessions
        SET resume_lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${f.b.id}`;
      if (fault === 'lease-lost') await fx.admin`UPDATE harness_shared.plan_blind_review_sessions
        SET resume_lease_id = ${randomUUID()} WHERE id = ${f.b.id}`;
      await expect(f.settle(permit)).rejects.toThrow();
      const [row] = await fx.admin`SELECT session_id FROM harness_shared.adv_sessions WHERE id = ${f.sourceId}`;
      expect(row!.session_id).toBe(f.sourceNative);
      if (fault !== 'confinement') await f.denyBoth();
    });

  it('keeps a crashed pre-child attempt uncertain after lease expiry', async () => {
    const f = await managedFixture(); await f.reserve();
    await fx.admin`UPDATE harness_shared.plan_blind_review_sessions SET resume_lease_expires_at =
      clock_timestamp() - interval '1 second' WHERE id = ${f.b.id}`;
    await f.denyBoth();
    await expect(f.reserve()).rejects.toThrow('resume_lease_lost');
  });
  async function nativeFixture() {
    const f = await fixture(), b = (await f.read())!;
    const request = { resume: { sessionId: f.sourceNative }, fork: false, headless: true,
      harness: 'papercusp', brief: 'Continue this exact blind review', idempotencyKey: randomUUID() };
    const basePermit: BlindReviewResumePermit = { bindingId: b.id, workspaceId: b.workspaceId,
      leaseId: f.input.leaseId, planSlug: b.planSlug, activationAuditSeq: b.activationAuditSeq,
      reviewerOwnerId: b.reviewerOwnerId, advSessionId: b.advSessionId, nativeSessionId: b.nativeSessionId };
    const permit = await reserveBlindReviewNativeAttempt({ permit: basePermit, request }, f.deps);
    const launchInput = { permit, request, workspaceId: b.workspaceId, actor: BLIND_GAP_REVIEW_ACTOR,
      systemRecruiter: true, confinement: b.confinementSnapshot };
    const run: typeof withBlindReviewNativeLaunch = (input, callback) => withBlindReviewNativeLaunch(input, callback, f.deps);
    const admission = async () => {
      const driver = new WorkItemAdmissionQueueDriver(new PgAdmissionLedgerQueueStore({ workspaceId: b.workspaceId,
        sql: fx.admin as unknown as SqlClient, resolveSessionStatesFn: allSessionsLiveResolver }), { namespace: 'agent-process' });
      return beginGovernedExecution({ admissionClass: 'agent', idempotencyKey: `blind-review-native:${permit.nativeAttempt!.key}`,
        metadata: { launchedBy: BLIND_GAP_REVIEW_ACTOR, targetOwnerId: f.owner,
          blindReviewAttemptKey: permit.nativeAttempt!.key } }, { owner: f.owner }, { driver, governor: new Governor(driver) });
    };
    const task = async (receiptId: string) => {
      const taskId = newTaskId();
      await fx.admin`INSERT INTO harness_shared.task_ledger
        (task_id, root_task_id, workspace_id, class, title, launched_by, pid, scope_unit, state, detail)
        VALUES (${taskId}, ${taskId}, ${b.workspaceId}, 'agent-session', 'native attempt fixture',
          ${BLIND_GAP_REVIEW_ACTOR}, 123, ${scopeUnitForTask(taskId)}, 'running', ${JSON.stringify({ coordOwnerId: f.owner,
            blindReviewAttemptKey: permit.nativeAttempt!.key, blindReviewAdmissionReceiptId: receiptId,
            blindReviewNativeSessionId: f.sourceNative })}::jsonb)`;
      return taskId;
    };
    const denied = async () => {
      expect(await f.inScope((tx, current) => resolveBlindReviewEndpoint(tx, current))).toBeNull();
      expect(await f.inScope((tx, current) => verifyBlindReviewEndpointCaller(tx, current, f.sourceId))).toBe(false);
      expect(await releaseBlindReviewSessionResume(b.id, f.input.leaseId, f.deps)).toBe(false);
      expect(await acquireBlindReviewSessionResume({ workspaceId: b.workspaceId, planSlug: f.slug,
        activationAuditSeq: 1 }, f.deps)).toMatchObject({ ok: false, code: 'binding_unavailable' });
    };
    return { ...f, request, basePermit, permit, launchInput, run, admission, task, denied };
  }

  it('native reservation commits before handler entry; exact no-open proof permits retry without rewriting history', async () => {
    const f = await nativeFixture();
    await f.denied();
    await expect(f.run(f.launchInput, async control => {
      expect(control?.endpoint.advSessionId).toBe(f.sourceId);
      throw new Error('pre-effect handler failure');
    })).rejects.toThrow('pre-effect handler failure');
    expect(await verifyBlindReviewNativeNoOpen(f.permit, f.deps)).toBe(true);
    const again = await reserveBlindReviewNativeAttempt({ permit: f.basePermit,
      request: { ...f.request, idempotencyKey: randomUUID() } }, f.deps);
    expect(again.nativeAttempt?.id).not.toBe(f.permit.nativeAttempt?.id);
    const rows = await fx.admin`SELECT event_kind FROM harness_shared.blind_review_continuation_custody
      WHERE binding_id = ${f.input.bindingId} ORDER BY id`;
    expect(rows.map(r => r.event_kind)).toEqual(['native-reserved', 'native-settled', 'native-reserved']);
    expect(await f.read()).toMatchObject({ advSessionId: f.sourceId, nativeSessionId: f.sourceNative });
  });

  it('crash after effect admission and timeout/no receipt retain uncertainty beyond lease expiry', async () => {
    const f = await nativeFixture(), execution = await f.admission();
    await expect(f.run(f.launchInput, async control => {
      await control!.beforeNativeCreate(null, execution.receiptId);
      throw new Error('crash after possible native open');
    })).rejects.toThrow('crash after possible native open');
    await fx.admin`UPDATE harness_shared.plan_blind_review_sessions SET resume_lease_expires_at =
      clock_timestamp() - interval '1 second' WHERE id = ${f.input.bindingId}`;
    await f.denied();
    const rows = await fx.admin`SELECT event_kind FROM harness_shared.blind_review_continuation_custody
      WHERE binding_id = ${f.input.bindingId} ORDER BY id`;
    expect(rows.map(r => r.event_kind)).toEqual(['native-reserved', 'native-admitted']);
    await execution.cancel('fixture cleanup');
  });

  it('checks expiry again after install/wait and refuses native creation', async () => {
    const f = await nativeFixture(), execution = await f.admission();
    await expect(f.run(f.launchInput, async control => {
      await fx.admin`UPDATE harness_shared.plan_blind_review_sessions SET resume_lease_expires_at =
        clock_timestamp() - interval '1 second' WHERE id = ${f.input.bindingId}`;
      await control!.beforeNativeCreate(null, execution.receiptId);
      throw new Error('must not create a process');
    })).rejects.toThrow('resume_lease_lost');
    await f.denied();
    await execution.cancel('fixture cleanup');
  });

  it('reconciles an exact surviving start after host loss and expiry, never owner/native identity alone', async () => {
    const f = await nativeFixture(), execution = await f.admission();
    await expect(f.run(f.launchInput, async control => {
      await control!.beforeNativeCreate(null, execution.receiptId);
      throw new Error('launcher host lost before settlement');
    })).rejects.toThrow('launcher host lost');
    const taskId = await f.task(execution.receiptId);
    await fx.admin`UPDATE harness_shared.adv_sessions SET ended_at = NULL WHERE id = ${f.sourceId}`;
    await fx.admin`UPDATE harness_shared.plan_blind_review_sessions SET resume_lease_expires_at =
      clock_timestamp() - interval '1 second' WHERE id = ${f.input.bindingId}`;
    const host: PsuPtyHost = { ownerId: f.owner, advSessionId: String(f.sourceId), pid: 456, ptyPid: 457,
      startedAt: Date.now(), childGeneration: 1, sock: '/fixture', command: 'claude',
      args: ['--resume', f.sourceNative] };
    const reconcile = (cgroup: string | null, findHost = async () => host) => f.inScope((tx, b) =>
      reconcileBlindReviewNativeStart(tx, b, { findHost, readCgroup: () => cgroup }));
    expect(await reconcile(null)).toBeNull();
    expect(await reconcile('/wrong-task.scope')).toBeNull();
    const cgroup = `/papercusp.slice/${scopeUnitForTask(taskId)}`;
    let reads = 0;
    expect(await reconcile(cgroup, async () => ({ ...host, childGeneration: ++reads }))).toBeNull();
    await f.denied();
    expect(await reconcile(cgroup)).toMatchObject({ advSessionId: f.sourceId,
      nativeSessionId: f.sourceNative, continuationId: expect.any(Number) });
    expect(await reconcile(cgroup)).toBeNull();
    const rows = await fx.admin`SELECT event_kind FROM harness_shared.blind_review_continuation_custody
      WHERE binding_id = ${f.input.bindingId} ORDER BY id`;
    expect(rows.map(r => r.event_kind)).toEqual(['native-reserved', 'native-admitted', 'native-settled']);
    expect(await releaseBlindReviewSessionResume(f.input.bindingId, f.input.leaseId, f.deps)).toBe(true);
    await execution.cancel('fixture cleanup');
  });

  it('settles only an exact admitted native start and cuts off the old runtime fingerprint', async () => {
    const f = await nativeFixture(), execution = await f.admission();
    await f.run(f.launchInput, async control => {
      await control!.beforeNativeCreate(null, execution.receiptId);
      const taskId = await f.task(execution.receiptId);
      await expect(control!.confirmedStart({ nativeSessionId: f.targetNative,
        admissionReceiptId: execution.receiptId, taskId })).rejects.toThrow('native_attempt_invalid');
      await expect(control!.confirmedStart({ nativeSessionId: f.sourceNative,
        admissionReceiptId: execution.receiptId, taskId: 'forged' })).rejects.toThrow('native_receipt_invalid');
      await control!.confirmedStart({ nativeSessionId: f.sourceNative, admissionReceiptId: execution.receiptId, taskId });
    });
    const endpoint = await f.inScope((tx, b) => resolveBlindReviewEndpoint(tx, b));
    expect(endpoint).toMatchObject({ advSessionId: f.sourceId, nativeSessionId: f.sourceNative,
      continuationId: expect.any(Number) });
    expect(endpoint!.continuationId).not.toBeNull();
    expect(await verifyBlindReviewNativeNoOpen(f.permit, f.deps)).toBe(false);
    await expect(f.run(f.launchInput, async () => 'replayed')).rejects.toThrow('native_attempt_invalid');
    expect(await releaseBlindReviewSessionResume(f.input.bindingId, f.input.leaseId, f.deps)).toBe(true);
    await execution.cancel('fixture cleanup');
  });

  it.each(['request', 'attempt', 'lease', 'actor', 'confinement'])('refuses a forged native permit: %s', async field => {
    const f = await nativeFixture();
    const input = { ...f.launchInput, permit: { ...f.permit } };
    if (field === 'request') input.request = { ...input.request, brief: 'different' };
    if (field === 'attempt') input.permit.nativeAttempt = { ...f.permit.nativeAttempt!, key: randomUUID() };
    if (field === 'lease') input.permit.leaseId = randomUUID();
    if (field === 'actor') input.actor = 'other';
    if (field === 'confinement') input.confinement = { ...input.confinement, denyOutside: [] };
    let entered = false;
    await expect(f.run(input, async () => { entered = true; })).rejects.toThrow();
    expect(entered).toBe(false);
    await f.denied();
  });

  it('serializes concurrent admissions of one exact attempt before either caller can open native', async () => {
    const f = await nativeFixture(), execution = await f.admission();
    let ready = 0;
    let release!: () => void;
    const both = new Promise<void>(resolve => { release = resolve; });
    const run = () => f.run(f.launchInput, async control => {
      if (++ready === 2) release();
      await both;
      await control!.beforeNativeCreate(null, execution.receiptId);
    });
    const results = await Promise.allSettled([run(), run()]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    await f.denied();
    await execution.cancel('fixture cleanup');
  });

  it('derives bootstrap provenance from the leased binding, then transfers only its reserved port receipt', async () => {
    const f = await fixture();
    // Maintained bootstrap records account in launch_argv, not launch_spec.
    await fx.admin`UPDATE harness_shared.adv_sessions SET launch_spec = NULL WHERE id = ${f.targetId}`;
    const request = { workspaceId: f.input.workspaceId, portId: f.input.portId,
      targetAdvSessionId: f.targetId, agent: 'codex', model: 'sol:xhigh', account: 'auto', headless: true };
    const permit = await authorizeBlindReviewPortBootstrap(request, f.deps);
    expect(permit).toMatchObject({ ...f.input, launchParentOwner: 'system:blind-gap-review' });
    await expect(f.reserve()).rejects.toThrow('recovery_port_invalid');
    await fx.admin`UPDATE harness_shared.adv_sessions SET launch_spec =
      ${JSON.stringify({ launchedBy: permit!.launchParentOwner, headless: true, model: request.model })}::jsonb,
      launch_argv = ${JSON.stringify(['psu', '--account=auto'])}::jsonb WHERE id = ${f.targetId}`;
    await reserveBlindReviewContinuation(permit!, f.deps);
    await f.deliver();
    expect(await finalizeBlindReviewPortCustody(request, f.deps)).toMatchObject({ advSessionId: f.targetId });
    expect(await finalizeBlindReviewPortCustody(request, f.deps)).toMatchObject({ advSessionId: f.targetId });
  });
  it('port delivery alone cannot manufacture custody, and bootstrap rejects a live source or broader target', async () => {
    const f = await fixture(); await f.deliver();
    expect(await finalizeBlindReviewPortCustody({ workspaceId: f.input.workspaceId,
      portId: f.input.portId, targetAdvSessionId: f.targetId }, f.deps)).toBeNull();
    const g = await fixture();
    const request = { workspaceId: g.input.workspaceId, portId: g.input.portId,
      targetAdvSessionId: g.targetId, agent: 'codex', model: 'sol:xhigh', account: 'default', headless: true };
    await expect(authorizeBlindReviewPortBootstrap(request, g.deps)).rejects.toThrow('recovery_port_invalid');
    await fx.admin`UPDATE harness_shared.adv_sessions SET ended_at = NULL WHERE id = ${g.sourceId}`;
    await expect(authorizeBlindReviewPortBootstrap({ ...request, account: 'auto' }, g.deps))
      .rejects.toThrow('recovery_port_invalid');
  });
  it('keeps uncertain custody reserved across release and expired-lease reacquisition', async () => {
    const f = await fixture(); await f.reserve();
    expect(await releaseBlindReviewSessionResume(f.input.bindingId, f.input.leaseId, f.deps)).toBe(false);
    await fx.admin`UPDATE harness_shared.plan_blind_review_sessions
      SET resume_lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${f.input.bindingId}`;
    expect(await acquireBlindReviewSessionResume({ workspaceId: f.input.workspaceId,
      planSlug: f.slug, activationAuditSeq: 1 }, f.deps)).toMatchObject({ ok: false, code: 'binding_unavailable' });
    expect(await f.read()).toMatchObject({ status: 'resuming', resumeLeaseId: f.input.leaseId });
  });
  it('leases the resolved native after transfer while preserving the immutable binding', async () => {
    const f = await fixture(), r = await f.reserve(); await f.deliver(); await f.finalize(r.reservationId);
    const acquired = await acquireBlindReviewSessionResume({ workspaceId: f.input.workspaceId,
      planSlug: f.slug, activationAuditSeq: 1 }, f.deps);
    expect(acquired).toMatchObject({ ok: true,
      binding: { advSessionId: f.sourceId, nativeSessionId: f.sourceNative, modelSpec: 'opus' },
      endpoint: { advSessionId: f.targetId, nativeSessionId: f.targetNative, modelSpec: 'sol:xhigh' } });
    if (!acquired.ok) throw new Error(acquired.message);
    expect(await releaseBlindReviewSessionResume(f.input.bindingId, acquired.leaseId, f.deps)).toBe(true);
  });
  it('commits a target post and receipt together, rejecting stale source and missing authenticated metadata', async () => {
    const f = await fixture(), r = await f.reserve(); await f.deliver(); await f.finalize(r.reservationId);
    const post = (authenticatedAdvSessionId?: number, failReceipt = false) => withAuthenticatedBlindReviewEndpoint({
      workspaceId: f.input.workspaceId, bindingId: f.input.bindingId, reviewerOwnerId: f.owner,
      authenticatedAdvSessionId,
    }, async (tx, b) => {
      const written = await recordBlindReview({ workspaceId: b.workspaceId, harnessSlug: b.harnessSlug,
        planSlug: b.planSlug, activationAuditSeq: b.activationAuditSeq, createdBy: f.owner,
        outcome: 'conclusive', gaps: [] }, { sql: tx });
      if (!written.ok) throw new Error(written.code);
      if (failReceipt) throw new Error('receipt_write_failed');
      expect(await recordBlindReviewSessionPost({ workspaceId: b.workspaceId, planSlug: b.planSlug,
        activationAuditSeq: b.activationAuditSeq, reviewerOwnerId: f.owner, reviewId: written.id },
      { sql: tx, deferRuntimeCleanup: true })).toBe(true);
      return written;
    }, f.deps);
    await expect(post(f.sourceId)).rejects.toThrow('authenticated_reviewer_endpoint_mismatch');
    await expect(post()).rejects.toThrow('authenticated_reviewer_endpoint_mismatch');
    await expect(post(f.targetId, true)).rejects.toThrow('receipt_write_failed');
    expect(await fx.admin`SELECT id FROM harness_shared.plan_blind_reviews
      WHERE workspace_id = ${f.input.workspaceId} AND plan_slug = ${f.slug}`).toHaveLength(0);
    expect((await f.read())?.status).toBe('ready');
    const written = await post(f.targetId);
    expect(await f.read()).toMatchObject({ status: 'posted', reviewId: written.id });
    expect(await post(f.targetId)).toEqual(written);
  });
  it('admits only the active target runtime after transfer, cutting off existing source leases', async () => {
    const f = await fixture(), r = await f.reserve(); await f.deliver(); await f.finalize(r.reservationId);
    const b = (await f.read())!;
    const identity = { workspaceId: b.workspaceId, bindingId: b.id, activationAuditSeq: b.activationAuditSeq,
      replacementEpoch: 0, reviewerOwnerId: b.reviewerOwnerId, nativeSessionId: f.targetNative,
      confinementFingerprint: runtimeCustodyFingerprint(b.confinementSnapshot) };
    const check = (nativeSessionId: string) => fx.admin.begin(tx => checkRuntimeReviewerAuthority(tx as never,
      { ...identity, nativeSessionId }));
    expect(await check(f.targetNative)).toBe(true);
    expect(await check(f.sourceNative)).toBe(false);
  });
  it.each(['audit hash', 'audit revision', 'plan body'] as const)(
    'denies original endpoint authority and pre-reservation launch with stale %s', async kind => {
      const f = await fixture();
      await fx.admin`UPDATE harness_shared.adv_sessions SET ended_at = NULL WHERE id = ${f.sourceId}`;
      expect(await f.inScope((tx, b) => verifyBlindReviewEndpointCaller(tx, b, f.sourceId))).toBe(true);
      if (kind === 'audit hash') await fx.admin`UPDATE harness_shared.plan_audits
        SET audited_plan_content_hash = ${'f'.repeat(64)} WHERE workspace_id = ${f.input.workspaceId} AND plan_slug = ${f.slug}`;
      else if (kind === 'audit revision') await fx.admin`UPDATE harness_shared.plan_audits
        SET audited_plan_revision_seq = 2 WHERE workspace_id = ${f.input.workspaceId} AND plan_slug = ${f.slug}`;
      else await fx.admin`UPDATE harness_shared.harness_plans SET content_hash = ${'f'.repeat(64)}
        WHERE workspace_id = ${f.input.workspaceId} AND plan_slug = ${f.slug}`;
      await expect(f.inScope((tx, b) => verifyBlindReviewEndpointCaller(tx, b, f.sourceId)))
        .rejects.toThrow('activation_audit_mismatch');
      await fx.admin`UPDATE harness_shared.adv_sessions SET ended_at = clock_timestamp() WHERE id = ${f.sourceId}`;
      await expect(f.reserve()).rejects.toThrow('activation_audit_mismatch');
      expect(await fx.admin`SELECT id FROM harness_shared.blind_review_continuation_custody
        WHERE binding_id = ${f.input.bindingId}`).toHaveLength(0);
    });
  it('keeps the draft migration in the maintained migration lint surface', () => {
    expect(() => assertMigrationPassesPreApplyLints({ filename: migrationName, sqlText: migration,
      sqlDir: fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql/', import.meta.url)) })).not.toThrow();
  });
  it('reserves once, denies both endpoints while uncertain, then transfers without changing the original binding tuple', async () => {
    const f = await fixture(), before = await f.read();
    const { reservationId } = await f.reserve();
    expect(await f.reserve()).toEqual({ reservationId });
    expect(await f.inScope((tx, b) => resolveBlindReviewEndpoint(tx, b))).toBeNull();
    expect(await f.inScope((tx, b) => verifyBlindReviewEndpointCaller(tx, b, f.targetId))).toBe(false);
    await f.deliver();
    const endpoint = await f.finalize(reservationId);
    expect(endpoint).toMatchObject({ advSessionId: f.targetId, nativeSessionId: f.targetNative, modelSpec: 'sol:xhigh' });
    expect(await f.finalize(reservationId)).toEqual(endpoint);
    expect(await f.inScope((tx, b) => resolveBlindReviewEndpoint(tx, b))).toEqual(endpoint);
    expect(await f.read()).toMatchObject({ advSessionId: before!.advSessionId, nativeSessionId: before!.nativeSessionId,
      reviewerOwnerId: before!.reviewerOwnerId, modelSpec: before!.modelSpec, status: 'ready', resumeLeaseId: null });
    expect(await fx.admin`SELECT id FROM harness_shared.blind_review_continuation_custody WHERE binding_id = ${f.input.bindingId}`)
      .toHaveLength(2);
  });
  it('authenticates the exact target and refuses stale-source, spoofed target and absent transport provenance', async () => {
    const f = await fixture(), r = await f.reserve(); await f.deliver(); await f.finalize(r.reservationId);
    expect(await f.inScope((tx, b) => verifyBlindReviewEndpointCaller(tx, b, f.targetId))).toBe(true);
    for (const id of [f.sourceId, f.targetId + 1000000, undefined])
      expect(await f.inScope((tx, b) => verifyBlindReviewEndpointCaller(tx, b, id))).toBe(false);
    await fx.admin`UPDATE harness_shared.adv_sessions SET session_id = 'spoofed-target' WHERE id = ${f.targetId}`;
    expect(await f.inScope((tx, b) => verifyBlindReviewEndpointCaller(tx, b, f.targetId))).toBe(false);
  });
  it('concurrent identical reservations serialize to one entry', async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([f.reserve(), f.reserve()]);
    expect(a).toEqual(b);
    expect(await fx.admin`SELECT id FROM harness_shared.blind_review_continuation_custody WHERE binding_id = ${f.input.bindingId}`)
      .toHaveLength(1);
  });
  it.each(['live source', 'wrong target owner', 'unsupported backend', 'missing bootstrap pin'] as const)(
    'rejects %s before reserving custody', async kind => {
      const f = await fixture();
      if (kind === 'live source') await fx.admin`UPDATE harness_shared.adv_sessions SET ended_at = NULL WHERE id = ${f.sourceId}`;
      if (kind === 'wrong target owner') await fx.admin`UPDATE harness_shared.adv_sessions SET coord_owner_id = 'foreign' WHERE id = ${f.targetId}`;
      if (kind === 'unsupported backend') await fx.admin`UPDATE harness_shared.adv_sessions SET agent = 'omp' WHERE id = ${f.targetId}`;
      if (kind === 'missing bootstrap pin') await fx.admin`UPDATE harness_shared.session_ports
        SET metadata = metadata - 'bootstrapRequestHash' WHERE id = ${f.input.portId}`;
      await expect(f.reserve()).rejects.toThrow('recovery_port_invalid');
      expect(await fx.admin`SELECT id FROM harness_shared.blind_review_continuation_custody
        WHERE binding_id = ${f.input.bindingId}`).toHaveLength(0);
    });
  it.each(['expired', 'lost'] as const)('retains authority denial after a %s lease without committing custody', async kind => {
    const f = await fixture(), r = await f.reserve(); await f.deliver();
    if (kind === 'expired') await fx.admin`UPDATE harness_shared.plan_blind_review_sessions
      SET resume_lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${f.input.bindingId}`;
    else await fx.admin`UPDATE harness_shared.plan_blind_review_sessions SET resume_lease_id = ${randomUUID()}
      WHERE id = ${f.input.bindingId}`;
    await expect(f.finalize(r.reservationId)).rejects.toThrow('resume_lease_lost');
    expect(await f.inScope((tx, b) => resolveBlindReviewEndpoint(tx, b))).toBeNull();
    await expect(f.reserve()).rejects.toThrow('resume_lease_lost');
  });
  it.each(['activation', 'manifest', 'plan'] as const)('refuses %s drift between reservation and transfer', async kind => {
    const f = await fixture(), r = await f.reserve(); await f.deliver();
    if (kind === 'activation') await fx.admin`INSERT INTO harness_shared.plan_audits
      (workspace_id,harness_slug,plan_slug,audit_seq,created_by,audit_kind,activation,
       audited_plan_revision_id,audited_plan_revision_seq,audited_plan_content_hash)
      VALUES (${f.input.workspaceId},'papercusp',${f.slug},2,'author','activation','{}',1,1,${'a'.repeat(64)})`;
    else if (kind === 'manifest') await fx.admin`UPDATE harness_shared.operator_session_confinements SET
      payload = jsonb_set(payload, ARRAY['sessions', ${f.owner}, 'confinement', 'reason'], '"changed manifest"')
      WHERE workspace_id = ${f.input.workspaceId}`;
    else await fx.admin`UPDATE harness_shared.harness_plans SET content_hash = ${'f'.repeat(64)}
      WHERE workspace_id = ${f.input.workspaceId} AND plan_slug = ${f.slug}`;
    await expect(f.finalize(r.reservationId)).rejects.toThrow();
    expect(await fx.admin`SELECT id FROM harness_shared.blind_review_continuation_custody
      WHERE binding_id = ${f.input.bindingId} AND event_kind = 'transferred'`).toHaveLength(0);
  });
  it.each(['live source', 'source reservation', 'wrong owner', 'missing receipt', 'changed hash', 'bootstrap pin'] as const)(
    'refuses %s and preserves the pending reservation', async kind => {
      const f = await fixture(), r = await f.reserve(); await f.deliver();
      if (kind === 'live source') await fx.admin`UPDATE harness_shared.adv_sessions SET ended_at = NULL WHERE id = ${f.sourceId}`;
      if (kind === 'source reservation') await fx.admin`UPDATE harness_shared.adv_sessions SET resume_claim_key = 'other' WHERE id = ${f.sourceId}`;
      if (kind === 'wrong owner') await fx.admin`UPDATE harness_shared.adv_sessions SET coord_owner_id = 'foreign' WHERE id = ${f.targetId}`;
      if (kind === 'missing receipt') await fx.admin`UPDATE harness_shared.session_ports SET metadata = metadata - 'persistenceProof' WHERE id = ${f.input.portId}`;
      if (kind === 'changed hash') await fx.admin`UPDATE harness_shared.session_ports SET rendered_hash = ${'f'.repeat(64)} WHERE id = ${f.input.portId}`;
      if (kind === 'bootstrap pin') await fx.admin`UPDATE harness_shared.session_ports SET metadata =
        jsonb_set(metadata, '{bootstrapRequestHash}', to_jsonb(${'f'.repeat(64)}::text)) WHERE id = ${f.input.portId}`;
      await expect(f.finalize(r.reservationId)).rejects.toThrow('recovery_port_invalid');
      expect(await f.inScope((tx, b) => resolveBlindReviewEndpoint(tx, b))).toBeNull();
    });
  it('does not restore endpoint authority when plan content changes after transfer', async () => {
    const f = await fixture(), r = await f.reserve(); await f.deliver(); await f.finalize(r.reservationId);
    await fx.admin`UPDATE harness_shared.harness_plans SET content_hash = ${'f'.repeat(64)}
      WHERE workspace_id = ${f.input.workspaceId} AND plan_slug = ${f.slug}`;
    await expect(f.inScope((tx, b) => resolveBlindReviewEndpoint(tx, b))).rejects.toThrow('activation_audit_mismatch');
  });
  it('application row locking retains the append-only trigger under workspace RLS', async () => {
    const f = await fixture(), r = await f.reserve();
    const rows = await fx.admin.begin(async tx => {
      await tx`SET LOCAL ROLE harness_app`;
      await tx`SELECT set_config('app.workspace_id', ${f.input.workspaceId}, true)`;
      return tx`SELECT id FROM harness_shared.blind_review_continuation_custody WHERE id = ${r.reservationId} FOR SHARE`;
    });
    expect(rows).toHaveLength(1);
    await expect(fx.admin.begin(async tx => {
      await tx`SET LOCAL ROLE harness_app`;
      await tx`SELECT set_config('app.workspace_id', ${f.input.workspaceId}, true)`;
      await tx`UPDATE harness_shared.blind_review_continuation_custody SET evidence = '{}' WHERE id = ${r.reservationId}`;
    })).rejects.toThrow('append-only');
  });
  it('the database refuses custody history mutation', async () => {
    const f = await fixture(), r = await f.reserve();
    await expect(fx.admin`UPDATE harness_shared.blind_review_continuation_custody SET evidence = '{}'
      WHERE id = ${r.reservationId}`).rejects.toThrow('append-only');
    await expect(fx.admin`DELETE FROM harness_shared.blind_review_continuation_custody
      WHERE id = ${r.reservationId}`).rejects.toThrow('append-only');
  });
});
