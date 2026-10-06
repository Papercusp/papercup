/**
 * WI-10006859 / plan app-agent-tasks-durable-execution-2026-10-06 D-017:
 * automatic applied-worker placement for accepted agent operations. Real
 * migrations, real admission (submitBlueprintOperation), a fake launcher.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { compileAgentSpecification, type Blueprint } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { projectBlueprintToPg } from './project-to-pg';
import { submitBlueprintOperation } from './operation-service';
import {
  buildAgentPlacementKickoff, claimAgentOperationPlacements, placeAcceptedAgentOperations,
  type AgentOperationPlacement,
} from './operation-agent-placement';

const connection = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: connection.sql }),
  withWorkspace: async <T>(workspace: string, fn: (tx: Sql) => Promise<T>) =>
    (connection.sql as Sql).begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspace}, true)`;
      return fn(tx as unknown as Sql);
    }) as Promise<T>,
}));

const harnessSlug = 'agent-placement-harness';
let db: OrgTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  connection.sql = sql;
}, 120_000);
afterAll(async () => db?.cleanup(), 120_000);

const specification = compileAgentSpecification({
  source: {
    id: 'agent-placement', version: 'A', workItem: { kind: 'feature' },
    roles: [{ id: 'worker' }],
    spine: { steps: [{ id: 'open', op: 'coord:thread-open', args: { title: 'Placement' } }] },
    operations: [{
      id: 'leaf', version: 'A',
      target: { kind: 'work-item', itemKind: 'feature' },
      execution: { kind: 'agent', role: 'worker' },
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      acceptance: { resultSchema: { type: 'object' } },
    }, {
      id: 'root', version: 'A',
      target: { kind: 'work-item', itemKind: 'feature' },
      execution: { kind: 'program' },
      inputSchema: { type: 'object' },
      acceptance: { resultSchema: { type: 'object' } },
    }],
  },
});

async function workspace(id: string): Promise<string> {
  await sql`
    INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${id}, ${harnessSlug}, ${Buffer.from(id)}, ${`kc-${id}`}, 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING
  `;
  await projectBlueprintToPg(sql, { workspaceId: id, harnessSlug,
    blueprint: specification.configuration as Blueprint, specification });
  return id;
}

async function accept(workspaceId: string, operationId: 'leaf' | 'root', key: string) {
  const accepted = await submitBlueprintOperation(sql, {
    workspaceId, harnessSlug, callerId: 'placement-caller', operationId,
    requestKey: key, input: operationId === 'leaf' ? { value: key } : {}, title: `Placement ${key}`,
  });
  const [row] = await sql<Array<{ target_ref: string }>>`
    SELECT target_ref FROM harness_shared.blueprint_operation_invocations WHERE id = ${accepted.receiptId}`;
  return { receiptId: accepted.receiptId, workItemId: row!.target_ref };
}

async function receipt(receiptId: number) {
  const [row] = await sql<Array<{
    agent_launch_attempts: number; agent_launch_owner_id: string | null;
    agent_placement_retired_at: Date | null;
  }>>`
    SELECT agent_launch_attempts, agent_launch_owner_id, agent_placement_retired_at
      FROM harness_shared.blueprint_operation_invocations WHERE id = ${receiptId}`;
  return row!;
}

/** Move the receipt's last launch outside the retry window. */
async function age(receiptId: number) {
  await sql`
    UPDATE harness_shared.blueprint_operation_invocations
       SET agent_last_launch_at = now() - interval '1 hour' WHERE id = ${receiptId}`;
}

