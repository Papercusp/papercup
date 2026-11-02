import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
const m = vi.hoisted(() => ({ sql: null as any, launch: vi.fn(), loops: vi.fn() }));
vi.mock('@papercusp/db-org', async orig => ({ ...(await orig<object>()), getOrgPg: () => ({ sql: m.sql }) }));
vi.mock('../../events/await/psu-pty-discovery', () => ({ findLiveHostAsync: async () => null }));
vi.mock('../../events/await/store', () => ({ hasPendingDeliberateWakeDelivery: async () => false }));
vi.mock('../../attention/gate-store', () => ({ listPendingGates: async () => [] }));
vi.mock('../../session-assume-pause', () => ({ readAssumeCallerPause: async () => null }));
vi.mock('./loop', () => ({ getLoopStatuses: m.loops }));
vi.mock('./psu-pty-host-events-ingest', () => ({ ingestPsuPtyHostEvents: async () => ({ ingestErrors: 0 }) }));
vi.mock('../../agent-tools/capability/launch-agent', () => ({ default: { handler: m.launch },
  INTERNAL_INTERRUPTION_RECOVERY: Symbol.for('integration-interruption') }));
import { sweepSessionInterruptions } from './session-interruption-runtime';
let db: OrgTestDb;
const ws = 'interruption-integration';
const owner = 'su-interruption-integration';
const native = '30c49db4-e1e3-4ac7-9bec-960c500b46ea';
const ctx = { workspaceId: ws, installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: null };
beforeAll(async () => { db = await createOrgTestDb(); m.sql = db.adminSql; });
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  vi.clearAllMocks(); m.loops.mockResolvedValue(new Map());
  m.launch.mockResolvedValue({ data: { launch: { resumeVerified: true } } });
  const sql = db.adminSql;
  await sql`DELETE FROM harness_shared.event_awaits WHERE subscriber_id = ${owner}`;
  await sql`DELETE FROM harness_shared.session_briefs WHERE owner_id = ${owner}`;
  await sql`DELETE FROM harness_shared.psu_pty_host_events WHERE owner_id = ${owner}`;
  await sql`DELETE FROM harness_shared.adv_sessions WHERE coord_owner_id = ${owner}`;
  const [a] = await sql`INSERT INTO harness_shared.adv_sessions
    (workspace_id, agent, mode, coord_owner_id, session_id, started_at, ended_at, launch_spec)
    VALUES (${ws}, 'codex', 'console', ${owner}, ${native}, now() - interval '1 minute', now(),
      '{"headless":true}'::jsonb) RETURNING id`;
  const now = Date.now();
  const payload = { workspaceId: ws, ownerId: owner, nativeSessionId: native, advSessionId: String(a.id),
    hostPid: 99999999, hostStartedAt: now - 10000,
    execution: { ownerId: owner, hostPid: 99999999, observedAt: now - 1, phase: 'running',
      turnStartedAt: now - 5000, lastProgressAt: now - 1, pendingTools: 0 } };
  await sql`INSERT INTO harness_shared.psu_pty_host_events
    (workspace_id, owner_id, ts, kind, payload, row_digest)
    VALUES (${ws}, ${owner}, now(), 'session-execution-observed', ${JSON.stringify(payload)}::jsonb, ${String(now)})`;
});
async function receipt() {
  const [r] = await db.adminSql`SELECT control_state #> '{lifecycle,interruption}' AS marker
    FROM harness_shared.session_briefs WHERE owner_id = ${owner}`;
  return r?.marker;
}
describe('production interruption SQL against migrated PostgreSQL', () => {
  it('arbitrates concurrent and repeated recoveries through one durable lifecycle receipt', async () => {
    await Promise.all([sweepSessionInterruptions(ctx), sweepSessionInterruptions(ctx)]);
    await sweepSessionInterruptions(ctx);
    expect(m.launch).toHaveBeenCalledTimes(1);
    expect(await receipt()).toMatchObject({ attempts: 1, state: 'restored', leaseKey: null });
  });
  it('persists a bounded failure budget across separate sweeps', async () => {
    m.launch.mockResolvedValue({ isError: true });
    for (let i = 0; i < 4; i++) {
      await sweepSessionInterruptions(ctx);
      await db.adminSql`UPDATE harness_shared.session_briefs SET control_state =
        jsonb_set(control_state, '{lifecycle,interruption,nextAttemptAt}', '0'::jsonb) WHERE owner_id = ${owner}`;
    }
    expect(m.launch).toHaveBeenCalledTimes(3);
    expect(await receipt()).toMatchObject({ attempts: 3, state: 'blocked' });
  });
  it('reads only policy=wake awaits and restores them without a work prompt', async () => {
    await db.adminSql`INSERT INTO harness_shared.event_awaits
      (workspace_id, subscriber_id, event_key, policy)
      VALUES (${ws}, ${owner}, 'dependency:ready', 'wake')`;
    await sweepSessionInterruptions(ctx);
    expect(m.launch).toHaveBeenCalledTimes(1);
    expect(m.launch.mock.calls[0][0]).not.toHaveProperty('brief');
  });
  it('does not resume a retired incarnation', async () => {
    await db.adminSql`UPDATE harness_shared.adv_sessions SET retired_at = now() WHERE coord_owner_id = ${owner}`;
    await sweepSessionInterruptions(ctx);
    expect(m.launch).not.toHaveBeenCalled(); expect(await receipt()).toBeUndefined();
  });
});
