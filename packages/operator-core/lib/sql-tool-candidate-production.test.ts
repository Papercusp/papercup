import { beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPinnedModuleState } from '@papercusp/module-singleton';
import './agent-tools/operator-tool-catalogue';
import type { ProjectedTool } from '@papercusp/agent-mcp';
import { projectedToolRegistryRevision } from '@papercusp/agent-mcp';
import type { SearchCorpusOptions } from './agent-opportunities/search-reformulation';
import { productionSqlRecommendationInput, readLoadedSqlToolCatalog, readCurrentSqlToolCatalog, readSqlCoverageAudits } from './sql-tool-candidate-production';
import { fingerprintSqlIntent } from './bash-substitution/sql-intent-fingerprint';
import { aggregateSqlDemand, observeSqlDemand } from './bash-substitution/sql-intent-corpus';
import { recommendSqlTool, sqlCoverageToken } from './bash-substitution/sql-tool-recommendations';
import { miningScopeId } from './agent-opportunities/privacy';
import type { SqlCandidateWorklistOptions } from './sql-tool-candidate-worklist';
import { rankSqlToolCandidates } from './sql-tool-candidate-score';
import type { SqlCandidateReadOptions, SqlCandidateSnapshot } from './bash-substitution/sql-tool-candidates';

const host = vi.hoisted(() => ({ sql: vi.fn(), list: vi.fn(), generation: vi.fn() }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: host.sql }),
}));
vi.mock('@papercusp/agent-mcp', async original => ({
  ...await original<typeof import('@papercusp/agent-mcp')>(), listAllProjectedTools: host.list,
}));
vi.mock('./serving-generation', () => ({ readServingGeneration: host.generation }));

const now = Date.parse('2026-11-07T00:00:00Z');
const scope = { workspaceId: 'fixture', sourceBoundary: 'fixture-ledger', epoch: '2026-11',
  key: new Uint8Array(32).fill(71) };
const query = 'SELECT id FROM jobs';
const shape = fingerprintSqlIntent(query, scope);
if (shape.status !== 'supported') throw new Error('maintained shape must parse');
const example = { canonical: shape.canonical, features: shape.features };
const summary = aggregateSqlDemand([observeSqlDemand({ workspaceId: scope.workspaceId, harnessSlug: 'fixture',
  namespace: 'ledger', callId: '1', resultCallId: '1', identityAuthority: 'ledger', provider: 'ledger',
  actor: 'fixture-agent', verifiedAgent: true, at: new Date(now - 1000).toISOString(), origin: 'agent',
  status: 'ok', durationMs: 10, sql: query, sourceComplete: true, copyRef: '1' }, scope)],
{ status: 'complete', scannedRows: 1, cap: 100, retention: 'complete', providers: ['ledger'] });
const candidate = rankSqlToolCandidates(summary).candidates[0]!;
const snapshot: SqlCandidateSnapshot = { ranOn: '2026-11-07', summary, examples: [example], sourceIds: ['1'] };
const definition = (): ProjectedTool => ({ pluginName: 'agent-mcp', description: 'maintained fixture',
  expose: { mcp: { name: 'fixture:jobs' } }, capabilities: [], fn: async () => ({ content: [] }),
  inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
    required: ['limit'], additionalProperties: false }, outputJsonSchema: { type: 'array', items: { type: 'string' } },
});
const options = (): SqlCandidateReadOptions => ({ workspaceId: scope.workspaceId, harnessSlug: 'fixture', scope,
  now, authorize: vi.fn(async () => true), authorizeSource: vi.fn(async () => true) });

beforeEach(() => {
  vi.clearAllMocks();
  readPinnedModuleState<{ loaded: boolean }>('@papercusp/operator-core.operator-tool-catalogue')!.loaded = true;
  host.list.mockReturnValue([definition()]);
  host.generation.mockImplementation(async ({ toolRegistryRevision }) => ({ state: 'known',
    revision: 'generation:' + toolRegistryRevision, buildSha: 'fixture-baked-build',
    appliedMigrationDigest: 'fixture-applied-schema', toolRegistryRevision }));
  host.sql.mockResolvedValue([{ id: '1', query, example, expires_at: new Date(now + 1000) }]);
});

it('refuses a partially registered catalogue even when its registered contracts and generation are valid', async () => {
  readPinnedModuleState<{ loaded: boolean }>('@papercusp/operator-core.operator-tool-catalogue')!.loaded = false;
  expect(await readLoadedSqlToolCatalog()).toMatchObject({ coverage: 'unknown', tools: [] });
});

