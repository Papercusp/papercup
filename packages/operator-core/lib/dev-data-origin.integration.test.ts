/**
 * Regression coverage for WI-38246: behavior-facing dev-data readers must
 * exclude hook/UI/system telemetry while retaining explicit agent/unknown
 * rows and legacy NULL-origin rows that are not legacy automatic tool names.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }) }));

const { listSessions, resolveOwnerSessions, toolCooccurrence } = await import('./dev-data');
const { createOrgTestDb } = await import('../test/_org-test-db');

const SESSION_WS = 'ws-dev-data-origin-sessions';
const COOCCURRENCE_WS = 'ws-dev-data-origin-cooccurrence';
const T0 = Date.now() - 60 * 60 * 1000;

let nextId = 1;

async function seed(
  db: OrgTestDb,
  workspaceId: string,
  ownerId: string,
  toolName: string,
  spawnId: string,
  offsetSec: number,
  opts: { callOrigin?: string | null; transport?: string } = {},
) {
  const invokedAt = new Date(T0 + offsetSec * 1000).toISOString();
  const callOrigin = opts.callOrigin ?? null;
  const callOriginSource = callOrigin == null ? null : 'declared';
  await db.adminSql`
    INSERT INTO harness_shared.tool_invocations
      (id, workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id,
       coord_owner_id, invoked_at, window_key, status, transport,
       call_origin, call_origin_source)
    VALUES
      (${nextId++}, ${workspaceId}, 'h1', 'core', ${toolName}, 'worker', ${spawnId},
       ${ownerId}, ${invokedAt}::timestamptz, 'w', 'ok', ${opts.transport ?? 'mcp'},
       ${callOrigin}, ${callOriginSource})`;
}

describe('dev-data behavior readers (WI-38246)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;

    // Session/owner readers: only agent + unknown + legacy non-automatic NULL
    // rows should survive. Hook, UI, system, and legacy automatic names must
    // not inflate behavior counts.
    await seed(db, SESSION_WS, 'owner-1', 'agent-tool', 'sp-agent', 0, { callOrigin: 'agent' });
    await seed(db, SESSION_WS, 'owner-1', 'coord:inbox', 'sp-hook', 1, { callOrigin: 'hook' });
    await seed(db, SESSION_WS, 'owner-1', 'unknown-tool', 'sp-unknown', 2, { callOrigin: 'unknown' });
    await seed(db, SESSION_WS, 'owner-1', 'ui-tool', 'sp-ui', 3, { callOrigin: 'ui' });
    await seed(db, SESSION_WS, 'owner-1', 'system-tool', 'sp-system', 4, { callOrigin: 'system' });
    await seed(db, SESSION_WS, 'owner-1', 'coord:glance', 'sp-null-hook', 5);
    await seed(db, SESSION_WS, 'owner-1', 'legacy-agent-tool', 'sp-null-agent', 6);

    // Co-occurrence must ignore the hook in the middle of an agent burst;
    // otherwise it would manufacture A/H and B/H pairs.
    await seed(db, COOCCURRENCE_WS, 'cooccur-owner', 'A', 'sp-a', 0, { callOrigin: 'agent' });
    await seed(db, COOCCURRENCE_WS, 'cooccur-owner', 'hook-tool', 'sp-h', 10, { callOrigin: 'hook' });
    await seed(db, COOCCURRENCE_WS, 'cooccur-owner', 'B', 'sp-b', 20, { callOrigin: 'unknown' });
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('filters sessions and owner activity to agent behavior rows', async () => {
    const sessions = await listSessions({ workspaceIds: [SESSION_WS], hours: 24 });
    expect(sessions.entries.map((entry) => entry.spawn_id).sort()).toEqual([
      'sp-agent',
      'sp-null-agent',
      'sp-unknown',
    ]);
    expect(sessions.entries.every((entry) => entry.tool_count === 1)).toBe(true);

    const owner = await resolveOwnerSessions('owner-1');
    expect(owner.activity.map((entry) => entry.spawn_id).sort()).toEqual([
      'sp-agent',
      'sp-null-agent',
      'sp-unknown',
    ]);
    expect(owner.activity.every((entry) => entry.tool_count === 1)).toBe(true);
  });

  it('filters hook rows out of agent co-occurrence bursts', async () => {
    const result = await toolCooccurrence({
      workspaceIds: [COOCCURRENCE_WS],
      minSupport: 1,
      hours: 24,
    });

    expect(result.totalTurns).toBe(1);
    expect(result.entries.map((entry) => `${entry.tool_a},${entry.tool_b}`)).toEqual(['A,B']);
  });
});
