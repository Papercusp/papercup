import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { sqlMiningFixture } from '../test/_sql-mining-fixture';
import { mineSqlCandidateSlice } from './bash-substitution/sql-tool-candidates';
import { bindSqlCandidateAuthorityResolver } from './sql-tool-candidate-pull';
import type { SqlCandidateWorklist } from './sql-tool-candidate-worklist';
import { fingerprintSqlIntent } from './bash-substitution/sql-intent-fingerprint';
import type { SqlRecommendationInput } from './bash-substitution/sql-tool-recommendations';
import { z } from 'zod';
import { productionMiningScope } from './agent-opportunities/privacy';
import { readSqlToolOpportunityLane } from './scout/sql-tool-opportunity-lane';
import tool from './agent-tools/dev/sql_tool_candidates';
import recipeCandidates from './agent-tools/recipes/candidates';

// The bridge uses the real SQL corpus, worklist, history and ACL reader below.
// Independent global recipe scoring is outside this scoped SQL fixture.
vi.mock('./code-recipes-candidates', () => ({ recipeCandidates: async () => ({ promoteCandidates: [], mergeClusters: [] }) }));
vi.mock('./agent-tools/search/embedder', () => ({ buildQueryEmbedderResolved: async () => null,
  interactiveEmbedAcquireBudgetMs: () => 0 }));
vi.mock('./recipe-cooccurrence-leg', () => ({ buildRecipeCooccurrenceDep: async () => null }));
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: f.db.adminSql }),
}));

let f: Awaited<ReturnType<typeof sqlMiningFixture>>;
// Keep the expected fail-closed response independent of the production helper.
const unknown: SqlCandidateWorklist = { status: 'UNKNOWN', candidates: [], snapshots: [],
  population: { candidates: 0, returned: 0, omitted: 0, snapshotCap: 120 } };
const ctx = { workspaceId: 'sql-mining-test', harnessSlug: 'mining-test', tx: null, log: () => {},
  signal: new AbortController().signal, emit: () => {}, progress: () => {},
  principal: { kind: 'system' as const, slug: 'fixture', workspaceId: 'sql-mining-test',
    authMethod: 'process-internal' as const, trust: 'trusted' as const, capabilities: new Set(['intel:read']) } };
beforeAll(async () => {
  f = await sqlMiningFixture();
}, 120_000);
afterAll(async () => { await f?.cleanup(); });
beforeEach(async () => { await f.clear(); });
afterEach(() => { bindSqlCandidateAuthorityResolver(null); vi.unstubAllEnvs(); });

