/**
 * work-items-needs-human-exclusion.integration.test.ts — post-migration-864
 * compatibility behavior for the historical `payload.needsHuman` key.
 *
 * Migration 864 replaced the ambiguous payload flag with typed owner-action and agent-review
 * destinations. The legacy key remains readable for pre-migration rows, but no lifecycle writer
 * may recreate it. Stored status='needs-human' is reserved for a strict typed owner capability;
 * unstructured requests are refused at the lifecycle seam.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/work-items-needs-human-exclusion.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { applyMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  ADV_SESSIONS_CLAIM_MIN_DDL,
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  USER_TRUST_LIST_DDL,
  WORK_ITEM_DEPS_DDL,
} from '../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const wi = await import('./work-items');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

/** An issue-family row in the work_items BASE. */
async function seedIssue(
  id: string,
  opts: { kind?: string; status?: string; takenBy?: string | null; createdTs?: number; payload?: Record<string, unknown> | null } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts, payload)
    VALUES (${H}, ${id}, ${opts.kind ?? 'bug'}, ${`title ${id}`}, ${opts.status ?? 'open'}, ${opts.takenBy ?? null},
       ${WS}, ${opts.createdTs ?? 0}, 0, ${opts.payload ? db.sql.json(opts.payload as unknown as Parameters<typeof db.sql.json>[0]) : null})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('wi-needs-human');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql.unsafe(ADV_SESSIONS_CLAIM_MIN_DDL);
  // The by-id issue claim auto-subscribes the claimer (coord_entity_subscriptions).
  await ensureCoordCapabilityTables(db.sql);
  // Claims and lifecycle transitions emit awaited-event latches. Keep this fixture's
  // runtime dependency explicit and migration-audited so a missing latch relation does
  // not turn otherwise-correct assertions into vitest-fail-on-console failures.
  await applyMigrationsForTest(db.sql, [
    '163-await-event-subscriptions.sql',
    '175-watch-floor-coalesce-cols.sql',
    '387-event-wake-delivery-source.sql',
    '533-add-event-awaits-payload-filter.sql',
    '541-predicate-watches.sql',
    '572-event-await-nodes-threshold-tree.sql',
    '599-event-announcement-generation.sql',
    '632-event-key-fire-latch.sql',
    '871-lifecycle-bound-watches.sql',
    '925-fleet-leader-watch-suppression.sql',
    '953-event-announcement-logical-gate.sql',
    '1216-event-await-fired-delivery-intent-marker.sql',
    '1250-predicate-watch-evaluator-baselines.sql',
  ], {
    label: 'work-items-needs-human-exclusion.integration.test.ts',
    runtimeTables: ['harness_shared.event_key_fires', 'harness_shared.event_awaits'],
  });
}, 180_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
  setFlagOverridesForTest({
    [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true,
    [FLAGS.SCHEDULER_MAINTAINED_READY]: false,
  });
});
afterEach(() => setFlagOverridesForTest({}));

describe('claimNextWorkItem admits a legacy needsHuman:true OPEN issue after migration 864', () => {
  it('serves the legacy-tagged item normally when it is oldest', async () => {
    await seedIssue('EI-human', { kind: 'change', createdTs: 100, payload: { needsHuman: true } });
    await seedIssue('WI-real', { createdTs: 200 });

    // The legacy payload key is no longer a floor, so ordinary oldest-first ordering applies.
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('EI-human');

    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'bee-2' })).toMatchObject({ id: 'WI-real' });
    const rows = await db.sql<{ taken_by: string | null }[]>`
      SELECT taken_by FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = 'EI-human'`;
    expect(rows[0]?.taken_by).toBe('bee-1');
  });

  it('a needsHuman row is also directly claimable by id', async () => {
    await seedIssue('EI-human-direct', { kind: 'change', createdTs: 100, payload: { needsHuman: true } });
    const claimed = await wi.claimWorkItem('EI-human-direct', 'inspector', { harness: H });
    expect(claimed?.id).toBe('EI-human-direct');
    expect(claimed?.assignee).toBe('inspector');
  });

  it('needsHuman:false is NOT excluded', async () => {
    await seedIssue('WI-not-human', { kind: 'change', createdTs: 100, payload: { needsHuman: false } });
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-not-human');
  });

  it('a row with no payload at all is NOT excluded (NULL-safe)', async () => {
    await seedIssue('WI-no-payload', { kind: 'change', createdTs: 100, payload: null });
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-no-payload');
  });
});

