import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProjectedTool, UnifiedToolContext } from '@papercusp/agent-mcp';
import { listAllProjectedTools, runToolOrchestration } from '@papercusp/agent-mcp';
import { sqlMiningFixture } from '../../../test/_sql-mining-fixture';
import { captureRecipe } from '../code/capture-recipe';
import { productionOpportunityReaders } from '../../agent-opportunities/source-readers';
import { resolveStoredSourceOperation } from '../../recipe-source-operation';
import { getRecipe } from '../../code-recipes-store';
import { recipeCandidates } from '../../code-recipes-candidates';
import { deriveLegacyForegroundManifest, recipeSourceOperationSchema, type RecipeBindingSchemaV1 } from '../../recipe-contract';
import { normalizeExecutionTrace } from '../../orchestration-trace';
import recipeGet from './get';
import recipeSearch from './search';
import recipeList from './list';
import recipeRun from './run';
import { orchestrationCallerSurface } from '../orchestration/contract-preflight';
import { findTopRecipeForWake } from '../../harness/routines/loop-wake-recipe';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { resolveProseProfileSelection } from '../../search/prose-vector-dims';

// Keep storage, capture, source hydration, authority derivation and hybrid
// search real. Only connection routing, the key and the current ACL decision
// belong to the fixture; no saved recipe or recommendation is mocked.
let fixture: Awaited<ReturnType<typeof sqlMiningFixture>>;
let permitted = true;
let callerPermitted = true;
let toolPresent = true;
let dispatches: Array<{ name: string; args: Record<string, unknown> }> = [];
const workspaceId = 'sql-mining-test', harnessSlug = 'mining-test';
const originalScope = { workspaceId, sourceBoundary: 'authorized-tool-ledger',
  epoch: new Date().toISOString().slice(0, 7), key: new Uint8Array(32).fill(83) };
let scope = originalScope;
vi.mock('@papercusp/agent-mcp', async original => ({
  ...await original<Record<string, unknown>>(),
  listAllProjectedTools: () => toolPresent ? ['dev:pg_query', 'capability:bash', 'discovery:pots', 'lexicon:active_pack'].map(name => ({
    pluginName: 'fixture', description: 'Controlled actual SQL or shell execution', capabilities: [],
    expose: { mcp: { name } }, effect: 'read',
    agentRoles: callerPermitted ? ['operator', 'su'] : ['operator'],
    inputSchema: { type: 'object', additionalProperties: true },
    fn: async input => {
      const args = input as Record<string, unknown>;
      dispatches.push({ name, args });
      if (name === 'dev:pg_query') {
        const rows = await fixture.db.adminSql.unsafe(args.sql as string, args.parameters as string[]);
        return { content: [], structuredContent: { rows } };
      }
      if (name !== 'capability:bash') {
        const [row] = await fixture.db.adminSql`SELECT ${args.value as string}::text AS value`;
        return { content: [], structuredContent: row };
      }
      const { stdout } = await promisify(execFile)('/bin/sh', ['-c', args.command as string], {
        cwd: args.cwd as string, timeout: 5_000,
      });
      return { content: [], structuredContent: { output: stdout, exit_code: 0 } };
    },
  } satisfies ProjectedTool)) : [],
}));
// Exercise the real recipe VM and dispatcher with controlled actual SQL/shell
// handlers. Outer host telemetry is covered by its separate compiled fixture.
vi.mock('../../projected-tool-deps', () => ({ PROJECTED_DEPS: {} }));
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
beforeEach(async () => {
  await fixture.clear(); permitted = true; callerPermitted = true; toolPresent = true; scope = originalScope;
  dispatches = [];
});
const context = (over: Partial<UnifiedToolContext> = {}) => ({
  workspaceId, harnessSlug, role: 'su', isSuperuser: true,
  uiClientId: 'su-discovery-reuser', log: () => {}, ...over,
}) as UnifiedToolContext;
function data(result: unknown): Record<string, any> {
  const envelope = result as { data?: Record<string, any>; content?: Array<{ type: string; text?: string }> };
  return envelope.data ?? JSON.parse(envelope.content!.find(row => row.type === 'text')!.text!);
}