it('P006 canonical production reader works without binding a fixture resolver and closes on grant loss or source deletion', async () => {
  vi.stubEnv('PAPERCUSP_DB_ENCRYPTION_KEY', 'maintained-sql-source-composition-fixture-key');
  const now = Date.now();
  const sourceId = await f.seed('SELECT id FROM jobs', new Date(now - 1000).toISOString());
  const opts = f.opts({ now, scope: productionMiningScope(ctx.workspaceId, now) });
  expect((await mineSqlCandidateSlice(opts)).status).toBe('ok');
  const principal = { ...ctx.principal, capabilities: new Set(['*']) };
  const admin = { ...ctx, principal };
  const allowed = await readSqlToolOpportunityLane(admin);
  expect(allowed.status).toBe('ok');
  expect(allowed.candidates).toHaveLength(1);
  expect(allowed.candidates[0]!.evidenceRefs).toEqual([{ kind: 'tool-invocation', id: sourceId }]);
  expect(await tool.handler({}, admin)).toEqual({ data: allowed });
  expect(await readSqlToolOpportunityLane(ctx)).toEqual(unknown);
  principal.capabilities.clear();
  expect(await readSqlToolOpportunityLane(admin)).toEqual(unknown);
  principal.capabilities.add('*');
  const bypass = { ...ctx, isSuperuser: true, gateBypass: { capability: true } };
  expect((await readSqlToolOpportunityLane(bypass)).candidates).toHaveLength(1);
  await f.db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE id=${sourceId}::bigint`;
  expect(await readSqlToolOpportunityLane(admin)).toEqual(unknown);
  expect(await readSqlToolOpportunityLane(bypass)).toEqual(unknown);
});

it('realPG endpoint and Scout return real scoped candidates and exclude a foreign harness OUTCOME-P-008', async () => {
  const sourceId = await f.seed();
  expect((await mineSqlCandidateSlice(f.opts())).status).toBe('ok');
  bindSqlCandidateAuthorityResolver(async request => ({ ...f.opts({ harnessSlug: request.harnessSlug }),
    authorizeSource: async () => true }));
  const allowed = await readSqlToolOpportunityLane(ctx);
  expect(allowed.status).toBe('ok');
  expect(allowed.candidates).toHaveLength(1);
  expect(allowed.candidates[0]!.evidenceRefs).toEqual([{ kind: 'tool-invocation', id: sourceId }]);
  expect(allowed.snapshots).toHaveLength(1);
  expect(await tool.handler({ limit: 25 }, ctx)).toEqual({ data: allowed });
  const operator = { ...ctx, harnessSlug: '*' };
  expect(await tool.handler({ harness: 'foreign' }, operator)).toEqual({ data: unknown });
  expect(await readSqlToolOpportunityLane(operator, { harness: 'foreign' })).toEqual(unknown);
});
it('realPG endpoint and Scout hide counts, membership, history and refs on revoke, unavailable and delete R23-DERIVED-ACL', async () => {
  const ids = [await f.seed(), await f.seed()];
  await mineSqlCandidateSlice(f.opts());
  let state: 'allowed' | 'denied' | 'unavailable' = 'allowed';
  bindSqlCandidateAuthorityResolver(async () => ({ ...f.opts(), authorizeSource: async id => {
    if (state === 'unavailable') throw new Error('source authority unavailable');
    return state === 'allowed' || id !== ids[1];
  } }));
  const allowed = await readSqlToolOpportunityLane(ctx);
  expect(allowed.candidates).toHaveLength(1);
  const id = allowed.candidates[0]!.candidate.id;
  expect(await tool.handler({}, ctx)).toEqual({ data: allowed });
  for (const next of ['denied', 'unavailable'] as const) {
    state = next;
    expect(await tool.handler({}, ctx)).toEqual({ data: unknown });
    expect(await readSqlToolOpportunityLane(ctx)).toEqual(unknown);
  }
  state = 'allowed';
  expect((await readSqlToolOpportunityLane(ctx)).candidates[0]!.candidate.id).toBe(id);
  await f.db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE id=${ids[0]!}::bigint`;
  expect(await tool.handler({}, ctx)).toEqual({ data: unknown });
  expect(await readSqlToolOpportunityLane(ctx)).toEqual(unknown);
});