describe('diagnoseClaimNextMiss counts a legacy needsHuman OPEN row as ordinary work', () => {
  it('reports the row pending and ready instead of a false drain', async () => {
    await seedIssue('EI-human-diag', { kind: 'change', createdTs: 100, payload: { needsHuman: true } });

    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'diag' });
    expect(diag.pendingUnclaimed).toBe(1);
    expect(diag.readyUnclaimed).toBe(1);
    expect(diag.drained).toBe(false);
  });

  it('counts both a plain row and a legacy-tagged row', async () => {
    await seedIssue('EI-human-diag-2', { kind: 'change', createdTs: 100, payload: { needsHuman: true } });
    await seedIssue('WI-ready-diag-2', { createdTs: 200 });

    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'diag' });
    expect(diag.pendingUnclaimed).toBe(2);
    expect(diag.readyUnclaimed).toBe(2);
    expect(diag.drained).toBe(false);
  });
});

describe('setWorkItemStateWithAliasInfo retires legacy needsHuman writes (P-006)', () => {
  it('releases an active claim when an issue enters needs-human so the next pull can proceed', async () => {
    const { blockers } = wi.updateExternalBlockerHistory(
      {},
      {
        kind: 'human',
        capability: 'credential',
        ref: 'credential:prod-db',
        summary: 'Provide the production DB credential.',
        nextVerb: 'setup:save_key',
      },
      'tester',
      '2026-08-23T18:00:00.000Z',
    );
    await seedIssue('EI-claimed-human', {
      kind: 'change',
      status: 'open',
      createdTs: 100,
    });
    await seedIssue('WI-next-after-human', { createdTs: 200 });

    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' })).toMatchObject({
      id: 'EI-claimed-human',
    });
    await db.sql`
      UPDATE harness_shared.work_items
         SET payload = ${db.sql.json(
           { humanCapability: 'credential', externalBlockers: blockers } as unknown as Parameters<typeof db.sql.json>[0],
         )}
       WHERE workspace_id = ${WS} AND feature_id = 'EI-claimed-human'`;

    const parked = await wi.setWorkItemStateWithAliasInfo('EI-claimed-human', 'needs-human', {
      harness: H,
      by: 'tester',
    });

    expect(parked.appliedState).toBe('needs-human');
    const released = await db.sql<{ status: string; taken_by: string | null; taken_at: string | null; last_progress_at: string | null }[]>`
      SELECT status, taken_by, taken_at, last_progress_at
        FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id = 'EI-claimed-human'`;
    expect(released[0]).toMatchObject({
      status: 'needs-human',
      taken_by: null,
      taken_at: null,
      last_progress_at: null,
    });

    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' })).toMatchObject({
      id: 'WI-next-after-human',
    });
  });

  it('refuses an unstructured needs-human request instead of creating a write-only park', async () => {
    await seedIssue('EI-echo-1', { kind: 'change', status: 'open', createdTs: 100, payload: {} });

    await expect(
      wi.setWorkItemStateWithAliasInfo('EI-echo-1', 'needs-human', { harness: H, by: 'tester' }),
    ).rejects.toThrow(/no structured owner ask.*work_items:set_blocker/);
  });

  it('keeps a strict structured owner ask parked and replaces the legacy key atomically', async () => {
    const { blockers } = wi.updateExternalBlockerHistory(
      {},
      {
        kind: 'human',
        capability: 'credential',
        ref: 'credential:prod-db',
        summary: 'Provide the production DB credential.',
        nextVerb: 'setup:save_key',
      },
      'tester',
      '2026-08-23T18:00:00.000Z',
    );
    await seedIssue('EI-echo-2', {
      kind: 'change',
      status: 'open',
      createdTs: 100,
      payload: { humanCapability: 'credential', needsHuman: true, externalBlockers: blockers },
    });
    const res = await wi.setWorkItemStateWithAliasInfo('EI-echo-2', 'needs-human', { harness: H, by: 'tester' });

    const rows = await db.sql<{ payload: Record<string, unknown> | null }[]>`
      SELECT payload FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = 'EI-echo-2'`;
    expect(res.appliedState).toBe('needs-human');
    expect(rows[0]?.payload?.needsOwnerAction).toBe(true);
    expect(rows[0]?.payload).not.toHaveProperty('needsHuman');
    expect((res.workItem?.payload as Record<string, unknown> | undefined)?.needsOwnerAction).toBe(true);
  });

  it('accepts a product-decision structured owner ask when retrying needs-human parking', async () => {
    const { blockers } = wi.updateExternalBlockerHistory(
      {},
      {
        kind: 'human',
        capability: 'product-decision',
        ref: 'decision:scope',
        summary: 'Choose the supported scope.',
        nextVerb: 'Record the product decision.',
      },
      'tester',
      '2026-08-23T18:00:00.000Z',
    );
    await seedIssue('EI-product-decision-human', {
      kind: 'change',
      status: 'open',
      payload: { humanCapability: 'product-decision', externalBlockers: blockers },
    });

    const res = await wi.setWorkItemStateWithAliasInfo('EI-product-decision-human', 'needs-human', {
      harness: H,
      by: 'tester',
    });

    expect(res.appliedState).toBe('needs-human');
    expect((res.workItem?.payload as Record<string, unknown> | undefined)?.needsOwnerAction).toBe(true);
    expect((res.workItem?.payload as Record<string, unknown> | undefined)?.needsHuman).toBeUndefined();
  });

  it('does not disturb an item already pending agent review', async () => {
    const agentReview = { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'WI-ledger', round: 1 };
    await seedIssue('EI-echo-review', { kind: 'change', status: 'open', payload: { agentReview } });
    const res = await wi.setWorkItemStateWithAliasInfo('EI-echo-review', 'needs-human', { harness: H, by: 'tester' });
    expect(res.appliedState).toBe('open');
    expect(res.aliasNote).toMatch(/already in agent review/);
    expect((res.workItem?.payload as Record<string, unknown> | undefined)?.agentReview).toEqual(agentReview);
    expect((res.workItem?.payload as Record<string, unknown> | undefined)?.needsHuman).toBeUndefined();
  });

  it('a non-issue-family transition (e.g. plain wip) never calls the auto-gate / re-fetch at all', async () => {
    await seedIssue('EI-echo-3', { kind: 'change', status: 'open', createdTs: 100, payload: { marker: 'untouched' } });
    const res = await wi.setWorkItemStateWithAliasInfo('EI-echo-3', 'wip', { harness: H, by: 'tester' });
    expect(res.appliedState).toBe('wip');
    expect((res.workItem?.payload as Record<string, unknown> | undefined)?.marker).toBe('untouched');
    expect((res.workItem?.payload as Record<string, unknown> | undefined)?.needsHuman).toBeUndefined();
  });
});