it('invalidates catalogue completion revoked during generation IO', async () => {
  host.generation.mockImplementationOnce(async ({ toolRegistryRevision }) => {
    readPinnedModuleState<{ loaded: boolean }>('@papercusp/operator-core.operator-tool-catalogue')!.loaded = false;
    return { state: 'known', revision: 'generation:' + toolRegistryRevision };
  });
  expect(await readLoadedSqlToolCatalog()).toMatchObject({ coverage: 'unknown', tools: [] });
});

it('binds actual input bounds and output declarations to the loaded build, never checkout HEAD', async () => {
  const catalog = await readLoadedSqlToolCatalog();
  expect(catalog.coverage).toBe('complete');
  expect(catalog.tools[0]!.args.safeParse({ limit: 5 }).success).toBe(true);
  expect(catalog.tools[0]!.args.safeParse({ limit: 101 }).success).toBe(false);
  const changed = definition(); changed.outputJsonSchema = { type: 'boolean' };
  host.list.mockReturnValue([changed]);
  expect((await readLoadedSqlToolCatalog()).tools[0]!.contractRef).not.toBe(catalog.tools[0]!.contractRef);
  host.generation.mockImplementation(async ({ toolRegistryRevision }) => ({ state: 'known',
    revision: 'new-baked-generation:' + toolRegistryRevision, buildSha: 'other-baked-build',
    appliedMigrationDigest: 'fixture-applied-schema', toolRegistryRevision }));
  expect((await readLoadedSqlToolCatalog()).tools[0]!.contractRef).not.toBe(catalog.tools[0]!.contractRef);
});

it('invalidates a snapshot when registry or serving generation changes during its read', async () => {
  const original = definition(), changed = definition(); changed.description = 'new edition';
  host.list.mockReturnValueOnce([original]).mockReturnValueOnce([changed]);
  expect((await readLoadedSqlToolCatalog()).coverage).toBe('unknown');
  host.list.mockReturnValue([original]);
  host.generation.mockResolvedValueOnce({ state: 'known', revision: 'old' })
    .mockResolvedValueOnce({ state: 'known', revision: 'new' });
  expect((await readLoadedSqlToolCatalog()).coverage).toBe('unknown');
  expect(projectedToolRegistryRevision([original])).not.toBe(projectedToolRegistryRevision([changed]));
});

it('refuses unknown build, uncompilable schema and unattested installed plugin implementation', async () => {
  host.generation.mockResolvedValueOnce({ state: 'unknown', reason: 'build-sha-unknown' });
  expect((await readLoadedSqlToolCatalog()).tools).toEqual([]);
  const invalid = definition(); invalid.inputSchema = { $ref: 'missing-definition' };
  host.list.mockReturnValue([invalid]);
  expect((await readLoadedSqlToolCatalog()).coverage).toBe('unknown');
  const plugin = definition(); plugin.pluginInstallation = { version: 'v1', path: '/fixture', source: 'project' };
  host.list.mockReturnValue([plugin]);
  expect(await readLoadedSqlToolCatalog()).toMatchObject({ coverage: 'unknown', tools: [] });
});

