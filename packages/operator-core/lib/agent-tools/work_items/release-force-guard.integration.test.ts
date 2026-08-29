/**
 * WI-592719 — the force-release guard's tool-activity liveness input must use
 * agent-authored calls, not hook/UI/system telemetry that can continue after an
 * agent has stopped taking turns.
 *
 * This runs the production SQL fragment against real Postgres. A mocked
 * timestamp dependency can prove the warm-idle policy, but it cannot catch the
 * query accidentally taking MAX(invoked_at) over every call origin.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { readLastAgentToolInvocationAt } from './release-force-guard';

const WORKSPACE = 'release-force-guard-origin-ws';
const OWNER_PREFIX = 'release-force-origin-';
const HOLDER = `${OWNER_PREFIX}holder`;

let org: OrgTestDb;
let sql: Sql;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});

afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.tool_invocations
             WHERE coord_owner_id LIKE ${OWNER_PREFIX + '%'}`;
});

async function seedCall(input: {
  ownerId?: string;
  toolName: string;
  callOrigin: string | null;
  invokedAt: string;
}): Promise<void> {
  await sql`
    INSERT INTO harness_shared.tool_invocations
      (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id,
       window_key, status, coord_owner_id, call_origin, invoked_at)
    VALUES
      (${WORKSPACE}, 'papercusp', 'papercusp-su', ${input.toolName}, 'su',
       'spawn-release-force-origin', 'test', 'ok', ${input.ownerId ?? HOLDER},
       ${input.callOrigin}, ${input.invokedAt}::timestamptz)
  `;
}

describe('readLastAgentToolInvocationAt', () => {
  it('returns the older agent call when newer hook/UI/system traffic exists', async () => {
    const agentAt = '2026-08-29T01:00:00.000Z';
    await seedCall({ toolName: 'work_items:get', callOrigin: 'agent', invokedAt: agentAt });
    await seedCall({ toolName: 'activity:report', callOrigin: 'hook', invokedAt: '2026-08-29T05:58:00.000Z' });
    await seedCall({ toolName: 'ui:state', callOrigin: 'ui', invokedAt: '2026-08-29T05:59:00.000Z' });
    await seedCall({ toolName: 'system:heartbeat', callOrigin: 'system', invokedAt: '2026-08-29T06:00:00.000Z' });
    await seedCall({
      ownerId: `${OWNER_PREFIX}other`,
      toolName: 'work_items:get',
      callOrigin: 'agent',
      invokedAt: '2026-08-29T06:01:00.000Z',
    });

    const result = await readLastAgentToolInvocationAt(sql, HOLDER);

    expect(result).not.toBeNull();
    expect(new Date(result as string | Date).toISOString()).toBe(agentAt);
  });

  it('returns null when the holder has only automatic traffic', async () => {
    await seedCall({ toolName: 'activity:report', callOrigin: 'hook', invokedAt: '2026-08-29T05:58:00.000Z' });
    await seedCall({ toolName: 'ui:state', callOrigin: 'ui', invokedAt: '2026-08-29T05:59:00.000Z' });
    await seedCall({ toolName: 'system:heartbeat', callOrigin: 'system', invokedAt: '2026-08-29T06:00:00.000Z' });

    await expect(readLastAgentToolInvocationAt(sql, HOLDER)).resolves.toBeNull();
  });
});