it('P007 composition: capture, exact dedup and second-caller typed replay preserve immutable success and independent refusal receipts', async () => {
  const script = 'const first = await tools.discovery.pots({ value: inputs.value }); return await tools.lexicon.active_pack({ value: first.value });';
  const tools = listAllProjectedTools();
  const allowed = new Set(['discovery:pots', 'lexicon:active_pack']);
  const bindingSchema: RecipeBindingSchemaV1 = { version: 1, additionalProperties: false,
    properties: { value: { type: 'string', required: true, lifetime: { kind: 'stable' } } } };
  const capabilityManifest = { ...deriveLegacyForegroundManifest([...allowed]), replay: { class: 'read-only' as const } };
  const observed = await runToolOrchestration(script, { ctx: { ...context({ role: 'operator', uiClientId: 'su-composition-author' }), codeMode: true },
    deps: {}, tools, allowed, inputs: { value: 'original observation' } });
  expect(observed, JSON.stringify(observed)).toMatchObject({ ok: true, dispatchCount: 2,
    summary: { value: 'original observation' } });
  const trace = await normalizeExecutionTrace({ script, backend: 'server', tools, allowed,
    callRecords: observed.callRecords, dispatchTimings: observed.dispatchTimings });
  const input = { script, title: 'Typed composition replay', workspaceId, harness: harnessSlug,
    ownerId: 'su-composition-author', role: 'operator', tools, allowed, bindingSchema, capabilityManifest, executionTrace: trace };
  const deps = { sql: fixture.db.adminSql, embed: async () => null, resolveHive: async () => null };
  const captured = await captureRecipe(deps, input);
  expect(captured).not.toBeNull();
  const reused = await captureRecipe(deps, input);
  expect(reused).toMatchObject({ disposition: 'exact-fingerprint-reuse', row: { id: captured!.row.id } });
  const saved = (await getRecipe(fixture.db.adminSql, captured!.row.id))!;
  const fetched = data(await recipeGet.handler({ id: saved.id } as never, context())).results[0];
  expect(fetched).toMatchObject({ ok: true, recipe: { id: saved.id, authorRole: 'operator',
    authority: { runnable: true, refsMeasured: true } } });
  const searched = data(await recipeSearch.handler({ query: saved.title, semantic: false } as never, context()));
  expect(searched.recipes.some((row: { id: string }) => row.id === saved.id)).toBe(true);
  const authority = fetched.recipe.authority;
  const rows = () => fixture.db.adminSql`SELECT receipt.id::text,success,reused,execution_trace
    FROM harness_shared.code_recipe_runs AS receipt WHERE recipe_id=${saved.id} ORDER BY receipt.id`;
  const replay = async (value: unknown, expected: 'success' | 'unsafe' | 'authority') => {
    const before = await rows();
    const counters = (await getRecipe(fixture.db.adminSql, saved.id))!;
    const count = dispatches.length;
    const result = data(await recipeRun.handler({ id: saved.id, authority,
      bindings: { values: { value } } } as never, context())).results[0];
    const after = await rows();
    expect(after).toHaveLength(before.length + 1);
    expect(after.slice(0, -1)).toEqual(before);
    expect(after.at(-1)).toMatchObject({ success: expected === 'success', reused: true });
    if (expected === 'success') {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { summary: { value } } });
      expect(dispatches.slice(count)).toEqual([
        { name: 'discovery:pots', args: { value } }, { name: 'lexicon:active_pack', args: { value } },
      ]);
    } else {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false, phase: 'preflight', executed: false,
        error: expected === 'unsafe' ? 'binding_invalid' : 'capability_denied' });
      expect(dispatches).toHaveLength(count);
      expect((await getRecipe(fixture.db.adminSql, saved.id))!.runCount).toBe(counters.runCount);
      expect(after.at(-1)?.execution_trace).toMatchObject({ usage: { outcome: 'refused', settled: true },
        runEvidence: { executed: false } });
    }
  };
  await replay("'; printf INJECTED; # $(printf EXTRA)", 'success');
  await replay({ script: 'unexpected executable input' }, 'unsafe');
  callerPermitted = false;
  await replay('safe typed value', 'authority');
  callerPermitted = true;
  await replay('restored typed value', 'success');
}, 120_000);

