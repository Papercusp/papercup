/**
 * P-003: exercise the production recovery composition, not a fake screen/dispatch.
 * Fresh PG owns every work-item/admission write. Only external model/transport and
 * ambient session-policy I/O are controlled; canonical create/read/claim, screening,
 * authorization composition, assignment and target-initiated pickup remain real.
 * A transport receipt is explicitly NOT proof of a running agent or a live deploy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { resolve } from 'node:path';
import { createFreshPgDb, applyMigrationForTest, type FreshPgDb } from '../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL, USER_TRUST_LIST_DDL, WORK_ITEM_DEPS_DDL,
  COORD_REF_HOLDERS_DDL,
} from '../test/_work-items-schema';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as Sql,
  denied: false, revoked: false,
  wake: vi.fn(), model: vi.fn(), claim: vi.fn(),
}));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...await orig<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./workspace-registry', async (orig) => ({
  ...await orig<typeof import('./workspace-registry')>(), activeWorkspaceId: () => 'default',
}));
vi.mock('@dbos-inc/dbos-sdk', () => ({ DBOS: { workflowID: undefined } }));
vi.mock('./harness/routines/system-actions', () => ({ registerSystemAction: vi.fn() }));
vi.mock('./agent-tools/coordination/presence', async (orig) => ({
  ...await orig<typeof import('./agent-tools/coordination/presence')>(),
  getPresence: async (actor: string) => ({ workspaceId: 'default', revoked: actor === 'reviewer' && h.revoked }),
}));
vi.mock('./modes/store', async (orig) => ({
  ...await orig<typeof import('./modes/store')>(), getModes: async () => [],
}));
vi.mock('./operator-state-pg', async (orig) => ({
  ...await orig<typeof import('./operator-state-pg')>(), readOperatorState: async () => null,
}));
vi.mock('./work-scope-policy', async (orig) => ({
  ...await orig<typeof import('./work-scope-policy')>(),
  readWorkScopePolicy: async () => ({ mode: 'enforce', allowHarnesses: ['papercusp'] }),
  // Never read or update the live workspace's cached control policy.
  isHarnessInScope: (slug: string) => slug === 'papercusp',
}));
vi.mock('./scheduler/fleet-scope-admission', async (orig) => ({
  ...await orig<typeof import('./scheduler/fleet-scope-admission')>(),
  admitWorkItemForFleetTarget: async ({ target }: { target: string }) =>
    h.denied && target === 'reviewer'
      ? { allowed: false, reason: 'restrictive reviewer override' } : { allowed: true },
}));
// Peripheral lifecycle subscriptions/events must not escape into live agent queues.
vi.mock('./work-items-events', async (orig) => ({
  ...await orig<typeof import('./work-items-events')>(),
  emitWorkItemCreatedEvent: vi.fn(), emitWorkItemClaimedEvent: vi.fn(),
}));
vi.mock('./interest-auto-arm', async (orig) => ({
  ...await orig<typeof import('./interest-auto-arm')>(),
  reconcileInterestEventAwaits: async () => undefined, retireInterestEventAwaits: async () => undefined,
}));

const wi = await import('./work-items');
const { authorizeAdmissionRecovery, requestAdmissionRecovery } = await import('./work-item-admission-recovery');
const { assignAndWakeActionableWorkItems, authorizeWorkItemDispatch } =
  await import('./agent-tools/coordination/actionable-work-item-dispatch');
const { planItemLaneBlockReason, planItemLiveClaimReason } = await import('./scheduler/plan-item-lane-guard');
const { composePickup } = await import('./agent-tools/work_items/pickup');
const { runAdmissionPromoterWithRecovery } = await import('./harness/routines/work-item-admission-promoter-action');

let db: FreshPgDb;
let run = 0;
const scope = { workspaceId: 'default', harnessSlug: 'papercusp' };
beforeAll(async () => {
  db = await createFreshPgDb('admission-recovery-chain');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql.unsafe(COORD_REF_HOLDERS_DDL);
  await applyMigrationForTest(db.sql, resolve(import.meta.dirname,
    '../../../libs/papercusp/libs/db/sql/944-work-queue-admission-dedup.sql'));
  await db.sql.unsafe(`
    CREATE EXTENSION IF NOT EXISTS vector;
    ALTER TABLE harness_shared.work_items ADD COLUMN IF NOT EXISTS embedding vector(3),
      ADD COLUMN IF NOT EXISTS embedding_mode text,
      ADD COLUMN IF NOT EXISTS first_claimed_at timestamptz;
    CREATE OR REPLACE FUNCTION harness_shared.work_item_status_is_terminal(value text)
      RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
        SELECT value = ANY(ARRAY['done','dropped','deprecated','passed','failed','resolved','closed']::text[])
      $$;
    CREATE TABLE harness_shared.operator_secrets(name text PRIMARY KEY, value_b64 text);
    CREATE TABLE harness_shared.routines (
      id text PRIMARY KEY, workspace_id text, install_slug text, name text, target_role text,
      active boolean DEFAULT true, trigger_config jsonb, next_fire_at timestamptz
    );
  `);
  await db.sql`INSERT INTO harness_shared.operator_secrets VALUES
    ('spawn-signing-key', ${Buffer.alloc(32, 42).toString('base64')})`;
}, 60_000);
afterAll(async () => db?.cleanup());
beforeEach(async () => {
  h.denied = false;
  h.revoked = false;
  h.model.mockReset().mockRejectedValue(new Error('unexpected external model call'));
  h.wake.mockReset().mockResolvedValue({ queued: 1, woken: 1, staged: 0, timedOutTargets: [] });
  h.claim.mockReset().mockImplementation(wi.claimWorkItem);
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.dedup_edges,
    harness_shared.dedup_adjudications, harness_shared.admission_runs, harness_shared.routines`;
  await db.sql`INSERT INTO harness_shared.routines
    (id, workspace_id, install_slug, name, target_role, trigger_config, next_fire_at)
    VALUES ('original-promoter','default','papercusp','work-item-admission-promoter',
      'system:work-item-admission-promoter','{"cron":"*/30 * * * *"}', now() + interval '30 minutes')`;
});

