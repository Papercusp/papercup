/**
 * EI-20263410682554156: exercise the terminal-plan admission diagnosis against
 * real Postgres. The unit test stubs the sql tag, so it cannot catch a wrong
 * harness_plans column, lifecycle filter, or workspace boundary.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../test/_work-items-schema';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import type { ClaimSpecRecord } from './claim-spec-store';
import type { FleetScopeContext } from './fleet-scope-admission';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { diagnoseFleetScopeRetiredPlans } = await import('./fleet-scope-admission');

const HARNESS = 'papercusp';
const WORKSPACE = 'retired-plan-diagnosis';
const OTHER_WORKSPACE = 'other-workspace';
let db: FreshPgDb;

function scopeFor(filter: ClaimSpecRecord['spec']['view']['filter'], workspaceId = WORKSPACE): FleetScopeContext {
  const spec: ClaimSpecRecord['spec'] = {
    specVersion: '1.0',
    specId: 'retired-plan-integration',
    revision: 1,
    view: { filter },
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
  };
  return {
    ownerId: 'su-member',
    fleetSlug: 'retired-plan-fleet',
    fleetRole: 'member',
    workspaceId,
    record: { source: 'fleet', spec, revision: 1, updatedBy: 'su-leader', updatedAt: 'now' },
  };
}

beforeAll(async () => {
  db = await createFreshPgDb('fsa-retired-plan');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
}, 180_000);

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.harness_plans CASCADE`;
});

afterAll(async () => {
  await db.cleanup();
});

describe('diagnoseFleetScopeRetiredPlans against real Postgres (EI-20263410682554156)', () => {
  it('matches terminal plan pins in the requested workspace only, including nested positive predicates', async () => {
    await db.sql`
      INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, status)
      VALUES
        (${WORKSPACE}, ${HARNESS}, 'finished-plan', 'shipped'),
        (${WORKSPACE}, ${HARNESS}, 'superseded-plan', 'superseded'),
        (${WORKSPACE}, ${HARNESS}, 'live-plan', 'active'),
        (${OTHER_WORKSPACE}, ${HARNESS}, 'finished-plan', 'active')
    `;

    const retired = await diagnoseFleetScopeRetiredPlans({
      scope: scopeFor({
        all: [
          { field: 'harness', op: '=', value: HARNESS },
          { field: 'plan', op: 'in', value: ['finished-plan', 'superseded-plan', 'live-plan'] },
        ],
      }),
    });

    expect(retired).toEqual([
      { planSlug: 'finished-plan', status: 'shipped' },
      { planSlug: 'superseded-plan', status: 'superseded' },
    ]);
  });

  it('returns no retired plans for a live-only or non-positive plan filter', async () => {
    await db.sql`
      INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, status)
      VALUES (${WORKSPACE}, ${HARNESS}, 'live-plan', 'active'),
             (${WORKSPACE}, ${HARNESS}, 'finished-plan', 'shipped')
    `;

    await expect(
      diagnoseFleetScopeRetiredPlans({
        scope: scopeFor({ not: { field: 'plan', op: '=', value: 'finished-plan' } }),
      }),
    ).resolves.toEqual([]);
    await expect(
      diagnoseFleetScopeRetiredPlans({
        scope: scopeFor({ field: 'plan', op: '=', value: 'live-plan' }),
      }),
    ).resolves.toEqual([]);
  });
});
