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
import { saveHostedUserPreferences } from '../auth/hosted/governance';
import { createTutorialState, confirmedTutorialSteps } from './cloud-tutorial-lesson';
import { readTutorialProgress, updateTutorialProgress, TutorialProgressConflict, type TutorialProgressUpdate,
  enrollAccountTutorial, readAccountTutorialProgress, updateAccountTutorialProgress,
  AccountTutorialProgressConflict, type AccountTutorialProgressUpdate } from './cloud-tutorial-progress';

const ORIGIN = 'https://app.papercusp.com';
const tenantA = randomUUID(), tenantB = randomUUID(), userA = randomUUID(), userB = randomUUID();
const scope = { tenantId: tenantA, userId: userA, workspaceId: 'customer-a' };
const change = (patch: Partial<TutorialProgressUpdate> = {}, selected = scope): TutorialProgressUpdate => ({ expectedScope: selected, expectedRevision: 0, mutationId: randomUUID(), disposition: 'paused', ...patch });
const principal = (patch: Partial<Parameters<typeof createHostedPrincipal>[0]> = {}) => createHostedPrincipal({
  workspaceId: 'control', userId: userA, activeOrganizationId: tenantA, selectedWorkspaceId: 'customer-a',
  sessionId: randomUUID(), sessionVersion: 1, permissions: ['workspace:view'], ...patch,
});
describe('hosted tutorial progress through real Postgres and composed browser routes', () => {
  let db: OrgTestDb;
  beforeAll(async () => {
    db = await createOrgTestDb();
    const sqlRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../libs/papercusp/libs/db/sql');
    const migration = readFileSync(process.env.CLOUD_TUTORIAL_PROGRESS_MIGRATION_PROBE ?? resolve(sqlRoot, '1304-hosted-tutorial-preferences-scope.sql'), 'utf8');
    await db.adminSql.unsafe(migration);
  }, 120_000);
  afterAll(async () => { await db?.cleanup(); });

  async function runTenant<T>(context: VerifiedTenantServerContext, fn: (tx: Sql) => Promise<T>): Promise<T> {
    const selected = deriveTenantContext(context);
    return await db.adminSql.begin(async tx => {
      await tx.unsafe('SET LOCAL ROLE hosted_app');
      await tx`SELECT set_config('app.organization_id', ${selected.organizationId}, true),
        set_config('app.user_id', ${selected.userId}, true), set_config('app.workspace_id', ${selected.workspaceId ?? ''}, true)`;
      return fn(tx as unknown as Sql);
    }) as T;
  }
  function withScope<T>(selected: typeof scope, fn: (tx: Sql) => Promise<T>) {
    const p = principal({ userId: selected.userId, activeOrganizationId: selected.tenantId, selectedWorkspaceId: selected.workspaceId });
    return runTenant(tenantContext(p), fn);
  }
  async function withAccount<T>(selected: { tenantId: string; userId: string }, fn: (tx: Sql) => Promise<T>): Promise<T> {
    return await db.adminSql.begin(async tx => {
      await tx.unsafe('SET LOCAL ROLE hosted_app');
      await tx`SELECT set_config('app.organization_id', ${selected.tenantId}, true),
        set_config('app.user_id', ${selected.userId}, true), set_config('app.workspace_id', '', true)`;
      return fn(tx as unknown as Sql);
    }) as T;
  }
  it('enrolls account orientation without a workspace and keeps replay from resetting completed progress', async () => {
    const account = { tenantId: tenantA, userId: randomUUID() };
    expect(await withAccount(account, tx => readAccountTutorialProgress(tx, account))).toBeNull();
    await withAccount(account, tx => enrollAccountTutorial(tx, account));
    const patch: AccountTutorialProgressUpdate = { expectedScope: account, expectedRevision: 0, mutationId: randomUUID(),
      version: 3, disposition: 'closed', currentLessonId: 'billing', reviewedLessonIds: ['welcome', 'billing'] };
    const saved = await withAccount(account, tx => updateAccountTutorialProgress(tx, account, patch));
    await withAccount(account, tx => enrollAccountTutorial(tx, account));
    expect(await withAccount(account, tx => readAccountTutorialProgress(tx, account))).toEqual(saved);
    expect(await withAccount(account, tx => updateAccountTutorialProgress(tx, account, patch))).toEqual(saved);
    await expect(withAccount(account, tx => updateAccountTutorialProgress(tx, account, { ...patch, disposition: 'active' }))).rejects.toThrow('tutorial_mutation_reused');
    await withAccount(account, tx => saveHostedUserPreferences({ organizationId: account.tenantId, userId: account.userId, locale: 'en-US', timeZone: 'UTC', profile: { displayName: 'Updated' } }, tx));
    expect(await withAccount(account, tx => readAccountTutorialProgress(tx, account))).toEqual(saved);
  });
  it('isolates account orientation and rejects forged scope or client enrollment', async () => {
    const account = { tenantId: tenantA, userId: randomUUID() };
    const patch: AccountTutorialProgressUpdate = { expectedScope: account, expectedRevision: 0, mutationId: randomUUID(),
      version: 3, disposition: 'active', currentLessonId: 'welcome', reviewedLessonIds: [] };
    await expect(withAccount(account, tx => updateAccountTutorialProgress(tx, account, patch))).rejects.toThrow('tutorial_not_enrolled');
    await withAccount(account, tx => enrollAccountTutorial(tx, account));
    for (const other of [{ ...account, tenantId: tenantB }, { ...account, userId: randomUUID() }]) {
      expect(await withAccount(other, tx => readAccountTutorialProgress(tx, other))).toBeNull();
      await expect(withAccount(account, tx => readAccountTutorialProgress(tx, other))).rejects.toThrow('tutorial_scope_mismatch');
      await expect(withAccount(account, tx => updateAccountTutorialProgress(tx, account, { ...patch, expectedScope: other }))).rejects.toThrow('tutorial_scope_changed');
    }
  });
  it('serializes account tabs without changing workspace-scoped Cloud receipts', async () => {
    const account = { tenantId: tenantA, userId: randomUUID() };
    await withAccount(account, tx => enrollAccountTutorial(tx, account));
    const patch: AccountTutorialProgressUpdate = { expectedScope: account, expectedRevision: 0, mutationId: randomUUID(),
      version: 3, disposition: 'paused', currentLessonId: 'navigation', reviewedLessonIds: ['welcome'] };
    const cloudScope = { ...account, workspaceId: 'account-cloud-workspace' };
    const cloud = await withScope(cloudScope, tx => updateTutorialProgress(tx, cloudScope, change({}, cloudScope)));
    const results = await Promise.allSettled([
      withAccount(account, tx => updateAccountTutorialProgress(tx, account, patch)),
      withAccount(account, tx => updateAccountTutorialProgress(tx, account, { ...patch, mutationId: randomUUID(), disposition: 'skipped' })),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(AccountTutorialProgressConflict);
    expect(await withScope(cloudScope, tx => readTutorialProgress(tx, cloudScope))).toEqual(cloud);
  });
  function context(p: HostedPrincipal | undefined = principal()): RouteContext {
    return { principal: p, input: undefined, params: {}, log: () => {}, signal: new AbortController().signal };
  }
  function handler(method: 'GET' | 'POST') {
    return createHostedTutorialProgressRoutes({ origin: ORIGIN, controlPlaneWorkspaceId: 'control', runTenant })
      .find(route => route.method === method)!.handler;
  }
  it('account entry reads and saves without a workspace, retaining CAS, principal scope and origin checks', async () => {
    const account = { tenantId: tenantA, userId: randomUUID() };
    await withAccount(account, tx => enrollAccountTutorial(tx, account));
    const p = principal({ userId: account.userId, selectedWorkspaceId: undefined, permissions: [] });
    const url = `${ORIGIN}/api${HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH}?scope=account&version=3`;
    const read = await handler('GET')(new Request(url), context(p));
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({ record: { scope: account, revision: 0, currentLessonId: 'welcome' } });
    const patch: AccountTutorialProgressUpdate = { expectedScope: account, expectedRevision: 0, mutationId: randomUUID(),
      version: 3, disposition: 'paused', currentLessonId: 'billing', reviewedLessonIds: ['welcome'] };
    const request = (body: unknown, origin = ORIGIN) => new Request(url, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const post = handler('POST');
    expect((await post(request(patch), context(p))).status).toBe(200);
    expect((await post(request(patch), context(p))).status).toBe(200);
    expect((await post(request({ ...patch, mutationId: randomUUID() }), context(p))).status).toBe(409);
    expect((await post(request(patch, 'https://foreign.test'), context(p))).status).toBe(403);
    expect((await post(request({ ...patch, expectedScope: { ...account, tenantId: tenantB } }), context(p))).status).toBe(403);
    expect((await post(request({ ...patch, completed: ['task'] }), context(p))).status).toBe(400);
    expect((await handler('GET')(new Request(url.replace('version=3', 'version=4')), context(p))).status).toBe(400);
    expect((await handler('GET')(new Request(url), { ...context(p), principal: null })).status).toBe(401);
    // A preassigned workspace cannot change the account record or make it Cloud scoped.
    const selected = principal({ userId: account.userId, selectedWorkspaceId: 'assigned-workspace' });
    await expect((await handler('GET')(new Request(url), context(selected))).json()).resolves.toMatchObject({ record: { scope: account, revision: 1 } });
  });
  it('full-product reviews persist through real routes without completing or rewriting Cloud work', async () => {
    const account = { tenantId: tenantA, userId: randomUUID() };
    await withAccount(account, tx => enrollAccountTutorial(tx, account));
    const cloudScope = { ...account, workspaceId: randomUUID() };
    const cloudBefore = await withScope(cloudScope, tx => updateTutorialProgress(tx, cloudScope, change({}, cloudScope)));
    const p = principal({ userId: account.userId, selectedWorkspaceId: cloudScope.workspaceId, permissions: [] });
    const url = `${ORIGIN}/api${HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH}?scope=account&version=3`;
    // This independent acceptance list is intentionally not generated by the
    // production curriculum or its progress validator.
    const lessons = ['welcome', 'navigation', 'workspace', 'planning', 'work', 'knowledge',
      'communications', 'operations', 'account', 'billing', 'cloud-first-agent', 'help'];
    for (let index = 0; index < lessons.length; index++) {
      const response = await handler('POST')(new Request(url, { method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({
          expectedScope: account, expectedRevision: index, mutationId: randomUUID(), version: 3,
          disposition: index === lessons.length - 1 ? 'closed' : 'active',
          currentLessonId: lessons[Math.min(index + 1, lessons.length - 1)], reviewedLessonIds: lessons.slice(0, index + 1),
        }) }), context(p));
      expect(response.status, lessons[index]).toBe(200);
      const { record } = await response.json();
      expect(record).toMatchObject({ scope: account, version: 3, revision: index + 1,
        reviewedLessonIds: lessons.slice(0, index + 1) });
      expect(record).not.toHaveProperty('completed');
      expect(record).not.toHaveProperty('inspectedResult');
      expect(await withScope(cloudScope, tx => readTutorialProgress(tx, cloudScope))).toEqual(cloudBefore);
    }
    const reread = await handler('GET')(new Request(url), context(principal({ userId: account.userId,
      selectedWorkspaceId: undefined, permissions: [] })));
    await expect(reread.json()).resolves.toMatchObject({ record: {
      scope: account, revision: lessons.length, disposition: 'closed', reviewedLessonIds: lessons,
    } });
  });
  it('invalid full-product lesson controls cannot alter real account or Cloud receipts', async () => {
    const account = { tenantId: tenantA, userId: randomUUID() };
    await withAccount(account, tx => enrollAccountTutorial(tx, account));
    const p = principal({ userId: account.userId, selectedWorkspaceId: undefined, permissions: [] });
    const url = `${ORIGIN}/api${HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH}?scope=account&version=3`;
    const before = await withAccount(account, tx => readAccountTutorialProgress(tx, account));
    const valid = { expectedScope: account, expectedRevision: 0, mutationId: randomUUID(), version: 3,
      disposition: 'active', currentLessonId: 'billing', reviewedLessonIds: ['welcome'] };
    for (const patch of [{ currentLessonId: 'missing-capability-lesson' },
      { reviewedLessonIds: ['welcome', 'missing-capability-lesson'] }, { version: 2 },
      { completed: ['billing'] }, { inspectedResult: { sessionId: 's', taskId: 't', resultId: 'r' } }]) {
      const response = await handler('POST')(new Request(url, { method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ ...valid, ...patch }) }), context(p));
      expect(response.status, JSON.stringify(patch)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: 'invalid_tutorial_progress' });
      expect(await withAccount(account, tx => readAccountTutorialProgress(tx, account))).toEqual(before);
    }
  });
  it('isolates beginner v2 receipts and CAS from the retained advanced v1 record', async () => {
    const s = { ...scope, workspaceId: randomUUID() };
    const legacy = await withScope(s, tx => updateTutorialProgress(tx, s, change({}, s)));
    expect((await withScope(s, tx => readTutorialProgress(tx, s, 2))).revision).toBe(0);
    const receipt = { sessionId: 'session', taskId: 'revision', resultId: 'answer' };
    const beginner = await withScope(s, tx => updateTutorialProgress(tx, s, change({ version: 2, inspectedRevision: receipt, disposition: 'active' }, s)));
    expect(beginner.progress.version).toBe(2);
    expect(beginner.progress.inspectedRevision).toEqual(receipt);
    expect(await withScope(s, tx => readTutorialProgress(tx, s))).toEqual(legacy);
    expect(await withScope(s, tx => readTutorialProgress(tx, s, 2))).toEqual(beginner);
    await expect(withScope(s, tx => updateTutorialProgress(tx, s, change({ inspectedPractice: receipt }, s)))).rejects.toThrow('tutorial_version_mismatch');
    expect(confirmedTutorialSteps(createTutorialState(s, beginner.progress, 2))).toEqual([]);
  });
  it('reads the explicit beginner version through the authenticated route and rejects unknown versions', async () => {
    const response = await handler('GET')(new Request(`${ORIGIN}/api${HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH}?version=2`), context());
    expect(response.status).toBe(200); expect((await response.json()).record.progress.version).toBe(2);
    const invalid = await handler('GET')(new Request(`${ORIGIN}/api${HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH}?version=3`), context());
    expect(invalid.status).toBe(400);
  });
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
    // This oracle is independently runnable by name: it owns its positive row.
    const current = await withScope(scope, tx => readTutorialProgress(tx, scope));
    if (current.revision === 0) await withScope(scope, tx => updateTutorialProgress(tx, scope, change()));
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
    await withScope(s, tx => updateTutorialProgress(tx, s, change({}, s)));
    expect(await withScope(scope, tx => readTutorialProgress(tx, scope))).toEqual(prior);
    const [row] = await db.adminSql`SELECT profile FROM papercusp_auth.hosted_user_preferences WHERE user_id = ${userA}::uuid AND organization_id = ${tenantA}::uuid`;
    expect(row.profile.displayName).toBe('Avi');
    expect(row.profile.cloudTutorial[oldKey]).toEqual({ disposition: 'skipped' });
  });
  it('serializes competing tabs; one CAS succeeds and one returns a recoverable conflict', async () => {
    const s = { ...scope, workspaceId: randomUUID() };
    const results = await Promise.allSettled([
      withScope(s, tx => updateTutorialProgress(tx, s, change({ disposition: 'paused' }, s))),
      withScope(s, tx => updateTutorialProgress(tx, s, change({ disposition: 'skipped' }, s))),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(TutorialProgressConflict);
    expect(rejected.reason.current.revision).toBe(1);
  });
  it('makes retries idempotent and rejects different writes reusing the same mutation id', async () => {
    const s = { ...scope, workspaceId: randomUUID() }, patch = change({}, s);
    const first = await withScope(s, tx => updateTutorialProgress(tx, s, patch));
    expect(await withScope(s, tx => updateTutorialProgress(tx, s, patch))).toEqual(first);
    await expect(withScope(s, tx => updateTutorialProgress(tx, s, { ...patch, disposition: 'skipped' }))).rejects.toThrow('tutorial_mutation_reused');
  });
  it('the maintained profile preference writer preserves tutorial state', async () => {
    const previous = await withScope(scope, tx => readTutorialProgress(tx, scope));
    await withScope(scope, tx => saveHostedUserPreferences({ organizationId: tenantA, userId: userA, locale: 'en-US', timeZone: 'UTC', profile: { displayName: 'Updated profile' } }, tx));
    expect(await withScope(scope, tx => readTutorialProgress(tx, scope))).toEqual(previous);
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
    const selected = { ...scope, workspaceId: p.selectedWorkspaceId! };
    const request = (body: unknown) => new Request(`${ORIGIN}/api${HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH}`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post(request(change({}, selected)), context(p))).status).toBe(200);
    const conflict = await post(request(change({}, selected)), context(p));
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: 'tutorial_progress_conflict', record: { revision: 1 } });
  });
  it('a cookie/user/workspace transition cannot copy a stale tab’s progress into the new scope', async () => {
    const post = handler('POST');
    for (const destination of [{ ...scope, tenantId: tenantB }, { ...scope, userId: userB }, { ...scope, workspaceId: randomUUID() }]) {
      const p = principal({ activeOrganizationId: destination.tenantId, userId: destination.userId, selectedWorkspaceId: destination.workspaceId });
      const response = await post(new Request(`${ORIGIN}/api${HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH}`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(change()) }), context(p));
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: 'tutorial_scope_changed' });
      expect((await withScope(destination, tx => readTutorialProgress(tx, destination))).revision).toBe(0);
    }
  });
});
