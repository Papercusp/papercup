/**
 * WI-4770 recurrence guard: membership transitions must not widen a self-puller
 * into DEFAULT_CLAIM_SPEC while a replacement fleet lane is being rebound.
 *
 * Run with:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/claim-spec-transition.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, applyClaimPathReadDeps, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';
import type { ClaimSpec } from './claim-spec';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const migration = (file: string) =>
  readFileSync(resolve(SQL_DIR, file), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/i.test(line))
    .join('\n');

const { getNextForBee, getClaimSpec, getClaimSpecRecord, setClaimSpec, fleetSpecBeeKey } = await import('./claim-spec-store');
const { appendFleetMembershipEvent } = await import('../fleet-membership-store');
const { DEFAULT_CLAIM_SPEC, validateClaimSpec } = await import('./claim-spec');
const { fleetScopeLeaderRemedy, fleetScopeRefusalContract } = await import('./fleet-scope-admission');

const H = 'papercup';
const WS = 'default';
const BEE = 'su-wi4770-switch';
const LEAVE_BEE = 'su-wi4770-leave';
const PARENT = 'reliability-parent';
const CHILD = 'reliability-child';
let db: FreshPgDb;

function laneSpec(specId: string, id: string): ClaimSpec {
  const spec = {
    specVersion: '1.0',
    specId,
    revision: 4,
    view: { filter: { field: 'id', op: 'in', value: [id] } },
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
  } as ClaimSpec;
  const parsed = validateClaimSpec(spec);
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return spec;
}

async function seedFeature(id: string, title: string) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, workspace_id, title, created_ts, updated_ts)
    VALUES (${H}, ${id}, 'feature', 'open', ${WS}, ${title}, 1, 1)`;
}

async function membership(ownerId: string, fleetSlug: string | null, fleetRole: string | null) {
  await appendFleetMembershipEvent({ workspaceId: WS, ownerId, fleetSlug, fleetRole }, db.sql);
}

beforeAll(async () => {
  db = await createFreshPgDb('claim-spec-transition');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql.unsafe(`ALTER TABLE harness_shared.work_items ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic'`);

  // This test needs only the claim-spec table, not the federation triggers.
  // Keep the fixture small and create the durable membership ledger directly.
  await db.sql.unsafe(migration('372-bee-claim-specs.sql'));
  await db.sql.unsafe(migration('389-bee-claim-spec-id-only.sql'));
  await db.sql.unsafe('ALTER TABLE harness_shared.bee_claim_specs RENAME TO cup_claim_specs');
  await db.sql.unsafe('ALTER TABLE harness_shared.cup_claim_specs ADD COLUMN IF NOT EXISTS harness_slug text');
  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.fleet_membership_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL DEFAULT 'default',
      owner_id text NOT NULL,
      owner_label text,
      fleet_slug text,
      fleet_role text,
      event text NOT NULL DEFAULT 'join',
      at timestamptz NOT NULL DEFAULT now()
    )`);
}, 90_000);

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps, harness_shared.cup_claim_specs, harness_shared.fleet_membership_events RESTART IDENTITY`;
});

afterAll(async () => {
  await db?.cleanup?.();
});

describe('WI-4770 fleet membership transition guard', () => {

  it.each(['cup', 'fleet'] as const)('refusal remedy repairs the effective %s row and changes the real scheduler consumer', async (source) => {
    await membership(BEE, PARENT, 'member');
    await seedFeature('WI-refused', 'exact refused row');
    await seedFeature('WI-forbidden', 'must stay outside the lane');
    const makeSpec = (id: string, allowed: string): ClaimSpec => ({
      ...laneSpec(id, allowed),
      view: { filter: { all: [
        { field: 'kind', op: '=', value: 'feature' },
        { field: 'id', op: 'in', value: [allowed] },
      ] } },
      limits: { maxConcurrentClaims: 1 },
    });
    // Validate fixtures explicitly and retain the writer's errors in failures;
    // an opaque `.ok` assertion hid an unsupported filter field on first run.
    const parent = makeSpec('fleet-parent', source === 'cup' ? 'WI-refused' : 'WI-parent');
    expect(validateClaimSpec(parent)).toMatchObject({ ok: true, errors: [] });
    const parentWrite = await setClaimSpec({ cupId: fleetSpecBeeKey(PARENT), workspaceId: WS, spec: parent, potSlug: H }, db.sql);
    expect(parentWrite.errors).toEqual([]);
    expect(parentWrite.ok).toBe(true);
    if (source === 'cup') {
      const memberWrite = await setClaimSpec({ cupId: BEE, workspaceId: WS,
        spec: makeSpec('member-private', 'WI-member'), potSlug: H }, db.sql);
      expect(memberWrite.errors).toEqual([]);
      expect(memberWrite.ok).toBe(true);
    }
    // Reproduce the incident's separate fleet3/private44 heads without creating
    // dozens of unrelated revisions in this disposable fixture.
    for (const [id, revision] of [[fleetSpecBeeKey(PARENT), 3], ...(source === 'cup' ? [[BEE, 44]] : [])] as Array<[string, number]>) {
      await db.sql`UPDATE harness_shared.cup_claim_specs SET revision=${revision},
        spec=jsonb_set(spec, '{revision}', to_jsonb(${revision}::int)) WHERE bee_id=${id} AND workspace_id=${WS}`;
    }
    const read = () => getClaimSpecRecord({ cupId: BEE, workspaceId: WS }, db.sql);
    const before = await read();
    expect(before.source).toBe(source);
    expect(before.revision).toBe(source === 'cup' ? 44 : 3);
    expect(await getNextForBee({ cupId: BEE, workspaceId: WS, harness: H })).toBeNull();
    const scope = { ownerId: BEE, fleetSlug: PARENT, fleetRole: 'member' as const, workspaceId: WS, record: before };
    const refusal = { allowed: false as const, scoped: true as const, code: 'fleet_scope_violation' as const,
      reason: 'exact row outside effective lane', scope, refusal: fleetScopeRefusalContract('fleet_scope_violation', scope) };
    const remedy = fleetScopeLeaderRemedy(refusal, true, null, null, 'WI-refused', H);
    const call = JSON.parse(/scheduler:set_claim_spec (\{[^\n]+?\})\./.exec(remedy)![1]) as {
      cupId?: string; fleet?: string; appendIds?: string[]; spec?: ClaimSpec; harness: string;
    };
    expect(call).toMatchObject(source === 'cup' ? { cupId: BEE } : { fleet: PARENT });
    const target = call.cupId ?? fleetSpecBeeKey(call.fleet!);
    const repaired = await setClaimSpec({ cupId: target, workspaceId: WS, potSlug: call.harness,
      ...(call.spec ? { spec: call.spec } : { appendIds: call.appendIds }) }, db.sql);
    expect(repaired.errors).toEqual([]);
    expect(repaired.ok).toBe(true);
    const after = await read();
    expect(after.source).toBe(source);
    expect(after.revision).toBe(before.revision! + 1);
    expect(after.spec.rank).toEqual(before.spec.rank);
    expect(after.spec.limits).toEqual(before.spec.limits);
    expect(after.spec.view.filter).toEqual({ all: [
      { field: 'kind', op: '=', value: 'feature' },
      { field: 'id', op: 'in', value: [source === 'cup' ? 'WI-member' : 'WI-parent', 'WI-refused'] },
    ] });
    expect((await getNextForBee({ cupId: BEE, workspaceId: WS, harness: H }))?.workItem.id).toBe('WI-refused');
    expect(await db.sql`SELECT feature_id, taken_by FROM harness_shared.work_items WHERE feature_id='WI-forbidden'`)
      .toEqual([{ feature_id: 'WI-forbidden', taken_by: null }]);
    if (source === 'cup') expect((await getClaimSpecRecord({ cupId: fleetSpecBeeKey(PARENT), workspaceId: WS }, db.sql)).revision).toBe(3);
  });

  it.each([false, true])('dedicated members FIRST pull stays in-lane, including helpers and restart (reverse=%s)', async (reverse) => {
    const { seedMemberLaunchClaimSpecs } = await import('./member-launch-spec');
    const rows = [
      { id: 'WI-control', plan: 'other', at: 1 },
      { id: 'WI-unrelated', plan: 'other', at: 2 },
      { id: 'WI-alpha', plan: 'alpha', at: 1000 },
      { id: 'WI-beta', plan: 'beta', at: 2000 },
      { id: 'WI-alpha-helper', plan: null, at: 3000 },
      { id: 'WI-forbidden', plan: 'outside-parent', at: 0 },
    ];
    for (const row of reverse ? [...rows].reverse() : rows) {
      await seedFeature(row.id, row.id);
      await db.sql`UPDATE harness_shared.work_items
        SET source_plan_slug=${row.plan}, created_ts=${row.at},
            item_kind=${row.id === 'WI-alpha-helper' ? 'task' : 'feature'}
        WHERE feature_id=${row.id}`;
    }
    const parent: ClaimSpec = {
      ...DEFAULT_CLAIM_SPEC,
      specId: 'dedicated-launch-parent', revision: 1,
      view: { filter: { field: 'id', op: 'in', value: rows.filter((row) => row.id !== 'WI-forbidden').map((row) => row.id) } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
      states: ['open'],
    };
    expect((await setClaimSpec({ cupId: fleetSpecBeeKey(PARENT), spec: parent }, db.sql)).ok).toBe(true);
    // Positive control: inherited broad scope selects the unrelated sibling first.
    await membership('su-launch-control', PARENT, 'member');
    expect((await getNextForBee({ cupId: 'su-launch-control', workspaceId: WS, harness: H }))?.workItem.id).toBe('WI-control');

    const filter = (plan: string): import('./claim-spec').FilterNode => ({ any: [
      { field: 'plan', op: '=', value: plan },
      { field: 'id', op: 'in', value: [`WI-${plan}-helper`, 'WI-forbidden'] },
    ] });
    // The launcher's real pre-spawn writer runs before member registration.
    await seedMemberLaunchClaimSpecs({ workspaceId: WS, harness: H, updatedBy: 'leader', parent,
      members: [
        { ownerId: 'su-launch-alpha', claimFilter: filter('alpha'), claimKinds: ['feature'] },
        { ownerId: 'su-launch-beta', claimFilter: filter('beta') },
        { ownerId: 'su-launch-helper', claimFilter: filter('alpha'), claimKinds: ['task'] },
      ],
    }, db.sql);
    for (const ownerId of ['su-launch-alpha', 'su-launch-beta', 'su-launch-helper']) {
      await membership(ownerId, PARENT, 'member');
      expect((await getClaimSpecRecord({ cupId: ownerId, workspaceId: WS }, db.sql)).source).toBe('cup');
    }
    expect((await getNextForBee({ cupId: 'su-launch-alpha', workspaceId: WS, harness: H }))?.workItem.id).toBe('WI-alpha');
    expect((await getNextForBee({ cupId: 'su-launch-beta', workspaceId: WS, harness: H }))?.workItem.id).toBe('WI-beta');
    expect((await getNextForBee({ cupId: 'su-launch-helper', workspaceId: WS, harness: H }))?.workItem.id).toBe('WI-alpha-helper');

    // Respawn's maintained source=cup copy retains the lane before replacement boot.
    const prior = await getClaimSpecRecord({ cupId: 'su-launch-alpha', workspaceId: WS }, db.sql);
    expect((await setClaimSpec({ cupId: 'su-launch-restart', spec: prior.spec }, db.sql)).ok).toBe(true);
    await membership('su-launch-restart', PARENT, 'member');
    expect(await getNextForBee({ cupId: 'su-launch-restart', workspaceId: WS, harness: H })).toBeNull();
    expect(await db.sql`SELECT feature_id, taken_by FROM harness_shared.work_items
      WHERE feature_id IN ('WI-unrelated','WI-forbidden') ORDER BY feature_id`).toEqual([
      { feature_id: 'WI-forbidden', taken_by: null }, { feature_id: 'WI-unrelated', taken_by: null },
    ]);
    // Replay must not overwrite a later member steer.
    await seedMemberLaunchClaimSpecs({ workspaceId: WS, harness: H, updatedBy: 'retry', parent,
      members: [{ ownerId: 'su-launch-alpha', claimFilter: filter('beta') }],
    }, db.sql);
    expect(await getClaimSpecRecord({ cupId: 'su-launch-alpha', workspaceId: WS }, db.sql))
      .toMatchObject({ revision: prior.revision, spec: prior.spec, updatedBy: prior.updatedBy });
  });

  it.each(['cup', 'fleet', 'inherited'] as const)(
    'P003 rejects a malformed %s policy instead of granting defaults, and repairs the same target',
    async (source) => {
      const target = source === 'cup' ? BEE : fleetSpecBeeKey(PARENT);
      const reader = source === 'fleet' ? target : BEE;
      await membership(BEE, PARENT, 'member');
      await setClaimSpec({ cupId: target, spec: laneSpec('restricted', 'WI-allowed') }, db.sql);
      await seedFeature('WI-outside', 'unrelated work must remain unclaimed');
      await db.sql`
        UPDATE harness_shared.cup_claim_specs SET spec = '{"specVersion":"invalid"}'::jsonb
         WHERE workspace_id = ${WS} AND bee_id = ${target}`;

      await expect(getClaimSpecRecord({ cupId: reader, workspaceId: WS }, db.sql))
        .rejects.toMatchObject({ code: 'invalid_claim_spec' });
      await expect(getClaimSpec({ cupId: reader, workspaceId: WS }, db.sql))
        .rejects.toMatchObject({ code: 'invalid_claim_spec' });
      await expect(getNextForBee({ cupId: reader, workspaceId: WS, harness: H }))
        .rejects.toMatchObject({ code: 'invalid_claim_spec' });
      expect(await db.sql`SELECT taken_by FROM harness_shared.work_items WHERE feature_id='WI-outside'`)
        .toEqual([{ taken_by: null }]);

      // No replacement owner, fleet or task: the canonical writer repairs the
      // existing policy and the same request resolves its new revision.
      const repaired = await setClaimSpec({ cupId: target, spec: laneSpec('repaired', 'WI-allowed') }, db.sql);
      expect(repaired.ok).toBe(true);
      expect(await getClaimSpecRecord({ cupId: reader, workspaceId: WS }, db.sql)).toMatchObject({
        source: source === 'cup' ? 'cup' : 'fleet',
        revision: repaired.revision,
        spec: { specId: 'repaired', view: { filter: { value: ['WI-allowed'] } } },
      });
    },
  );

  it('P003 propagates membership read failure, then retries against the restored ledger', async () => {
    await membership(BEE, PARENT, 'member');
    await setClaimSpec({ cupId: fleetSpecBeeKey(PARENT), spec: laneSpec('restricted', 'WI-allowed') }, db.sql);
    // Real missing-relation failure in an isolated transaction; rejection rolls
    // back the rename. Previously the catch returned solo DEFAULT_CLAIM_SPEC.
    await expect(db.sql.begin(async (tx) => {
      await tx`ALTER TABLE harness_shared.fleet_membership_events RENAME TO unavailable_membership`;
      return getClaimSpecRecord({ cupId: BEE, workspaceId: WS }, tx as unknown as postgres.Sql);
    })).rejects.toMatchObject({ code: '42P01' });
    expect(await getClaimSpecRecord({ cupId: BEE, workspaceId: WS }, db.sql)).toMatchObject({
      source: 'fleet', fleetSlug: PARENT, spec: { specId: 'restricted' },
    });
  });

  it('P003 propagates an inherited policy read failure without a default receipt', async () => {
    await membership(BEE, PARENT, 'member');
    await setClaimSpec({ cupId: fleetSpecBeeKey(PARENT), spec: laneSpec('restricted', 'WI-allowed') }, db.sql);
    const failure = new Error('injected inherited policy read failure');
    const sql = new Proxy(db.sql, {
      apply(target, thisArg, args) {
        if (Array.isArray(args[0]) && args[0].join('').includes('FROM harness_shared.cup_claim_specs')
          && args.includes(fleetSpecBeeKey(PARENT))) return Promise.reject(failure);
        return Reflect.apply(target, thisArg, args);
      },
    });
    await expect(getClaimSpecRecord({ cupId: BEE, workspaceId: WS }, sql)).rejects.toBe(failure);
    await expect(getClaimSpec({ cupId: BEE, workspaceId: WS }, sql)).rejects.toBe(failure);
    expect(await getClaimSpecRecord({ cupId: BEE, workspaceId: WS }, db.sql)).toMatchObject({
      source: 'fleet', fleetSlug: PARENT,
    });
  });

  it('P003 preserves confirmed solo absence and a missing direct fleet sentinel as distinct states', async () => {
    expect(await getClaimSpecRecord({ cupId: BEE, workspaceId: WS }, db.sql)).toEqual({
      source: 'default', spec: DEFAULT_CLAIM_SPEC, revision: null, updatedBy: null, updatedAt: null,
    });
    expect(await getClaimSpecRecord({ cupId: fleetSpecBeeKey(PARENT), workspaceId: WS }, db.sql))
      .toMatchObject({ source: 'default', fleetSlug: PARENT });
  });

  it('fails closed across a fleet switch until the new lane is explicitly rebound', async () => {
    const outside = 'WI-3488';
    await setClaimSpec({ cupId: fleetSpecBeeKey(PARENT), spec: laneSpec('parent-lane', 'WI-in-scope') }, db.sql);
    await membership(BEE, PARENT, 'member');

    expect(await getClaimSpecRecord({ cupId: BEE, workspaceId: WS }, db.sql)).toMatchObject({
      source: 'fleet',
      fleetSlug: PARENT,
    });

    // The observed failure path: a member changes fleet/role before the child
    // sentinel is installed. DEFAULT_CLAIM_SPEC would otherwise take WI-3488.
    await membership(BEE, CHILD, 'leader');
    await seedFeature(outside, 'p2p transport item');

    const guarded = await getNextForBee({ cupId: BEE, workspaceId: WS, harness: H });
    expect(guarded).toBeNull();
    expect(await db.sql`SELECT taken_by FROM harness_shared.work_items WHERE feature_id=${outside}`).toEqual([{ taken_by: null }]);
    expect(await getClaimSpecRecord({ cupId: BEE, workspaceId: WS }, db.sql)).toMatchObject({
      source: 'default',
      fleetSlug: CHILD,
    });

    // A deliberate per-bee rebind is the only way to reopen the pull path.
    await setClaimSpec({ cupId: BEE, spec: laneSpec('child-rebound', outside), updatedBy: 'leader' }, db.sql);
    const reboundRecord = await getClaimSpecRecord({ cupId: BEE, workspaceId: WS }, db.sql);
    expect(reboundRecord).toMatchObject({ source: 'cup', spec: { specId: 'child-rebound' } });
    expect(await db.sql`SELECT item_kind, status, taken_by FROM harness_shared.work_items WHERE feature_id=${outside}`).toEqual([
      { item_kind: 'feature', status: 'open', taken_by: null },
    ]);
    // The rebind removes the transition marker; subsequent claim eligibility is
    // governed by the ordinary scheduler floors, not by this guard.
    expect(reboundRecord.fleetSlug).toBeUndefined();
  });

  it('an explicit leave settles the transition: solo default pulls resume', async () => {
    // The membership store's contract: a latest fact with fleet_slug=null means
    // "explicitly in no fleet" — a settled state, not a transition window. The
    // admission seams (resolveFleetScopeContext) already treat a left agent as
    // unscoped (by-id claims are open), so the self-select path must agree:
    // resurrecting the prior fleet as a transition marker permanently fail-closed
    // every ex-member's get_next (observed live 2026-07-17 after a scratch-fleet
    // wind-down) while protecting nothing the by-id path didn't already allow.
    const generic = 'WI-4770-leave-generic';
    await setClaimSpec({ cupId: fleetSpecBeeKey(PARENT), spec: DEFAULT_CLAIM_SPEC }, db.sql);
    await membership(LEAVE_BEE, PARENT, 'member');
    await membership(LEAVE_BEE, null, null);
    await seedFeature(generic, 'generic backlog item');

    const record = await getClaimSpecRecord({ cupId: LEAVE_BEE, workspaceId: WS }, db.sql);
    expect(record).toMatchObject({ source: 'default' });
    expect(record.fleetSlug).toBeUndefined();

    const claimed = await getNextForBee({ cupId: LEAVE_BEE, workspaceId: WS, harness: H });
    expect(claimed?.workItem.id).toBe(generic);
    expect(claimed?.specSource).toBe('default');
    expect(await db.sql`SELECT taken_by FROM harness_shared.work_items WHERE feature_id=${generic}`).toEqual([
      { taken_by: LEAVE_BEE },
    ]);
  });
});
