import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import type { RouteContext } from '@papercusp/agent-mcp';
import { deriveTenantContext, type VerifiedTenantServerContext } from '@papercusp/db-org';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createHostedPrincipal, type HostedPrincipal } from '../auth/hosted-principal';
import { HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH, createHostedTutorialProgressRoutes } from '../endpoint-route/routes/hosted-tutorial-progress';
import { tenantContext } from '../endpoint-route/hosted-browser-context';
import { createTutorialState, confirmedTutorialSteps } from './cloud-tutorial-lesson';
import { readTutorialProgress, updateTutorialProgress, TutorialProgressConflict, type TutorialProgressUpdate } from './cloud-tutorial-progress';

const ORIGIN = 'https://app.papercusp.com';
const tenantA = randomUUID(), tenantB = randomUUID(), userA = randomUUID(), userB = randomUUID();
const scope = { tenantId: tenantA, userId: userA, workspaceId: 'customer-a' };
const change = (patch: Partial<TutorialProgressUpdate> = {}): TutorialProgressUpdate => ({ expectedRevision: 0, mutationId: randomUUID(), disposition: 'paused', ...patch });
const principal = (patch: Partial<Parameters<typeof createHostedPrincipal>[0]> = {}) => createHostedPrincipal({
  workspaceId: 'control', userId: userA, activeOrganizationId: tenantA, selectedWorkspaceId: 'customer-a',
  sessionId: randomUUID(), sessionVersion: 1, permissions: ['workspace:view'], ...patch,
});
describe('hosted tutorial progress through real Postgres and composed browser routes', () => {
  let db: OrgTestDb;
  beforeAll(async () => {
    db = await createOrgTestDb();
    const sqlRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../libs/papercusp/libs/db/sql');
    let migration: string;
    try { migration = readFileSync(resolve(sqlRoot, '1304-hosted-tutorial-preferences-scope.sql'), 'utf8'); }
    catch { migration = readFileSync(resolve(sqlRoot, '1304-hosted-tutorial-preferences-scope.sql.DRAFT'), 'utf8'); }
    await db.adminSql.unsafe(migration);
  }, 120_000);
  afterAll(async () => { await db?.cleanup(); });

  async function runTenant<T>(context: VerifiedTenantServerContext, fn: (tx: Sql) => Promise<T>): Promise<T> {
    const selected = deriveTenantContext(context);
    return await db.adminSql.begin(async tx => {
      await tx.unsafe('SET LOCAL ROLE hosted_app');
      await tx`SELECT set_config('app.organization_id', ${selected.organizationId}, true),
        set_config('app.user_id', ${selected.userId}, true), set_config('app.workspace_id', ${selected.workspaceId!}, true)`;
      return fn(tx as unknown as Sql);
    }) as T;
  }
  function withScope<T>(selected: typeof scope, fn: (tx: Sql) => Promise<T>) {
    const p = principal({ userId: selected.userId, activeOrganizationId: selected.tenantId, selectedWorkspaceId: selected.workspaceId });
    return runTenant(tenantContext(p), fn);
  }
  function context(p: HostedPrincipal | undefined = principal()): RouteContext {
    return { principal: p, input: undefined, params: {}, log: () => {}, signal: new AbortController().signal };
  }
  function handler(method: 'GET' | 'POST') {
    return createHostedTutorialProgressRoutes({ origin: ORIGIN, controlPlaneWorkspaceId: 'control', runTenant })
      .find(route => route.method === method)!.handler;
  }
  it('restores UI state in a fresh request/later session without asserting domain completion', async () => {
    const update = change();
    const saved = await withScope(scope, tx => updateTutorialProgress(tx, scope, update));
    const response = await handler('GET')(new Request(`${ORIGIN}/api${HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH}`), context(principal({ sessionId: randomUUID() })));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.record).toEqual(saved);
    const restored = createTutorialState(scope, body.record.progress);
    expect(restored.disposition).toBe('paused');
    expect(confirmedTutorialSteps(restored)).toEqual([]);
  });
  it('isolates the same user by tenant/workspace and different users by RLS', async () => {
    for (const other of [{ ...scope, tenantId: tenantB }, { ...scope, userId: userB }, { ...scope, workspaceId: 'customer-b' }]) {
      expect((await withScope(other, tx => readTutorialProgress(tx, other))).revision).toBe(0);
      await expect(withScope(scope, tx => readTutorialProgress(tx, other))).rejects.toThrow('tutorial_scope_mismatch');
    }
    const rows = await withScope({ ...scope, userId: userB }, tx => tx`SELECT * FROM papercusp_auth.hosted_user_preferences WHERE user_id = ${userA}::uuid`);
    expect(rows).toHaveLength(0);
  });
  it('preserves other profile fields, workspaces and lesson versions', async () => {
    const s = { ...scope, workspaceId: randomUUID() };
    await db.adminSql`UPDATE papercusp_auth.hosted_user_preferences SET profile = profile || '{"displayName":"Avi"}'::jsonb WHERE user_id = ${userA}::uuid AND organization_id = ${tenantA}::uuid`;
    const prior = await withScope(scope, tx => readTutorialProgress(tx, scope));
    const oldKey = JSON.stringify([s.workspaceId, 'first-cloud-agent', 0]);
    await db.adminSql`UPDATE papercusp_auth.hosted_user_preferences SET profile = jsonb_set(profile, '{cloudTutorial}', (profile->'cloudTutorial') || ${JSON.stringify({ [oldKey]: { disposition: 'skipped' } })}::jsonb) WHERE user_id = ${userA}::uuid AND organization_id = ${tenantA}::uuid`;
    expect((await withScope(s, tx => readTutorialProgress(tx, s))).revision).toBe(0);
    await withScope(s, tx => updateTutorialProgress(tx, s, change()));
    expect(await withScope(scope, tx => readTutorialProgress(tx, scope))).toEqual(prior);
    const [row] = await db.adminSql`SELECT profile FROM papercusp_auth.hosted_user_preferences WHERE user_id = ${userA}::uuid AND organization_id = ${tenantA}::uuid`;
    expect(row.profile.displayName).toBe('Avi');
    expect(row.profile.cloudTutorial[oldKey]).toEqual({ disposition: 'skipped' });
  });
  it('serializes competing tabs; one CAS succeeds and one returns a recoverable conflict', async () => {
    const s = { ...scope, workspaceId: randomUUID() };
    const results = await Promise.allSettled([
      withScope(s, tx => updateTutorialProgress(tx, s, change({ disposition: 'paused' }))),
      withScope(s, tx => updateTutorialProgress(tx, s, change({ disposition: 'skipped' }))),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(TutorialProgressConflict);
    expect(rejected.reason.current.revision).toBe(1);
  });
  it('makes retries idempotent and rejects different writes reusing the same mutation id', async () => {
    const s = { ...scope, workspaceId: randomUUID() }, patch = change();
    const first = await withScope(s, tx => updateTutorialProgress(tx, s, patch));
    expect(await withScope(s, tx => updateTutorialProgress(tx, s, patch))).toEqual(first);
    await expect(withScope(s, tx => updateTutorialProgress(tx, s, { ...patch, disposition: 'skipped' }))).rejects.toThrow('tutorial_mutation_reused');
  });
  it('uses verified principal scope, rejects forged scope/completion fields and cross-origin writes', async () => {
    const post = handler('POST');
    const request = (body: unknown, origin = ORIGIN) => new Request(`${ORIGIN}/api${HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post(request(change(), 'https://foreign.test'), context())).status).toBe(403);
    expect((await post(request({ ...change(), scope: { ...scope, tenantId: tenantB } }), context())).status).toBe(400);
    expect((await post(request({ ...change(), completed: ['task'] }), context())).status).toBe(400);
    expect((await post(request(change()), context(principal({ permissions: [] })))).status).toBe(403);
    const signedOut = { ...context(), principal: undefined } as unknown as RouteContext;
    expect((await post(request(change()), signedOut)).status).toBe(401);
  });
  it('returns current state on stale-tab writes instead of replaying a product action', async () => {
    const p = principal({ selectedWorkspaceId: randomUUID() }), post = handler('POST');
    const request = (body: unknown) => new Request(`${ORIGIN}/api${HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH}`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post(request(change()), context(p))).status).toBe(200);
    const conflict = await post(request(change()), context(p));
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: 'tutorial_progress_conflict', record: { revision: 1 } });
  });
});