describe('blocked auto-gate lease cleanup (EI-20490353465054928)', () => {
  async function payloadOf(id: string) {
    const rows = await db.sql<{ status: string; payload: Record<string, unknown> | null }[]>`
      SELECT status, payload
        FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id = ${id}`;
    return rows[0];
  }

  it('clears the temporary blocked hold when no durable park exists', async () => {
    await seedIssue('EI-blocked-lease-no-park', { kind: 'change', status: 'open' });

    await wi.setWorkItemStateWithAliasInfo('EI-blocked-lease-no-park', 'blocked', { harness: H, by: 'tester' });
    expect(await payloadOf('EI-blocked-lease-no-park')).toMatchObject({
      status: 'blocked',
      payload: { _claimHold: true, held_open_by: 'tester', held_open_reason: 'blocked' },
    });

    const reopened = await wi.setWorkItemStateWithAliasInfo('EI-blocked-lease-no-park', 'open', {
      harness: H,
      by: 'tester',
    });
    const row = await payloadOf('EI-blocked-lease-no-park');

    expect(reopened.workItem?.state).toBe('open');
    expect(reopened.workItem?.payload).not.toHaveProperty('_claimHold');
    expect(row?.status).toBe('open');
    expect(row?.payload).not.toHaveProperty('_claimHold');
    expect(row?.payload).not.toHaveProperty('held_open_by');
    expect(row?.payload).not.toHaveProperty('held_open_reason');
  });

  it('clears only the temporary lease and preserves a coexisting durable park', async () => {
    await seedIssue('EI-blocked-lease-durable-park', { kind: 'change', status: 'open' });

    await wi.setWorkItemStateWithAliasInfo('EI-blocked-lease-durable-park', 'blocked', {
      harness: H,
      by: 'tester',
    });
    await wi.setWorkItemClaimHold('EI-blocked-lease-durable-park', true, {
      harness: H,
      parkedBy: 'park-owner',
      parkedReason: 'deliberate retry hold',
    });

    const reopened = await wi.setWorkItemStateWithAliasInfo('EI-blocked-lease-durable-park', 'open', {
      harness: H,
      by: 'tester',
    });
    const row = await payloadOf('EI-blocked-lease-durable-park');

    expect(reopened.workItem?.state).toBe('open');
    expect(reopened.workItem?.payload).toMatchObject({
      _claimHold: true,
      claim_hold_by: 'park-owner',
      claim_hold_reason: 'deliberate retry hold',
    });
    expect(reopened.workItem?.payload).not.toHaveProperty('held_open_by');
    expect(reopened.workItem?.payload).not.toHaveProperty('held_open_reason');
    expect(row?.status).toBe('open');
    expect(row?.payload).toMatchObject({
      _claimHold: true,
      claim_hold_by: 'park-owner',
      claim_hold_reason: 'deliberate retry hold',
    });
    expect(row?.payload).not.toHaveProperty('held_open_by');
    expect(row?.payload).not.toHaveProperty('held_open_reason');
  });
});
