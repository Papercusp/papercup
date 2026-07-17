/**
 * fleet-scope-admission.cooldown-diagnosis.integration.test.ts — WI-5303: recurrence guard
 * for `diagnoseFleetScopeCooldownMiss`'s MIN-vs-MAX / over-broad-count bug against REAL
 * Postgres (the unit-level mocks in fleet-scope-admission.test.ts stub the `sql` tag itself,
 * so they can validate the WIRING but can never catch a WHERE-clause logic bug in the query
 * text — this is the "seed the exact row shapes" test the original investigation asked for,
 * since live psql probing on a concurrently-mutating tree proved unreliable for pinning the
 * bug down (WI-5281's own notes)).
 *
 * THE BUG (pre-fix): the diagnosis query counted every row that matched the spec + every
 * OTHER floor once the cooldown leg was dropped entirely (`cnt`), then took
 * `MIN(last_released_at) FILTER (WHERE last_released_by = me)` over THAT SAME row set for
 * `earliest`. Two rows released by the caller — one long expired, one still cooling down —
 * made MIN lock onto the EXPIRED one, so `earliestExpiryMs` computed to a timestamp in the
 * PAST and the derived `cooldownExpirySec` (fleetScopedMiss) reported 0 forever, even though
 * a genuinely-still-cooling-down row explained the real miss.
 *
 * THE FIX: restrict the query up front to rows this bee itself released AND that are still
 * inside the cooldown window — the exact predicate the WITH-cooldown floor excludes on. `cnt`
 * becomes the true set difference (only cooldown-attributable rows, never a row excluded by a
 * different floor or a stale/expired self-release), and `earliest` can never lock onto an
 * expired timestamp because expired rows never enter the aggregate at all.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/fleet-scope-admission.cooldown-diagnosis.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, USER_TRUST_LIST_DDL, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import type { ClaimSpecRecord } from './claim-spec-store';
import type { FleetScopeContext } from './fleet-scope-admission';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { diagnoseFleetScopeCooldownMiss } = await import('./fleet-scope-admission');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

async function seedFeature(id: string, opts: { createdTs?: number; takenBy?: string | null } = {}) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts)
    VALUES (${H}, ${id}, 'feature', ${`title ${id}`}, 'todo', ${opts.takenBy ?? null}, ${WS}, ${opts.createdTs ?? 0}, 0)`;
}

async function releaseAt(id: string, releasedBy: string, secondsAgo: number) {
  await db.sql`
    UPDATE harness_shared.work_items
       SET taken_by = NULL,
           last_released_by = ${releasedBy},
           last_released_at = now() - make_interval(secs => ${secondsAgo})
     WHERE workspace_id = ${WS} AND feature_id = ${id}`;
}

function scopeFor(ownerId: string): FleetScopeContext {
  const spec: ClaimSpecRecord['spec'] = {
    specVersion: '1.0',
    specId: 'wi-5303-cooldown',
    revision: 1,
    view: { filter: { field: 'kind', op: '=', value: 'feature' } },
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
  };
  return {
    ownerId,
    fleetSlug: 'bugs',
    fleetRole: 'member',
    record: { source: 'fleet', spec, revision: 1, updatedBy: 'su-leader', updatedAt: 'now' },
  };
}

beforeAll(async () => {
  db = await createFreshPgDb('fsa-cooldown-diag');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await ensureCoordCapabilityTables(db.sql);
}, 180_000);
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
  delete process.env.PAPERCUSP_RELEASE_COOLDOWN_SEC; // default (300s) unless a test overrides it
});
afterEach(() => {
  delete process.env.PAPERCUSP_RELEASE_COOLDOWN_SEC;
});

describe('diagnoseFleetScopeCooldownMiss against real Postgres (WI-5303)', () => {
  it('a STALE self-release well past cooldown never masks a FRESH self-release still cooling down (the MIN-lock bug)', async () => {
    await seedFeature('WI-fsa-stale', { createdTs: 100, takenBy: 'su-member' });
    await releaseAt('WI-fsa-stale', 'su-member', 10_000); // ~2.8h ago — long past the 300s default

    await seedFeature('WI-fsa-fresh', { createdTs: 200, takenBy: 'su-member' });
    await releaseAt('WI-fsa-fresh', 'su-member', 30); // 30s ago — still well inside the window

    const diag = await diagnoseFleetScopeCooldownMiss({
      scope: scopeFor('su-member'),
      harness: H,
      workspaceId: WS,
    });

    expect(diag).not.toBeNull();
    // Pre-fix: cnt counted BOTH rows (the without-cooldown floor admits both), and MIN(last_released_at)
    // locked onto the STALE row -> earliestExpiryMs in the past -> cooldownExpirySec stuck at 0 forever.
    // Post-fix: only the still-cooling-down row is attributable to cooldown.
    expect(diag?.cooldownExcluded).toBe(1);
    expect(diag?.earliestExpiryMs).not.toBeNull();
    // The fix's whole point: the expiry must be in the FUTURE, never the past.
    expect(diag!.earliestExpiryMs as number).toBeGreaterThan(Date.now());
  });

  it('a row excluded by a DIFFERENT floor (taken by someone else) is never attributed to MY cooldown', async () => {
    // Never released by su-member at all -> currently claimed by a peer -> fails the
    // taken_by-IS-NULL floor, not the cooldown floor. The old bare without-cooldown count
    // would still admit it (cooldown clause dropped to TRUE) and over-count.
    await seedFeature('WI-fsa-peer-held', { createdTs: 50, takenBy: 'su-other' });

    const diag = await diagnoseFleetScopeCooldownMiss({
      scope: scopeFor('su-member'),
      harness: H,
      workspaceId: WS,
    });

    // Nothing attributable to su-member's own cooldown -> no diagnosis.
    expect(diag).toBeNull();
  });

  it('once the cooldown window fully elapses for every self-release, the diagnosis reports null (no residual)', async () => {
    await seedFeature('WI-fsa-expired', { createdTs: 100, takenBy: 'su-member' });
    await releaseAt('WI-fsa-expired', 'su-member', 10_000);

    const diag = await diagnoseFleetScopeCooldownMiss({
      scope: scopeFor('su-member'),
      harness: H,
      workspaceId: WS,
    });

    expect(diag).toBeNull();
  });

  it('PAPERCUSP_RELEASE_COOLDOWN_SEC=0 short-circuits to null without querying (cooldown disabled entirely)', async () => {
    process.env.PAPERCUSP_RELEASE_COOLDOWN_SEC = '0';
    await seedFeature('WI-fsa-nocooldown', { createdTs: 100, takenBy: 'su-member' });
    await releaseAt('WI-fsa-nocooldown', 'su-member', 5);

    const diag = await diagnoseFleetScopeCooldownMiss({
      scope: scopeFor('su-member'),
      harness: H,
      workspaceId: WS,
    });

    expect(diag).toBeNull();
  });
});
