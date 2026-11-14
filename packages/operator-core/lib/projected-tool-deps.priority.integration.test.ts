import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { _resetForTests, getOrgPg } from '@papercusp/db-org';
import type { KernelEnforcementRequest } from '@papercusp/agent-mcp';
import {
  PROJECTED_DEPS, controlAnchorKernelResolver, setKernelEnforcementResolver,
} from './projected-tool-deps';

const WORKSPACE = 'private-desktop-authority-queue';
const OWNER = 'su-private-desktop-authority-queue';
const keys = ['HARNESS_ADMIN_DATABASE_URL', 'HARNESS_DATABASE_URL', 'PAPERCUSP_DB_POOL_MAX', 'PAPERCUSP_PGBOUNCER'] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
let db: MigratedTestDb;

const request: KernelEnforcementRequest = {
  phase: 'preflight', boundary: 'dispatch', toolName: 'coord:whoami', capabilities: [], args: {},
  ctx: { workspaceId: WORKSPACE, uiClientId: OWNER, isSuperuser: true } as KernelEnforcementRequest['ctx'],
};

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'desktopauthority' });
  process.env.HARNESS_ADMIN_DATABASE_URL = db.url;
  process.env.HARNESS_DATABASE_URL = db.url;
  process.env.PAPERCUSP_DB_POOL_MAX = '1';
  process.env.PAPERCUSP_PGBOUNCER = '0';
  await _resetForTests();
  await getOrgPg().sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS harness_shared;
    CREATE TABLE harness_shared.session_briefs (
      owner_id text, workspace_id text, control_state jsonb, control_generation bigint
    );
    CREATE TABLE harness_shared.adv_sessions (
      id bigint PRIMARY KEY, coord_owner_id text, workspace_id text,
      launch_spec jsonb, started_at timestamptz, ended_at timestamptz, ended_by text
    );
    CREATE TABLE harness_shared.operator_session_confinements (
      workspace_id text PRIMARY KEY, payload jsonb
    );
  `);
  setKernelEnforcementResolver(controlAnchorKernelResolver);
}, 120_000);

afterAll(async () => {
  setKernelEnforcementResolver(null);
  await _resetForTests();
  await db?.drop();
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('desktop authority reads under ordinary pool saturation', () => {
  it('keeps kernel and confinement checks fresh while ordinary work stays queued', async () => {
    const ordinary = getOrgPg().sql;
    const held = await Promise.all(Array.from({ length: ordinary.options.max }, () => ordinary.reserve()));
    let ordinaryAcquired = false;
    const waiting = ordinary.reserve().then(connection => {
      ordinaryAcquired = true;
      connection.release();
    });
    const pending: Promise<unknown>[] = [waiting];
    const whileSaturated = async <T>(check: T | Promise<T>): Promise<T> => {
      const task = Promise.resolve(check);
      pending.push(task);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([task, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Authority check waited behind ordinary work')), 2_000);
        })]);
      } finally {
        clearTimeout(timer);
      }
    };
    void waiting.catch(() => {});
    try {
      for (const phase of ['preflight', 'enforce'] as const) {
        await expect(whileSaturated(PROJECTED_DEPS.kernelEnforcement!({ ...request, phase })))
          .resolves.toMatchObject({ decision: 'allow' });
      }
      await expect(whileSaturated(PROJECTED_DEPS.kernelPolicy!(request)))
        .resolves.toMatchObject({ decision: 'allow' });
      await expect(whileSaturated(PROJECTED_DEPS.checkCapabilityEnvelope!({
        toolName: request.toolName, capabilities: [], ctx: request.ctx, args: {},
      }))).resolves.toBeNull();
      expect(ordinaryAcquired).toBe(false);
      expect(getOrgPg().poolLabel).toBe('org-admin');

      // Mutate the real policy through an already-held connection. A warm
      // successful read must never conceal the next revocation or denial.
      await held[0]`
        INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, control_state, control_generation)
        VALUES (${OWNER}, ${WORKSPACE}, ${ordinary.json({ lifecycle: { released: null } })}, 1)
      `;
      const now = Date.now();
      await held[0]`
        INSERT INTO harness_shared.operator_session_confinements (workspace_id, payload)
        VALUES (${WORKSPACE}, ${ordinary.json({ sessions: { [OWNER]: {
          confinement: { denyTools: ['coord:whoami'], reason: 'private freshness regression', imposedBy: 'test' },
          declaredAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
        } } })})
      `;
      await expect(whileSaturated(PROJECTED_DEPS.kernelEnforcement!({ ...request, phase: 'enforce' })))
        .resolves.toMatchObject({ decision: 'deny', code: 'revoked' });
      await expect(whileSaturated(PROJECTED_DEPS.checkCapabilityEnvelope!({
        toolName: request.toolName, capabilities: [], ctx: request.ctx, args: {},
      }))).resolves.toMatchObject({ decision: 'deny' });
      expect(ordinaryAcquired).toBe(false);
      expect(getOrgPg().poolLabel).toBe('org-admin');
    } finally {
      for (const connection of held) connection.release();
      await Promise.allSettled(pending);
    }
    expect(ordinaryAcquired).toBe(true);
  }, 15_000);
});