it('P006 recipe discovery shares SQL source revocation and never copies executable SQL into the result', async () => {
  const sourceId = await f.seed();
  expect((await mineSqlCandidateSlice(f.opts())).status).toBe('ok');
  let allowed = true;
  bindSqlCandidateAuthorityResolver(async () => ({ ...f.opts(), authorizeSource: async () => allowed }));
  const read = async () => {
    const result = await recipeCandidates.handler({ limit: 25 }, ctx);
    if (!('content' in result)) throw new Error('Expected a recipe worklist content response');
    const item = result.content[0];
    expect(item?.type).toBe('text');
    return JSON.parse(item!.type === 'text' ? item!.text : '{}');
  };
  const current = await read();
  expect(current.opportunities.sql).toEqual(await readSqlToolOpportunityLane(ctx));
  expect(current.opportunities.sql.candidates).toHaveLength(1);
  expect(current.opportunities.sql.candidates[0].evidenceRefs).toEqual([{ kind: 'tool-invocation', id: sourceId }]);
  expect(current.promoteCandidates).toEqual([]);
  expect(current).not.toHaveProperty('script');
  expect(JSON.stringify(current)).not.toContain('SELECT ');
  allowed = false;
  expect((await read()).opportunities.sql).toEqual(unknown);
  allowed = true;
  await f.db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE id=${sourceId}::bigint`;
  expect((await read()).opportunities.sql).toEqual(unknown);
});

it('P006 realPG discovery links audited contracts to retained exact examples and renews source authority after lookup', async () => {
  const query = 'SELECT id FROM jobs';
  const sourceId = await f.seed(query);
  const sourceOpts = f.opts();
  expect((await mineSqlCandidateSlice(sourceOpts)).status).toBe('ok');
  const shape = fingerprintSqlIntent(query, sourceOpts.scope);
  if (shape.status !== 'supported') throw new Error('fixture SQL must parse');
  let verdict: 'exact' | 'partial' = 'exact', deleteDuringLookup = false;
  bindSqlCandidateAuthorityResolver(async () => ({ ...sourceOpts, authorizeSource: async () => true,
    recommendationInput: async (): Promise<SqlRecommendationInput> => {
      if (deleteDuringLookup) await f.db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE id=${sourceId}::bigint`;
      const contract = { name: 'fixture:jobs', contractRef: 'fixture-output-contract', args: z.object({}) };
      return { sql: query, scope: sourceOpts.scope, sourceAuthorized: true, sourceCoverage: 'complete',
        now: sourceOpts.now!, exampleExpiresAt: sourceOpts.now! + 86400_000, candidateCoverage: 'complete',
        current: { ref: 'fixture-current', buildRef: 'fixture-current-build', coverage: 'complete', tools: [contract] },
        served: { ref: 'fixture-served', buildRef: 'fixture-served-build', coverage: 'complete', tools: [contract] },
        audits: [{ toolName: contract.name, contractRef: contract.contractRef, parserVersion: shape.version,
          fingerprint: shape.fingerprint, requiredFeatures: shape.features, fixtureRef: 'fixture-contract-case',
          resultRef: 'fixture-contract-result', verdict, args: {}, missingFeatures: verdict === 'partial' ? ['output:id'] : [] }],
      };
    },
  }));
  const exact = await readSqlToolOpportunityLane(ctx);
  expect(exact.candidates[0]!.recommendation).toMatchObject({ kind: 'route-existing', toolName: 'fixture:jobs',
    immediatelyCallable: true, fingerprint: shape.fingerprint });
  const recipeResponse = await recipeCandidates.handler({}, ctx);
  if (!('content' in recipeResponse) || recipeResponse.content[0]?.type !== 'text') throw new Error('expected recipe discovery content');
  const recipes = JSON.parse(recipeResponse.content[0].text);
  expect(recipes.opportunities.sql.candidates[0].recommendation.kind).toBe('route-existing');
  expect(JSON.stringify(recipes)).not.toContain(query);
  expect(JSON.stringify(recipes)).not.toContain('"args"');
  verdict = 'partial';
  const partial = await readSqlToolOpportunityLane(ctx);
  expect(partial.candidates[0]!.recommendation).toMatchObject({ kind: 'extend-existing', immediatelyCallable: false,
    missingFeatures: ['output:id'] });
  expect(partial.candidates[0]!.candidate).toEqual(exact.candidates[0]!.candidate);
  await f.db.adminSql`UPDATE harness_shared.sql_intent_examples
    SET captured_at=${new Date(sourceOpts.now! - 30 * 86400_000 - 1).toISOString()}::timestamptz,
      expires_at=${new Date(sourceOpts.now! - 1).toISOString()}::timestamptz`;
  const expired = await readSqlToolOpportunityLane(ctx);
  expect(expired.candidates[0]!.recommendation).toMatchObject({ kind: 'insufficient-evidence', evidenceRefs: [] });
  expect(expired.candidates[0]!.candidate.counts).toEqual(exact.candidates[0]!.candidate.counts);
  deleteDuringLookup = true;
  expect(await readSqlToolOpportunityLane(ctx)).toEqual(unknown);
  expect(await tool.handler({}, ctx)).toEqual({ data: unknown });
});
