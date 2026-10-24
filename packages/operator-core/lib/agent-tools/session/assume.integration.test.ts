/** Real PostgreSQL custody coverage. Managed PTY/routing journeys are separate
 * acceptance coverage; a database lease alone does not prove a takeover. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { acquireAdvSessionResume, releaseAdvSessionResume, type AdvSessionResumePin } from '../../adv-sessions';
import { claimAgentLaunch } from '../../agent-launch-core';
import { createAssumeReceiptStore } from '../../session-assume-store';
import { createAssumeCustodyAdapters } from '../../session-assume-custody';
import { readAssumeCheckpoint } from '../../session-assume-preparation';
import { loopScope, setCarryNote } from '../../carry-note';
import { checkpointAssumeCaller, createAssumeCallerAdapters, readAssumeCallerCheckpoint } from '../../session-assume-caller';
import { clearAssumeCallerPause, installAssumeCallerPause, readAssumeCallerPause } from '../../session-assume-pause';
import { getSessionBriefLifecycle } from '../../session-brief';
import { loopRoutineName } from '../../harness/routines/loop';
import { registerAwait, listActiveAwaits } from '../../events/await/store';
import { acquireClaim, getClaim } from '../../plan-items/claims';
import { getWorkItem, releaseWorkItem } from '../../work-items';
import { setWorkItemCheckpoint } from '../../work-item-checkpoint';
import { runWithWorkspace } from '../../workspace-als';
import { persistControlAnchor, type ControlAnchorState } from '../coordination/control-anchor';
import {
  assumePreparationFingerprint, assumePreparationSchema, assumeTransitionKey,
  type AssumePreparation, type AssumeTransitionReceipt,
} from '../../session-assume';

let database: OrgTestDb;
let fixture: BaselineCoordFixture;
const workspaceId = 'assume-isolated-custody';

beforeAll(async () => {
  database = await createOrgTestDb();
  fixture = await setupBaselineCoordFixture({ dsn: database.adminDsn });
});

afterAll(async () => {
  try { await fixture?.dispose(); }
  finally { await database?.cleanup(); }
});

async function target() {
  const ownerId = `su-assume-fixture-${randomUUID()}`;
  const nativeId = randomUUID();
  const [row] = await fixture.admin<{ id: string; started: string }[]>`
    INSERT INTO harness_shared.adv_sessions
      (workspace_id, agent, mode, coord_owner_id, session_id, started_at, ended_at, ended_by)
    VALUES (${workspaceId}, 'codex', 'console', ${ownerId}, ${nativeId}, now(), now(), 'self')
    RETURNING id, started_at::text AS started
  `;
  const id = Number(row.id);
  const pin: AdvSessionResumePin = { workspaceId, requireTerminal: true,
    binding: { coordOwnerId: ownerId, sessionId: nativeId, startedAt: row.started } };
  return { id, pin };
}

function receiptFixture(): { plan: AssumePreparation; receipt: AssumeTransitionReceipt } {
  const now = Date.now();
  const plan: AssumePreparation = {
    version: 1, requestId: randomUUID(), authorizationRef: 'fixture:admin-envelope',
    preparedAt: now, expiresAt: now + 120_000,
    caller: { ownerId: `su-${randomUUID()}`, workspaceId, nativeSessionId: randomUUID(),
      incarnation: 'fixture-start', hostId: 'fixture-host', attachmentId: 'fixture-pty', nativePid: 101, backend: 'codex' },
    target: { ownerId: `su-${randomUUID()}`, workspaceId, harnessSlug: 'fixture-harness',
      advSessionId: 42, role: 'su', nativeSessionId: 'fixture-native', executionNativeSessionId: 'fixture-native',
      backend: 'codex', binding: { coordOwnerId: 'fixture-target', sessionId: 'fixture-native', startedAt: 'fixture-start' },
      writerGeneration: 'fixture-free', writer: 'free', ended: true, liveHost: false,
      context: { mode: 'native-resume', ref: 'fixture-native', sha256: 'a'.repeat(64), revision: 'fixture-revision' } },
  };
  plan.target.binding.coordOwnerId = plan.target.ownerId;
  return { plan, receipt: { transitionKey: assumeTransitionKey(plan), preparationFingerprint: assumePreparationFingerprint(plan),
    preparation: plan, state: 'prepared', updatedAt: now, durable: true } };
}

describe('session:assume production receipt adapter (real PG)', () => {
  it('fences only the caller generation, preserves sibling controls and rejects conflicting or stale unpause', async () => {
    const { plan } = receiptFixture();
    const recovery = await checkpointAssumeCaller(plan, { readCaller: async () => plan.caller });
    await fixture.admin`INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, control_state)
      VALUES (${plan.caller.ownerId}, ${workspaceId}, '{"unrelated":1,"lifecycle":{"shutdown":{"at":"2026-01-01T00:00:00Z","by":"fixture"}}}'::jsonb)`;
    await installAssumeCallerPause(plan, recovery);
    const staleAnchor: ControlAnchorState = { modes: [], loop: { active: false, intervalSec: null }, carry: 'warm',
      route: { kind: 'self' }, scope: { workspace: workspaceId, harness: null, plan: null, items: [] } };
    await persistControlAnchor({ ownerId: plan.caller.ownerId, workspaceId, state: staleAnchor });
    await installAssumeCallerPause(assumePreparationSchema.parse(plan), recovery);
    expect(await getSessionBriefLifecycle(plan.caller.ownerId, { failClosed: true }))
      .toMatchObject({ assumeCaller: { transitionKey: assumeTransitionKey(plan) }, shutdown: { by: 'fixture' } });
    expect(await readAssumeCallerPause(plan.target.ownerId)).toBeNull();
    await expect(installAssumeCallerPause({ ...plan, requestId: randomUUID() }, recovery)).rejects.toThrow('pause-conflict');
    expect(await clearAssumeCallerPause(plan, { ...recovery, checkpointSha256: 'f'.repeat(64) })).toBe(false);
    expect(await readAssumeCallerPause(plan.caller.ownerId)).not.toBeNull();
    expect(await clearAssumeCallerPause(plan, recovery)).toBe(true);
    await persistControlAnchor({ ownerId: plan.caller.ownerId, workspaceId,
      state: { ...staleAnchor, lifecycle: { assumeCaller: { transitionKey: 'stale' } } } });
    expect(await clearAssumeCallerPause(plan, recovery)).toBe(false);
    const [brief] = await fixture.admin`SELECT control_state FROM harness_shared.session_briefs WHERE owner_id = ${plan.caller.ownerId}`;
    expect(brief.control_state.lifecycle).toEqual({ shutdown: { at: '2026-01-01T00:00:00Z', by: 'fixture' } });
  });

  it('quiesces and restores caller loops and plan claims while retaining awaits and target wake sources', async () => {
    const { plan } = receiptFixture();
    const loopId = randomUUID(), targetLoopId = randomUUID();
    for (const [id, owner] of [[loopId, plan.caller.ownerId], [targetLoopId, plan.target.ownerId]]) {
      await fixture.admin`INSERT INTO harness_shared.routines
        (id, install_slug, name, workspace_id, target_owner_id, active, trigger_kind, trigger_config, target_role)
        VALUES (${id}, 'fixture-harness', ${loopRoutineName(owner)}, ${workspaceId}, ${owner}, true, 'cron', '{}'::jsonb, 'su')`;
    }
    const claim = await acquireClaim({ workspaceId, harnessSlug: 'fixture-harness', planSlug: 'caller-plan',
      itemId: 'P-001', owner: plan.caller.ownerId, intent: 'caller fixture', ttlSec: 1200 });
    expect(claim.ok).toBe(true);
    const awaited = await registerAwait({ subscriberId: plan.caller.ownerId, eventKey: `fixture:${randomUUID()}`, once: false });
    const host = { freeze: vi.fn(async () => true), thaw: vi.fn(async () => true), readCaller: async () => plan.caller };
    const adapter = createAssumeCallerAdapters(host);
    const recovery = await adapter.checkpointCaller(plan);
    const disposition = await adapter.quiesceCaller(plan, recovery);
    expect(disposition).toMatchObject({ pausedAwaitIds: [awaited.id], releasedPlanClaims: [{ plan: 'caller-plan', item: 'P-001' }],
      inbox: 'retained', directives: 'retained' });
    expect(await getClaim(workspaceId, 'fixture-harness', 'caller-plan', 'P-001')).toBeNull();
    expect((await listActiveAwaits(plan.caller.ownerId)).map(row => row.id)).toContain(awaited.id);
    const paused = await fixture.admin`SELECT id, active FROM harness_shared.routines WHERE id IN (${loopId}, ${targetLoopId})`;
    expect(paused.find(row => row.id === loopId)?.active).toBe(false);
    expect(paused.find(row => row.id === targetLoopId)?.active).toBe(true);
    expect(await adapter.restoreCaller(plan, recovery)).toBe(true);
    expect((await getClaim(workspaceId, 'fixture-harness', 'caller-plan', 'P-001'))?.owner).toBe(plan.caller.ownerId);
    expect(await readAssumeCallerPause(plan.caller.ownerId)).toBeNull();
    const [loop] = await fixture.admin`SELECT active FROM harness_shared.routines WHERE id = ${loopId}`;
    expect(loop.active).toBe(true);
    expect(host.thaw).toHaveBeenCalledOnce();
    expect(await adapter.restoreCaller(plan, recovery)).toBe(false);
  });

  it('retains the fence after failed host acknowledgement or changed recovery custody', async () => {
    const { plan } = receiptFixture();
    let caller = plan.caller;
    const host = { freeze: vi.fn(async () => false), thaw: vi.fn(async () => true), readCaller: async () => caller };
    const adapter = createAssumeCallerAdapters(host);
    const recovery = await adapter.checkpointCaller(plan);
    await expect(adapter.quiesceCaller(plan, recovery)).rejects.toThrow('host-not-fenced');
    caller = { ...caller, nativePid: caller.nativePid + 1 };
    expect(await adapter.restoreCaller(plan, recovery)).toBe(false);
    expect(host.thaw).not.toHaveBeenCalled();
    expect(await readAssumeCallerPause(plan.caller.ownerId)).not.toBeNull();
    caller = plan.caller;
    expect(await adapter.restoreCaller(plan, recovery)).toBe(true);
  });

  it('refuses rollback over a newer loop configuration', async () => {
    const { plan } = receiptFixture();
    const loopId = randomUUID();
    await fixture.admin`INSERT INTO harness_shared.routines
      (id, install_slug, name, workspace_id, target_owner_id, active, trigger_kind, trigger_config, target_role)
      VALUES (${loopId}, 'fixture-harness', ${loopRoutineName(plan.caller.ownerId)}, ${workspaceId}, ${plan.caller.ownerId}, true, 'cron', '{}'::jsonb, 'su')`;
    const adapter = createAssumeCallerAdapters({ freeze: async () => true, thaw: async () => true, readCaller: async () => plan.caller });
    const recovery = await adapter.checkpointCaller(plan);
    await adapter.quiesceCaller(plan, recovery);
    await fixture.admin`UPDATE harness_shared.routines SET trigger_config = '{"newerOwnerChoice":true}'::jsonb, updated_at = now() WHERE id = ${loopId}`;
    expect(await adapter.restoreCaller(plan, recovery)).toBe(false);
    expect(await readAssumeCallerPause(plan.caller.ownerId)).not.toBeNull();
    const [loop] = await fixture.admin`SELECT active, trigger_config FROM harness_shared.routines WHERE id = ${loopId}`;
    expect(loop).toMatchObject({ active: false, trigger_config: { newerOwnerChoice: true } });
  });

  it('restores nonempty caller work without cancelling its bound awaits or moving work to the target', async () => {
    const { plan } = receiptFixture();
    const id = `WI-assume-${randomUUID()}`;
    await fixture.admin`INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin, admission, taken_by, taken_at, updated_ts)
      VALUES (${workspaceId}, 'fixture-harness', ${id}, 'caller work fixture', 'open', 'feature', 'local', NULL,
        ${plan.caller.ownerId}, now(), ${Date.now()})`;
    await setWorkItemCheckpoint({ workspaceId, harness: 'fixture-harness', workItemId: id }, 'caller work must remain recoverable');
    const awaited = await registerAwait({ subscriberId: plan.caller.ownerId, eventKey: `work-item:done:${id}`,
      once: false, boundTo: { kind: 'work-item', ref: id } });
    const adapter = createAssumeCallerAdapters({ freeze: async () => true, thaw: async () => true, readCaller: async () => plan.caller });
    const recovery = await adapter.checkpointCaller(plan);
    expect((await adapter.quiesceCaller(plan, recovery)).releasedWorkClaims).toEqual([{ id, checkpointRef: recovery.checkpointRef }]);
    expect((await runWithWorkspace(workspaceId, () => getWorkItem(id, 'fixture-harness')))?.assignee).toBeNull();
    expect((await listActiveAwaits(plan.caller.ownerId)).map(row => row.id)).toContain(awaited.id);
    expect(await adapter.restoreCaller(plan, recovery)).toBe(true);
    expect((await runWithWorkspace(workspaceId, () => getWorkItem(id, 'fixture-harness')))?.assignee).toBe(plan.caller.ownerId);
    expect((await listActiveAwaits(plan.caller.ownerId)).map(row => row.id)).toContain(awaited.id);
    await expect(runWithWorkspace(workspaceId, () => releaseWorkItem(id, { harness: 'fixture-harness',
      expectedAssignee: plan.caller.ownerId, retainPausedCallerBindings: {
        ownerId: plan.caller.ownerId, transitionKey: assumeTransitionKey(plan) } }))).rejects.toThrow('pause-required');
  });

  it('keeps recovery paused instead of taking a peer plan claim', async () => {
    const { plan } = receiptFixture();
    const key = { workspaceId, harnessSlug: 'fixture-harness', planSlug: randomUUID(), itemId: 'P-001' };
    expect((await acquireClaim({ ...key, owner: plan.caller.ownerId })).ok).toBe(true);
    const thaw = vi.fn(async () => true);
    const adapter = createAssumeCallerAdapters({ freeze: async () => true, thaw, readCaller: async () => plan.caller });
    const recovery = await adapter.checkpointCaller(plan);
    await adapter.quiesceCaller(plan, recovery);
    expect((await acquireClaim({ ...key, owner: plan.target.ownerId })).ok).toBe(true);
    expect(await adapter.restoreCaller(plan, recovery)).toBe(false);
    expect((await getClaim(workspaceId, key.harnessSlug, key.planSlug, key.itemId))?.owner).toBe(plan.target.ownerId);
    expect(await readAssumeCallerPause(plan.caller.ownerId)).not.toBeNull();
    expect(thaw).not.toHaveBeenCalled();
  });

  it('writes an immutable caller-only recovery snapshot and exact return reference', async () => {
    const { plan } = receiptFixture();
    const callerScope = loopScope('caller-harness', plan.caller.ownerId);
    await setCarryNote({ workspaceId, scope: callerScope }, 'caller-only recovery context');
    await setCarryNote({ workspaceId, scope: loopScope('target-harness', plan.target.ownerId) }, 'target-only context');
    const deps = { readCaller: async () => ({ ...plan.caller }) };
    const recovery = await checkpointAssumeCaller(plan, deps);
    expect(recovery.returnRef).toMatchObject({ ownerId: plan.caller.ownerId, nativeSessionId: plan.caller.nativeSessionId });
    const saved = await readAssumeCallerCheckpoint(plan, recovery);
    expect(await readAssumeCallerCheckpoint(assumePreparationSchema.parse(plan), recovery)).toEqual(saved);
    expect(saved.carryNotes.map(note => note.scope)).toEqual([callerScope]);
    expect(saved.carryNotes[0].note).toBe('caller-only recovery context');
    expect(JSON.stringify(saved)).not.toContain(plan.target.ownerId);
    expect(saved).toMatchObject({ inbox: 'retained', directives: 'retained' });
    await setCarryNote({ workspaceId, scope: callerScope }, 'newer caller note');
    expect(await checkpointAssumeCaller(plan, deps)).toEqual(recovery);
    expect((await readAssumeCallerCheckpoint(plan, recovery)).carryNotes[0].note).toBe('caller-only recovery context');
  });

  it('refuses changed caller custody before creating its recovery snapshot and rejects later tampering', async () => {
    const { plan } = receiptFixture();
    await expect(checkpointAssumeCaller(plan, { readCaller: async () => ({ ...plan.caller, nativePid: 102 }) }))
      .rejects.toThrow('assume-caller-changed');
    const scope = `${assumeTransitionKey(plan)}:caller`;
    const before = await fixture.admin`SELECT note FROM harness_shared.carry_notes WHERE workspace_id = ${workspaceId} AND scope = ${scope}`;
    expect(before).toHaveLength(0);
    const recovery = await checkpointAssumeCaller(plan, { readCaller: async () => plan.caller });
    await fixture.admin`UPDATE harness_shared.carry_notes SET note = 'tampered'
      WHERE workspace_id = ${workspaceId} AND scope = ${scope}`;
    await expect(readAssumeCallerCheckpoint(plan, recovery)).rejects.toThrow('assume-caller-recovery-changed');
  });

  it('pins the checkpoint body revision in the exact workspace and rejects a stale body with a recent attestation', async () => {
    const ownerId = `su-checkpoint-${randomUUID()}`;
    const scope = loopScope('fixture-harness', ownerId);
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const target = { ownerId, workspaceId, harnessSlug: 'fixture-harness',
      binding: { coordOwnerId: ownerId, sessionId: 'native', startedAt } };
    await setCarryNote({ scope, workspaceId }, 'target-owned checkpoint');
    const pin = await readAssumeCheckpoint(target);
    expect(pin).toMatchObject({ mode: 'checkpoint', ref: `carry-note:${scope}` });
    expect(await readAssumeCheckpoint({ ...target, workspaceId: 'foreign-workspace' })).toBeNull();
    await fixture.admin`UPDATE harness_shared.carry_notes SET updated_ts = ${Date.now() + 5_000}
      WHERE workspace_id = ${workspaceId} AND scope = ${scope}`;
    expect(await readAssumeCheckpoint(target)).toEqual(pin);
    await fixture.admin`UPDATE harness_shared.carry_notes SET body_ts = ${Date.now() - 120_000}
      WHERE workspace_id = ${workspaceId} AND scope = ${scope}`;
    expect(await readAssumeCheckpoint(target)).toBeNull();
  });

  it('admits one request winner and fences a stale receipt writer without adding its audit', async () => {
    const { plan, receipt } = receiptFixture();
    const stores = [createAssumeReceiptStore(plan), createAssumeReceiptStore(plan)];
    const claims = await Promise.all(stores.map(store => store.claim(receipt)));
    expect(claims.filter(claim => claim.won)).toHaveLength(1);
    const winner = stores[claims.findIndex(claim => claim.won)];
    const loser = stores[claims.findIndex(claim => !claim.won)];
    const accepted = { ...receipt, state: 'handoff-accepted' as const, updatedAt: receipt.updatedAt + 1 };
    await winner.save(accepted);
    await expect(loser.save({ ...receipt, state: 'rolled-back', updatedAt: receipt.updatedAt + 2 }))
      .rejects.toThrow('assume-receipt-changed');
    expect(await createAssumeReceiptStore(plan).load()).toEqual(accepted);
    const events = await fixture.admin<{ body: { sessionAssume: AssumeTransitionReceipt } }[]>`
      SELECT body FROM harness_shared.coord_event_log
       WHERE workspace_id = ${workspaceId} AND body #>> '{sessionAssume,transitionKey}' = ${receipt.transitionKey}
    `;
    expect(events.map(row => row.body.sessionAssume.state)).toEqual(['handoff-accepted']);
    expect(events[0].body.sessionAssume.preparation.authorizationRef).toBe(plan.authorizationRef);
    // Repeating an acknowledged state is idempotent, including its audit append.
    await winner.save(accepted);
    const [{ count }] = await fixture.admin<{ count: string }[]>`
      SELECT count(*) FROM harness_shared.coord_event_log
       WHERE workspace_id = ${workspaceId} AND body #>> '{sessionAssume,transitionKey}' = ${receipt.transitionKey}
    `;
    expect(Number(count)).toBe(1);
  });

  it('rolls back the mutable receipt when its append-only audit cannot commit', async () => {
    const { plan, receipt } = receiptFixture();
    const store = createAssumeReceiptStore(plan);
    await store.claim(receipt);
    await fixture.admin.unsafe(`CREATE FUNCTION harness_shared.assume_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.body #>> '{sessionAssume,reason}' = 'audit-failure-fixture' THEN
          RAISE EXCEPTION 'fixture-audit-refused';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER assume_audit_failure BEFORE INSERT ON harness_shared.coord_event_log
        FOR EACH ROW EXECUTE FUNCTION harness_shared.assume_audit_failure();`);
    try {
      await expect(store.save({ ...receipt, state: 'indeterminate', reason: 'audit-failure-fixture' }))
        .rejects.toThrow('fixture-audit-refused');
      expect(await createAssumeReceiptStore(plan).load()).toEqual(receipt);
    } finally {
      await fixture.admin.unsafe(`DROP TRIGGER assume_audit_failure ON harness_shared.coord_event_log;
        DROP FUNCTION harness_shared.assume_audit_failure();`);
    }
    await store.save({ ...receipt, state: 'indeterminate' });
    expect(await createAssumeReceiptStore(plan).load()).toMatchObject({ state: 'indeterminate' });
  });

  it('retains an uncertain execution fence beyond ordinary launch cleanup and refuses corrupt stored receipts', async () => {
    const { plan, receipt } = receiptFixture();
    const store = createAssumeReceiptStore(plan);
    await store.claim(receipt);
    await store.save({ ...receipt, state: 'indeterminate' });
    await fixture.admin`UPDATE harness_shared.agent_launch_idempotency
      SET launched_at = ${Date.now() - 30 * 24 * 60 * 60 * 1_000}
      WHERE workspace_id = ${workspaceId} AND idempotency_key = ${receipt.transitionKey}`;
    await claimAgentLaunch({ workspaceId, idempotencyKey: `unrelated-${randomUUID()}`, failClosed: true });
    expect(await createAssumeReceiptStore(plan).claim(receipt)).toMatchObject({ won: false, prior: { state: 'indeterminate' } });
    await fixture.admin`UPDATE harness_shared.agent_launch_idempotency
      SET summary = '{"sessionAssume":{"state":"target-verified"}}'::jsonb
      WHERE workspace_id = ${workspaceId} AND idempotency_key = ${receipt.transitionKey}`;
    await expect(createAssumeReceiptStore(plan).load()).rejects.toThrow();
    await expect(createAssumeReceiptStore(plan).claim(receipt)).rejects.toThrow();
  });
});

describe('session:assume existing resume reservation (real PG)', () => {
  async function custodyFixture() {
    const { id, pin } = await target();
    const { plan } = receiptFixture();
    plan.target = { ...plan.target, advSessionId: id, ownerId: pin.binding.coordOwnerId,
      nativeSessionId: pin.binding.sessionId!, executionNativeSessionId: pin.binding.sessionId!,
      binding: pin.binding, context: { ...plan.target.context, ref: pin.binding.sessionId! } };
    const readTarget = vi.fn(async () => structuredClone(plan.target));
    return { id, plan, readTarget, adapter: createAssumeCustodyAdapters(plan, { readTarget }) };
  }

  it('rechecks the exact live reservation and native context before allowing handoff', async () => {
    const { plan, adapter, readTarget } = await custodyFixture();
    expect(await adapter.checkCustody(plan)).toBe(false);
    expect(await adapter.reserve(plan)).toMatchObject({ acquired: true });
    expect(await adapter.checkCustody(plan)).toBe(true);
    readTarget.mockResolvedValue({ ...plan.target, writer: 'held' });
    expect(await adapter.checkCustody(plan)).toBe(false);
    expect(await adapter.releaseTarget(plan)).toBe(false);
    readTarget.mockResolvedValue(structuredClone(plan.target));
    expect(await adapter.releaseTarget(plan)).toBe(true);
    expect(await adapter.releaseTarget(plan)).toBe(true);
    expect(await adapter.checkCustody(plan)).toBe(false);
  });

  it('refuses changed context and an expired or replaced reservation', async () => {
    const { id, plan, adapter, readTarget } = await custodyFixture();
    await adapter.reserve(plan);
    readTarget.mockResolvedValue({ ...plan.target, context: { ...plan.target.context, revision: 'changed' } });
    expect(await adapter.checkCustody(plan)).toBe(false);
    readTarget.mockResolvedValue(structuredClone(plan.target));
    await fixture.admin`UPDATE harness_shared.adv_sessions SET resume_claimed_at = now() - interval '121 seconds' WHERE id = ${id}`;
    expect(await adapter.checkCustody(plan)).toBe(false);
    expect(await acquireAdvSessionResume(id, 'competing-caller', 120, undefined, undefined, false,
      { workspaceId, binding: plan.target.binding, requireTerminal: true })).toMatchObject({ acquired: true });
    expect(await adapter.checkCustody(plan)).toBe(false);
    expect(await adapter.releaseTarget(plan)).toBe(false);
  });

  it('does not renew custody or release another incarnation after target binding changes', async () => {
    const { id, plan, adapter } = await custodyFixture();
    await adapter.reserve(plan);
    await fixture.admin`UPDATE harness_shared.adv_sessions SET started_at = started_at + interval '1 second' WHERE id = ${id}`;
    expect(await adapter.checkCustody(plan)).toBe(false);
    expect(await adapter.reserve(plan)).toEqual({ acquired: false, status: 'binding-changed' });
    await expect(adapter.reserve({ ...plan, requestId: 'different' })).rejects.toThrow('preparation-changed');
  });

  it('checks lease ownership again when a slow native probe outlives its reservation', async () => {
    const { id, plan, adapter, readTarget } = await custodyFixture();
    await adapter.reserve(plan);
    readTarget.mockImplementation(async () => {
      await fixture.admin`UPDATE harness_shared.adv_sessions SET resume_claimed_at = now() - interval '121 seconds' WHERE id = ${id}`;
      return structuredClone(plan.target);
    });
    expect(await adapter.checkCustody(plan)).toBe(false);
  });

  it('serializes different caller keys on the exact same ended incarnation', async () => {
    const { id, pin } = await target();
    const keys = ['caller-a', 'caller-b'];
    const results = await Promise.all(keys.map(key =>
      acquireAdvSessionResume(id, key, 120, undefined, undefined, false, pin)));
    expect(results.filter(result => result.acquired)).toHaveLength(1);
    expect(results.filter(result => result.status === 'reserved')).toHaveLength(1);
    const [stored] = await fixture.admin<{ key: string; ended: boolean }[]>`
      SELECT resume_claim_key AS key, ended_at IS NOT NULL AS ended
        FROM harness_shared.adv_sessions WHERE id = ${id}
    `;
    expect(stored.ended).toBe(true);
    const winner = keys[results.findIndex(result => result.acquired)];
    expect(stored.key).toBe(winner);
    expect(await acquireAdvSessionResume(id, winner, 120, undefined, undefined, false, pin))
      .toMatchObject({ acquired: true, replayed: true });
    expect(await releaseAdvSessionResume(id, 'not-the-owner')).toBe(false);
    expect(await releaseAdvSessionResume(id, winner)).toBe(true);
  });

  it('refuses stale incarnation and foreign workspace without writing a lease', async () => {
    const { id, pin } = await target();
    await fixture.admin`UPDATE harness_shared.adv_sessions SET started_at = started_at + interval '1 second' WHERE id = ${id}`;
    expect(await acquireAdvSessionResume(id, 'stale', 120, undefined, undefined, false, pin))
      .toEqual({ status: 'binding-changed', acquired: false });
    const other = await target();
    expect(await acquireAdvSessionResume(other.id, 'foreign', 120, undefined, undefined, false,
      { ...other.pin, workspaceId: 'foreign-workspace' }))
      .toEqual({ status: 'binding-changed', acquired: false });
    const rows = await fixture.admin<{ key: string | null }[]>`
      SELECT resume_claim_key AS key FROM harness_shared.adv_sessions WHERE id IN (${id}, ${other.id})
    `;
    expect(rows.map(row => row.key)).toEqual([null, null]);
  });

  it('refuses ended-to-live changes despite a stale or replayed claim', async () => {
    const { id, pin } = await target();
    await acquireAdvSessionResume(id, 'caller', 120, undefined, undefined, false, pin);
    await fixture.admin`UPDATE harness_shared.adv_sessions SET ended_at = NULL, ended_by = NULL WHERE id = ${id}`;
    expect(await acquireAdvSessionResume(id, 'caller', 120, undefined, undefined, false, pin))
      .toEqual({ status: 'live', acquired: false });
  });
});
