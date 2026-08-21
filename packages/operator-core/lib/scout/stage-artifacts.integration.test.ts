import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }) }));

const { persistStageArtifacts } = await import('./stage-artifacts');
const { createOrgTestDb } = await import('../../test/_org-test-db');

describe('scout stage artifacts routing reconciliation (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('WI-20860583842231472: persists success, failure, and skip decisions losslessly', async () => {
    const proposals = [{ id: 'p-success' }, { id: 'p-failed' }, { id: 'p-skipped' }];
    const routingDecisions = [
      { proposalId: 'p-success', rail: 'goal', routedRef: 'goal:G-1' },
      { proposalId: 'p-failed', rail: 'goal', error: 'goal dispatch unavailable' },
      { proposalId: 'p-skipped', rail: 'plan' },
    ];

    await persistStageArtifacts({
      cycleId: 'cycle-routing-reconciliation',
      workspaceId: 'ws-routing-reconciliation',
      proposals,
      routingDecisions,
    });

    const [row] = await db.adminSql<{
      proposals: typeof proposals;
      routing_decisions: typeof routingDecisions;
    }[]>`
      SELECT proposals, routing_decisions
        FROM harness_shared.scout_cycle_stage_artifacts
       WHERE workspace_id = 'ws-routing-reconciliation'
         AND cycle_id = 'cycle-routing-reconciliation'`;

    expect(row.proposals).toEqual(proposals);
    expect(row.routing_decisions).toEqual(routingDecisions);
    const dispatched = row.routing_decisions.filter((d) => d.routedRef).length;
    const failed = row.routing_decisions.filter((d) => d.error).length;
    const skipped = row.routing_decisions.filter((d) => !d.routedRef && !d.error).length;
    expect(row.proposals.length).toBe(dispatched + failed + skipped);
  });
});