async function create(title = 'Original independent review') {
  return wi.createWorkItem({
    kind: 'feature', title, harness: scope.harnessSlug, workspaceId: scope.workspaceId,
    assignee: 'reviewer', admission: 'pending', payload: { keep: 'original instructions' },
  });
}
function request(id: string) {
  return requestAdmissionRecovery({
    ...scope, workItemId: id, caller: 'requester', target: 'reviewer',
    note: 'Review original work', body: 'Report findings; do not implement.',
  });
}
function dispatch(args: Parameters<typeof assignAndWakeActionableWorkItems>[0]) {
  return assignAndWakeActionableWorkItems(args, {
    observe: wi.observeWorkItem, claim: h.claim, authorize: authorizeWorkItemDispatch,
    explainClaimFloors: wi.explainIssueClaimFloors, blockers: wi.readUnresolvedDepBlockers,
    planBlock: planItemLaneBlockReason, planClaim: planItemLiveClaimReason,
    resolveTarget: async () => ({
      requested: 'reviewer', ownerId: 'reviewer-session', present: true, sessionState: 'parked', wakeable: true,
    }),
    wake: h.wake,
  });
}
function tick() {
  return runAdmissionPromoterWithRecovery({
    ...scope, runId: `chain-${++run}`, batchSize: 10, recentTerminalDays: 30, model: undefined,
  }, { sql: db.sql, llmCall: h.model, authorize: authorizeAdmissionRecovery, dispatch });
}
async function row(id: string) {
  const [r] = await db.sql`SELECT feature_id, title, status, admission, taken_by, payload
    FROM harness_shared.work_items WHERE workspace_id = ${scope.workspaceId}
      AND harness_slug = ${scope.harnessSlug} AND feature_id = ${id}`;
  return r!;
}
/** Target's later turn, not the dispatcher's turn. The compound keeps its actual
 * get/claim algorithm; its dispatcher adapter binds the caller to this target and
 * rechecks current authority before the canonical claim. No canned claim receipt.
 */
async function pickup(id: string) {
  return composePickup({ id, harness: scope.harnessSlug }, async (name, args) => {
    expect(args).toMatchObject({ id });
    if (name === 'work_items:get') {
      const item = await wi.getWorkItem(id, scope.harnessSlug);
      return { ok: true, results: [{ ok: Boolean(item), workItem: item }] };
    }
    expect(name).toBe('work_items:claim');
    await authorizeAdmissionRecovery({ ...scope, workItemId: id }, { caller: 'reviewer', target: 'reviewer' });
    const item = await wi.claimWorkItem(id, 'reviewer', { harness: scope.harnessSlug });
    return { ok: true, results: [{ ok: Boolean(item), workItem: item }] };
  });
}

