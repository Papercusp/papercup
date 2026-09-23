/**
 * WI-10002717: a revision-less CTRL acknowledgement (the coord:orient
 * {afterCompaction} path) must not advance the delivery watermark past a
 * generation whose identity activation is still pending. Measured live on :3170
 * (2026-09-23, events 16831/16832): orient acked such a generation, turn-start then
 * saw nothing pending, and the activation stayed at 'desired' with no prepared or
 * applied receipt. This runs the real UPDATE against the migrated schema, so the
 * guard's JSON comparison is exercised by Postgres, not by a mock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acknowledgeControlTransition } from './control-anchor';
import { setupPlanPgFixture, type PlanPgFixture } from '../plans/__tests__/_pg-tool-fixture';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const OWNER_PREFIX = `su-ctrl-ack-${RUN}`;
let fx: PlanPgFixture;

const REV_A = { specificationRevision: 'a'.repeat(64), stateRevision: 'state-a' };
const REV_B = { specificationRevision: 'b'.repeat(64), stateRevision: 'state-b' };

async function seed(owner: string, activation: unknown) {
  const controlState = { modes: ['auto'], carry: 'warm', ...(activation === undefined ? {} : { activation }) };
  await fx.admin`
    INSERT INTO harness_shared.session_briefs
      (owner_id, workspace_id, control_generation, control_delivered_generation, control_state)
    VALUES (${owner}, ${fx.workspaceId}, 5, 4, ${JSON.stringify(controlState)}::jsonb)
  `;
}

async function delivered(owner: string): Promise<number> {
  const rows = await fx.admin<Array<{ d: string }>>`
    SELECT control_delivered_generation::text AS d FROM harness_shared.session_briefs
     WHERE owner_id = ${owner} AND workspace_id = ${fx.workspaceId}
  `;
  return Number(rows[0]!.d);
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
});

afterAll(async () => {
  await fx.admin`DELETE FROM harness_shared.session_briefs WHERE owner_id LIKE ${`${OWNER_PREFIX}%`}`;
  await fx.dispose();
});

describe('revision-less CTRL acknowledgement leaves a pending activation for turn-start (WI-10002717)', () => {
  it('refuses while the activation is pending (desired != applied) and keeps the watermark', async () => {
    const owner = `${OWNER_PREFIX}-pending`;
    await seed(owner, { schemaVersion: 1, desired: REV_B, prepared: null, applied: REV_A, status: 'desired' });
    await expect(acknowledgeControlTransition(owner, fx.workspaceId, 5, fx.admin)).resolves.toBe(false);
    expect(await delivered(owner)).toBe(4);
  });

  it('refuses a first activation that has never been applied', async () => {
    const owner = `${OWNER_PREFIX}-first`;
    await seed(owner, { schemaVersion: 1, desired: REV_A, prepared: null, applied: null, status: 'desired' });
    await expect(acknowledgeControlTransition(owner, fx.workspaceId, 5, fx.admin)).resolves.toBe(false);
    expect(await delivered(owner)).toBe(4);
  });

  it('acknowledges once the activation has converged (desired == applied)', async () => {
    const owner = `${OWNER_PREFIX}-converged`;
    await seed(owner, { schemaVersion: 1, desired: REV_A, prepared: null, applied: REV_A, status: 'applied' });
    await expect(acknowledgeControlTransition(owner, fx.workspaceId, 5, fx.admin)).resolves.toBe(true);
    expect(await delivered(owner)).toBe(5);
  });

  it('acknowledges a control state with no activation at all (the legacy shape)', async () => {
    const owner = `${OWNER_PREFIX}-none`;
    await seed(owner, undefined);
    await expect(acknowledgeControlTransition(owner, fx.workspaceId, 5, fx.admin)).resolves.toBe(true);
    expect(await delivered(owner)).toBe(5);
  });

  it('acknowledges when desired is explicitly null', async () => {
    const owner = `${OWNER_PREFIX}-null`;
    await seed(owner, { schemaVersion: 1, desired: null, prepared: null, applied: REV_A, status: 'applied' });
    await expect(acknowledgeControlTransition(owner, fx.workspaceId, 5, fx.admin)).resolves.toBe(true);
    expect(await delivered(owner)).toBe(5);
  });
});
