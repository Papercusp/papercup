import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { runInNewContext } from 'node:vm';
import type { Sql } from 'postgres';
import type { ZodTypeAny } from 'zod';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { seedSupportWorkflowNativeFixture, supportWorkflowNativeLoginScript,
  type SupportWorkflowNativeFixture } from '../../../../apps/operator/e2e/_support-workflow-native-fixture';
import { registerRoute, type RouteDefinition } from '../endpoint-route/define-route';
import authLogin from '../endpoint-route/routes/auth/login';
import authMe from '../endpoint-route/routes/auth/me';
import { principalFromCookie } from '../auth/principal/from-cookie';
import { submitBlueprintOperation } from './operation-service';
import { readHostedAllocationReport } from '../auth/hosted/billing/allocation-store';
import { replacePermissionListMembers } from '../data-sources/documents-corpus';

const connection = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: connection.sql }),
}));

let db: OrgTestDb;
let fixture: SupportWorkflowNativeFixture;
const workspaceId = 'verify-tauri-isolated-support-pg';
beforeAll(async () => {
  db = await createOrgTestDb(); connection.sql = db.adminSql;
  fixture = await seedSupportWorkflowNativeFixture(db.adminSql, { workspaceId });
}, 120_000);
afterAll(async () => db?.cleanup(), 120_000);

describe('maintained native support seed and production cookie switching', () => {
  it('refuses a shared workspace and a forged isolated label before any mutation', async () => {
    const forbidden = vi.fn();
    await expect(seedSupportWorkflowNativeFixture(forbidden as unknown as Sql,
      { workspaceId: 'papercusp-workspace' })).rejects.toThrow(/isolated workspace/);
    expect(forbidden).not.toHaveBeenCalled();
    forbidden.mockResolvedValue([{ name: 'papercusp', directory: '/live/pgdata' }]);
    await expect(seedSupportWorkflowNativeFixture(forbidden as unknown as Sql, { workspaceId }))
      .rejects.toThrow(/isolated PostgreSQL/);
    expect(forbidden).toHaveBeenCalledTimes(1);
  });

  it('switches three real password-authenticated cookie principals and admits only accessible source input', async () => {
    const app = new Hono();
    type Route = RouteDefinition<ZodTypeAny | undefined>;
    for (const route of [authLogin, ...authMe] as Route[]) registerRoute(app, route);
    let cookie = '';
    const evaluate = (actor: keyof typeof fixture.actors) => runInNewContext(
      supportWorkflowNativeLoginScript(fixture, actor), { fetch: async (path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        if (cookie) headers.set('cookie', cookie);
        const response = await app.request(`http://localhost${path.replace(/^\/api/, '')}`, { ...init, headers });
        if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0]!;
        return response;
      } });
    const principals = [];
    for (const actor of ['employee', 'reviewer', 'admin'] as const) {
      expect(await evaluate(actor)).toMatchObject({ actor, userId: fixture.actors[actor].id, workspaceId });
      const principal = await principalFromCookie(new Headers({ cookie }));
      expect(principal).toMatchObject({ kind: 'user', trust: 'verified', authMethod: 'cookie-session',
        slug: fixture.actors[actor].id, workspaceId });
      principals.push(principal!.slug);
    }
    expect(new Set(principals).size).toBe(3);
    const report = await readHostedAllocationReport(db.adminSql, fixture.funding);
    expect(report.byCostClass.model.allocations.find(a => a.allocationId === fixture.funding.allocationId))
      .toMatchObject({ level: 'project', capMicros: 1_000_000 });
    await evaluate('employee');
    const principal = await principalFromCookie(new Headers({ cookie }));
    const submit = (requestKey: string) => submitBlueprintOperation(db.adminSql, { workspaceId,
      harnessSlug: fixture.harnessSlug, operationId: fixture.operationId, callerId: `${principal!.slug}/employee`,
      requestKey, expectedSpecificationRevision: fixture.approvedRevision, input: fixture.input }, { principal });
    const handle = await submit('native-fixture-employee');
    expect(handle).toMatchObject({ workspaceId, specificationRevision: fixture.approvedRevision });
    expect(await submit('native-fixture-employee')).toEqual(handle);
    await replacePermissionListMembers(db.adminSql, workspaceId, fixture.listId, [fixture.identities.reviewer]);
    await expect(submit('native-fixture-revoked')).rejects.toThrow(/unavailable|revoked/);
    const [count] = await db.adminSql<{ n: number }[]>`SELECT count(*)::int AS n
      FROM harness_shared.blueprint_operation_invocations WHERE workspace_id=${workspaceId}
      AND request_key='native-fixture-revoked'`;
    expect(count?.n).toBe(0);
  }, 30_000);
});