describe('canonical original-item recovery chain (fresh PG; controlled external I/O)', () => {
  it('repairs the same pending task, narrows promotion, then requires a separate target pickup', async () => {
    const original = await create();
    const unrelated = await create('Unrelated pending work');
    expect((await row(original.id)).taken_by).toBeNull();
    expect(await wi.claimWorkItem(original.id, 'reviewer', { harness: scope.harnessSlug })).toBeNull();
    h.denied = true;
    await expect(request(original.id)).rejects.toThrow('restrictive reviewer override');
    expect((await row(original.id)).payload).not.toHaveProperty('_admissionRecovery');
    h.denied = false; // external authorized policy repair, not a recovery bypass
    const queued = await request(original.id);
    expect((await row(original.id)).admission).toBe('pending');
    const result = await tick();
    expect(result).toMatchObject({ promoted: 1, writerCoverageGap: [] });
    expect(h.claim).toHaveBeenCalledWith(original.id, 'reviewer', { harness: 'papercusp' });
    expect(h.wake).toHaveBeenCalledWith(['reviewer-session'], expect.objectContaining({
      payload: { kind: 'actionable-work-item-dispatch', workItemIds: [original.id],
        instructions: 'Report findings; do not implement.' },
    }));
    expect(await row(original.id)).toMatchObject({
      title: original.title, admission: 'admitted', taken_by: 'reviewer',
      payload: { keep: 'original instructions', _admissionRecovery: {
        requestId: queued.request.requestId, state: 'delivered', pickupConfirmed: false,
      } },
    });
    expect(await row(unrelated.id)).toMatchObject({ admission: 'pending', taken_by: null });
    expect(await pickup(original.id)).toMatchObject({ ok: true, claimed: true, item: { id: original.id, assignee: 'reviewer' } });
    // The delivery record does not retroactively become proof of execution.
    expect((await row(original.id)).payload._admissionRecovery.pickupConfirmed).toBe(false);
    expect(await db.sql`SELECT feature_id FROM harness_shared.work_items`).toHaveLength(2);
  });

  it('survives a crash after canonical claim without a replacement or a second screen', async () => {
    const original = await create();
    const queued = await request(original.id);
    h.wake.mockRejectedValueOnce(new Error('transport crash after committed claim'));
    await expect(tick()).rejects.toThrow('transport crash after committed claim');
    expect(await row(original.id)).toMatchObject({
      admission: 'admitted', taken_by: 'reviewer',
      payload: { _admissionRecovery: { state: 'queued', requestId: queued.request.requestId } },
    });
    await tick();
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(await db.sql`SELECT id FROM harness_shared.admission_runs`).toHaveLength(1);
    expect(await pickup(original.id)).toMatchObject({ ok: true, claimed: true });
    expect(await db.sql`SELECT feature_id FROM harness_shared.work_items`).toHaveLength(1);
  });

  it('concurrent consumers preserve one claim and one screening run', async () => {
    const original = await create();
    const first = await request(original.id);
    expect((await request(original.id)).request.requestId).toBe(first.request.requestId);
    await Promise.all([tick(), tick(), tick()]);
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.wake).toHaveBeenCalledTimes(1);
    expect(await db.sql`SELECT id FROM harness_shared.admission_runs`).toHaveLength(1);
    expect((await row(original.id)).payload._admissionRecovery.state).toBe('delivered');
  });

  it('revocation after enqueue holds the original without admission, assignment or wake', async () => {
    const original = await create();
    await request(original.id);
    h.revoked = true;
    await tick();
    expect(await row(original.id)).toMatchObject({
      admission: 'pending', taken_by: null,
      payload: { _admissionRecovery: { state: 'held', pickupConfirmed: false } },
    });
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
    expect(await db.sql`SELECT id FROM harness_shared.admission_runs`).toHaveLength(0);
  });

  it('a queued delivery never authorizes a later target pickup after revocation', async () => {
    const original = await create();
    await request(original.id);
    await tick();
    h.revoked = true;
    await expect(pickup(original.id)).rejects.toThrow('revoked');
    expect((await row(original.id)).payload._admissionRecovery.pickupConfirmed).toBe(false);
  });

  it.each(['distinct', 'hold', 'revoke'] as const)(
    'runs the real model-backed screening path with a %s outcome before any claim',
    async (outcome) => {
      const original = await create();
      // Pair selection reads title/condition/embedding, not the census edge.
      const twin = await create(original.title);
      const [a, b] = [original.id, twin.id].sort();
      await db.sql`INSERT INTO harness_shared.dedup_edges
        (workspace_id,harness_slug,a,b,cos,run_id)
        VALUES ('default','papercusp',${a},${b},0.98,'prior-census')`;
      h.model.mockImplementation(async () => {
        // The actual model boundary must precede admission and assignment.
        expect(await row(original.id)).toMatchObject({ admission: 'pending', taken_by: null });
        expect(h.claim).not.toHaveBeenCalled();
        if (outcome === 'revoke') h.revoked = true;
        return {
          text: '', inputTokens: 17, outputTokens: 9, costUsd: 0,
          json: { judgements: [{ pairKey: `${a}::${b}`,
            verdict: outcome === 'hold' ? 'hold' : 'distinct', reason: 'Controlled screening response' }] },
        };
      });
      await request(original.id);
      const result = await tick();
      expect(h.model).toHaveBeenCalledTimes(1);
      expect(await row(twin.id)).toMatchObject({ admission: 'pending', taken_by: null });
      const [ledger] = await db.sql`SELECT promoted, detail FROM harness_shared.admission_runs`;
      // Even a "distinct" judgement cannot authorize its outside-target endpoint
      // writes. Preserve the canonical component fence instead of widening repair.
      if (outcome === 'distinct') expect(result.guardRefusals).toEqual(expect.arrayContaining([
        expect.objectContaining({ itemId: original.id, reason: 'outside-mutation-scope' }),
      ]));
      expect(ledger!.detail.status).toBe(outcome === 'revoke' ? 'failed' : 'complete');
      expect(await row(original.id)).toMatchObject({
        admission: 'pending', taken_by: null,
        payload: { _admissionRecovery: { state: 'held', pickupConfirmed: false } },
      });
      expect(h.claim).not.toHaveBeenCalled();
      expect(h.wake).not.toHaveBeenCalled();
    },
  );
});
