import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { OrgTestDb } from '../../test/_org-test-db';
const h = vi.hoisted(() => ({ appSql: null as any }));
vi.mock('@papercusp/db-org', async original => ({ ...(await original<typeof import('@papercusp/db-org')>()),
  withWorkspace: (ws: string, cb: (tx: any) => unknown) => h.appSql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    return cb(tx);
  }),
}));
import { auditDeviceAction, deviceActionKey, deviceActionRefusal, runDeviceAction } from './device-actions';
import { createOrgTestDb } from '../../test/_org-test-db';
describe('device action receipts (real PG and RLS)', () => {
  let db: OrgTestDb;
  beforeAll(async () => { db = await createOrgTestDb(); h.appSql = db.appSql; }, Number(process.env.VITEST_INTEGRATION_HOOK_TIMEOUT_MS) || 120_000);
  afterAll(async () => { await db?.cleanup(); });
  const context = () => ({ principal: { kind: 'device' as const, slug: `phone-${randomUUID()}`, workspaceId: `ws-${randomUUID()}` }, owner: 'su-target', action: 'send' as const });
  it('serializes concurrent network retries and stores one action audit row without message text', async () => {
    const c = context(); const run = vi.fn(async () => ({ status: 200, body: { ok: true, delivery: { kind: 'queued' } } }));
    const replies = await Promise.all(Array.from({ length: 4 }, () => runDeviceAction(c, 'same-key', { text: 'credential marker never stored' }, run)));
    expect(run).toHaveBeenCalledTimes(1);
    expect(replies.every(reply => reply.status === 200)).toBe(true);
    const rows = await db.adminSql`SELECT * FROM harness_shared.audit_log WHERE workspace_id = ${c.principal.workspaceId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: c.principal.slug, subject: c.owner, action: 'device.session.send' });
    expect(JSON.stringify(rows)).not.toContain('credential marker never stored');
  });
  it('refuses a changed body or target and audits each refusal without repeating the action', async () => {
    const c = context(); const run = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    await runDeviceAction(c, 'key', { text: 'first' }, run);
    expect((await runDeviceAction(c, 'key', { text: 'changed' }, run)).status).toBe(409);
    expect((await runDeviceAction({ ...c, owner: 'su-other' }, 'key', { text: 'first' }, run)).status).toBe(409);
    expect(run).toHaveBeenCalledTimes(1);
    const rows = await db.adminSql`SELECT details FROM harness_shared.audit_log WHERE workspace_id = ${c.principal.workspaceId}`;
    expect(rows).toHaveLength(3);
    expect(rows.filter(row => row.details.reason === 'idempotency_conflict')).toHaveLength(2);
  });
  it('scopes the same key separately for two phones and two workspaces', async () => {
    const a = context(); const b = { ...a, principal: { ...a.principal, slug: 'phone-b' } };
    const foreign = { ...a, principal: { ...a.principal, workspaceId: `ws-${randomUUID()}` } };
    const run = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    await Promise.all([a, b, foreign].map(c => runDeviceAction(c, 'shared-key', {}, run)));
    expect(run).toHaveBeenCalledTimes(3);
    expect(deviceActionKey(a, 'shared-key')).not.toBe(deviceActionKey(foreign, 'shared-key'));
  });
  it('writes an authenticated refusal once with device, target and reason', async () => {
    const c = context();
    await auditDeviceAction(c, deviceActionRefusal('agent_sessions_not_granted'));
    const rows = await db.adminSql`SELECT details FROM harness_shared.audit_log WHERE workspace_id = ${c.principal.workspaceId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toMatchObject({ deviceId: c.principal.slug, owner: c.owner, reason: 'agent_sessions_not_granted', status: 403 });
  });
});
