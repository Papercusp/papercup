/**
 * role-principal-caps.integration.test.ts
 *
 * Covers the least-privilege capability loader behind the fix for built-in
 * tools failing `requires authenticated request (bearer + workspace tx)` when
 * called by a signed role-scoped (non-superuser) MCP agent (found in
 * harness_shared.tool_invocations, 2026-05-31).
 *
 * Contract: a role-scoped caller is granted exactly the capabilities its
 * provisioned system principal holds — operator/oracle have rows; pipeline
 * roles do not and get an empty set (capability-gated built-ins stay denied);
 * and the lookup is workspace-isolated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config';
import {
  loadRoleCapabilities,
  dispatchNeedsTx,
  synthesizeDispatchPrincipal,
} from '@papercusp/operator-core/lib/endpoint-route/routes/transport/role-principal-caps';

let sql: postgres.Sql;
let dbName: string;

beforeAll(async () => {
  const adminUri = await getTestPg();
  dbName = `rpc_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 1, onnotice: () => {} });

  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
  await sql.unsafe(`
    CREATE TABLE harness_shared.system_principals (
      workspace_id TEXT NOT NULL,
      name         TEXT NOT NULL,
      capabilities JSONB NOT NULL,
      bearer_hash  TEXT,
      PRIMARY KEY (workspace_id, name)
    )`);
  const ins = async (ws: string, name: string, caps: string[]) => {
    await sql`INSERT INTO harness_shared.system_principals (workspace_id, name, capabilities)
              VALUES (${ws}, ${name}, ${sql.json(caps)})`;
  };
  await ins('default', 'operator', ['harness:read', 'audit:read', 'chat:write']);
  await ins('default', 'oracle', ['harness:read', 'docs:read']);
  await ins('other', 'operator', ['harness:read']);
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describe('loadRoleCapabilities (least-privilege)', () => {
  it('returns the provisioned caps for a system-principal role (operator)', async () => {
    const caps = await loadRoleCapabilities(sql, 'default', 'operator');
    expect(caps.has('audit:read')).toBe(true);
    expect(caps.has('harness:read')).toBe(true);
    expect(caps.has('chat:write')).toBe(true);
    expect(caps.size).toBe(3);
  });

  it('returns an EMPTY set for a pipeline role with no system principal (worker)', async () => {
    const caps = await loadRoleCapabilities(sql, 'default', 'worker');
    expect(caps.size).toBe(0); // capability-gated built-ins correctly stay denied
  });

  it('is workspace-isolated — does not leak another workspace’s caps', async () => {
    const caps = await loadRoleCapabilities(sql, 'default', 'operator');
    // 'other' workspace's operator has only harness:read; 'default' has 3.
    expect(caps.size).toBe(3);
    const otherCaps = await loadRoleCapabilities(sql, 'other', 'operator');
    expect([...otherCaps]).toEqual(['harness:read']);
  });
});

// The #1 handler-path decision+synthesis (the wiring in _mcp-handler.ts that
// the cap-loader alone didn't cover). These are the exact functions the tools/
// call handler now calls.
describe('dispatchNeedsTx', () => {
  it('a concrete workspace needs a principal + tx', () => {
    expect(dispatchNeedsTx({ workspaceId: 'default' })).toBe(true);
  });
  it("'*' (superuser, no workspace chosen) does NOT — caller must pass ?workspace", () => {
    expect(dispatchNeedsTx({ workspaceId: '*' })).toBe(false);
  });
  it('an empty workspace does NOT', () => {
    expect(dispatchNeedsTx({ workspaceId: '' })).toBe(false);
  });
});

describe('synthesizeDispatchPrincipal', () => {
  it('role-scoped (non-superuser) gets its provisioned caps + system:<role> slug', async () => {
    const p = await synthesizeDispatchPrincipal(sql, { workspaceId: 'default', role: 'operator', isSuperuser: false });
    expect(p.slug).toBe('system:operator');
    expect(p.workspaceId).toBe('default');
    expect([...p.capabilities].sort()).toEqual(['audit:read', 'chat:write', 'harness:read']);
  });

  it('a pipeline role (no system principal) gets an EMPTY cap-set — capability-gated built-ins stay denied', async () => {
    const p = await synthesizeDispatchPrincipal(sql, { workspaceId: 'default', role: 'worker', isSuperuser: false });
    expect(p.slug).toBe('system:worker');
    expect(p.capabilities.size).toBe(0);
  });

  it('superuser keeps an empty cap-set (it relies on gateBypass.capability, not loaded caps)', async () => {
    const p = await synthesizeDispatchPrincipal(sql, { workspaceId: 'default', role: 'operator', isSuperuser: true });
    expect(p.slug).toBe('system:operator');
    expect(p.capabilities.size).toBe(0); // not 3 — superuser does NOT load role caps
  });
});