describe('accepted agent operation placement (WI-10006859)', () => {
  it('claims an accepted agent operation once, with the role and target item bootstrap binds', async () => {
    const ws = await workspace('placement-basic');
    const leaf = await accept(ws, 'leaf', 'basic');
    const launched: AgentOperationPlacement[] = [];
    const pass = await placeAcceptedAgentOperations(sql, {
      launch: async (p) => { launched.push(p); return { ok: true }; },
    });
    const mine = launched.filter((p) => p.workspaceId === ws);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      receiptId: leaf.receiptId, workItemId: leaf.workItemId, role: 'worker',
      harnessSlug, operationId: 'leaf', attempt: 1,
    });
    expect(mine[0]!.ownerId).toMatch(/^su-[0-9a-f-]{36}$/);
    expect(pass.launched).toBeGreaterThanOrEqual(1);
    expect((await receipt(leaf.receiptId)).agent_launch_owner_id).toBe(mine[0]!.ownerId);
    expect(buildAgentPlacementKickoff(mine[0]!)).toContain(leaf.workItemId);

    // Inside the retry window the receipt is not placed again.
    const again = await claimAgentOperationPlacements(sql);
    expect(again.filter((p) => p.receiptId === leaf.receiptId)).toHaveLength(0);
  }, 90_000);

  it('never places a program operation and retires its receipt from the scan', async () => {
    const ws = await workspace('placement-program');
    const root = await accept(ws, 'root', 'program');
    const claimed = await claimAgentOperationPlacements(sql);
    expect(claimed.filter((p) => p.receiptId === root.receiptId)).toHaveLength(0);
    const row = await receipt(root.receiptId);
    expect(row.agent_launch_attempts).toBe(0);
    expect(row.agent_placement_retired_at).not.toBeNull();
  }, 90_000);

  it('re-places only after the window and only when the previous worker is gone, then stops at maxAttempts', async () => {
    const ws = await workspace('placement-retry');
    const leaf = await accept(ws, 'leaf', 'retry');
    const options = { maxAttempts: 2 };
    const first = (await claimAgentOperationPlacements(sql, options)).find((p) => p.receiptId === leaf.receiptId);
    expect(first?.attempt).toBe(1);

    // The worker booted and is live: the window passing alone does not re-place.
    await sql`INSERT INTO harness_shared.adv_sessions (workspace_id, mode, coord_owner_id)
              VALUES (${ws}, 'console', ${first!.ownerId})`;
    await age(leaf.receiptId);
    expect((await claimAgentOperationPlacements(sql, options))
      .filter((p) => p.receiptId === leaf.receiptId)).toHaveLength(0);

    // The worker ended without claiming the item: the next pass re-places it.
    await sql`UPDATE harness_shared.adv_sessions SET ended_at = now(), ended_by = 'self'
               WHERE coord_owner_id = ${first!.ownerId}`;
    const second = (await claimAgentOperationPlacements(sql, options)).find((p) => p.receiptId === leaf.receiptId);
    expect(second?.attempt).toBe(2);
    expect(second?.ownerId).not.toBe(first!.ownerId);

    // Attempts exhausted: never placed again, and retired once its window passes.
    await age(leaf.receiptId);
    expect((await claimAgentOperationPlacements(sql, options))
      .filter((p) => p.receiptId === leaf.receiptId)).toHaveLength(0);
    expect((await receipt(leaf.receiptId)).agent_placement_retired_at).not.toBeNull();
  }, 90_000);

  it('skips a claimed target, and retires a terminal one', async () => {
    const ws = await workspace('placement-target-state');
    const held = await accept(ws, 'leaf', 'held');
    const finished = await accept(ws, 'leaf', 'finished');
    await sql`UPDATE harness_shared.work_items SET taken_by = 'some-worker'
               WHERE workspace_id = ${ws} AND feature_id = ${held.workItemId}`;
    await sql`UPDATE harness_shared.work_items SET status = 'dropped'
               WHERE workspace_id = ${ws} AND feature_id = ${finished.workItemId}`;
    const claimed = await claimAgentOperationPlacements(sql);
    expect(claimed.filter((p) => p.workspaceId === ws)).toHaveLength(0);
    expect((await receipt(held.receiptId)).agent_placement_retired_at).toBeNull();
    expect((await receipt(finished.receiptId)).agent_placement_retired_at).not.toBeNull();
  }, 90_000);

  it('bounds live workers per workspace, counting ones still inside their boot window', async () => {
    const ws = await workspace('placement-cap');
    const a = await accept(ws, 'leaf', 'cap-a');
    const b = await accept(ws, 'leaf', 'cap-b');
    const options = { perWorkspaceLive: 1 };
    const first = (await claimAgentOperationPlacements(sql, options)).filter((p) => p.workspaceId === ws);
    expect(first.map((p) => p.receiptId)).toEqual([a.receiptId]);
    // a is still booting (inside its window), so b waits.
    expect((await claimAgentOperationPlacements(sql, options))
      .filter((p) => p.workspaceId === ws)).toHaveLength(0);
    // a's item was claimed by its worker and a's window passed: b is next.
    await sql`UPDATE harness_shared.work_items SET taken_by = ${first[0]!.ownerId}
               WHERE workspace_id = ${ws} AND feature_id = ${a.workItemId}`;
    await age(a.receiptId);
    expect((await claimAgentOperationPlacements(sql, options))
      .filter((p) => p.workspaceId === ws).map((p) => p.receiptId)).toEqual([b.receiptId]);
  }, 90_000);

  it('reports a failed launch and keeps the consumed attempt', async () => {
    const ws = await workspace('placement-failure');
    const leaf = await accept(ws, 'leaf', 'failure');
    const pass = await placeAcceptedAgentOperations(sql, {
      launch: async (p) => {
        if (p.receiptId === leaf.receiptId) throw new Error('spawn refused');
        return { ok: true };
      },
    });
    expect(pass.failed).toContainEqual({
      receiptId: leaf.receiptId, workItemId: leaf.workItemId, detail: 'spawn refused',
    });
    expect((await receipt(leaf.receiptId)).agent_launch_attempts).toBe(1);
  }, 90_000);
});
