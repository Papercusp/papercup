/** Public blocker contracts over real PostgreSQL. The external condition
 * producer writes the isolated event ledger; validation, identities,
 * dependencies, lifecycle, decision CAS, claims and checkpoints are production. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyEventSubstrateMigrationsForTest, applyDisclosureLedgerForTest, applyMigrationsForTest,
  COORD_SUBSCRIPTION_SUBSTRATE,
  createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL,
  applyClaimPathReadDeps } from '../../../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import type { BlockerDecisionInput } from '../../blocker-resolution-decision';
import { activeExternalBlockers, updateExternalBlockerHistory } from '../../external-blockers';
import { createBlockerEvidenceReader, preflightBlockerDecision } from '../../blocker-resolution-evidence';
import { planLaneBlockerRef, syncLinkedWorkItemsToPlanLane } from '../../plan-items/reconcile-linked-work-items';
import { readPlanLineNodes } from '../plans/plan-line-graph';
import { readAgentReviewState } from '../../harness/improvements/agent-review-policy';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql,
  parkConsult: vi.fn(), parkWake: vi.fn(), parkNotify: vi.fn() }));
vi.mock('../../consult/park-door', async original => ({
  ...(await original<typeof import('../../consult/park-door')>()),
  makeProdParkDoorDeps: () => ({ now: () => Date.now(), openConsult: h.parkConsult,
    registerVerdictWake: h.parkWake, notifyOwner: h.parkNotify }),
}));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../../workspace-registry', async original => ({
  ...(await original<typeof import('../../workspace-registry')>()), activeWorkspaceId: () => 'default',
}));
vi.mock('../../harness-core', async original => ({
  ...(await original<typeof import('../../harness-core')>()),
  resolveProject: async (slug: string) => ({ slug, path: `/tmp/${slug}` }),
}));
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
  getPresence: async (ownerId: string) => ownerId === 'agent-repair'
    ? { ownerId, workspaceId: 'default', stale: false } : null,
}));

const wi = await import('../../work-items');
const checkpoints = await import('../../work-item-checkpoint');
const { registerAnnouncement, registerAwait } = await import('../../events/await/store');
const { readEventConditionReachability } = await import('../../external-condition-reachability');
const { readBlockerResolution } = await import('../../blocker-resolution-decision');
const { default: setBlocker } = await import('./set_blocker');
const { default: setState } = await import('./set_state');
const { default: release } = await import('./release');
const { default: park } = await import('./park');
const { default: link } = await import('./link');

const HARNESS = 'blocker-boundaries';
const OWNER = 'su-blocker-boundaries';
const EVENT = 'fixture:dependency-repaired';
const ref = { kind: 'event' as const, ref: EVENT };
const CTX = { isSuperuser: true, uiClientId: OWNER, workspaceId: 'default', role: 'su',
  signal: new AbortController().signal, log: () => {}, progress: () => {}, metadata: () => {} } as never;
type Result = { ok?: boolean; code?: string; error?: string; nextAction?: string;
  results?: Result[]; replayed?: boolean; blockerDecision?: { id: string } };
async function call(tool: { handler: (args: never, ctx: never) => Promise<unknown> }, args: Record<string, unknown>) {
  const result = await tool.handler(args as never, CTX) as { data?: Result; content?: { text?: string }[] };
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
  db = await createFreshPgDb('blocker-boundaries');
  h.sql = db.sql;
  await ensureCoordCapabilityTables(db.sql);
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(readFileSync(new URL('../../../../../libs/papercusp/libs/db/sql/741-work-items-condition-key-singleton.sql', import.meta.url), 'utf8'));
  await applyEventSubstrateMigrationsForTest(db.sql, {
    label: 'blocker-resolution-boundaries.integration.test.ts', ...COORD_SUBSCRIPTION_SUBSTRATE,
  });
  // Use the production routine table and loop extension, rather than the
  // claim-reader's intentionally minimal live-holder projection.
  const baseline = readFileSync(fileURLToPath(new URL('../../../../../libs/papercusp/libs/db/sql/000-baseline.sql', import.meta.url)), 'utf8');
  const routines = baseline.match(/CREATE TABLE IF NOT EXISTS harness_shared\.routines \([\s\S]*?\n\);/);
  if (!routines) throw new Error('production routines table not found');
  await db.sql.unsafe(routines[0]);
  await applyMigrationsForTest(db.sql, ['323-loop-routines-reschedule-interval.sql',
    '408-routines-ephemeral-tier.sql', '909-routines-next-fire-ms-precision.sql',
    '1046-in-process-sweep-arm-tier.sql'], {
    label: 'blocker-resolution-boundaries.integration.test.ts',
  });
  await applyDisclosureLedgerForTest(db.sql);
  for (const name of ['831-issue-occurrence-ledger.sql', '140-plan-item-assignments.sql']) {
    const ddl = readFileSync(fileURLToPath(new URL(`../../../../../libs/papercusp/libs/db/sql/${name}`, import.meta.url)), 'utf8')
      .split('\n').filter(line => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line)).join('\n');
    await db.sql.unsafe(ddl).simple();
  }
  await applyClaimPathReadDeps(ddl => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL);
  // Observe the database transaction itself, independently of rollback errors.
  // A premature COMMIT can still pass a deferred decision-failure trigger.
  await db.sql.unsafe(`CREATE TABLE harness_shared.blocker_boundary_transactions (
    feature_id text NOT NULL, phase text NOT NULL, transaction_id bigint NOT NULL);
    CREATE FUNCTION harness_shared.observe_blocker_boundary_transaction() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF OLD.payload->'blockerResolution' IS DISTINCT FROM NEW.payload->'blockerResolution' THEN
        INSERT INTO harness_shared.blocker_boundary_transactions VALUES (NEW.feature_id, 'decision', txid_current());
      END IF;
      IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('blocked', 'needs-human') THEN
        INSERT INTO harness_shared.blocker_boundary_transactions VALUES (NEW.feature_id, 'lifecycle', txid_current());
      END IF;
      RETURN NEW;
    END $fn$;
    CREATE TRIGGER observe_blocker_boundary_transaction AFTER UPDATE ON harness_shared.work_items
      FOR EACH ROW EXECUTE FUNCTION harness_shared.observe_blocker_boundary_transaction()`);
  await db.sql.unsafe(`CREATE TABLE IF NOT EXISTS harness_shared.coord_event_log (
    id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    workspace_id text NOT NULL DEFAULT 'default', surface text NOT NULL,
    writer_key text, msg_id text NOT NULL, body jsonb NOT NULL,
    ts timestamptz NOT NULL DEFAULT now())`);
  await db.sql.unsafe(`CREATE TABLE IF NOT EXISTS harness_shared.carry_notes (
    workspace_id text NOT NULL, scope text NOT NULL, note text, journal jsonb NOT NULL DEFAULT '[]',
    updated_ts bigint NOT NULL, deps jsonb, body_ts bigint, attested_count integer NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, scope))`);
}, 90_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  h.parkConsult.mockReset().mockResolvedValue({ consultId: 'prospective-authority-review' });
  h.parkWake.mockReset().mockResolvedValue(undefined);
  h.parkNotify.mockReset().mockResolvedValue(undefined);
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps,
    harness_shared.carry_notes, harness_shared.coord_event_log, harness_shared.blocker_boundary_transactions,
    harness_shared.event_awaits, harness_shared.event_key_fires, harness_shared.predicate_watches,
    harness_shared.coord_entity_subscriptions, harness_shared.routines RESTART IDENTITY CASCADE`;
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
    return { id, input, blockers };
  }

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
