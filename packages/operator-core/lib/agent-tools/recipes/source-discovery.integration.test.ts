import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { sqlMiningFixture } from '../../../test/_sql-mining-fixture';
import { captureRecipe } from '../code/capture-recipe';
import { productionOpportunityReaders } from '../../agent-opportunities/source-readers';
import { resolveStoredSourceOperation } from '../../recipe-source-operation';
import { getRecipe } from '../../code-recipes-store';
import { recipeCandidates } from '../../code-recipes-candidates';
import recipeGet from './get';
import recipeSearch from './search';
import recipeList from './list';

// Keep storage, capture, source hydration, authority derivation and hybrid
// search real. Only connection routing, the key and the current ACL decision
// belong to the fixture; no saved recipe or recommendation is mocked.
let fixture: Awaited<ReturnType<typeof sqlMiningFixture>>;
let permitted = true;
const workspaceId = 'sql-mining-test', harnessSlug = 'mining-test';
const originalScope = { workspaceId, sourceBoundary: 'authorized-tool-ledger',
  epoch: 'discovery-test', key: new Uint8Array(32).fill(83) };
let scope = originalScope;
vi.mock('@papercusp/db-org', async original => ({
  ...await original<Record<string, unknown>>(), getOrgPg: () => ({ sql: fixture.db.adminSql }),
}));
vi.mock('../../agent-opportunities/privacy', async original => ({
  ...await original<Record<string, unknown>>(), productionMiningScope: (workspaceId: string) => ({ ...scope, workspaceId }),
}));
vi.mock('../../agent-opportunities/source-readers', async original => {
  const actual = await original<typeof import('../../agent-opportunities/source-readers')>();
  return { ...actual, productionOpportunityReaders: (opts: Parameters<typeof actual.productionOpportunityReaders>[0]) =>
    actual.productionOpportunityReaders({ ...opts, authorize: async boundary => permitted && await opts.authorize(boundary) }) };
});
vi.mock('../locks/su-lock-store', () => ({ getTxPool: () => fixture.db.adminSql }));
vi.mock('../coordination/presence-fleet', () => ({ resolvePresenceFleet: async () => ({ fleetSlug: null }) }));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: async () => {} }));

beforeAll(async () => { fixture = await sqlMiningFixture(); }, 120_000);
afterAll(async () => { await fixture?.cleanup(); });
beforeEach(async () => { await fixture.clear(); permitted = true; scope = originalScope; });
const context = (over: Partial<UnifiedToolContext> = {}) => ({
  workspaceId, harnessSlug, role: 'su', isSuperuser: true,
  uiClientId: 'su-discovery-reuser', log: () => {}, ...over,
}) as UnifiedToolContext;
function data(result: unknown): Record<string, any> {
  const envelope = result as { data?: Record<string, any>; content?: Array<{ type: string; text?: string }> };
  return envelope.data ?? JSON.parse(envelope.content!.find(row => row.type === 'text')!.text!);
}

for (const family of ['sql', 'shell'] as const) {
  it(`P007 ${family}: warm production search/get/list/review renew source access, scope, expiry and key`, async () => {
    const tool = family === 'sql' ? 'dev:pg_query' : 'capability:bash';
    const id = await fixture.seed();
    const at = new Date().toISOString();
    const sourceArgs = family === 'sql'
      ? { sql: 'SELECT $1::text AS PRIVATE_COLUMN', parameters: ['PRIVATE_SAMPLE'] }
      : { command: "printf '%s' PRIVATE_SAMPLE", cwd: '/tmp' };
    const receipt = { version: 1, callId: `host:discovery:${family}`, parentCallId: 'host:parent',
      handlerEntered: true, role: 'operation', disposition: 'ok', outcome: { status: 'success', final: true } };
    await fixture.db.adminSql`UPDATE harness_shared.tool_invocations SET invoked_at=${at}::timestamptz,
      tool_name=${tool}, args_json=${JSON.stringify(sourceArgs)}::jsonb,
      metadata_json=${JSON.stringify({ managedOperation: receipt })}::jsonb WHERE id=${id}::bigint`;
    const reader = productionOpportunityReaders({ workspaceId, harnessSlug, sourceBoundary: scope.sourceBoundary,
      client: fixture.db.adminSql, authorize: async () => true });
    const source = await reader.readRecipeOperation({ id, scope });
    expect(source).not.toBeNull();
    const captured = await captureRecipe({ sql: fixture.db.adminSql, embed: async () => null, resolveHive: async () => null }, {
      script: 'PRIVATE_WRAPPER', title: 'PRIVATE_TITLE', workspaceId, harness: harnessSlug,
      ownerId: 'su-private-actor', role: 'operator', allowed: new Set([tool]),
      tools: [{ expose: { mcp: { name: tool } } }] as never, operationSource: { source: source!, scope },
    });
    expect(captured).not.toBeNull();
    const saved = (await getRecipe(fixture.db.adminSql, captured!.row.id))!;
    expect(JSON.stringify(saved)).not.toContain('PRIVATE_');
    const visible = async (ctx = context()) => {
      const searched = data(await recipeSearch.handler({ query: saved.title, semantic: false, limit: 50 } as never, ctx));
      const fetched = data(await recipeGet.handler({ id: saved.id } as never, ctx));
      const listed = data(await recipeList.handler({ includeTrivial: true, limit: 100 } as never, ctx));
      const reviewed = await recipeCandidates(fixture.db.adminSql, { minRunCount: 1 }, {
        authorizeSource: async row => Boolean(await resolveStoredSourceOperation(row,
          { workspace: ctx.workspaceId, harness: ctx.harnessSlug })),
      });
      for (const value of [searched, fetched, listed, reviewed]) expect(JSON.stringify(value)).not.toContain('PRIVATE_');
      return {
        search: searched.recipes.some((row: { id: string }) => row.id === saved.id),
        get: fetched.results.some((row: { id: string; ok: boolean }) => row.id === saved.id && row.ok),
        list: listed.recipes.some((row: { id: string }) => row.id === saved.id),
        review: reviewed.signals.some(row => row.id === saved.id),
      };
    };
    const allowed = { search: true, get: true, list: true, review: true };
    const denied = { search: false, get: false, list: false, review: false };
    expect(await visible()).toEqual(allowed);
    permitted = false; expect(await visible()).toEqual(denied);
    permitted = true; expect(await visible()).toEqual(allowed);
    expect(await visible(context({ workspaceId: 'foreign-workspace' }))).toEqual(denied);
    expect(await visible(context({ harnessSlug: 'foreign-harness' }))).toEqual(denied);
    scope = { ...originalScope, key: new Uint8Array(32).fill(84) };
    expect(await visible()).toEqual(denied);
    scope = { ...originalScope, epoch: 'rotated' };
    expect(await visible()).toEqual(denied);
    scope = originalScope;
    expect(await visible()).toEqual(allowed);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(saved.capabilityManifest!.sourceOperation!.expiresAt));
    try { expect(await visible()).toEqual(denied); } finally { clock.mockRestore(); }
    expect(await visible()).toEqual(allowed);
    await fixture.db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE id=${id}::bigint`;
    expect(await visible()).toEqual(denied);
  }, 120_000);
}
