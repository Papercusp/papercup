/**
 * glance-bee-working.integration.test.ts — WI-36765 recurrence guard, real Postgres.
 *
 * coord:glance's `bees.working` count used to trust ONLY
 * `spawned_agents.last_output_at` (captured child STDOUT freshness). A
 * headless cup makes MCP tool calls — which never touch that column — so a
 * cup that is actively working but has emitted no stdout read as "not
 * working" forever (measured live: a cup executed 13 tool calls while
 * bees.working reported 0). The fix widens the `working` predicate with an
 * `OR EXISTS` against a fresh `harness_shared.tool_invocations` row for the
 * same spawn.
 *
 * glance.ts's unit test (glance.test.ts) mocks `getOrgPg().sql` entirely, so
 * it cannot exercise this query's actual WHERE-clause semantics — only a
 * real-Postgres test can prove the OR-EXISTS branch actually widens the
 * count. This drives the extracted `getBeeCounts` helper directly against
 * the baseline-schema container, which is the smallest surface that still
 * exercises the real SQL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../../_baseline-coord-fixture';
import { getBeeCounts } from './glance';

let fx: BaselineCoordFixture;
let admin: postgres.Sql;

const WS = 'ws-glance-bee-working-it';
const HARNESS = 'papercusp';

/** Seed a running/heartbeat-fresh nursery row with an explicit last_output_at age. */
async function seedBee(spawnId: string, lastOutputAgeSeconds: number | null): Promise<void> {
  await admin`
    INSERT INTO harness_shared.spawned_agents (
      spawn_id, workspace_id, harness_slug, parent_role, child_role, run_id,
      status, started_at, heartbeat_at, coordination_domain, restart_strategy,
      cancel_requested, last_output_at
    ) VALUES (
      ${spawnId}, ${WS}, ${HARNESS}, 'queen', 'bee', ${`run-${spawnId}`},
      'running', now(), now(), 'default', 'one_for_one',
      false,
      ${lastOutputAgeSeconds === null ? null : admin`now() - ${`${lastOutputAgeSeconds} seconds`}::interval`}
    )
  `;
}

/** Seed a tool_invocations row for the given spawn with an explicit age. */
async function seedToolInvocation(spawnId: string, ageSeconds: number): Promise<void> {
  await admin`
    INSERT INTO harness_shared.tool_invocations (
      workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id,
      window_key, invoked_at, status
    ) VALUES (
      ${WS}, ${HARNESS}, 'papercusp-su', 'work_items:get', 'su', ${spawnId},
      'w', now() - ${`${ageSeconds} seconds`}::interval, 'ok'
    )
  `;
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  admin = fx.admin;
});
afterAll(async () => {
  await admin`DELETE FROM harness_shared.tool_invocations WHERE workspace_id = ${WS}`.catch(() => {});
  await admin`DELETE FROM harness_shared.spawned_agents WHERE workspace_id = ${WS}`.catch(() => {});
  await fx.dispose();
});
beforeEach(async () => {
  await admin`DELETE FROM harness_shared.tool_invocations WHERE workspace_id = ${WS}`;
  await admin`DELETE FROM harness_shared.spawned_agents WHERE workspace_id = ${WS}`;
});

describe('getBeeCounts (real PG) — WI-36765', () => {
  it('counts a bee with fresh last_output_at as working (unchanged baseline behavior)', async () => {
    await seedBee('s-fresh-stdout', 5);
    const { n, working } = await getBeeCounts(admin);
    expect(n).toBe(1);
    expect(working).toBe(1);
  });

  it('STALE last_output_at + a FRESH tool_invocations row for the same spawn still counts as working', async () => {
    // The exact shape of the bug: a headless cup with stale/null stdout
    // freshness but a recent real MCP tool call.
    await seedBee('s-stale-stdout-active-cup', 20 * 60); // 20 min — outside the 15-min freshness window
    await seedToolInvocation('s-stale-stdout-active-cup', 5); // 5s ago — well inside it

    const { n, working } = await getBeeCounts(admin);
    expect(n).toBe(1);
    expect(working).toBe(1); // pre-fix this was 0 — the exact false zero WI-36765 measured
  });

  it('STALE last_output_at + a STALE tool_invocations row does NOT count as working', async () => {
    await seedBee('s-stale-both', 20 * 60);
    await seedToolInvocation('s-stale-both', 20 * 60);

    const { n, working } = await getBeeCounts(admin);
    expect(n).toBe(1);
    expect(working).toBe(0);
  });

  it('STALE last_output_at + NO tool_invocations row at all does NOT count as working', async () => {
    await seedBee('s-idle', 20 * 60);

    const { n, working } = await getBeeCounts(admin);
    expect(n).toBe(1);
    expect(working).toBe(0);
  });

  it("a fresh tool_invocations row under ANOTHER workspace's spawn_id does not leak in (workspace_id is part of the correlation)", async () => {
    await seedBee('s-cross-ws', 20 * 60);
    // Same spawn_id text, different workspace — must NOT correlate.
    await admin`
      INSERT INTO harness_shared.tool_invocations (
        workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id,
        window_key, invoked_at, status
      ) VALUES (
        'a-different-workspace', ${HARNESS}, 'papercusp-su', 'work_items:get', 'su',
        's-cross-ws', 'w', now(), 'ok'
      )
    `;

    const { n, working } = await getBeeCounts(admin);
    expect(n).toBe(1);
    expect(working).toBe(0);

    await admin`DELETE FROM harness_shared.tool_invocations WHERE workspace_id = 'a-different-workspace'`;
  });
});