it('binds the current source closure and refuses changed bytes, dirty/new sources, different builds and races', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sql-current-catalog-'));
  try {
    const file = join(root, 'handler.ts'), bytes = Buffer.from('export const current = true;');
    await writeFile(file, bytes);
    const sha = 'a'.repeat(40), blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    const artifact = () => ({ status: 'measured' as const, sourceSha: sha, bundleSha256: 'b'.repeat(64),
      manifestSha256: 'c'.repeat(64), sourceBlobs: { 'handler.ts': blob }, evidenceRef: 'fixture:measured-input' });
    // The source seam is a unit control. Actual operator acceptance must use
    // the default Git reader and a boot-measured artifact, not this fixture.
    const source = vi.fn(async () => sha), loaded = await readLoadedSqlToolCatalog();
    expect(await readCurrentSqlToolCatalog(loaded, { root, artifact, source })).toEqual(loaded);
    await writeFile(file, 'export const current = false;');
    expect((await readCurrentSqlToolCatalog(loaded, { root, artifact, source })).coverage).toBe('unknown');
    await writeFile(file, bytes);
    source.mockRejectedValueOnce(Error('dirty or untracked source'));
    expect((await readCurrentSqlToolCatalog(loaded, { root, artifact, source })).coverage).toBe('unknown');
    source.mockResolvedValueOnce('d'.repeat(40));
    expect((await readCurrentSqlToolCatalog(loaded, { root, artifact, source })).coverage).toBe('unknown');
    source.mockResolvedValueOnce(sha).mockResolvedValueOnce('d'.repeat(40));
    expect((await readCurrentSqlToolCatalog(loaded, { root, artifact, source })).coverage).toBe('unknown');
    const changed = definition(); changed.description = 'registry changed during source read';
    host.list.mockReturnValue([changed]);
    expect((await readCurrentSqlToolCatalog(loaded, { root, artifact, source })).coverage).toBe('unknown');
    expect((await readCurrentSqlToolCatalog(loaded, { root, artifact: () => null, source })).coverage).toBe('unknown');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('hydrates the exact authorized retained shape while keeping missing executed proof and source catalog UNKNOWN', async () => {
  const opts = options(), input = await productionSqlRecommendationInput(candidate, opts, snapshot);
  expect(input).toMatchObject({ sql: query, sourceAuthorized: true, exampleExpiresAt: now + 1000,
    served: { coverage: 'complete' }, current: { coverage: 'unknown' }, audits: [], candidateCoverage: 'unknown' });
  expect(recommendSqlTool(input!)).toMatchObject({ kind: 'insufficient-evidence', immediatelyCallable: false });
  expect(opts.authorizeSource).toHaveBeenCalledWith('1');
});

it('checks scope and every source before reading raw arguments and again after async catalog lookup', async () => {
  const opts = options();
  vi.mocked(opts.authorizeSource).mockResolvedValue(false);
  expect(await productionSqlRecommendationInput(candidate, opts, snapshot)).toBeNull();
  expect(host.sql).not.toHaveBeenCalled();
  vi.mocked(opts.authorizeSource).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(await productionSqlRecommendationInput(candidate, opts, snapshot)).toBeNull();
  expect(host.sql).toHaveBeenCalledTimes(1);
});

it('rejects expired, secret-bearing, neighboring and no-longer-retained source queries', async () => {
  for (const patch of [ { expires_at: new Date(now) }, { query: 'SELECT state FROM jobs' },
    { query: "SELECT id FROM jobs WHERE password='credential'" }, { example: { ...example, canonical: 'changed' } } ]) {
    host.sql.mockResolvedValue([{ id: '1', query, example, expires_at: new Date(now + 1000), ...patch }]);
    expect(await productionSqlRecommendationInput(candidate, options(), snapshot)).toBeNull();
  }
  host.sql.mockResolvedValue([{ id: '1', query, example, expires_at: new Date(now + 1000) }]);
  expect(await productionSqlRecommendationInput(candidate, options(), { ...snapshot, examples: [] })).toBeNull();
});

it('keeps bounded, unavailable and incomplete source evidence out of positive coverage claims', async () => {
  const row = { id: '1', query, example, expires_at: new Date(now + 1000) };
  host.sql.mockResolvedValue(Array.from({ length: 101 }, () => row));
  expect(await productionSqlRecommendationInput(candidate, options(), snapshot)).toBeNull();
  host.sql.mockRejectedValue(new Error('fixture ledger unavailable'));
  expect(await productionSqlRecommendationInput(candidate, options(), snapshot)).toBeNull();
  host.sql.mockResolvedValue([row]);
  const input = await productionSqlRecommendationInput(candidate, options(), { ...snapshot,
    summary: { ...summary, coverage: { ...summary.coverage, retention: 'gap' } } });
  expect(input?.sourceCoverage).toBe('unknown');
});

/** Canonical reader unit controls. Real invocation production is exercised by
 * the maintained runtime suite; these rows alone never prove live coverage. */
type CoverageOutput = NonNullable<Awaited<ReturnType<SearchCorpusOptions['readOutput']>>>;

function coverageFixture() {
  if (shape.status !== 'supported') throw new Error('expected supported shape');
  const rows = [{ id: 'synthetic-job' }], sqlArgs = { sql: query }, toolArgs = { limit: 5 };
  const token = (domain: 'args' | 'rows' | 'features', value: unknown) => sqlCoverageToken(scope, 'fixture', domain, value)!;
  const receipt = (toolName: string, callId: string, args: unknown) => ({ schemaVersion: 1, callId,
    workspaceId: scope.workspaceId, harness: 'fixture', scopeId: miningScopeId(scope, 'fixture'), toolName,
    contractRef: toolName === 'dev:pg_query' ? 'sql-contract' : 'target-contract',
    startedAt: now - 500, endedAt: now - 400, outcome: 'ok', argsToken: token('args', args),
    resultToken: token('rows', rows), sourceFingerprint: 'd'.repeat(64), buildSha: 'e'.repeat(40),
    artifactFingerprint: 'f'.repeat(64), environmentFingerprint: '1'.repeat(64) });
  const sqlReceipt = receipt('dev:pg_query', 'sql-call', sqlArgs);
  const toolReceipt = receipt('fixture:jobs', 'tool-call', toolArgs);
  const hint = { caseKey: 'suite > exact jobs', occurrence: 1, fixtureRef: 'fixture:jobs-v1',
    scopeId: miningScopeId(scope, 'fixture'), parserVersion: shape.version, fingerprint: shape.fingerprint,
    featuresToken: token('features', shape.features), contractRef: 'target-contract', verdict: 'exact',
    missingFeatures: [], sqlExecution: sqlReceipt, toolExecution: toolReceipt };
  const run = { id: 10, status: 'pass', source: 'local', commit_sha: 'e'.repeat(40),
    started_at: new Date(now - 1000), finished_at: new Date(now - 100), execution_details: {
      schemaVersion: 1, root: '/maintained-fixture', filePath: 'jobs.integration.test.ts', runGroupId: 'fixture',
      workspaceId: scope.workspaceId, harnessSlug: 'fixture', testNamePattern: null, testLayer: 'integration',
      passed: 1, failed: 0, skipped: 0, collectionFailed: false, mutationPhase: null,
      commitSha: 'e'.repeat(40), worktreeDirty: false, sqlCoverageObservations: [hint] } };
  const cases = [{ case_key: hint.caseKey, occurrence: 1, status: 'pass' }];
  const invocations = [sqlReceipt, toolReceipt].map((own, i) => ({ id: String(11 + i), tool_name: own.toolName,
    status: 'ok', args_json: i === 0 ? sqlArgs : toolArgs, output_ref: 'fixture-output-' + i,
    serving_build_sha: own.buildSha, metadata_json: { sqlCoverageExecution: own } }));
  const ledger = vi.fn(async (parts: TemplateStringsArray) => {
    const text = parts.join('?');
    if (text.includes('test_case_runs')) return cases;
    if (text.includes('tool_invocations')) return invocations;
    if (text.includes('test_runs')) return [run];
    throw new Error('unexpected SQL reader');
  });
  Object.assign(ledger, { json: (value: unknown) => value });
  const opts = { ...options(), client: ledger, rowBudget: 100, timeBudgetMs: 1000,
    retainedFrom: new Date(now - 1000).toISOString() } as unknown as SqlCandidateWorklistOptions;
  const catalog = { ref: 'fixture-registry', buildRef: 'fixture-generation', coverage: 'complete' as const,
    tools: [{ name: 'fixture:jobs', contractRef: 'target-contract', sourceFingerprint: 'd'.repeat(64),
      args: { safeParse: (value: unknown) => ({ success: JSON.stringify(value) === JSON.stringify(toolArgs) }) } } ] };
  const outputValue = (over: Partial<CoverageOutput> = {}): CoverageOutput => ({ callId: 'fixture',
    provider: 'ledger', namespace: 'operator-dispatch', complete: true,
    body: { rows, rowCount: 1, truncated: false }, ...over });
  const output = vi.fn<SearchCorpusOptions['readOutput']>(async () => outputValue());
  const read = () => readSqlCoverageAudits(opts, shape, [catalog], { readOutput: output });
  return { rows, run, cases, invocations, ledger, opts, output, outputValue, read, hint, catalog };
}

it('joins exact passing run/case and both independently written executions with authorized retained bytes', async () => {
  const f = coverageFixture();
  expect(await f.read()).toEqual([{ toolName: 'fixture:jobs', contractRef: 'target-contract',
    parserVersion: shape.version, fingerprint: shape.status === 'supported' ? shape.fingerprint : '',
    requiredFeatures: shape.status === 'supported' ? shape.features : {}, fixtureRef: f.hint.fixtureRef,
    resultRef: 'test-run:10:case:1:sql-call:tool-call', verdict: 'exact', missingFeatures: [], args: { limit: 5 } }]);
  expect(f.output).toHaveBeenCalledTimes(2);
  expect(f.opts.authorizeSource).toHaveBeenCalledWith('11');
  expect(f.opts.authorizeSource).toHaveBeenCalledWith('12');
});

it('rejects failed, dirty, mutation, unparsed, cross-scope, wrong-layer and failing-case evidence', async () => {
  for (const change of [
    (f: ReturnType<typeof coverageFixture>) => { f.run.status = 'fail'; },
    (f: ReturnType<typeof coverageFixture>) => { f.run.execution_details.worktreeDirty = true; },
    (f: ReturnType<typeof coverageFixture>) => { f.run.source = 'mutation-probe'; },
    (f: ReturnType<typeof coverageFixture>) => { Object.assign(f.run.execution_details, { guessed: true }); },
    (f: ReturnType<typeof coverageFixture>) => { f.run.execution_details.workspaceId = 'foreign'; },
    (f: ReturnType<typeof coverageFixture>) => { f.run.execution_details.testLayer = 'unit'; },
    (f: ReturnType<typeof coverageFixture>) => { f.cases[0]!.status = 'fail'; },
    (f: ReturnType<typeof coverageFixture>) => { f.cases.push(f.cases[0]!); },
    (f: ReturnType<typeof coverageFixture>) => { f.run.finished_at = new Date(now - 600); },
  ]) {
    const f = coverageFixture(); change(f); expect(await f.read()).toEqual([]);
  }
});

it('rejects forged/replayed invocation custody, mismatched args, stale contracts and unavailable or clipped output', async () => {
  for (const change of [
    (f: ReturnType<typeof coverageFixture>) => { f.invocations[1]!.status = 'error'; },
    (f: ReturnType<typeof coverageFixture>) => { f.invocations[1]!.metadata_json.sqlCoverageExecution = {
      ...f.invocations[1]!.metadata_json.sqlCoverageExecution, resultToken: '0'.repeat(64) }; },
    (f: ReturnType<typeof coverageFixture>) => { f.invocations.push(f.invocations[1]!); },
    (f: ReturnType<typeof coverageFixture>) => { f.invocations[1]!.args_json = { limit: 99 }; },
    (f: ReturnType<typeof coverageFixture>) => { f.invocations[0]!.args_json = { sql: 'SELECT state FROM jobs' }; },
    (f: ReturnType<typeof coverageFixture>) => { f.catalog.tools[0]!.contractRef = 'new-contract'; },
    (f: ReturnType<typeof coverageFixture>) => { f.output.mockResolvedValue(null); },
    (f: ReturnType<typeof coverageFixture>) => { f.output.mockResolvedValue(f.outputValue({ complete: false })); },
    (f: ReturnType<typeof coverageFixture>) => { f.output.mockResolvedValue(f.outputValue({
      body: { rows: f.rows, truncated: true } })); },
  ]) {
    const f = coverageFixture(); change(f); expect(await f.read()).toEqual([]);
  }
});

it('renews proof source authority after IO and refuses output/ledger mutation or an oversized proof population', async () => {
  const denied = coverageFixture(); vi.mocked(denied.opts.authorizeSource).mockResolvedValue(false);
  expect(await denied.read()).toEqual([]); expect(denied.output).not.toHaveBeenCalled();
  const revoked = coverageFixture(); revoked.output.mockImplementation(async () => {
    vi.mocked(revoked.opts.authorizeSource).mockResolvedValue(false);
    return { callId: 'fixture', provider: 'ledger', namespace: 'operator-dispatch', complete: true,
      body: { rows: revoked.rows, rowCount: 1, truncated: false } };
  });
  expect(await revoked.read()).toEqual([]);
  const moved = coverageFixture(); moved.ledger.mockImplementationOnce(async () => [moved.run])
    .mockImplementationOnce(async () => moved.cases).mockImplementationOnce(async () => structuredClone(moved.invocations))
    .mockImplementationOnce(async () => []);
  expect(await moved.read()).toEqual([]);
  const oversized = coverageFixture(); oversized.ledger.mockResolvedValue(Array<typeof oversized.run>(33).fill(oversized.run));
  expect(await oversized.read()).toEqual([]);
});

it('rejects passing run or case evidence revoked while private outputs are being read', async () => {
  for (const revoke of [
    (f: ReturnType<typeof coverageFixture>) => { f.run.status = 'fail'; },
    (f: ReturnType<typeof coverageFixture>) => { f.cases[0]!.status = 'fail'; },
    (f: ReturnType<typeof coverageFixture>) => { f.run.execution_details.worktreeDirty = true; },
  ]) {
    const f = coverageFixture(), query = f.ledger.getMockImplementation()!;
    // PostgreSQL returns separate snapshots, unlike shared mock object refs.
    f.ledger.mockImplementation(async parts => structuredClone(await query(parts)));
    f.output.mockImplementation(async () => {
      revoke(f);
      return { callId: 'fixture', provider: 'ledger', namespace: 'operator-dispatch', complete: true,
        body: { rows: f.rows, rowCount: 1, truncated: false } };
    });
    expect(await f.read()).toEqual([]);
  }
});
