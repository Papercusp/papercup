/** Public blocker contracts over real PostgreSQL. The external condition
 * producer writes the isolated event ledger; validation, identities,
 * dependencies, lifecycle, decision CAS, claims and checkpoints are production. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { FreshPgDb } from '../../../test/_pg-helpers';
import { createPublicParkTestDb } from '../../../test/_public-park-pg';
import type { BlockerDecisionInput } from '../../blocker-resolution-decision';
import { activeExternalBlockers, updateExternalBlockerHistory } from '../../external-blockers';
import { blockerBoundaryContext, createBlockerEvidenceReader, preflightBlockerDecision } from '../../blocker-resolution-evidence';
import { planLaneBlockerRef, syncLinkedWorkItemsToPlanLane } from '../../plan-items/reconcile-linked-work-items';
import { readPlanLineNodes } from '../plans/plan-line-graph';
import { readAgentReviewState } from '../../harness/improvements/agent-review-policy';
import { PLAN_ITEM_KIND, planItemRef } from '../../issue-blocks-merge';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql,
  parkConsult: vi.fn(), parkWake: vi.fn(), parkNotify: vi.fn() }));
vi.mock('../../consult/park-door', async original => ({
  ...(await original<typeof import('../../consult/park-door')>()),
  makeProdParkDoorDeps: () => ({ now: () => Date.now(), openConsult: h.parkConsult,
    registerVerdictWake: h.parkWake, notifyOwner: h.parkNotify }),
}));
vi.mock('@papercusp/db-org', async original => {
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const actual = await original<typeof import('@papercusp/db-org')>();
  const privatePg = () => {
    const db = drizzle(h.sql);
    // Mirror production connection initialization: Drizzle installs transparent
    // serializers, so restore raw SQL's Date/JSONB bindings on this same client.
    actual.restoreRawDateSerializers(h.sql);
    actual.restoreRawJsonbSerializer(h.sql);
    return { sql: h.sql, db };
  };
  return {
  ...actual,
  getOrgPg: privatePg,
  getOrgPgApp: privatePg,
  withWorkspace: async <T>(workspace: string, callback: (sql: postgres.Sql) => Promise<T>) =>
    h.sql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${workspace}, true)`;
      return callback(tx as unknown as postgres.Sql);
    }) as Promise<T>,
};
});
vi.mock('../plans/source', async original => ({
  ...(await original<typeof import('../plans/source')>()),
  resolvePlanScope: async (opts: { harnessSlug?: string } = {}) => ({
    workspaceId: 'default', harnessSlug: opts.harnessSlug ?? 'blocker-boundaries',
  }),
}));
vi.mock('../plans/_ctx-opts', async original => ({
  ...(await original<typeof import('../plans/_ctx-opts')>()),
  ctxToPlanSourceOpts: async (ctx: { harnessSlug?: string }) => ({
    workspaceId: 'default', harnessSlug: ctx.harnessSlug ?? 'blocker-boundaries',
  }),
}));
vi.mock('../../harness-core', async original => ({
  ...(await original<typeof import('../../harness-core')>()),
  resolveProject: async (slug: string) => ({ slug, path: `/tmp/${slug}` }),
}));
vi.mock('../../harness-registry', async original => {
  const { fileURLToPath } = await import('node:url');
  return { ...(await original<typeof import('../../harness-registry')>()),
    loadHarnessRegistry: async () => ({ projects: [{ slug: 'blocker-boundaries',
      path: fileURLToPath(new URL('../../../../../', import.meta.url)), harness_kind: 'project' }] }),
  };
});
vi.mock('../../blueprint/operation-worker-binding', async original => ({
  ...(await original<typeof import('../../blueprint/operation-worker-binding')>()),
  readActiveOperationWorkerClaimBinding: async () => ({ status: 'none' as const }),
}));
vi.mock('../coordination/federation-scope', async original => ({
  ...(await original<typeof import('../coordination/federation-scope')>()),
  resolveWorkspaceHiveScope: async () => ({ kind: 'none' as const }),
}));
vi.mock('../coordination/presence', async original => ({
  ...(await original<typeof import('../coordination/presence')>()),
  listPresence: async () => [{ ownerId: 'agent-repair', workspaceId: 'default', stale: false }],
  getPresence: async (ownerId: string) => ownerId === 'agent-repair'
    ? { ownerId, workspaceId: 'default', stale: false } : null,
}));

// Use the real tenant resolver throughout lazy/circular imports. An async
// partial module mock can leave one evidence reader using the host registry
// while another sees the mocked tenant, invalidating the private DB fixture.
vi.stubEnv('PAPERCUSP_WORKSPACE_ID', 'default');
const wi = await import('../../work-items');
const parkRecovery = await import('../../durable-park-recovery');
const checkpoints = await import('../../work-item-checkpoint');
const { registerAnnouncement, registerAwait, recordKeyFire, fireAwaitsForKey, inspectEventKey } = await import('../../events/await/store');
const { readEventConditionReachability } = await import('../../external-condition-reachability');
const { readBlockerResolution } = await import('../../blocker-resolution-decision');
const { default: setBlocker } = await import('./set_blocker');
const { default: setState } = await import('./set_state');
const { default: release } = await import('./release');
const { default: park } = await import('./park');
const { default: link } = await import('./link');
const { default: claim } = await import('./claim');
const { default: holdOpen } = await import('./hold_open');

const HARNESS = 'blocker-boundaries';
const OWNER = 'su-blocker-boundaries';
const EVENT = 'fixture:dependency-repaired';
const ref = { kind: 'event' as const, ref: EVENT };
const CTX = { isSuperuser: true, uiClientId: OWNER, workspaceId: 'default', role: 'su',
  signal: new AbortController().signal, log: () => {}, progress: () => {}, metadata: () => {} } as never;
type Result = { ok?: boolean; code?: string; error?: string; nextAction?: string;
  results?: Result[]; replayed?: boolean; blockerDecision?: { id: string }; slowPathTiming?: unknown };
async function call(tool: { handler: (args: never, ctx: never) => Promise<unknown> }, args: Record<string, unknown>, ctx = CTX) {
  const result = await tool.handler(args as never, ctx) as { data?: Result; content?: { text?: string }[] };
  const data = result.data ?? JSON.parse(result.content?.find(entry => entry.text?.startsWith('{'))?.text ?? '{}') as Result;
  const row = data.results?.[0] ?? data;
  if (!row.ok && args.blockerDecision) console.info('BOUNDARY_REFUSAL', JSON.stringify({ args, result: row }));
  return row;
}
const checkpointRef = (id: string) => ({ workItemId: id, harness: HARNESS, workspaceId: 'default' });
type DeferralDecision = Extract<BlockerDecisionInput, { disposition: 'defer' }>;
const deferral = (key: string): DeferralDecision => ({ schemaVersion: 1, idempotencyKey: key,
  disposition: 'defer', symptom: 'Dependency probe is pending', evidenceRefs: [ref],
  investigation: [{ action: 'Read the condition producer', outcome: 'Repair has not completed', evidenceRefs: [ref] }],
  attempts: [], deferral: { reason: 'external-dependency', responsibleParty: `event:${EVENT}`,
    reasonEvidenceRefs: [ref], nextAction: 'Resume when the producer certifies recovery', recheckRef: ref } });
const resolution = (key: string): BlockerDecisionInput => ({ schemaVersion: 1, idempotencyKey: key,
  disposition: 'self_resolve', symptom: 'Dependency was unavailable', evidenceRefs: [ref],
  investigation: [{ action: 'Read the condition producer', outcome: 'Safe repair is available', evidenceRefs: [ref] }],
  attempts: [{ action: 'Repair the isolated dependency', outcome: 'Producer confirms recovery', evidenceRefs: [ref] }],
  verification: { outcome: 'The original dependency condition is satisfied', evidenceRefs: [ref] } });
let db: FreshPgDb;
let announcementId: number;
async function declareCondition() {
  const declaration = await registerAnnouncement({ subscriberId: OWNER, eventKey: EVENT,
    scopeKind: 'harness', scopeRef: HARNESS, note: 'Isolated dependency producer',
    expectedCondition: { kind: 'predicate', predicate: { ready: { eq: true } } } });
  announcementId = declaration.id;
  expect(await readEventConditionReachability(EVENT, { requireSpecificCondition: true }))
    .toMatchObject({ verdict: 'reachable', authoritative: true, basis: 'live-resolver' });
}
async function repairCondition() {
  // Simulate the external producer's completed generation without running the
  // automatic consumer reconciler: each public boundary must measure it itself.
  const rows = await db.sql`UPDATE harness_shared.event_awaits
    SET fired_at=now(), fired_reason='event', fired_by='fixture-producer', fired_payload='{"ready":true}'::jsonb
    WHERE id=${announcementId} AND event_key=${EVENT} AND superseded_at IS NULL RETURNING id`;
  expect(rows).toHaveLength(1);
  expect(await readEventConditionReachability(EVENT, { requireSpecificCondition: true }))
    .toMatchObject({ verdict: 'reachable', authoritative: true, basis: 'fired' });
}
beforeAll(async () => {
  db = await createPublicParkTestDb('blocker-boundaries');
  h.sql = db.sql;
  const { getOrgPg } = await import('@papercusp/db-org');
  getOrgPg();
  const [raw] = await db.sql`SELECT ${db.sql.json({ ready: true })}::jsonb AS value`;
  expect(raw.value).toEqual({ ready: true });
}, 90_000);
afterAll(async () => {
  try { await db?.cleanup(); }
  finally { vi.unstubAllEnvs(); }
});
beforeEach(async () => {
  h.parkConsult.mockReset().mockResolvedValue({ consultId: 'prospective-authority-review' });
  h.parkWake.mockReset().mockResolvedValue(undefined);
  h.parkNotify.mockReset().mockResolvedValue(undefined);
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps,
    harness_shared.carry_notes, harness_shared.coord_event_log, harness_shared.blocker_boundary_transactions,
    harness_shared.event_awaits, harness_shared.event_key_fires, harness_shared.predicate_watches,
    harness_shared.coord_entity_subscriptions, harness_shared.routines,
    harness_shared.coord_links RESTART IDENTITY CASCADE`;
  await declareCondition();
});
async function seed(kind: 'task' | 'bug' | 'feature' = 'feature', blocked = true) {
  const item = await wi.createWorkItem({ kind, title: 'Investigate dependency', harness: HARNESS, createdBy: OWNER });
  const blockers = blocked ? [{ kind: 'event', capability: 'live-dependency', ref: EVENT, status: 'active',
    summary: 'Await isolated dependency recovery',
    createdBy: OWNER, createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' }] : [];
  await db.sql`UPDATE harness_shared.work_items SET status='wip', taken_by=${OWNER}, taken_at=now(),
    payload=COALESCE(payload, '{}'::jsonb) || ${db.sql.json({ keep: 'original', externalBlockers: blockers,
      _claimHold: true, claim_hold_by: OWNER })} WHERE feature_id=${item.id}
    AND workspace_id='default' AND harness_slug=${HARNESS}`;
  await checkpoints.setWorkItemCheckpoint(checkpointRef(item.id), 'Original checkpoint');
  const canonical = await wi.getWorkItem(item.id, HARNESS);
  expect(canonical).toMatchObject({ id: item.id, harness: HARNESS, state: 'wip', assignee: OWNER,
    payload: { keep: 'original', _claimHold: true, claim_hold_by: OWNER } });
  expect(activeExternalBlockers(canonical?.payload), JSON.stringify(canonical)).toHaveLength(blocked ? 1 : 0);
  // Validate the actual reader/fixture contract before interpreting a public
  // refusal as a product failure. These reads never replace production logic.
  await wi.readUnresolvedDepBlockers(item.id, HARNESS);
  if (blocked && canonical) {
    const context = { ownerId: OWNER, sessionId: OWNER, workspaceId: 'default',
      harnessSlug: HARNESS, role: 'su', root: null };
    const measured = await createBlockerEvidenceReader({ ...context, workItemId: item.id,
      blockers: activeExternalBlockers(canonical.payload) })(ref);
    expect(measured, JSON.stringify(measured)).toMatchObject({ status: 'available', reachable: true });
    const checked = await preflightBlockerDecision(canonical, deferral('fixture-preflight'), context,
      { effect: { fixture: true }, enteringDeferral: true });
    expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true });
  }
  return item.id;
}
async function snapshot(id: string) {
  const [row] = await db.sql`SELECT to_jsonb(w) AS value FROM harness_shared.work_items w
    WHERE workspace_id='default' AND harness_slug=${HARNESS} AND feature_id=${id}`;
  return { row: row.value, checkpoint: await checkpoints.getWorkItemCheckpoint(checkpointRef(id)),
    edges: [...await db.sql`SELECT * FROM harness_shared.work_item_deps ORDER BY id`],
    events: [...await db.sql`SELECT * FROM harness_shared.coord_event_log ORDER BY id`],
    monitors: {
      awaits: [...await db.sql`SELECT * FROM harness_shared.event_awaits ORDER BY id`],
      watches: [...await db.sql`SELECT * FROM harness_shared.predicate_watches ORDER BY id`],
      subscriptions: [...await db.sql`SELECT * FROM harness_shared.coord_entity_subscriptions ORDER BY id`],
      routines: [...await db.sql`SELECT * FROM harness_shared.routines ORDER BY id`],
    } };
}
async function seedMonitors(id: string) {
  const event = `fixture:monitor:${id}`;
  const bound = { kind: 'work-item', ref: id };
  await registerAwait({ subscriberId: OWNER, eventKey: event, policy: 'notify',
    boundTo: bound, note: 'Existing monitor remains owned' });
  await db.sql`INSERT INTO harness_shared.predicate_watches
    (workspace_id, owner_id, harness_slug, event_key, tool, args, path, op, value, bound_to)
    VALUES ('default', ${OWNER}, ${HARNESS}, ${event}, 'work_items:get', ${db.sql.json({ id })},
      'workItem.state', 'eq', '"done"'::jsonb, ${db.sql.json(bound)})`;
  await db.sql`INSERT INTO harness_shared.coord_entity_subscriptions
    (workspace_id, subscriber_id, target_kind, target_ref, follow_blockers)
    VALUES ('default', ${OWNER}, 'object', ${`feature:${HARNESS}#${id}`}, true)
    ON CONFLICT (workspace_id, subscriber_id, target_kind, target_ref)
      WHERE cancelled_at IS NULL DO UPDATE SET follow_blockers=true`;
  for (const loop of [false, true]) await db.sql`INSERT INTO harness_shared.routines
    (id, workspace_id, install_slug, name, trigger_kind, trigger_config, target_role,
      target_owner_id, reschedule_interval_sec, active, metadata)
    VALUES (${`${loop ? 'loop' : 'routine'}:${id}`}, 'default', ${HARNESS},
      ${`${loop ? 'loop' : 'routine'}:${id}`}, 'cron', '{"cron":"* * * * *"}'::jsonb,
      'su', ${OWNER}, ${loop ? 60 : null}, true, ${db.sql.json({ workItemId: id })})`;
  const { monitors } = await snapshot(id);
  for (const rows of Object.values(monitors)) expect(rows.length).toBeGreaterThan(0);
  expect(monitors.awaits).toEqual(expect.arrayContaining([expect.objectContaining({
    event_key: event, policy: 'notify', bound_to: bound, cancelled_at: null })]));
  expect(monitors.watches).toEqual(expect.arrayContaining([expect.objectContaining({
    event_key: event, bound_to: bound, active: true })]));
  expect(monitors.routines.filter(row => row.metadata.workItemId === id)).toHaveLength(2);
}
const state = (id: string, key: string) => call(setState, {
  id, harness: HARNESS, state: 'blocked', blockerDecision: deferral(key),
});
async function expectPairedMutationTransaction(id: string) {
  const rows = await db.sql<{ phase: string; transaction_id: string }[]>`
    SELECT phase, transaction_id::text FROM harness_shared.blocker_boundary_transactions
    WHERE feature_id=${id} ORDER BY phase`;
  expect(rows.map(row => row.phase)).toEqual(['decision', 'lifecycle']);
  expect(rows[0].transaction_id).toBe(rows[1].transaction_id);
}

describe('catalogued work-item completion evidence', () => {
  it('measures a completed review and fired waiter without a producer announcement', async () => {
    const review = await wi.createWorkItem({ kind: 'feature', title: 'Independent review', harness: HARNESS, createdBy: OWNER });
    const event = `work-item:done:${review.id}`;
    const eventRef = { kind: 'event' as const, ref: event };
    const waiter = await registerAwait({ subscriberId: OWNER, eventKey: event, policy: 'notify', timeoutSec: 60 });
    const read = createBlockerEvidenceReader({ ownerId: OWNER, sessionId: OWNER, workspaceId: 'default',
      harnessSlug: HARNESS, role: 'su', root: null, workItemId: 'WI-original', blockers: [] });

    expect(await read(eventRef)).toMatchObject({ status: 'available', condition: 'pending' });
    await db.sql`UPDATE harness_shared.work_items SET status='done'
      WHERE workspace_id='default' AND harness_slug=${HARNESS} AND feature_id=${review.id}`;
    // A terminal row alone must not substitute for the exact event's proof.
    expect(await read(eventRef)).toMatchObject({ status: 'available', condition: 'pending' });
    const payload = { id: review.id, state: 'done', harness: HARNESS };
    await recordKeyFire({ eventKey: event, firedBy: 'fixture-review-completion', payload });
    await fireAwaitsForKey({ eventKey: event, source: 'work-items', payload });

    const snapshot = await inspectEventKey(event);
    expect(snapshot.announcements).toEqual([]);
    expect(snapshot.fireLatch?.lastFiredAt).toBeTruthy();
    expect(snapshot.waiters).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: waiter.id, firedReason: 'event' }),
    ]));
    expect(await readEventConditionReachability(event, { requireSpecificCondition: true }))
      .toMatchObject({ authoritative: true, verdict: 'reachable', basis: 'fired' });
    expect(await read(eventRef)).toMatchObject({ status: 'available', condition: 'satisfied',
      reachable: true, canonicalWorkItemId: review.id });
  });
});

// Four maintained callers, including both homogeneous ids and heterogeneous
// items defaults. The request goes through the PUBLIC parser and handler; no
// fixture release/admission substitute can make this census pass.
const parkCallCensus = (['bug', 'feature'] as const).flatMap(kind =>
  [false, true].flatMap(blocker => (['single', 'ids-default', 'items-default', 'items-override'] as const)
    .map(form => ({ kind, blocker, form }))));
type ParkCall = typeof parkCallCensus[number];
async function publicParkCase(entry: ParkCall) {
  const ids = await Promise.all(Array.from({ length: entry.form === 'single' ? 1 : 2 }, () => seed(entry.kind, entry.blocker)));
  await db.sql`UPDATE harness_shared.work_items SET payload=payload - '_claimHold' - 'claim_hold_by'
    WHERE feature_id=ANY(${ids}::text[])`;
  const contract = { condition: 'Every input is qualified', trigger: EVENT, owner: 'fixture-producer' };
  const defaults = { harness: HARNESS, claimHold: true, claimHoldRelease: contract,
    ...(entry.blocker ? { blockerDecision: deferral(`park-${ids.join('-')}`) } : {}) };
  const args = entry.form === 'single' ? { ...defaults, id: ids[0] }
    : entry.form === 'ids-default' ? { ...defaults, ids }
    : entry.form === 'items-default' ? { ...defaults, items: ids.map(id => ({ id })) }
    : { ...defaults, claimHold: false,
      claimHoldRelease: { condition: 'Unused default', trigger: 'fixture:unused-default' },
      items: ids.map(id => ({ id, claimHold: true, claimHoldRelease: contract })) };
  const run = async () => {
    const result = await release.handler(release.args.parse(args) as never, CTX) as { data: { results: Result[] } };
    return result.data.results;
  };
  const rows = async () => Promise.all(ids.map(async id => ({
    row: (await snapshot(id)).row, checkpoint: await checkpoints.getWorkItemCheckpoint(checkpointRef(id)),
  })));
  return { ids, run, rows, contract };
}
async function parkTimers() {
  return db.sql`SELECT id, subscriber_id, expires_ts, producer_health FROM harness_shared.event_awaits
    WHERE producer_health->'producer'->>'kind'='durable-park-recovery' ORDER BY id`;
}
describe('PARK-ADMISSION unchanged public call census', () => {
  it.each((['bug', 'feature'] as const).flatMap(kind => [false, true].flatMap(blocker =>
    (['qualification', 'admission'] as const).map(winner => ({ kind, blocker, winner })))))
  ('$kind blocker=$blocker: serializes $winner first after the public condition probe', async ({ kind, blocker, winner }) => {
    const fixture = await publicParkCase({ kind, blocker, form: 'single' });
    const before = await fixture.rows();
    let reached = false;
    let resume!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    // These wrappers only insert scheduling barriers. Both paths execute the
    // actual public parser, handler, writer, event lock and admission function.
    const originalRelease = wi.releaseWorkItem;
    const originalLock = parkRecovery.lockParkRecoveryCondition;
    const barrier = winner === 'qualification'
      ? vi.spyOn(wi, 'releaseWorkItem').mockImplementationOnce(async (...args) => {
          reached = true;
          await paused;
          return originalRelease(...args);
        })
      : vi.spyOn(parkRecovery, 'lockParkRecoveryCondition').mockImplementationOnce(async (...args) => {
          await originalLock(...args);
          reached = true;
          await paused;
        });
    const pending = fixture.run();
    let producer: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => { expect(reached).toBe(true); }, { timeout: 10_000 });
      const qualify = () => db.sql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'event-announce:' + EVENT}, 0))`;
        await tx`UPDATE harness_shared.event_awaits SET fired_at=now(), fired_reason='event',
          fired_payload='{"ready":true}'::jsonb WHERE id=${announcementId}`;
      });
      if (winner === 'qualification') await qualify();
      else {
        producer = qualify();
        // Observe the losing producer's actual wait, not an elapsed-time guess.
        await vi.waitFor(async () => {
          const [row] = await db.sql`SELECT count(*)::int AS waiting FROM pg_locks
            WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`;
          expect(row.waiting).toBe(1);
        }, { timeout: 10_000 });
      }
      resume();
      const result = await pending;
      await producer;
      expect(result).toHaveLength(1);
      if (winner === 'qualification') {
        expect(result[0]).toMatchObject({ ok: true, parkAdmission: 'already-satisfied' });
        expect(await fixture.rows()).toEqual(before);
        expect(await parkTimers()).toHaveLength(0);
        expect(await db.sql`SELECT feature_id FROM harness_shared.work_items WHERE condition_key IS NOT NULL`).toHaveLength(0);
      } else {
        expect(result[0]).toMatchObject({ ok: true });
        const [saved] = await fixture.rows();
        const [timer] = await parkTimers();
        expect(await parkTimers()).toHaveLength(1);
        expect(saved.row).toMatchObject({ taken_by: null, payload: { _claimHold: true,
          claim_hold_by: OWNER, claim_hold_release: fixture.contract } });
        expect(saved.row.payload.claim_hold_release.recovery.awaitId).toBe(Number(timer.id));
        expect(timer.producer_health.details.parkRecovery.state).toBe('waiting');
        const admission = saved.row.payload.claim_hold_release.recovery;
        expect(await db.sql.begin(tx => parkRecovery.checkParkRecoveryInTransaction(tx, {
          awaitId: admission.awaitId, receipt: admission.receipt, nowMs: admission.receipt.deadlineMs,
        }))).toMatchObject({ disposition: 'retired' });
        const [retired] = await fixture.rows();
        const protectedRow = (value: typeof retired) => {
          const copy = structuredClone(value);
          delete copy.row.payload.claim_hold_release.recovery;
          return copy;
        };
        expect(protectedRow(retired)).toEqual(protectedRow(saved));
        expect(await db.sql`SELECT feature_id FROM harness_shared.work_items WHERE condition_key IS NOT NULL`).toHaveLength(0);
      }
    } finally {
      resume();
      barrier.mockRestore();
      await Promise.allSettled([pending, ...(producer ? [producer] : [])]);
    }
  });

  it.each(parkCallCensus)('$kind blocker=$blocker $form: complete condition has no artifacts; unsatisfied commits exactly once', async entry => {
    const fixture = await publicParkCase(entry);
    await repairCondition();
    const before = await fixture.rows();
    for (const result of await fixture.run()) expect(result).toMatchObject({ ok: false, code: 'wait_ref_already_satisfied' });
    expect(await fixture.rows()).toEqual(before);
    expect(await parkTimers()).toHaveLength(0);
    expect(await db.sql`SELECT feature_id FROM harness_shared.work_items WHERE condition_key IS NOT NULL`).toHaveLength(0);
    await db.sql`UPDATE harness_shared.event_awaits SET fired_at=NULL, fired_reason=NULL, fired_payload=NULL
      WHERE id=${announcementId}`;
    for (const result of await fixture.run()) expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const after = await fixture.rows();
    const timers = await parkTimers();
    expect(timers).toHaveLength(fixture.ids.length);
    for (const saved of after) {
      const admission = saved.row.payload.claim_hold_release.recovery;
      expect(saved.row).toMatchObject({ taken_by: null, payload: { _claimHold: true,
        keep: 'original', claim_hold_by: OWNER, claim_hold_release: fixture.contract } });
      expect(admission.receipt).toMatchObject({ custodianId: OWNER, state: 'waiting',
        workItemId: saved.row.feature_id, policy: { initialMs: 1_800_000, maxExtensions: 2, maxAgeMs: 5_400_000 } });
      expect(timers.find(timer => Number(timer.id) === admission.awaitId)?.subscriber_id).toBe(admission.receipt.id);
      expect(saved.row.payload.externalBlockers).toEqual(before.find(item => item.row.feature_id === saved.row.feature_id)!.row.payload.externalBlockers);
    }
    for (const result of await fixture.run()) expect(result).toMatchObject({ ok: true, replayed: true });
    expect(await fixture.rows()).toEqual(after);
    expect(await parkTimers()).toEqual(timers);
  });

  it.each((['bug', 'feature'] as const).flatMap(kind => [false, true].flatMap(blocker =>
    ['insert', 'commit'].map(cut => ({ kind, blocker, cut })))))('$kind blocker=$blocker: rollback at $cut leaves claim, checkpoint and condition actionable', async ({ kind, blocker, cut }) => {
    const fixture = await publicParkCase({ kind, blocker, form: 'single' });
    const before = await fixture.rows();
    await db.sql.unsafe(`CREATE FUNCTION harness_shared.reject_public_park() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN IF NEW.producer_health->'producer'->>'kind'='durable-park-recovery' THEN
        RAISE EXCEPTION 'public park crash cut'; END IF; RETURN NEW; END $fn$`);
    await db.sql.unsafe(cut === 'insert'
      ? `CREATE TRIGGER reject_public_park BEFORE INSERT ON harness_shared.event_awaits FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_public_park()`
      : `CREATE CONSTRAINT TRIGGER reject_public_park AFTER INSERT ON harness_shared.event_awaits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_public_park()`);
    try {
      for (const result of await fixture.run()) expect(result).toMatchObject({ ok: false });
      expect(await fixture.rows()).toEqual(before);
      expect(await parkTimers()).toHaveLength(0);
    } finally {
      await db.sql.unsafe('DROP TRIGGER reject_public_park ON harness_shared.event_awaits; DROP FUNCTION harness_shared.reject_public_park()');
    }
    for (const result of await fixture.run()) expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(await parkTimers()).toHaveLength(1);
  });
});

describe('public blocker resolution boundaries', () => {
  async function legacyRuntime() {
    const id = await seed('feature', false);
    const recheck = await seed('task', false);
    const runtime = { kind: 'runtime' as const, ref: 'runtime:codex-execution-authority:9171' };
    const witness = { kind: 'work-item' as const, ref: `${HARNESS}#${recheck}` };
    const blockers = [{ ...runtime, status: 'active', summary: 'Original native availability remains unmeasured',
      createdBy: OWNER, createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z',
      reachability: { verdict: 'unknown', authoritative: false, basis: 'unmeasured' } }];
    await db.sql`UPDATE harness_shared.work_items SET status='blocked',
      payload=payload || ${db.sql.json({ externalBlockers: blockers })}
      WHERE workspace_id='default' AND harness_slug=${HARNESS} AND feature_id=${id}`;
    const input: DeferralDecision = { schemaVersion: 1, idempotencyKey: `legacy-${id}`, disposition: 'defer',
      symptom: 'The original runtime predicate cannot be measured', evidenceRefs: [runtime, witness],
      investigation: [{ action: 'Read the original blocker and diagnostic record', outcome: 'No recovery verdict', evidenceRefs: [runtime, witness] }],
      attempts: [{ action: 'Attempt the recorded safe diagnostic', outcome: 'The owned diagnostic retains the measurement gap', evidenceRefs: [witness] }],
      deferral: { reason: 'technical-limit', responsibleParty: OWNER, reasonEvidenceRefs: [runtime],
        nextAction: 'Continue diagnosis under the separate retained recheck', recheckRef: witness } };
    return { id, input, blockers, recheck };
  }

  async function proposedSettlementRecheck() {
    const fixture = await legacyRuntime();
    const settlementManifest = { version: 1, generation: 1, evidenceHash: 'e'.repeat(64),
      repositoryRoot: process.cwd(), headSha: 'a'.repeat(40), normalizedPaths: ['repair.ts'],
      contentIdentity: [{ path: 'repair.ts', headBlobSha: 'b'.repeat(40), workingTreeBlobSha: 'c'.repeat(40) }] };
    await db.sql`UPDATE harness_shared.work_items SET status='done', taken_by=NULL,
      terminal_owner=${OWNER}, authority='proposed',
      payload=payload || ${db.sql.json({ _completionEvidence: { settlementManifest } })}
      WHERE workspace_id='default' AND harness_slug=${HARNESS} AND feature_id=${fixture.recheck}`;
    fixture.input.deferral.recheckRef = { kind: 'event', ref: `work-item:settled:${fixture.recheck}` };
    return fixture;
  }

  it('plain release retains a real pending owned commit settlement without clearing the runtime blocker', async () => {
    const { id, input, blockers, recheck } = await proposedSettlementRecheck();
    expect(await call(release, { id, harness: HARNESS, blockerDecision: input }))
      .toMatchObject({ ok: true, blockerDecision: { decision: { disposition: 'defer' } } });
    const current = await wi.getWorkItem(id, HARNESS);
    expect(current).toMatchObject({ state: 'blocked', assignee: null });
    expect((current!.payload as Record<string, unknown>).externalBlockers).toEqual(blockers);
    expect(await wi.getWorkItem(recheck, HARNESS))
      .toMatchObject({ state: 'done', completionAuthority: 'proposed', terminalOwner: OWNER, assignee: null });
  });

  it.each(['foreign owner', 'missing manifest'])('refuses an invalid pending settlement: %s', async invalid => {
    const { id, input, recheck } = await proposedSettlementRecheck();
    if (invalid === 'foreign owner') {
      await db.sql`UPDATE harness_shared.work_items SET terminal_owner='su-other'
        WHERE workspace_id='default' AND harness_slug=${HARNESS} AND feature_id=${recheck}`;
    } else {
      await db.sql`UPDATE harness_shared.work_items SET payload=payload - '_completionEvidence'
        WHERE workspace_id='default' AND harness_slug=${HARNESS} AND feature_id=${recheck}`;
    }
    const before = await snapshot(id);
    expect(await call(release, { id, harness: HARNESS, blockerDecision: input })).toMatchObject({ ok: false });
    expect(await snapshot(id)).toEqual(before);
  });

  it('ordinary public release executes the real writer without clearing an unmeasured runtime condition', async () => {
    const { id, input, blockers } = await legacyRuntime();
    const args = release.args.parse({ id, harness: HARNESS, reason: 'Retain original unknown', blockerDecision: input });
    expect(await call(release, args)).toMatchObject({ ok: true, blockerDecision: { decision: { disposition: 'defer' } } });
    const item = await wi.getWorkItem(id, HARNESS);
    expect(item).toMatchObject({ state: 'blocked', assignee: null, payload: { keep: 'original', _claimHold: true } });
    expect((item!.payload as Record<string, unknown>).externalBlockers).toEqual(blockers);
    expect(readBlockerResolution(item!.payload)).toMatchObject({ status: 'recorded', current: { decision: { disposition: 'defer' } } });
    const after = await snapshot(id);
    expect(await call(release, args)).toMatchObject({ ok: true, replayed: true });
    expect(await snapshot(id)).toEqual(after);
    expect(await call(release, { ...args, reason: 'Changed reason on same key' }))
      .toMatchObject({ ok: false, code: 'blocker_decision_conflict' });
    expect(await snapshot(id)).toEqual(after);
  });

  it.each([{ payloadPatch: { keep: 'rewritten' } }, { unset: ['keep'] }])(
    'real release writer refuses a hidden payload mutation behind the public effect: %j', async mutation => {
      const { id, input } = await legacyRuntime();
      const before = await snapshot(id);
      await expect(wi.releaseWorkItem(id, { harness: HARNESS, expectedAssignee: OWNER, releasingOwnerId: OWNER,
        blockerEvidenceContext: { ownerId: OWNER, sessionId: OWNER, workspaceId: 'default', harnessSlug: HARNESS, role: 'su', root: null },
        blockerDecision: { input, sessionId: OWNER, ...mutation,
          effect: { release: true, claimHold: null, claimHoldRelease: null, reason: 'Retain original unknown', force: false } },
      })).rejects.toMatchObject({ code: 'blocker_decision_evidence' });
      expect(await snapshot(id)).toEqual(before);
    });

  it.each([{ force: true }, { claimHold: false },
    { claimHold: true, claimHoldRelease: { condition: 'Wait', trigger: EVENT } },
    { claimHoldRelease: { condition: 'Wait', trigger: EVENT } }])('refuses public runtime defer mutation %j', async mutation => {
    const { id, input } = await legacyRuntime();
    const before = await snapshot(id);
    const args = release.args.parse({ id, harness: HARNESS, reason: 'Retain unknown', blockerDecision: input, ...mutation });
    expect(await call(release, args)).toMatchObject({ ok: false });
    expect(await snapshot(id)).toEqual(before);
  });

  async function completedDependency(kind: 'task' | 'feature' = 'feature') {
    const id = await seed('feature', false);
    const dependency = await seed(kind, false);
    const dependencyRef = kind === 'task' ? dependency : `${HARNESS}#${dependency}`;
    await db.sql`INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
      VALUES ('default', 'feature', ${`${HARNESS}#${id}`}, ${kind === 'task' ? 'issue' : 'feature'}, ${dependencyRef}, 'blocks')`;
    await db.sql`UPDATE harness_shared.work_items SET status='done'
      WHERE workspace_id='default' AND harness_slug=${HARNESS} AND feature_id=${dependency}`;
    await db.sql`UPDATE harness_shared.work_items SET status='blocked'
      WHERE workspace_id='default' AND harness_slug=${HARNESS} AND feature_id=${id}`;
    const witness = { kind: 'work-item' as const, ref: `${HARNESS}#${dependency}` };
    const decision: BlockerDecisionInput = { schemaVersion: 1, idempotencyKey: `completed-${kind}`,
      disposition: 'self_resolve', symptom: 'The original dependency finished while this item was blocked',
      investigation: [{ action: 'Read the canonical dependency edge and endpoint',
        outcome: 'The related endpoint completed', evidenceRefs: [witness] }],
      attempts: [], evidenceRefs: [witness],
      verification: { outcome: 'The original dependency is terminal', evidenceRefs: [witness] } };
    return { id, dependency, witness, decision };
  }

  it.each(['task', 'feature'] as const)('resumes after its completed %s dependency leaves the unresolved set', async kind => {
    const { id, dependency, decision } = await completedDependency(kind);
    expect(await wi.readUnresolvedDepBlockers(id, HARNESS)).toEqual([]);
    expect(await call(setState, { id, harness: HARNESS, state: 'wip', blockerDecision: decision }))
      .toMatchObject({ ok: true });
    expect(await wi.getWorkItem(id, HARNESS)).toMatchObject({ state: 'wip', assignee: OWNER });
    expect(await wi.getWorkItem(dependency, HARNESS)).toMatchObject({ state: 'done' });
    expect(readBlockerResolution((await wi.getWorkItem(id, HARNESS))?.payload).status).toBe('recorded');
  });

  it('refuses an unrelated completed witness when the original dependency has settled', async () => {
    const { id, decision } = await completedDependency();
    const unrelated = await seed('task', false);
    await db.sql`UPDATE harness_shared.work_items SET status='done'
      WHERE workspace_id='default' AND harness_slug=${HARNESS} AND feature_id=${unrelated}`;
    const witness = { kind: 'work-item' as const, ref: `${HARNESS}#${unrelated}` };
    const before = await snapshot(id);
    expect(await call(setState, { id, harness: HARNESS, state: 'wip', blockerDecision: {
      ...decision, verification: { outcome: 'An unrelated repair completed', evidenceRefs: [witness] },
    } })).toMatchObject({ ok: false, code: 'blocker_decision_evidence' });
    expect(await snapshot(id)).toEqual(before);
  });

  it('does not let a completed dependency witness clear a second pending dependency', async () => {
    const { id, decision } = await completedDependency();
    const pending = await seed('task', false);
    await db.sql`INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
      VALUES ('default', 'feature', ${`${HARNESS}#${id}`}, 'issue', ${pending}, 'blocks')`;
    const before = await snapshot(id);
    expect(await call(setState, { id, harness: HARNESS, state: 'wip', blockerDecision: decision }))
      .toMatchObject({ ok: false, code: 'blocker_decision_evidence' });
    expect(await snapshot(id)).toEqual(before);
  });

  it('guards all public deferral boundaries before mutation', async () => {
    for (const kind of ['task', 'feature'] as const) {
      const id = await seed(kind);
      const source = await seed('task', false);
      const before = await snapshot(id);
      const requests = [
        [setBlocker, { id, kind: 'event', ref: EVENT }],
        [setBlocker, { id, ref: EVENT, clear: true }],
        [setState, { id, state: 'blocked' }],
        [setState, { id, state: 'open' }],
        [release, { id }],
        [release, { id, claimHold: true }],
        [park, { id, checkpoint: 'Must not overwrite original', reason: 'Dependency remains' }],
        [link, { id: source, target_id: id, target_harness: HARNESS, rel: 'blocks' }],
      ] as const;
      for (const [tool, args] of requests) {
        const result = await call(tool, { ...args, harness: HARNESS });
        expect(result, JSON.stringify({ args, result })).toMatchObject({ ok: false, code: 'blocker_decision_evidence' });
        expect(await snapshot(id), JSON.stringify(args)).toEqual(before);
      }
    }
  });
  it('preserves work state and claim on refusal', async () => {
    const id = await seed();
    const before = await snapshot(id);
    const invalid = await call(setBlocker, { id, harness: HARNESS, kind: 'event', ref: EVENT,
      blockerDecision: { ...deferral('invalid'), evidenceRefs: [{ kind: 'work-item', ref: `${HARNESS}#WI-absent` }] } });
    expect(invalid).toMatchObject({ ok: false, code: 'blocker_decision_evidence', nextAction: expect.stringContaining('custody') });
    expect(await snapshot(id)).toEqual(before);
  });
  it('persists one decision across blocker boundaries', async () => {
    const id = await seed();
    const args = { id, harness: HARNESS, kind: 'event', ref: EVENT, blockerDecision: deferral('persist') };
    const first = await call(setBlocker, args);
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
    const recorded = readBlockerResolution((await wi.getWorkItem(id, HARNESS))?.payload);
    expect(recorded.status).toBe('recorded');
    const before = await snapshot(id);
    expect(await call(setBlocker, args)).toMatchObject({ ok: true, replayed: true, blockerDecision: first.blockerDecision });
    expect(await snapshot(id)).toEqual(before);
    expect(await call(setState, { id, harness: HARNESS, state: 'open', blockerDecision: deferral('persist') }))
      .toMatchObject({ ok: false, code: 'blocker_decision_conflict' });
    expect(await snapshot(id)).toEqual(before);
  });
  it.each(['task', 'feature'] as const)('admits the first event blocker through the atomic lifecycle preflight for %s', async kind => {
    const id = await seed(kind, false);
    const result = await call(setBlocker, { id, harness: HARNESS, kind: 'event', ref: EVENT,
      blockerDecision: deferral('first-event') });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(await wi.getWorkItem(id, HARNESS)).toMatchObject({ state: 'blocked', assignee: OWNER });
    expect(activeExternalBlockers((await wi.getWorkItem(id, HARNESS))?.payload))
      .toMatchObject([{ ref: EVENT, status: 'active' }]);
    await expectPairedMutationTransaction(id);
  });
  it.each(['bug', 'feature'] as const)('admits a first product-decision park after its caller ref becomes a consult ref for %s', async kind => {
    const id = await seed(kind, false);
    // A newly created task may still have an independent agent-review gate.
    // Exercise an admitted issue, matching the production bug-item failure.
    const current = await wi.getWorkItem(id, HARNESS);
    expect(['pending', 'revision-requested']).not.toContain(readAgentReviewState(current?.payload)?.status);
    const authority = { kind: 'authority' as const, ref: 'fixture:owner-publication-exception' };
    const decision: DeferralDecision = { ...deferral('first-authority'), evidenceRefs: [authority, ref],
      investigation: [{ action: 'Read the owner-only publication gate', outcome: 'Owner approval remains pending',
        evidenceRefs: [authority, ref] }],
      deferral: { reason: 'missing-authority', responsibleParty: 'product-owner',
        reasonEvidenceRefs: [authority], nextAction: 'Preserve the gate until the owner signs off', recheckRef: ref } };
    const args = { id, harness: HARNESS, kind: 'human', capability: 'product-decision', ref: authority.ref,
      summary: 'Owner approval for a publication exception', ownerAuthorityTopic: 'publish',
      nextVerb: 'After owner approval, perform the audited publication exception',
      defaultIfUnanswered: 'Preserve the publication gate; silence is not approval',
      decideBy: new Date(Date.now() + 3_600_000).toISOString(), blockerDecision: decision };
    const result = await call(setBlocker, args);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const item = await wi.getWorkItem(id, HARNESS);
    // Issue-family owner parks release the claim; feature-family parks retain it.
    expect({ state: item?.state, assignee: item?.assignee })
      .toEqual({ state: 'needs-human', assignee: kind === 'bug' ? null : OWNER });
    expect(activeExternalBlockers(item?.payload)).toMatchObject([
      { ref: 'consult:prospective-authority-review', capability: 'product-decision', status: 'active' },
    ]);
    await expectPairedMutationTransaction(id);
    const before = await snapshot(id);
    expect(await call(setBlocker, args)).toMatchObject({ ok: true, replayed: true });
    expect(await snapshot(id)).toEqual(before);
    expect(h.parkConsult).toHaveBeenCalledTimes(1);
    expect(h.parkConsult).toHaveBeenCalledWith(expect.objectContaining({
      cascade: expect.objectContaining({ ownerAuthorityTopic: 'publish' }),
    }));
  });
  it('safe repair clears the blocker and retains custody', async () => {
    for (const kind of ['task', 'feature'] as const) {
      const id = await seed(kind);
      const before = await snapshot(id);
      const args = { id, harness: HARNESS, ref: EVENT, clear: true, blockerDecision: resolution('repair') };
      expect(await call(setBlocker, args)).toMatchObject({ ok: false, code: 'blocker_decision_evidence' });
      expect(await snapshot(id)).toEqual(before);
      await repairCondition();
      expect(await call(setBlocker, args)).toMatchObject({ ok: true });
      const item = await wi.getWorkItem(id, HARNESS);
      expect(item?.assignee).toBe(OWNER);
      expect(item?.payload).toMatchObject({ externalBlockers: [{ status: 'cleared' }],
        blockerResolution: { history: [{ authorId: OWNER, sessionId: OWNER }] } });
      expect(await checkpoints.getWorkItemCheckpoint(checkpointRef(id))).toBe('Original checkpoint');
      await declareCondition();
    }
  });
  it('resumes only after measured dependency clearance', async () => {
    const id = await seed();
    expect(await state(id, 'defer-before-resume')).toMatchObject({ ok: true });
    const before = await snapshot(id);
    expect(await call(setBlocker, { id, harness: HARNESS, ref: EVENT, clear: true,
      blockerDecision: { ...resolution('premature-resume'), priorRevision: 1 } })).toMatchObject({ ok: false, code: 'blocker_decision_evidence' });
    expect(await snapshot(id)).toEqual(before);
    await repairCondition();
    expect(await call(setBlocker, { id, harness: HARNESS, ref: EVENT, clear: true,
      blockerDecision: { ...resolution('measured-resume'), priorRevision: 1 } })).toMatchObject({ ok: true });
    expect(await wi.getWorkItem(id, HARNESS)).toMatchObject({ state: 'open', assignee: OWNER });
  });

  it('preserves custody when a fired event does not match its declared condition', async () => {
    const id = await seed();
    await db.sql`UPDATE harness_shared.event_awaits
      SET fired_at=now(), fired_reason='event', fired_by='fixture-producer', fired_payload='{"ready":false}'::jsonb
      WHERE id=${announcementId} AND event_key=${EVENT} AND superseded_at IS NULL`;
    expect(await readEventConditionReachability(EVENT, { requireSpecificCondition: true }))
      .toMatchObject({ verdict: 'unknown', authoritative: false, uncertifiedReason: 'expected-condition-unproven' });
    // The producer emission is test setup; the refusal must preserve the state
    // measured after it, including the canonical event registration.
    const before = await snapshot(id);
    const args = { id, harness: HARNESS, ref: EVENT, clear: true, blockerDecision: resolution('matched-fire-only') };
    expect(await call(setBlocker, args)).toMatchObject({ ok: false, code: 'blocker_decision_evidence' });
    expect(await snapshot(id)).toEqual(before);
    await repairCondition();
    expect(await call(setBlocker, args)).toMatchObject({ ok: true });
    expect(await wi.getWorkItem(id, HARNESS)).toMatchObject({ assignee: OWNER,
      payload: { externalBlockers: [{ status: 'cleared' }] } });
  });

  it('honors peer human and external custody', async () => {
    const peer = await seed('task', false);
    await db.sql`UPDATE harness_shared.work_items SET taken_by='agent-repair'
      WHERE workspace_id='default' AND harness_slug=${HARNESS} AND feature_id=${peer}`;
    const id = await seed('feature', false);
    const peerRef = { kind: 'work-item' as const, ref: `${HARNESS}#${peer}` };
    await db.sql`INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
      VALUES ('default', 'feature', ${`${HARNESS}#${id}`}, 'issue', ${peer}, 'blocks')`;
    const peerDecision: DeferralDecision = { ...deferral('peer'), evidenceRefs: [peerRef],
      investigation: [{ action: 'Read canonical peer work', outcome: 'Live repair owner retains custody', evidenceRefs: [peerRef] }],
      deferral: { reason: 'active-peer', responsibleParty: 'agent-repair', reasonEvidenceRefs: [peerRef],
        nextAction: 'Resume when the owned dependency settles', recheckRef: peerRef } };
    const peerMeasurement = await createBlockerEvidenceReader({ ownerId: OWNER,
      workspaceId: 'default', harnessSlug: HARNESS, role: 'su', root: null,
      workItemId: id, blockers: [] })(peerRef);
    expect(peerMeasurement, JSON.stringify(peerMeasurement)).toMatchObject({ status: 'available',
      condition: 'pending', responsibleParty: 'agent-repair', liveOwnerId: 'agent-repair' });
    const dependencies = await wi.readUnresolvedDepBlockers(id, HARNESS);
    expect(dependencies, JSON.stringify(dependencies)).toHaveLength(1);
    expect(await preflightBlockerDecision((await wi.getWorkItem(id, HARNESS))!, peerDecision,
      { ownerId: OWNER, sessionId: OWNER, workspaceId: 'default', harnessSlug: HARNESS,
        role: 'su', root: null }, { effect: { fixture: 'peer' }, enteringDeferral: true }),
    JSON.stringify({ peerMeasurement, dependencies })).toMatchObject({ ok: true });
    // The edge above bypasses the production link writer. Establish the
    // holder recovery interests that writer normally creates before measuring
    // whether a repeated public link preserves the existing monitor rows.
    const recovery = await wi.armWorkItemHolderInterests((await wi.getWorkItem(id, HARNESS))!, OWNER);
    expect(recovery?.event_keys).toEqual([`work-item:done:${peer}`, `work-item:unblocked:${id}`]);
    expect(recovery?.await_ids).toHaveLength(2);
    const recoveryRows = (await snapshot(id)).monitors.awaits.filter(row =>
      row.bound_to?.kind === 'work-item-blocked' && row.bound_to.ref === id);
    expect(recoveryRows).toHaveLength(2);
    for (const row of recoveryRows) expect(row).toMatchObject({
      subscriber_id: OWNER, policy: 'wake', once: true, cancelled_at: null,
    });
    await seedMonitors(id);
    const before = await snapshot(id);
    expect(await call(setState, { id, harness: HARNESS, state: 'needs-human', blockerDecision: {
      ...peerDecision, deferral: { ...peerDecision.deferral, responsibleParty: 'absent-peer' },
    } })).toMatchObject({ ok: false, code: 'blocker_decision_evidence' });
    expect(await snapshot(id)).toEqual(before);
    // A peer dependency never becomes a human ask. Preserve the existing
    // lifecycle authority gate as well as the validated peer decision.
    expect(await call(setState, { id, harness: HARNESS, state: 'needs-human', blockerDecision: peerDecision }))
      .toMatchObject({ ok: false, error: expect.stringContaining('no answerable owner ask') });
    expect(await snapshot(id)).toEqual(before);
    expect(await call(setState, { id, harness: HARNESS, state: 'blocked', blockerDecision: peerDecision }))
      .toMatchObject({ ok: false, error: expect.stringContaining('no active typed blocker') });
    expect(await snapshot(id)).toEqual(before);
    expect(await call(link, { id: peer, harness: HARNESS, rel: 'blocks', target_id: id,
      blockerDecision: peerDecision })).toMatchObject({ ok: true });
    expect(await wi.getWorkItem(peer, HARNESS)).toMatchObject({ state: 'wip', assignee: 'agent-repair' });
    expect(await wi.getWorkItem(id, HARNESS)).toMatchObject({ assignee: OWNER });
    expect((await snapshot(id)).edges).toEqual(before.edges);
    expect((await snapshot(id)).monitors).toEqual(before.monitors);

    const human = await seed();
    const authority = { kind: 'authority' as const, ref: 'fixture:device-action' };
    const humanBlocker = { kind: 'human', capability: 'physical-device', ref: authority.ref,
      summary: 'Device holder must press the physical confirmation', status: 'active',
      nextVerb: 'Device holder presses the physical confirmation',
      defaultIfUnanswered: 'Keep the work parked until physical acceptance',
      createdBy: OWNER, createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' };
    await db.sql`UPDATE harness_shared.work_items SET payload=jsonb_set(payload, '{externalBlockers}',
      (payload->'externalBlockers') || ${db.sql.json([humanBlocker])})
      WHERE workspace_id='default' AND harness_slug=${HARNESS} AND feature_id=${human}`;
    const humanDecision: DeferralDecision = { ...deferral('human'), evidenceRefs: [authority, ref],
      investigation: [{ action: 'Inspect capability and event', outcome: 'Physical action requires the device holder', evidenceRefs: [authority, ref] }],
      deferral: { reason: 'human-action', responsibleParty: 'device-holder', reasonEvidenceRefs: [authority],
        nextAction: 'Device holder performs physical confirmation; await its declared event', recheckRef: ref } };
    await seedMonitors(human);
    const humanBefore = await snapshot(human);
    expect(await call(setState, { id: human, harness: HARNESS, state: 'needs-human', blockerDecision: humanDecision })).toMatchObject({ ok: true });
    expect(await wi.getWorkItem(human, HARNESS)).toMatchObject({ assignee: OWNER });
    expect(activeExternalBlockers((await wi.getWorkItem(human, HARNESS))?.payload)).toHaveLength(2);
    expect((await snapshot(human)).checkpoint).toBe(humanBefore.checkpoint);
    expect((await snapshot(human)).monitors).toEqual(humanBefore.monitors);

    const external = await seed();
    await seedMonitors(external);
    const externalBefore = await snapshot(external);
    expect(await state(external, 'external-custody')).toMatchObject({ ok: true });
    expect(await wi.getWorkItem(external, HARNESS)).toMatchObject({ state: 'blocked', assignee: OWNER });
    expect((await snapshot(external)).monitors).toEqual(externalBefore.monitors);
  });

  const PLAN = 'blocker-boundary-lane';
  const lane = { planSlug: PLAN, itemId: 'P-001', harnessSlug: HARNESS };
  async function planNode(status: string, harness = HARNESS) {
    const item = await wi.createWorkItem({ kind: 'task', title: 'Canonical plan lane', harness, createdBy: OWNER });
    await db.sql`UPDATE harness_shared.work_items SET status=${status}, plan_slug=${PLAN},
      plan_line_id='P-001', plan_seq=1, plan_line_text='Canonical plan lane', payload='{}'::jsonb
      WHERE workspace_id='default' AND harness_slug=${harness} AND feature_id=${item.id}`;
    expect(await readPlanLineNodes(db.sql, { workspaceId: 'default', harnessSlug: harness, slug: PLAN }))
      .toMatchObject([{ featureId: item.id, id: 'P-001' }]);
    return item.id;
  }
  async function legacyChild() {
    const child = await seed('feature', false);
    await db.sql`UPDATE harness_shared.work_items SET status='open', taken_by=NULL,
      payload=payload || ${db.sql.json({ plan_item: { plan_slug: PLAN, item_id: 'P-001' } })}
      WHERE workspace_id='default' AND harness_slug=${HARNESS} AND feature_id=${child}`;
    return child;
  }
  it('mutates only the scoped canonical plan-line row over legacy execution children', async () => {
    const node = await planNode('open');
    const child = await legacyChild();
    const other = await planNode('open', `${HARNESS}-other`);
    const beforeChild = await snapshot(child);
    const otherBefore = await wi.getWorkItem(other, `${HARNESS}-other`);
    const result = await syncLinkedWorkItemsToPlanLane(lane, 'blocked');
    expect(result).toMatchObject({ gated: [node], skippedDuplicates: [child] });
    expect(result.failures).toBeUndefined();
    expect(await wi.getWorkItem(node, HARNESS)).toMatchObject({ state: 'blocked' });
    expect((await snapshot(child)).row).toEqual(beforeChild.row);
    expect(await wi.getWorkItem(other, `${HARNESS}-other`)).toEqual(otherBefore);
    expect(readBlockerResolution((await wi.getWorkItem(node, HARNESS))?.payload).status).toBe('unproven');
  });
  it('terminal canonical plan-line identity prevents legacy child mutation', async () => {
    const node = await planNode('done');
    const child = await legacyChild();
    const before = await snapshot(child);
    const terminal = await snapshot(node);
    const result = await syncLinkedWorkItemsToPlanLane(lane, 'blocked');
    expect(result).toMatchObject({ gated: [], skippedAlreadyTerminal: [node], skippedDuplicates: [child] });
    expect(result.failures).toBeUndefined();
    expect(await snapshot(child)).toEqual(before);
    expect(await snapshot(node)).toEqual(terminal);
  });
  it('isolates canonical lanes across workspace harness plan item and legacy implements collisions', async () => {
    const node = await planNode('open');
    const stamp = await legacyChild();
    const execution = await legacyChild();
    const edgeOnly = await seed('feature', false);
    await db.sql`UPDATE harness_shared.work_items SET status='open', taken_by=NULL,
      created_ts=1, payload=payload - 'plan_item', parent_id=${node}
      WHERE feature_id=${execution} OR feature_id=${edgeOnly}`;
    await db.sql`INSERT INTO harness_shared.coord_links
      (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel)
      VALUES ('default', 'feature', ${`${HARNESS}#${edgeOnly}`},
        ${PLAN_ITEM_KIND}, ${planItemRef(PLAN, 'P-001')}, 'implements')`;
    const otherHarness = await planNode('open', `${HARNESS}-other`);
    const otherPlan = await seed('task', false);
    const otherItem = await seed('task', false);
    const otherWorkspace = await seed('task', false);
    for (const [id, workspace, plan, item] of [
      [otherPlan, 'default', `${PLAN}-other`, 'P-001'],
      [otherItem, 'default', PLAN, 'P-002'],
      [otherWorkspace, 'other-workspace', PLAN, 'P-001'],
    ]) await db.sql`UPDATE harness_shared.work_items SET workspace_id=${workspace},
      status='open', plan_slug=${plan}, plan_line_id=${item}, plan_seq=1,
      plan_line_text='Collision decoy', payload='{}'::jsonb WHERE feature_id=${id}`;
    const allRows = async () => [...await db.sql`SELECT to_jsonb(w) AS value
      FROM harness_shared.work_items w ORDER BY workspace_id, harness_slug, feature_id`];
    const before = await allRows();
    expect(before).toHaveLength(8);
    const untouched = (rows: Awaited<ReturnType<typeof allRows>>) => rows.filter(row => row.value.feature_id !== node);
    const gated = await syncLinkedWorkItemsToPlanLane(lane, 'blocked');
    expect(gated).toMatchObject({ gated: [node] });
    expect(gated.failures).toBeUndefined();
    expect(gated.skippedDuplicates).toEqual(expect.arrayContaining([stamp, edgeOnly]));
    expect(untouched(await allRows())).toEqual(untouched(before));
    expect(await wi.getWorkItem(node, HARNESS)).toMatchObject({ state: 'blocked' });
    expect(await wi.getWorkItem(otherHarness, `${HARNESS}-other`)).toMatchObject({ state: 'open' });
    // A terminal canonical node remains authoritative even though an older
    // implements edge and live stamp/execution rows remain discoverable.
    await db.sql`UPDATE harness_shared.work_items SET status='done' WHERE feature_id=${node}`;
    const terminal = await allRows();
    const result = await syncLinkedWorkItemsToPlanLane(lane, 'blocked');
    expect(result).toMatchObject({ gated: [], skippedAlreadyTerminal: [node] });
    expect(result.failures).toBeUndefined();
    expect(await allRows()).toEqual(terminal);
  });
  it('partial lane ungate preserves independent blockers state holds and dispatch custody', async () => {
    const node = await planNode('blocked');
    const laneRef = planLaneBlockerRef(PLAN, 'P-001');
    const laneBlocker = updateExternalBlockerHistory({}, { kind: 'gate', capability: 'live-dependency',
      ref: laneRef, summary: 'Plan prerequisite pending' }, 'system:plan-item-lane-sync');
    const blockers = updateExternalBlockerHistory({ externalBlockers: laneBlocker.blockers }, {
      kind: 'human', capability: 'physical-device', ref: 'fixture:physical-acceptance',
      summary: 'Device holder must accept' }, OWNER).blockers;
    await db.sql`UPDATE harness_shared.work_items SET taken_by=${OWNER}, taken_at=now(),
      payload=${db.sql.json(JSON.parse(JSON.stringify({ externalBlockers: blockers, planLaneParkedFrom: 'open',
        _claimHold: true, claim_hold_by: OWNER, claim_hold_reason: 'Independent physical acceptance',
        held_open_by: 'system:plan-item-lane-sync', keep: 'original' })))}
      WHERE workspace_id='default' AND harness_slug=${HARNESS} AND feature_id=${node}`;
    await seedMonitors(node);
    const before = await snapshot(node);
    const result = await syncLinkedWorkItemsToPlanLane(lane, 'actionable');
    expect(result).toMatchObject({ ungated: [node] });
    expect(result.failures).toBeUndefined();
    const after = await snapshot(node);
    expect(after.row).toMatchObject({ status: 'blocked', taken_by: OWNER, taken_at: before.row.taken_at,
      payload: { _claimHold: true, claim_hold_by: OWNER, claim_hold_reason: 'Independent physical acceptance',
        held_open_by: 'system:plan-item-lane-sync', planLaneParkedFrom: 'open', keep: 'original' } });
    expect(activeExternalBlockers(after.row.payload)).toEqual(blockers.filter(blocker => blocker.ref !== laneRef));
    expect(after.row.payload.externalBlockers.find((blocker: { ref: string }) => blocker.ref === laneRef))
      .toMatchObject({ status: 'cleared', clearedBy: 'system:plan-item-lane-sync' });
    expect(after.checkpoint).toEqual(before.checkpoint);
    expect(after.edges).toEqual(before.edges);
    expect(await db.sql`SELECT * FROM harness_shared.plan_item_assignments`).toHaveLength(0);
    expect(after.events).toEqual(before.events);
    expect(after.monitors).toEqual(before.monitors);
  });

  it('guards removal and reclassification of existing blocking relations before mutation', async () => {
    const dependent = await seed();
    const source = await seed('feature', false);
    const dst = { kind: 'feature', ref: `${HARNESS}#${dependent}` };
    // Establish the existing relation through its production system writer;
    // admission requires adding dependencies BEFORE the dependent is active.
    // Every attempted agent change below uses the public link handler.
    async function establishBeforeActivation(id: string) {
      const original = (await snapshot(id)).row;
      const inactive = await db.sql`UPDATE harness_shared.work_items SET status='open', taken_by=NULL,
        taken_at=NULL WHERE feature_id=${id} RETURNING status, taken_by`;
      expect(inactive).toMatchObject([{ status: 'open', taken_by: null }]);
      const added = await wi.linkWorkItem(source, { kind: 'feature', ref: `${HARNESS}#${id}` },
        'blocks', { harness: HARNESS, by: 'system:fixture' });
      expect(added, JSON.stringify(added)).toEqual({ ok: true });
      await db.sql`UPDATE harness_shared.work_items SET status=${original.status},
        taken_by=${original.taken_by}, taken_at=${original.taken_at}::text::timestamptz WHERE feature_id=${id}`;
      expect((await snapshot(id)).row).toEqual(original);
    }
    await establishBeforeActivation(dependent);
    await seedMonitors(dependent);
    const before = await snapshot(dependent);
    expect(before.edges).toEqual(expect.arrayContaining([expect.objectContaining({
      blocked_ref: dst.ref, blocker_ref: `${HARNESS}#${source}`, dep_type: 'blocks',
    })]));
    const remove = { id: source, harness: HARNESS, target_id: dependent, rel: 'blocks', remove: true };
    expect(await call(link, remove)).toMatchObject({ ok: false });
    expect(await snapshot(dependent)).toEqual(before);
    expect(await call(link, { ...remove, rel: 'relates', blockerDecision: deferral('relabel-escape') }))
      .toMatchObject({ ok: false, error: 'blockerDecision is valid only for rel=blocks' });
    expect(await snapshot(dependent)).toEqual(before);
    // Descriptive relations cannot reclassify or delete an existing blocks
    // relation. The removal half remains independently guarded.
    expect(await call(link, { ...remove, rel: 'relates', remove: false })).toMatchObject({ ok: true });
    const relabeled = await snapshot(dependent);
    expect(relabeled.row).toEqual(before.row);
    expect(relabeled.edges).toEqual(before.edges);
    expect(relabeled.checkpoint).toEqual(before.checkpoint);
    expect(await call(link, remove)).toMatchObject({ ok: false });
    expect(await snapshot(dependent)).toEqual(relabeled);
    expect(await call(link, { ...remove, blockerDecision: deferral('evidenced-unlink') })).toMatchObject({ ok: true });
    const evidenced = await snapshot(dependent);
    expect(evidenced.edges).toEqual([]);
    expect(evidenced.row).toMatchObject({ taken_by: OWNER, status: before.row.status });
    expect(activeExternalBlockers(evidenced.row.payload)).toEqual(activeExternalBlockers(before.row.payload));
    expect(readBlockerResolution(evidenced.row.payload)).toMatchObject({ status: 'recorded',
      current: { decision: { disposition: 'defer' } } });
    expect(evidenced.checkpoint).toEqual(before.checkpoint);
    const ordinary = await seed('feature', false);
    await establishBeforeActivation(ordinary);
    await db.sql`UPDATE harness_shared.work_items SET status='passed' WHERE feature_id=${source}`;
    expect(await call(link, { ...remove, target_id: ordinary })).toMatchObject({ ok: true });
    expect((await snapshot(ordinary)).edges).toEqual([]);
    expect((await wi.getWorkItem(ordinary, HARNESS))?.assignee).toBe(OWNER);
  });

  it('preserves unresolved blocker obligations through explicit public handoff', async () => {
    for (const blocked of [true, false]) {
      const id = await seed('feature', blocked);
      if (blocked) expect(await state(id, 'handoff-investigation')).toMatchObject({ ok: true });
      const before = await snapshot(id);
      // work_items:claim is the atomic custody-transfer route. coord:handoff
      // records an envelope and cannot itself transfer or settle the item.
      const transferred = await call(claim, { id, harness: HARNESS, assignee: 'agent-repair' });
      expect(transferred, JSON.stringify(transferred)).toMatchObject({ ok: true });
      const after = await snapshot(id);
      expect(after.row.taken_by).toBe('agent-repair');
      expect(after.row.status).toBe(before.row.status);
      expect(after.row.payload.externalBlockers).toEqual(before.row.payload.externalBlockers);
      expect(after.row.payload.blockerResolution).toEqual(before.row.payload.blockerResolution);
      expect(after.checkpoint).toEqual(before.checkpoint);
      expect(after.edges).toEqual(before.edges);
      if (blocked) {
        const peerCtx = { ...(CTX as object), uiClientId: 'agent-repair' } as never;
        expect(await call(setState, { id, harness: HARNESS, state: 'open' }, peerCtx)).toMatchObject({ ok: false });
        expect(await snapshot(id)).toEqual(after);
        expect(readBlockerResolution(after.row.payload)).toMatchObject({ status: 'recorded',
          current: { decision: { disposition: 'defer' } } });
      }
    }
  });

  it('partial lane ungate resumes after final authorized blocker and hold clearance without duplicate monitors', async () => {
    const node = await planNode('blocked');
    const laneRef = planLaneBlockerRef(PLAN, 'P-001');
    const laneHistory = updateExternalBlockerHistory({}, { kind: 'gate', capability: 'live-dependency',
      ref: laneRef, summary: 'Plan prerequisite pending' }, 'system:plan-item-lane-sync');
    const blockers = updateExternalBlockerHistory({ externalBlockers: laneHistory.blockers }, {
      kind: 'event', capability: 'live-dependency', ref: EVENT, summary: 'Independent dependency pending',
    }, OWNER).blockers;
    await db.sql`UPDATE harness_shared.work_items SET taken_by=${OWNER}, taken_at=now(),
      payload=${JSON.stringify({ externalBlockers: blockers, planLaneParkedFrom: 'open',
        _claimHold: true, claim_hold_by: OWNER, claim_hold_reason: 'Independent dependency',
        keep: 'original' })}::text::jsonb WHERE feature_id=${node}`;
    await checkpoints.setWorkItemCheckpoint(checkpointRef(node), 'Original checkpoint');
    await seedMonitors(node);
    const before = await snapshot(node);
    expect(await syncLinkedWorkItemsToPlanLane(lane, 'actionable')).toMatchObject({ ungated: [node] });
    const partial = await snapshot(node);
    expect(partial.row).toMatchObject({ status: 'blocked', taken_by: OWNER,
      payload: { _claimHold: true, claim_hold_by: OWNER, planLaneParkedFrom: 'open' } });
    expect(activeExternalBlockers(partial.row.payload)).toMatchObject([{ ref: EVENT }]);
    expect(partial.monitors).toEqual(before.monitors);
    const clear = { id: node, harness: HARNESS, ref: EVENT, clear: true,
      blockerDecision: resolution('final-lane-repair') };
    expect(await call(setBlocker, clear)).toMatchObject({ ok: false, code: 'blocker_decision_evidence' });
    expect(await snapshot(node)).toEqual(partial);
    await repairCondition();
    const measured = await snapshot(node);
    expect(await call(setBlocker, clear)).toMatchObject({ ok: true });
    expect(activeExternalBlockers((await wi.getWorkItem(node, HARNESS))?.payload)).toEqual([]);
    // Clear the independent hold in place. park releases the claim and cannot
    // exercise preservation of custody through this final authorized ungate.
    const clearedHold = await call(holdOpen, { id: node, harness: HARNESS, clear: true });
    expect(clearedHold, JSON.stringify(clearedHold)).toMatchObject({ ok: true });
    const resumed = await syncLinkedWorkItemsToPlanLane(lane, 'actionable');
    expect(resumed.failures).toBeUndefined();
    const after = await snapshot(node);
    expect(after.row.status).toBe('open');
    expect(after.row.taken_by).toBe(OWNER);
    expect(after.row.taken_at).toBe(before.row.taken_at);
    expect(after.row.payload).toMatchObject({ keep: 'original', blockerResolution: {
        history: [{ authorId: OWNER, sessionId: OWNER, decision: { disposition: 'self_resolve' } }],
      } });
    expect(after.row.payload._claimHold).not.toBe(true);
    expect(after.row.payload.claim_hold_by).toBeUndefined();
    // The public blocker clearer already restored the state. Reconciliation
    // retains the original-state provenance on this already-actionable row.
    expect(after.row.payload.planLaneParkedFrom).toBe('open');
    expect(after.checkpoint).toBe(before.checkpoint);
    expect(after.edges).toEqual(before.edges);
    expect(after.monitors).toEqual(measured.monitors);
    // Repeated reconciliation must not mint monitors, reassign custody or
    // append a second decision after the final authorized clearance.
    expect((await syncLinkedWorkItemsToPlanLane(lane, 'actionable')).failures).toBeUndefined();
    expect(await snapshot(node)).toEqual(after);
  });

  it('guards the actual plans:set-status blocker boundary before mutation', async () => {
    // The real plan writer needs the complete production schema. Its app,
    // admin and workspace-scoped entry points all use this private database.
    const { createOrgTestDb } = await import('../../../test/_org-test-db');
    const isolated = await createOrgTestDb();
    const sql = isolated.adminSql;
    h.sql = sql;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let checkedWarnings = 0;
    try {
      const { default: setStatus } = await import('../plans/set-status');
      const { hashPlanContent } = await import('../plans/content-hash');
      const { parsePlan } = await import('../plans/parser');
      const { insertHiveIfAbsent } = await import('../../hive-store');
      const { generateEd25519KeypairDer } = await import('../../identity/ed25519');
      // A public park CAS saves a PG-canonical artifact through Drizzle as well
      // as writing its SQL audit. Verify both clients point at the private DB
      // before interpreting any later refusal as a product recovery defect.
      const { saveTextArtifact, loadTextArtifact } = await import('../../text-artifacts');
      await saveTextArtifact(HARNESS, 'fixture/blocker-recovery-preflight.json', '{"ready":true}');
      expect(await loadTextArtifact(HARNESS, 'fixture/blocker-recovery-preflight.json')).toBe('{"ready":true}');
      await insertHiveIfAbsent({ workspaceId: 'default', homeSlug: HARNESS,
        pubkeyBase64: generateEd25519KeypairDer().pubkeyBase64,
        keychainId: 'isolated-blocker-plan' }, sql);
      // Source-internal calls retain the real Hive resolver even when the
      // public scope adapter is mocked. Check that prerequisite explicitly.
      const source = await vi.importActual<typeof import('../plans/source')>('../plans/source');
      expect(await source.resolvePlanScope({ workspaceId: 'default', harnessSlug: HARNESS }))
        .toEqual({ workspaceId: 'default', harnessSlug: HARNESS });
      const slug = 'blocker-public-status';
      const content = '---\ntitle: Public blocker boundary\nstatus: draft\nupdated: 2026-11-10\n---\n\n' +
        '## Phase\n- **P-001** `wip` Investigate dependency\n- **P-002** `todo` Ordinary control\n';
      expect(parsePlan(content).items.map(item => item.id)).toEqual(['P-001', 'P-002']);
      await sql`INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, title, status)
        VALUES ('default', ${HARNESS}, ${slug}, ${content}, ${hashPlanContent(content)},
          'Public blocker boundary', 'draft')`;
      const condition = await registerAnnouncement({ subscriberId: OWNER, eventKey: EVENT,
        scopeKind: 'harness', scopeRef: HARNESS, note: 'Private plan dependency',
        expectedCondition: { kind: 'predicate', predicate: { ready: { eq: true } } } });
      expect(condition.id).toBeGreaterThan(0);
      const blockers = updateExternalBlockerHistory({}, { kind: 'event', capability: 'live-dependency',
        ref: EVENT, summary: 'Private plan dependency pending' }, OWNER).blockers;
      const nodes: string[] = [];
      for (const [index, itemId] of ['P-001', 'P-002'].entries()) {
        const item = await wi.createWorkItem({ kind: 'task', title: index ? 'Ordinary control' : 'Investigate dependency',
          harness: HARNESS, createdBy: OWNER });
        nodes.push(item.id);
        await sql`UPDATE harness_shared.work_items SET status=${index ? 'open' : 'wip'},
          taken_by=${OWNER}, taken_at=now(), plan_slug=${slug}, plan_line_id=${itemId}, plan_seq=${index + 1},
          plan_line_text=${index ? 'Ordinary control' : 'Investigate dependency'},
          payload=${JSON.stringify(index ? {} : { keep: 'original', externalBlockers: blockers })}::text::jsonb
          WHERE workspace_id='default' AND harness_slug=${HARNESS} AND feature_id=${item.id}`;
      }
      await checkpoints.setWorkItemCheckpoint(checkpointRef(nodes[0]), 'Plan investigation remains actionable');
      await registerAwait({ subscriberId: OWNER, eventKey: EVENT,
        policy: 'notify', boundTo: { kind: 'work-item', ref: nodes[0] } });
      const capture = async () => ({
        plan: [...await sql`SELECT to_jsonb(p) AS value FROM harness_shared.harness_plans p
          WHERE workspace_id='default' AND harness_slug=${HARNESS} AND plan_slug=${slug}`],
        nodes: [...await sql`SELECT to_jsonb(w) AS value FROM harness_shared.work_items w
          WHERE workspace_id='default' AND harness_slug=${HARNESS} AND plan_slug=${slug} ORDER BY plan_seq`],
        revisions: [...await sql`SELECT to_jsonb(r) AS value FROM harness_shared.plan_revisions r
          WHERE workspace_id='default' AND harness_slug=${HARNESS} AND plan_slug=${slug} ORDER BY seq`],
        checkpoint: await checkpoints.getWorkItemCheckpoint(checkpointRef(nodes[0])),
        awaits: [...await sql`SELECT to_jsonb(a) AS value FROM harness_shared.event_awaits a ORDER BY id`],
        edges: [...await sql`SELECT to_jsonb(d) AS value FROM harness_shared.work_item_deps d ORDER BY blocked_ref, blocker_ref`],
      });
      const args = { slug, item: 'P-001', harness: HARNESS, status: 'blocked' };
      const invoke = async (input: Record<string, unknown>, ctx = CTX) => {
        expect(warning.mock.calls).toHaveLength(checkedWarnings);
        const offset = warning.mock.calls.length;
        const result = await call(setStatus, setStatus.args.parse(input), ctx);
        expect(warning.mock.calls.slice(offset)).toEqual(result.slowPathTiming
          ? [[`[plans:set-status] slow ${slug}#${input.item} ${JSON.stringify(result.slowPathTiming)}`]]
          : []);
        checkedWarnings = warning.mock.calls.length;
        return result;
      };
      const before = await capture();
      expect(before.nodes).toHaveLength(2);
      expect(before.awaits.length).toBeGreaterThan(0);
      const baseline = await source.readPlanBySlug(slug, { workspaceId: 'default', harnessSlug: HARNESS });
      expect(baseline?.parsed.items).toMatchObject([
        { id: 'P-001', storedStatus: 'wip' }, { id: 'P-002', storedStatus: 'todo' },
      ]);
      for (const input of [args, { ...args, blockerDecision: resolution('unmeasured-plan-repair') }]) {
        const refused = await invoke(input);
        expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, code: 'blocker_decision_evidence' });
        expect(await capture()).toEqual(before);
      }
      const evidenced = { ...args, blockerDecision: deferral('public-plan-deferral') };
      const peerCtx = { ...(CTX as object), uiClientId: 'agent-repair' } as never;
      const unauthorized = await invoke(evidenced, peerCtx);
      expect(unauthorized, JSON.stringify(unauthorized)).toMatchObject({ ok: false, code: 'blocker_decision_custody' });
      expect(await capture()).toEqual(before);
      // Inject failure at the canonical graph write, after receipt preparation:
      // neither the receipt nor the plan body/revision may commit alone.
      await sql.unsafe(`CREATE FUNCTION harness_shared.reject_public_plan_block() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN IF NEW.status='blocked' THEN RAISE EXCEPTION 'injected public plan graph failure'; END IF; RETURN NEW; END $fn$;
        CREATE TRIGGER reject_public_plan_block BEFORE UPDATE ON harness_shared.work_items
        FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_public_plan_block()`);
      try {
        const rolledBack = await invoke(evidenced);
        expect(rolledBack, JSON.stringify(rolledBack)).toMatchObject({
          ok: false, error: 'injected public plan graph failure',
        });
        expect(await capture()).toEqual(before);
      } finally { await sql.unsafe('DROP TRIGGER reject_public_plan_block ON harness_shared.work_items'); }
      const accepted = await invoke(evidenced);
      expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true });
      const after = await capture();
      expect(after.nodes[0].value).toMatchObject({ status: 'blocked', taken_by: OWNER,
        payload: { keep: 'original', blockerResolution: { history: [{ authorId: OWNER,
          decision: { disposition: 'defer' } }] } } });
      expect(readBlockerResolution(after.nodes[0].value.payload)).toMatchObject({ status: 'recorded' });
      // Read the graph-backed plan through the production reader used by plans:get.
      const rendered = await source.readPlanBySlug(slug, { workspaceId: 'default', harnessSlug: HARNESS });
      expect(rendered?.parsed.items.find(item => item.id === 'P-001')).toMatchObject({
        id: 'P-001', storedStatus: 'blocked',
      });
      expect(after.checkpoint).toEqual(before.checkpoint);
      expect(after.awaits).toEqual(before.awaits);
      const replayed = await invoke(evidenced);
      expect(replayed, JSON.stringify(replayed)).toMatchObject({ ok: true });
      expect(await capture()).toEqual(after);
      // Ordinary blocker-free edits and the explicit system lane remain usable.
      const ordinary = await invoke({ slug, item: 'P-002', harness: HARNESS, status: 'todo', note: 'Ordinary update' });
      expect(ordinary, JSON.stringify(ordinary)).toMatchObject({ ok: true });
      // System provenance exempts the agent-decision requirement, while the
      // database still requires a named condition before entering blocked.
      await sql`UPDATE harness_shared.work_items SET payload=${JSON.stringify({ externalBlockers: blockers })}::text::jsonb
        WHERE workspace_id='default' AND harness_slug=${HARNESS} AND feature_id=${nodes[1]}`;
      expect(activeExternalBlockers((await wi.getWorkItem(nodes[1], HARNESS))?.payload))
        .toMatchObject([{ ref: EVENT, status: 'active' }]);
      const systemCtx = { ...(CTX as object), uiClientId: 'system:plan-item-lane-sync' } as never;
      const system = await invoke({ slug, item: 'P-002', harness: HARNESS, status: 'blocked' }, systemCtx);
      expect(system, JSON.stringify(system)).toMatchObject({ ok: true });
      expect(await wi.getWorkItem(nodes[1], HARNESS)).toMatchObject({ state: 'blocked' });
      expect(readBlockerResolution((await wi.getWorkItem(nodes[1], HARNESS))?.payload))
        .toEqual({ status: 'unproven', state: null, current: null });
      expect(warning.mock.calls).toHaveLength(checkedWarnings);

      // EI-28396634030775553: the dependency can finish while an independent
      // migration park remains. Clearing that park must leave a supported
      // public begin path, without inventing an event for a derived plan lane.
      const recoverySlug = 'blocker-public-derived-lane-recovery';
      const discovery = { questions: [],
        notApplicable: 'This bounded lifecycle fixture reuses the current blocker-evidence and lane-reconciliation implementation.',
        findings: [{ id: 'F-1', questions: [],
          conclusion: 'Use the existing canonical blocker preflight and generated-lane recovery seam.',
          evidenceRefs: ['source:packages/operator-core/lib/blocker-resolution-evidence.ts'],
          dispositions: ['P-001', 'P-002'].map(target => ({ target, decision: 'reuse',
            reason: 'The maintained source supplies this lifecycle boundary.' })) }] };
      const recoveryContent = '---\ntitle: Derived lane recovery\nstatus: ready\nupdated: 2026-11-10\n---\n\n' +
        '## Phase\n- **P-001** `done` Completed prerequisite\n' +
        '- **P-002** `todo` Resume canonical lane blocked-by: P-001\n' +
        `\n## Discovery\n\n\`\`\`discovery\n${JSON.stringify(discovery)}\n\`\`\`\n`;
      await sql`INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, title, status)
        VALUES ('default', ${HARNESS}, ${recoverySlug}, ${recoveryContent}, ${hashPlanContent(recoveryContent)},
          'Derived lane recovery', 'ready')`;
      const recoveryNodes: string[] = [];
      const recoveryRef = planLaneBlockerRef(recoverySlug, 'P-002');
      const recoveryBlockers = updateExternalBlockerHistory({}, { kind: 'gate', capability: 'live-dependency',
        ref: recoveryRef, summary: 'Prerequisite was pending before migration clearance' },
      'system:plan-item-lane-sync').blockers;
      for (const [index, itemId] of ['P-001', 'P-002'].entries()) {
        const node = await wi.createWorkItem({ kind: 'task', title: 'Derived recovery fixture',
          harness: HARNESS, createdBy: OWNER });
        recoveryNodes.push(node.id);
        await sql`UPDATE harness_shared.work_items SET status=${index ? 'blocked' : 'done'},
          taken_by=NULL, taken_at=NULL, plan_slug=${recoverySlug}, plan_line_id=${itemId}, plan_seq=${index + 1},
          plan_line_text=${index ? 'Resume canonical lane' : 'Completed prerequisite'},
          payload=${JSON.stringify(index ? { keep: 'original', externalBlockers: recoveryBlockers,
            planLaneParkedFrom: 'open', _claimHold: true,
            claim_hold_by: 'migration:plan-line-work-item-nodes', claim_hold_at: '2026-11-10T00:00:00Z',
            claim_hold_reason: 'D-011 P-008 conversion park' } : {})}::text::jsonb
          WHERE workspace_id='default' AND harness_slug=${HARNESS} AND feature_id=${node.id}`;
      }
      const target = recoveryNodes[1];
      await sql`INSERT INTO harness_shared.work_item_deps
        (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, satisfaction)
        VALUES ('default', 'issue', ${target}, 'issue', ${recoveryNodes[0]}, 'blocks', 'settled')`;
      const recoveryPlan = await source.readPlanBySlug(recoverySlug, { workspaceId: 'default', harnessSlug: HARNESS });
      expect(recoveryPlan?.parsed.items).toMatchObject([
        { id: 'P-001', storedStatus: 'done' },
        { id: 'P-002', storedStatus: 'blocked', blockedBy: ['P-001'] },
      ]);
      // New starts retain the real discovery gate. Seed its canonical revision
      // and finalize against current source rather than mocking acceptance.
      await sql`INSERT INTO harness_shared.plan_revisions
        (workspace_id,harness_slug,plan_slug,seq,content_hash,content_snapshot,rationale,author_kind,author_id,session_id,session_kind,created_at)
        VALUES ('default',${HARNESS},${recoverySlug},1,${hashPlanContent(recoveryContent)},${recoveryContent},
          'Private canonical lifecycle fixture','agent',${OWNER},'fixture','codex',${Date.now()})`;
      const { recordCurrentDiscoveryAudit, withCurrentDiscovery } = await import('../../plan-audits');
      const discoveryInput = { workspaceId: 'default', harnessSlug: HARNESS, planSlug: recoverySlug, createdBy: OWNER };
      const discoveryAudit = await recordCurrentDiscoveryAudit(discoveryInput);
      expect(discoveryAudit, JSON.stringify(discoveryAudit))
        .toMatchObject({ ok: true, discovery: { readiness: { ready: true } } });
      const discoveryReadback = await withCurrentDiscovery(discoveryInput, async () => true);
      expect(discoveryReadback, JSON.stringify(discoveryReadback)).toMatchObject({ ok: true });
      expect(await wi.getWorkItem(target, HARNESS)).toMatchObject({ state: 'blocked', assignee: null,
        payload: { _claimHold: true, claim_hold_by: 'migration:plan-line-work-item-nodes' } });
      const clearPark = { id: target, harness: HARNESS, clear: true, ownerOverride: true,
        reconcile: { reasonCode: 'operator-directed', dryRun: true,
          evidence: 'Isolated fixture: exact migration-only adoption after prerequisite completion' } };
      const preview = await call(holdOpen, holdOpen.args.parse(clearPark)) as Result & {
        wouldClear?: boolean; observedParkFingerprint?: string;
      };
      expect(preview, JSON.stringify(preview)).toMatchObject({ ok: true, wouldClear: true });
      expect(preview.observedParkFingerprint).toMatch(/^[a-f0-9]{64}$/);
      const clearedPark = await call(holdOpen, holdOpen.args.parse({ ...clearPark, reconcile: { ...clearPark.reconcile,
        dryRun: false, expectedParkFingerprint: preview.observedParkFingerprint } }));
      expect(clearedPark, JSON.stringify(clearedPark)).toMatchObject({ ok: true, outcome: 'cleared' });
      expect(activeExternalBlockers((await wi.getWorkItem(target, HARNESS))?.payload))
        .toMatchObject([{ ref: recoveryRef, status: 'active' }]);
      const claimed = await call(claim, claim.args.parse({ id: target, harness: HARNESS, force: false }));
      expect(claimed, JSON.stringify(claimed)).toMatchObject({ ok: true });
      const held = await wi.getWorkItem(target, HARNESS);
      expect(held).toMatchObject({ assignee: OWNER, state: 'blocked' });
      const beginArgs = { slug: recoverySlug, harness: HARNESS, item: 'P-002', status: 'wip' };
      const unmeasuredBegin = await call(setStatus, setStatus.args.parse(beginArgs));
      expect(unmeasuredBegin, JSON.stringify(unmeasuredBegin)).toMatchObject({ ok: false,
        code: 'blocker_decision_evidence' });
      expect(await wi.getWorkItem(target, HARNESS)).toEqual(held);
      const laneEvidence = { kind: 'event' as const, ref: recoveryRef };
      const prerequisiteEvidence = { kind: 'work-item' as const, ref: `${HARNESS}#${recoveryNodes[0]}` };
      const tenant = await import('../../workspace-registry');
      const evidenceContext = await blockerBoundaryContext(CTX, OWNER, HARNESS);
      const scopeEvidence = { active: tenant.activeWorkspaceId(),
        resolved: tenant.resolveConcreteWorkspaceId('default'), context: evidenceContext.workspaceId };
      expect(scopeEvidence, JSON.stringify(scopeEvidence)).toEqual({ active: 'default', resolved: 'default', context: 'default' });
      const prerequisiteMeasurement = await createBlockerEvidenceReader({ ...evidenceContext,
        workItemId: target, custodianId: OWNER, blockers: activeExternalBlockers(held?.payload) })(prerequisiteEvidence);
      expect(prerequisiteMeasurement, JSON.stringify({ scopeEvidence, prerequisiteMeasurement }))
        .toMatchObject({ status: 'available', condition: 'satisfied' });
      // Legacy JSON can carry the durable park as a string and without a
      // provenance stamp. The canonical park predicate still reserves it.
      try {
        for (const claimHold of [true, 'true']) {
          const parkedPayload = { ...(held?.payload ?? {}), _claimHold: claimHold };
          await sql`UPDATE harness_shared.work_items SET payload=${JSON.stringify(parkedPayload)}::text::jsonb
            WHERE workspace_id='default' AND harness_slug=${HARNESS} AND feature_id=${target}`;
          const guarded = await createBlockerEvidenceReader({ ...evidenceContext, workItemId: target,
            custodianId: OWNER, blockers: activeExternalBlockers(parkedPayload) })(laneEvidence);
          expect(guarded, JSON.stringify({ claimHold, guarded })).toMatchObject({ status: 'unknown' });
        }
      } finally {
        await sql`UPDATE harness_shared.work_items SET payload=${JSON.stringify(held?.payload ?? {})}::text::jsonb
          WHERE workspace_id='default' AND harness_slug=${HARNESS} AND feature_id=${target}`;
      }
      expect(await wi.getWorkItem(target, HARNESS)).toEqual(held);
      const begun = await call(setStatus, setStatus.args.parse({ ...beginArgs, blockerDecision: {
        schemaVersion: 1, idempotencyKey: 'derived-lane-after-authorized-park-clear', disposition: 'self_resolve',
        symptom: 'The derived dependency lane remains blocked after its prerequisite settled',
        evidenceRefs: [laneEvidence, prerequisiteEvidence],
        investigation: [{ action: 'Read the canonical prerequisite and exact generated lane',
          outcome: 'Prerequisite is done; the only remaining blocker is this system-derived lane',
          evidenceRefs: [laneEvidence, prerequisiteEvidence] }],
        attempts: [{ action: 'Clear the independent migration park through its authorized fingerprint CAS',
          outcome: 'CAS cleared the migration park; ordinary custody is retained',
          evidenceRefs: [prerequisiteEvidence] }],
        verification: { outcome: 'Fresh canonical dependency graph satisfies the exact derived lane condition',
          evidenceRefs: [laneEvidence, prerequisiteEvidence] },
      } }));
      expect(begun, JSON.stringify(begun)).toMatchObject({ ok: true });
      const resumed = await wi.getWorkItem(target, HARNESS);
      expect(resumed, JSON.stringify(resumed)).toMatchObject({ state: 'wip', assignee: OWNER, payload: { keep: 'original' } });
      expect((await source.readPlanBySlug(recoverySlug, { workspaceId: 'default', harnessSlug: HARNESS }))?.parsed.items)
        .toMatchObject([{ id: 'P-001', storedStatus: 'done' }, { id: 'P-002', storedStatus: 'wip' }]);
      expect(readBlockerResolution(resumed?.payload)).toMatchObject({ status: 'recorded',
        current: { decision: { disposition: 'self_resolve' } } });
      expect(activeExternalBlockers(resumed?.payload)).toEqual([]);
      expect(resumed?.payload).toMatchObject({ externalBlockers: [expect.objectContaining({
        ref: recoveryRef, status: 'cleared', clearedBy: 'system:plan-item-lane-sync',
      })] });
    } finally {
      warning.mockRestore();
      h.sql = db.sql;
      await isolated.cleanup();
    }
  }, 120_000);

  for (const [family, kind] of [['issue', 'task'], ['feature', 'feature']] as const) {
    it(`rolls back decision history when lifecycle mutation fails for ${family} payloads`, async () => {
      const id = await seed(kind);
      const before = await snapshot(id);
      await db.sql.unsafe(`CREATE OR REPLACE FUNCTION harness_shared.reject_boundary_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN IF NEW.status='blocked' THEN RAISE EXCEPTION 'injected lifecycle failure'; END IF; RETURN NEW; END $fn$;
        CREATE TRIGGER reject_boundary_lifecycle BEFORE UPDATE ON harness_shared.work_items
        FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_boundary_lifecycle()`);
      try {
        expect(await state(id, 'lifecycle-failure')).toMatchObject({ ok: false });
        expect(await snapshot(id)).toEqual(before);
      } finally { await db.sql.unsafe('DROP TRIGGER reject_boundary_lifecycle ON harness_shared.work_items'); }
      expect(await state(id, 'lifecycle-control')).toMatchObject({ ok: true });
      await expectPairedMutationTransaction(id);
      const second = await seed(kind);
      const race = await Promise.all([state(second, 'lifecycle-race-a'), state(second, 'lifecycle-race-b')]);
      expect(race.filter(result => result.ok)).toHaveLength(1);
      expect(race.filter(result => !result.ok)).toHaveLength(1);
      expect((await snapshot(second)).row.payload.blockerResolution.history).toHaveLength(1);
    });
    it(`rolls back lifecycle custody when decision CAS loses for ${family} payloads`, async () => {
      const id = await seed(kind);
      const before = await snapshot(id);
      await db.sql.unsafe(`CREATE OR REPLACE FUNCTION harness_shared.reject_boundary_decision() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN IF NEW.payload ? 'blockerResolution' THEN RAISE EXCEPTION 'injected decision commit failure'; END IF; RETURN NEW; END $fn$;
        CREATE CONSTRAINT TRIGGER reject_boundary_decision AFTER UPDATE ON harness_shared.work_items
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_boundary_decision()`);
      try {
        expect(await state(id, 'decision-failure')).toMatchObject({ ok: false });
        expect(await snapshot(id)).toEqual(before);
      } finally { await db.sql.unsafe('DROP TRIGGER reject_boundary_decision ON harness_shared.work_items'); }
      expect(await state(id, 'decision-control')).toMatchObject({ ok: true });
      await expectPairedMutationTransaction(id);
      const committed = await snapshot(id);
      expect(await call(setState, { id, harness: HARNESS, state: 'open',
        blockerDecision: { ...deferral('stale-cas'), priorRevision: 0 } })).toMatchObject({ ok: false });
      expect(await snapshot(id)).toEqual(committed);
      const second = await seed(kind);
      const race = await Promise.all([state(second, 'decision-race-a'), state(second, 'decision-race-b')]);
      expect(race.filter(result => result.ok)).toHaveLength(1);
      expect(race.filter(result => !result.ok)).toHaveLength(1);
      expect((await snapshot(second)).row.payload.blockerResolution.history).toHaveLength(1);
    });
  }
});
