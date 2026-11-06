import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hashPlanContent } from '@papercusp/plan-parser/content-hash';
import { seedPlan, setupPlanPgFixture, type PlanPgFixture } from './agent-tools/plans/__tests__/_pg-tool-fixture';
import { acquireBlindReviewSessionResume, findBlindReviewSessionBinding, recordBlindReviewSessionPost,
  releaseBlindReviewSessionResume, type BlindReviewSessionBinding } from './blind-review-session-bindings';
import { recordBlindReview } from './blind-review-gate';
import { checkRuntimeReviewerAuthority } from './blind-review-runtime-authority';
import { runtimeCustodyFingerprint } from './blind-review-runtime-custody';
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

let fx: PlanPgFixture;
const migrationName = '1623-blind-review-continuation-custody.sql.DRAFT';
const migration = readFileSync(new URL('../../../libs/papercusp/libs/db/sql/' + migrationName, import.meta.url), 'utf8');
beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  const [present] = await fx.admin`SELECT to_regclass('harness_shared.blind_review_continuation_custody') AS name`;
  if (!present!.name) await fx.admin.begin(tx => tx.unsafe(migration));
  const [replacement] = await fx.admin`SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'harness_shared' AND table_name = 'plan_blind_review_sessions' AND column_name = 'attempt_seq'`;
  if (!replacement) await fx.admin.begin(tx => tx.unsafe(readFileSync(
    new URL('../../../libs/papercusp/libs/db/sql/1567-blind-review-replacement-attempts.sql', import.meta.url), 'utf8')));
}, 120_000);
afterAll(async () => { await fx?.dispose(); });

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

describe('blind reviewer continuation custody, real transaction boundaries', () => {
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