for (const family of ['sql', 'shell'] as const) {
  it(`P007 ${family}: actual typed replay and warm discovery renew source access, scope, expiry and key with immutable receipts`, async () => {
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
    expect(recipeSourceOperationSchema.safeParse(saved.capabilityManifest!.sourceOperation).success).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('PRIVATE_');
    const embedding = Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0);
    const profile = resolveProseProfileSelection('gemma', EMBEDDER_DIM_SPECS.gemma)!;
    await fixture.db.adminSql`UPDATE harness_shared.code_recipes SET embedding=${`[${embedding.join(',')}]`}::vector,
      embedding_mode='gemma', embedding_profile=${profile.profileId} WHERE id=${saved.id}`;
    const authority = data(await recipeGet.handler({ id: saved.id } as never, context())).results[0].recipe.authority;
    const hostile = "'; printf INJECTED; # $(printf EXTRA)";
    const replay = async (ctx = context(), value: unknown = hostile) => {
      const before = await fixture.db.adminSql`SELECT id::text,success,reused,execution_trace
        FROM harness_shared.code_recipe_runs AS receipt WHERE recipe_id=${saved.id} ORDER BY receipt.id`;
      const recipeBefore = (await getRecipe(fixture.db.adminSql, saved.id))!;
      const count = dispatches.length;
      const result = data(await recipeRun.handler({ id: saved.id, authority,
        bindings: { values: { value0: value } } } as never, ctx)).results[0];
      const after = await fixture.db.adminSql`SELECT id::text,success,reused,execution_trace
        FROM harness_shared.code_recipe_runs AS receipt WHERE recipe_id=${saved.id} ORDER BY receipt.id`;
      expect(after).toHaveLength(before.length + 1);
      expect(after.slice(0, -1)).toEqual(before);
      expect(after.at(-1)).toMatchObject({ success: result.ok === true, reused: true });
      if (result.ok) {
        expect(dispatches).toHaveLength(count + 1);
        if (family === 'sql') {
          expect(dispatches.at(-1)).toEqual({ name: tool, args: {
            sql: sourceArgs.sql, parameters: [hostile],
          } });
          expect(result.result.summary).toEqual({ rows: [{ private_column: hostile }] });
        } else {
          expect(dispatches.at(-1)?.args.cwd).toBe('/tmp');
          expect(result.result.summary).toEqual({ output: hostile, exit_code: 0 });
        }
      } else {
        expect(dispatches).toHaveLength(count);
        expect(result, JSON.stringify(result)).toMatchObject({ phase: 'preflight', executed: false });
        expect(JSON.stringify(result)).not.toContain('PRIVATE_');
        expect((await getRecipe(fixture.db.adminSql, saved.id))!.runCount).toBe(recipeBefore.runCount);
      }
      return result.ok === true;
    };
    expect(await replay(context(), { command: 'printf UNSAFE' })).toBe(false);
    const visible = async (ctx = context()) => {
      const searched = data(await recipeSearch.handler({ query: saved.title, semantic: false, limit: 50 } as never, ctx));
      const fetched = data(await recipeGet.handler({ id: saved.id } as never, ctx));
      const listed = data(await recipeList.handler({ includeTrivial: true, limit: 100 } as never, ctx));
      const reviewed = await recipeCandidates(fixture.db.adminSql, { minRunCount: 1 }, {
        authorizeSource: async row => Boolean(await resolveStoredSourceOperation(row,
          { workspace: ctx.workspaceId, harness: ctx.harnessSlug, catalog: orchestrationCallerSurface(ctx).catalog })),
      });
      const brief = await findTopRecipeForWake(saved.title, { sql: fixture.db.adminSql,
        queryEmbedder: { embed: async () => embedding, profile }, timeoutMs: 10_000,
        target: { ownerId: 'su-discovery-reuser', workspaceId: ctx.workspaceId!, harness: ctx.harnessSlug! },
        readPresence: async () => ({ ownerId: 'su-discovery-reuser', workspaceId: ctx.workspaceId,
          potSlug: ctx.harnessSlug, agentRole: ctx.role, stale: false, revoked: false }) as never });
      for (const value of [searched, fetched, listed, reviewed, brief]) expect(JSON.stringify(value)).not.toContain('PRIVATE_');
      return {
        search: searched.recipes.some((row: { id: string }) => row.id === saved.id),
        get: fetched.results.some((row: { id: string; ok: boolean }) => row.id === saved.id && row.ok),
        list: listed.recipes.some((row: { id: string }) => row.id === saved.id),
        review: reviewed.signals.some(row => row.id === saved.id),
        brief: brief?.id === saved.id,
        run: await replay(ctx),
      };
    };
    const allowed = { search: true, get: true, list: true, review: true, brief: true, run: true };
    const denied = { search: false, get: false, list: false, review: false, brief: false, run: false };
    expect(await visible()).toEqual(allowed);
    callerPermitted = false; expect(await visible()).toEqual(denied);
    callerPermitted = true; expect(await visible()).toEqual(allowed);
    toolPresent = false; expect(await visible()).toEqual(denied);
    toolPresent = true; expect(await visible()).toEqual(allowed);
    permitted = false; expect(await visible()).toEqual(denied);
    permitted = true; expect(await visible()).toEqual(allowed);
    expect(await visible(context({ workspaceId: 'foreign-workspace' }))).toEqual(denied);
    expect(await visible(context({ harnessSlug: 'foreign-harness' }))).toEqual(denied);
    scope = { ...originalScope, key: new Uint8Array(32).fill(84) };
    expect(await visible()).toEqual(denied);
    scope = { ...originalScope, epoch: originalScope.epoch === '2000-01' ? '2000-02' : '2000-01' };
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
