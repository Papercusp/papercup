/** Existing HTTP/shared installer -> retained credentials -> real PG journal.
 * The download/install core is substituted to exercise its journal callback
 * deterministically; no network, publisher or full release acceptance claimed. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@papercusp/agent-mcp';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createOrgTestDb } from '../../test/_org-test-db';
import { retainRequestPrincipal } from '../auth/require-principal';
import { readPackageInstallation } from '../blueprint/package-resource-receipts';
import { blueprintInstallDependentId } from './blueprint-install-journal';
import { installBlueprintFromCupboard, type InstallBlueprintFromCupboardInput } from './install-blueprint-io';
import type { InstallBlueprintCoreDeps, InstallBlueprintCoreResult } from './install-blueprint-core';
import route from '../endpoint-route/routes/cupboard-install-blueprint';

const H = vi.hoisted(() => ({ core: vi.fn(), sql: null as OrgTestDb['adminSql'] | null,
  principal: null as Principal | null, pot: '', id: '', hash: 'a'.repeat(64), onCore: null as (() => void) | null }));
vi.mock('@papercusp/db-org', async original => ({ ...(await original<object>()), getOrgPg: () => ({ sql: H.sql }) }));
vi.mock('../auth/principal/from-cookie', () => ({ principalFromCookie: vi.fn(async () => H.principal) }));
vi.mock('../hive-federation', () => ({ potHomeSlugForHarness: vi.fn(async () => H.pot) }));
vi.mock('../workspace-registry', async original => ({ ...(await original<object>()), activeWorkspaceId: () => WS }));
vi.mock('./install-blueprint-core', async original => ({ ...(await original<object>()), installBlueprintFromCupboardCore: H.core }));

const WS = 'ws-install-human-ownership';
let db: OrgTestDb;
let sequence = 0;
beforeAll(async () => { db = await createOrgTestDb(); H.sql = db.adminSql; }, 120_000);
afterAll(async () => { await db?.cleanup(); }, 30_000);
afterEach(() => { vi.unstubAllGlobals(); });
beforeEach(() => {
  sequence++;
  H.pot = 'pot-owner-' + sequence;
  H.id = 'identity-owner-' + sequence;
  H.onCore = null;
  H.principal = { kind: 'user', trust: 'verified', authMethod: 'cookie-session', slug: 'human-1',
    workspaceId: WS, capabilities: new Set() };
  H.core.mockReset();
  H.core.mockImplementation(async (_input: unknown, deps: InstallBlueprintCoreDeps) => {
    H.onCore?.();
    const journal = deps.blueprintInstallJournal!({ blueprintId: H.id, bindings: [], eventKeys: [] });
    const attempt = await journal.prepare(H.hash);
    const report = await attempt.apply();
    return { id: H.id, journal: report } as unknown as InstallBlueprintCoreResult;
  });
});

function declaration() {
  return { declaration: 'self' as const, userId: 'human-1', ownerId: 'pot:' + H.pot, specificationRevision: H.hash };
}
function input(): InstallBlueprintFromCupboardInput {
  return { workspaceId: WS, potSlug: 'member-harness', githubUrl: 'https://github.com/example/identity',
    humanOwnershipDeclaration: declaration() };
}
async function request() {
  return { workspaceId: WS, resolvePrincipal: await retainRequestPrincipal(new Headers(), WS) };
}
async function receipt() {
  return readPackageInstallation(db.adminSql, WS, blueprintInstallDependentId(H.pot, H.id, H.hash));
}

describe('P-002 production installer ownership provenance (real PG)', () => {
  it('carries the real HTTP handler claim through retained credentials to the installation receipt', async () => {
    const response = await (route as unknown as { handler(req: Request): Promise<Response> }).handler(
      new Request('http://localhost/api/cupboard/install-blueprint', { method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'session=test-only' },
        body: JSON.stringify(input()) }));
    expect(response.status).toBe(200);
    expect((await receipt())!.human_ownership).toMatchObject({ userId: 'human-1', ownerId: 'pot:' + H.pot });
  });

  it('records the explicit human on the canonical destination pot and exact release', async () => {
    expect((await installBlueprintFromCupboard(input(), await request())).ok).toBe(true);
    expect(await receipt()).toMatchObject({ owner_id: 'pot:' + H.pot, phase: 'applied',
      human_ownership: { userId: 'human-1', workspaceId: WS, ownerId: 'pot:' + H.pot,
        specificationRevision: H.hash, declaration: 'self' } });
  });

  it('leaves ordinary agent/legacy installs unknown even with a named caller', async () => {
    const ordinary = input(); delete ordinary.humanOwnershipDeclaration;
    expect((await installBlueprintFromCupboard(ordinary, await request())).ok).toBe(true);
    expect((await receipt())!.human_ownership).toBeNull();
  });

  it('does not backfill an unknown installation when a human later claims it', async () => {
    const ordinary = input(); delete ordinary.humanOwnershipDeclaration;
    expect((await installBlueprintFromCupboard(ordinary)).ok).toBe(true);
    expect((await installBlueprintFromCupboard(input(), await request())).ok).toBe(false);
    expect((await receipt())!.human_ownership).toBeNull();
  });

  it('refuses a claim without retained request evidence before invoking the core', async () => {
    expect(await installBlueprintFromCupboard(input())).toMatchObject({ ok: false, status: 403 });
    expect(H.core).not.toHaveBeenCalled(); expect(await receipt()).toBeNull();
  });

  it('rejects a forged resolver returning an otherwise matching human', async () => {
    expect(await installBlueprintFromCupboard(input(), { workspaceId: WS, resolvePrincipal: async () => H.principal }))
      .toMatchObject({ ok: false, status: 403 });
    expect(H.core).not.toHaveBeenCalled(); expect(await receipt()).toBeNull();
  });

  it.each(['device', 'system', 'other-user', 'other-workspace'])('refuses %s authority as this human', async kind => {
    if (kind === 'device') H.principal = { ...H.principal!, kind: 'device', authMethod: 'jwt' };
    if (kind === 'system') H.principal = { ...H.principal!, kind: 'system', authMethod: 'bearer-token', trust: 'trusted' };
    if (kind === 'other-user') H.principal = { ...H.principal!, slug: 'human-2' };
    const req = await request();
    if (kind === 'other-workspace') req.workspaceId = 'another-workspace';
    expect(await installBlueprintFromCupboard(input(), req)).toMatchObject({ ok: false, status: 403 });
    expect(H.core).not.toHaveBeenCalled(); expect(await receipt()).toBeNull();
  });

  it('refuses a target other than the canonical pot after harness resolution', async () => {
    const wrong = input(); wrong.humanOwnershipDeclaration!.ownerId = 'pot:member-harness';
    expect(await installBlueprintFromCupboard(wrong, await request()))
      .toMatchObject({ ok: false, error: 'human_ownership_target_mismatch' });
    expect(H.core).not.toHaveBeenCalled(); expect(await receipt()).toBeNull();
  });

  it('rejects a different release at the real journal boundary without persisting a claim', async () => {
    const wrong = input(); wrong.humanOwnershipDeclaration!.specificationRevision = 'b'.repeat(64);
    expect((await installBlueprintFromCupboard(wrong, await request())).ok).toBe(false);
    expect(await receipt()).toBeNull();
  });

  it('rechecks revoked credentials after core/download waits before the journal write', async () => {
    const req = await request(); H.onCore = () => { H.principal = null; };
    expect((await installBlueprintFromCupboard(input(), req)).ok).toBe(false);
    expect(await receipt()).toBeNull();
  });

  it('preserves entry-time declaration while the core waits', async () => {
    const proposed = input(); H.onCore = () => { proposed.humanOwnershipDeclaration!.ownerId = 'pot:other'; };
    expect((await installBlueprintFromCupboard(proposed, await request())).ok).toBe(true);
    expect((await receipt())!.human_ownership!.ownerId).toBe('pot:' + H.pot);
  });

  it('does not infer ownership of a transitive blueprint from the root declaration', async () => {
    const child = 'child-' + H.id;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: [
      { listing_ref: child, github_url: 'https://github.com/example/child' },
    ] }), { status: 200 })));
    H.core.mockImplementation(async (_input: unknown, deps: InstallBlueprintCoreDeps) => {
      const root = H.core.mock.calls.length === 1;
      const journal = deps.blueprintInstallJournal!({ blueprintId: root ? H.id : child, bindings: [], eventKeys: [] });
      const attempt = await journal.prepare(H.hash);
      const report = await attempt.apply();
      return { id: root ? H.id : child, journal: report,
        ...(root ? { depCheck: { installable: { blueprints: [child], plugins: [] } } } : {}) } as unknown as InstallBlueprintCoreResult;
    });
    const result = await installBlueprintFromCupboard(input(), await request());
    expect(result.ok).toBe(true);
    if (!result.ok || !('blueprintInstalls' in result.result)) throw new Error('install closure result missing');
    expect(result.result.blueprintInstalls).toEqual([{ blueprint: child, ok: true }]);
    expect((await receipt())!.human_ownership!.userId).toBe('human-1');
    expect((await readPackageInstallation(db.adminSql, WS,
      blueprintInstallDependentId(H.pot, child, H.hash)))!.human_ownership).toBeNull();
  });

  it.each(['rollback', 'uninstall'] as const)('refuses a new declaration on %s instead of rewriting historical ownership', async operation => {
    expect(await installBlueprintFromCupboard({ ...input(), operation }, await request()))
      .toMatchObject({ ok: false, status: 400, error: 'invalid_human_ownership_declaration' });
    expect(H.core).not.toHaveBeenCalled(); expect(await receipt()).toBeNull();
  });
});
