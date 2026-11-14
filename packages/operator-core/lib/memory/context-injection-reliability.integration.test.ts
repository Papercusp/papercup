/** Production adapter -> endpoint -> real query/builder integration. External
 * storage/index/identity services are deterministic fixtures. These query tests
 * do not certify native emission. The database-independent R-7 cases live in
 * native-mcp-export.integration.test.ts. Neither suite proves shipment. */
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCache } from '@papercusp/cache';
import ts from 'typescript';
import { firstPartyCallers } from '../code-intelligence/first-party-callers';
import { runSelectiveAssist, type AssistIntent } from '../code-intelligence/selective-assist';
import { buildConsumerEvidence, evaluateConsumerEvidence, gateConsumerRating } from '../code-intelligence/consumer-evidence';
import type { GitnexusDispatch } from '../code-intelligence/gitnexus-facade';
import { getMemoryBlockBoundedResult, MEMORY_CANONICAL_CACHE_TAG } from './injection-block-cache';
import * as codex from '../../../../apps/operator/scripts/hooks/inject/adapters/codex.mjs';
import * as claude from '../../../../apps/operator/scripts/hooks/inject/adapters/claude.mjs';
import * as omp from '../../../../apps/operator/scripts/hooks/inject/adapters/omp.mjs';
import { postInjection } from '../../../../apps/operator/scripts/hooks/inject/core.mjs';
import { openDeliveryLedger } from '../../../../apps/operator/scripts/hooks/inject/delivery-ledger.mjs';
import * as injection from './injection';
import * as corpusIo from './corpus-recall-io';
import * as recallStats from './recall-stats';
import { setSessionConfinementResolver } from '../capability-envelope/session-confinement-port';
import { resetMemoryDegradedForTest } from './op-deadline';
import { _resetSessionEpochLedgerForTests, confirmMemoryEmission, MEMORY_EMISSION_TTL_MS,
  type MemoryEmissionConfirmation, type MemoryFragmentOffer } from './session-epoch-ledger';
import { getOrgPg } from '@papercusp/db-org';
import { computeTurnDoors, contextPackingCarrier, optionalRecallContextCandidates, packContextCandidates, validateContextPackingResult, type ContextCandidate } from '../context-doors';
import { appendAdvisories } from '../../../../apps/operator/scripts/hooks/omp/non-preempting-delivery';
import { saveContextPackingReceipt, loadContextPackingReceipt, pageContextPackingReceipt,
  type ContextPackingScope } from '../context-packing-receipts';
import { selectCorpusLines, renderCorpusBlock } from './corpus-recall';
import { configureReadCursorStore, InMemoryReadCursorStore, resetReadCursorStore } from '../agent-tools/coordination/read-cursors';
import routes from '../endpoint-route/routes/agent-mcp/mid-turn-context';
import { DELIVERY_MATRIX_CLIENTS, DELIVERY_MATRIX_FAULTS, DELIVERY_MATRIX_EXTRA_SINKS,
  deliveryMatrixPopulation, deliveryMatrixCellKey, deliveryTerminalOracle, validateDeliveryMatrix,
  type DeliveryMatrixManifest, GROUNDED_QUERY_CASES, validateGroundedQueryArtifact,
  CACHE_IDENTITY_CASES, validateCacheIdentityArtifact, type CacheIdentityCell, type CacheIdentityArtifact,
  OPERATIVE_UNIT_CONDITIONS, OPERATIVE_UNIT_BOUNDARIES, validateOperativeUnitArtifact,
  type OperativeUnitCell, type OperativeUnitArtifact,
  type GroundedQueryArtifact, type GroundedQueryCell } from './injection-delivery-coverage';
import { CONSUMER_IMPACT_CASES, CONSUMER_IMPACT_BOUNDARIES, consumerImpactSourceFingerprint,
  validateConsumerImpactArtifact, type ConsumerImpactArtifact, type ConsumerImpactCell } from './injection-delivery-coverage';
import { SOURCE_REVISION_CASES, validateSourceRevisionArtifact,
  type SourceRevisionArtifact, type SourceRevisionCell } from './injection-delivery-coverage';
import { contextSourceVersion, contextSourceChangeNotice } from './temporal-render';
import type { OrgTestDb } from '../../test/_org-test-db';
import { sampleFinalDeliveredContext, validateFinalDeliveredContextSample,
  attributeFinalContextTranscript, type FinalContextTranscriptSource,
  type FinalContextAttemptSnapshot } from './injection-delivery-coverage';
import { recordRubricCheckResults, readLatestRubricCheckResults,
  type RubricCheckResult } from '../check-results-ledger';
import { fillRatingsFromLedger } from '../scorecard-ledger-fill';
import { retainMeasurementProvenance } from '../measurement-provenance';

const services = vi.hoisted(() => ({
  unavailable: false,
  control: { generation: 1, applied: 'cache-fixture-identity', scope: 'cache-fixture-task' },
  search: vi.fn(), lexical: vi.fn(), readMemory: vi.fn(), coverage: vi.fn(), writes: vi.fn(),
  packingArtifacts: new Map<string, string>(), packingIndexes: new Map<string, string>(),
}));
// Deterministic storage fixture, with the real immutable packing writer/reader.
// This does not certify PostgreSQL or native emission.
vi.mock('../text-artifacts', () => ({
  saveImmutableTextArtifact: async (harness: string, content: string) => {
    const sha256 = createHash('sha256').update(content).digest('hex');
    services.packingArtifacts.set(`${harness}/${sha256}`, content);
    return { sha256, relPath: `immutable/sha256/${sha256}.json` };
  },
  loadImmutableTextArtifact: async (harness: string, sha256: string) => services.packingArtifacts.get(`${harness}/${sha256}`) ?? null,
  claimImmutableTextArtifact: async (harness: string, path: string, content: string) => {
    const key = `${harness}/${path}`;
    if (services.packingIndexes.has(key)) {
      if (services.packingIndexes.get(key) !== content) throw new Error('text_artifact_immutable_claim_conflict');
      return false;
    }
    services.packingIndexes.set(key, content); return true;
  },
  loadImmutableTextArtifactClaim: async (harness: string, path: string) => services.packingIndexes.get(`${harness}/${path}`) ?? null,
}));
vi.mock('@papercusp/db-org', async orig => {
  const identifierKey = Symbol('fixture-sql-identifier');
  type Identifier = { [identifierKey]: string };
  const isIdentifier = (value: unknown): value is Identifier =>
    typeof value === 'object' && value !== null && identifierKey in value;
  return { ...await orig<typeof import('@papercusp/db-org')>(),
    getOrgPg: () => ({ sql: (parts: TemplateStringsArray | string, ...values: unknown[]) => {
      // postgres.sql(name) is synchronous; only tagged queries return rows.
      if (typeof parts === 'string') return { [identifierKey]: parts };
      const query = parts.reduce((text, part, index) =>
        text + part + (isIdentifier(values[index]) ? values[index][identifierKey] : ''), '');
      if (query.includes('control_generation AS generation')) return Promise.resolve([{ ...services.control }]);
      if (/INSERT INTO harness_shared\.(memory|corpus)_session_surfaced/.test(query)) {
        return Promise.resolve(services.writes(query, values) ?? [{}]);
      }
      return Promise.resolve([]);
    } }),
  };
});
vi.mock('./backend', () => {
  const backend = { name: 'query-integration-fixture',
  available: async () => ({ ok: !services.unavailable }), search: services.search, searchLexical: services.lexical,
    listPage: services.readMemory,
  };
  return { getMemoryBackend: () => backend };
});
vi.mock('./mid-turn-admission', () => ({
  withIdentityBoundedMemoryAdmission: async (_read: unknown, run: (bounds: null) => Promise<unknown>) => ({ admitted: true, value: await run(null) }),
}));
vi.mock('../agent-identities/identity-recall', async original => ({
  ...await original<typeof import('../agent-identities/identity-recall')>(),
  readAppliedIdentityRecall: async () => null,
}));
vi.mock('../agent-identities/sync-hook-rules', () => ({ evaluateHookContextSink: async () => ({ text: '', result: null }) }));
vi.mock('../code-intelligence/push-channel', () => ({ codeIntelPushText: async () => '' }));
vi.mock('../failure-loop-circuit-breaker', async orig => ({ ...await orig<typeof import('../failure-loop-circuit-breaker')>(),
  takePendingFailureLoopHint: () => null,
}));
vi.mock('./agent-signals', () => ({ resolveClaimedWorkItemIdForOwner: async () => undefined }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'query-fixture-ws' }));
vi.mock('../auth', () => ({ getSessionUserOrDefault: async () => ({ id: 'query-fixture-user' }) }));
vi.mock('../harness-registry', () => ({ loadHarnessRegistry: async () => ({ projects: [] }) }));
vi.mock('../blueprint/package-memory-visibility', async original => ({
  ...await original<typeof import('../blueprint/package-memory-visibility')>(),
  wearerPackageResourcesOrEmpty: async () => new Set(),
}));
vi.mock('./jev-settings', () => ({ JEV_MEMORY_TIMEOUT_MS: 800,
  getJevMode: async () => 'off', resolveJevMemoryInjection: async () => ({ mode: 'off', keyPresent: false, effective: 'off' }),
  ensureJevDecisionClient: vi.fn(),
}));

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Signals = GroundedQueryCell['signals'];
// Independent fixture oracle: literal normalized fields and canonical wire hash,
// not another invocation of the extractor being tested.
function signal(fields: Partial<Pick<Signals, 'ids' | 'symbols' | 'paths' | 'task' | 'search' | 'errors'>> = {}): Signals {
  const parts = { ids: [], symbols: [], paths: [], task: [], search: [], errors: [], ...fields };
  const semantic = [...parts.task, ...parts.search, ...parts.errors].join(' ');
  const lexical = [...parts.ids, ...parts.symbols, ...parts.paths, ...parts.task, ...parts.search, ...parts.errors].join(' ');
  const normalized = { version: 1 as const, ...parts, semantic, lexical };
  return { ...normalized, fingerprint: sha(normalized) };
}
type Fixture = { tool: string; input: unknown; response?: string; expected: Signals; unavailable?: boolean };
const fixtures: Record<typeof GROUNDED_QUERY_CASES[number], Fixture> = {
  task: { tool: 'exec_command', input: { cmd: 'node -e "' + 'x'.repeat(2000) + '"', justification: 'repair delivery receipt' }, expected: signal({ task: ['repair delivery receipt'] }) },
  symbol: { tool: 'Grep', input: { pattern: 'buildMemoryContextBlock' }, expected: signal({ symbols: ['buildMemoryContextBlock'] }) },
  path: { tool: 'Read', input: { file_path: 'src/memory/injection.ts' }, expected: signal({ paths: ['src/memory/injection.ts'] }) },
  search: { tool: 'Grep', input: { pattern: 'lost delivery receipt' }, expected: signal({ search: ['lost delivery receipt'] }) },
  error: { tool: 'Read', input: { file_path: 'src/memory.ts' }, response: 'TypeError: failed', expected: signal({ paths: ['src/memory.ts'], errors: ['TypeError'] }) },
  'exact-id': { tool: 'Grep', input: { pattern: 'WI-6512' }, expected: signal({ ids: ['WI-6512'] }) },
  'shell-negative': { tool: 'Bash', input: { command: 'pwd && git status' }, expected: signal() },
  'javascript-negative': { tool: 'exec', input: 'const x = await tools.exec_command({cmd: "echo WI-6512"}); text(x)', expected: signal() },
  'heredoc-negative': { tool: 'exec_command', input: { cmd: "python3 - <<'PY'\nprint('WI-6512')\nPY" }, expected: signal() },
  'serialized-json-negative': { tool: 'Grep', input: { pattern: '{"query":"WI-6512"}' }, expected: signal() },
  'truncated-json-negative': { tool: 'Grep', input: '{"pattern":"WI-6512"', expected: signal() },
  'lexical-only': { tool: 'Bash', input: { command: 'rg WI-6512', description: 'repair delivery receipt' }, unavailable: true,
    expected: signal({ ids: ['WI-6512'], task: ['repair delivery receipt'] }) },
};
const endpoint = routes[0] as unknown as { handler(req: Request): Promise<Response> };
const originalPrepareMemoryContextBlock = injection.prepareMemoryContextBlock;
let sequence = 0;
// Retain actual observations using the test framework's attachment surface.
// These hashes identify a current-tree fixture run, never a serving build or
// independent acceptance receipt. The runner records the invocation separately.
const sourceSnapshot = [
  '../context-doors.ts', '../context-packing-receipts.ts', '../text-artifacts.ts',
  './injection.ts', './injection-delivery-coverage.ts', './context-injection-reliability.integration.test.ts',
  './injection-block-cache.ts', '../auth.ts', '../agent-tools/coordination/control-anchor.ts',
  '../code-intelligence/selective-assist.ts', '../code-intelligence/consumer-evidence.ts',
  '../code-intelligence/first-party-callers.ts', '../code-intelligence/gitnexus-facade.ts',
  './temporal-render.ts', './corpus-recall.ts', './session-epoch-ledger.ts', './corpus-surfaced-ledger.ts',
  '../endpoint-route/routes/agent-mcp/operator-converse.ts', '../agent-tools/operator/converse-prompt.ts',
  '../endpoint-route/routes/agent-mcp/turn-start-memory.ts', '../../../../libs/generic/cache/src/cache.ts',
  '../endpoint-route/routes/agent-mcp/mid-turn-context.ts', '../../vitest.config.ts',
  '../../../../apps/operator/scripts/hooks/inject/core.mjs',
  '../../../../apps/operator/scripts/hooks/inject/delivery-ledger.mjs',
  '../../../../apps/operator/scripts/hooks/inject/recall-query.mjs',
  '../../../../apps/operator/scripts/hooks/inject/ports.mjs',
  ...['codex', 'claude', 'omp'].map(client => `../../../../apps/operator/scripts/hooks/inject/adapters/${client}.mjs`),
].map(path => ({ path, sha256: createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex') }));

beforeEach(() => {
  services.packingArtifacts.clear(); services.packingIndexes.clear();
  vi.stubEnv('PAPERCUSP_SID', 'query-fixture-session');
  setSessionConfinementResolver(() => null);
  configureReadCursorStore(new InMemoryReadCursorStore());
  _resetSessionEpochLedgerForTests();
  resetMemoryDegradedForTest();
  services.unavailable = false;
  services.writes.mockReset();
  services.readMemory.mockReset().mockResolvedValue({ entries: [], total: 0 });
  services.control = { generation: 1, applied: 'cache-fixture-identity', scope: 'cache-fixture-task' };
  const rows = async (_query: string, opts: { scope: string[] }) => [
    { id: '11111111-1111-4111-8111-111111111111', text: 'grounded query fixture result', score: 0.95, scope: opts.scope[0] },
    { id: '22222222-2222-4222-8222-222222222222', text: 'below lexical relevance floor', score: 0.001, scope: opts.scope[0] },
  ];
  services.search.mockReset().mockImplementation(async (...args) => (await rows(args[0], args[1])).slice(0, 1));
  services.lexical.mockReset().mockImplementation(rows);
  vi.spyOn(injection, 'prepareMemoryContextBlock');
  vi.spyOn(recallStats, 'recordRecallStats').mockResolvedValue(undefined);
  vi.spyOn(corpusIo, 'recallCorpusContext').mockResolvedValue({ block: null, outcome: 'ok',
    rerank: 'nothing-to-reorder', legs: null, retrievalDepth: 0, hits: [], diagnostics: [] } as unknown as corpusIo.CorpusRecallResult);
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); resetReadCursorStore();
  setSessionConfinementResolver(undefined);
});

it('supports synchronous SQL identifiers without interpreting parameter values as query text', async () => {
  const { sql } = getOrgPg();
  const table = sql('harness_shared.memory_session_surfaced');
  expect(table).not.toBeInstanceOf(Promise);
  await expect(sql`SELECT payload FROM ${table}`).resolves.toEqual([]);
  await expect(sql`INSERT INTO ${table} VALUES (${'fixture'})`).resolves.toEqual([{}]);
  expect(services.writes).toHaveBeenCalledOnce();
  services.writes.mockClear();
  await expect(sql`SELECT ${'INSERT INTO harness_shared.memory_session_surfaced'}`).resolves.toEqual([]);
  expect(services.writes).not.toHaveBeenCalled();
});

function digest(client: typeof DELIVERY_MATRIX_CLIENTS[number], fixture: Fixture) {
  if (client === 'codex') return codex.parse('mid-turn', { tool_name: fixture.tool, tool_input: fixture.input, tool_response: fixture.response });
  if (client === 'claude') return claude.parse('mid-turn', { tool_calls: [{ tool_name: fixture.tool, tool_input: fixture.input, tool_response: fixture.response }] });
  return omp.parse('mid-turn', { message: { content: [{ type: 'toolCall', id: 'call1', name: fixture.tool, arguments: fixture.input }] },
    toolResults: [{ toolCallId: 'call1', toolName: fixture.tool, content: fixture.response ?? '' }] });
}

/** Each client exercises its maintained native tool vocabulary as well as its
 * event envelope. Literal expected signals remain independent of extraction. */
function nativeFixture(client: typeof DELIVERY_MATRIX_CLIENTS[number], scenario: typeof GROUNDED_QUERY_CASES[number]): Fixture {
  const fixture = fixtures[scenario];
  const exec = (command: string, description?: string): Fixture => ({ ...fixture,
    tool: client === 'codex' ? 'exec_command' : client === 'claude' ? 'Bash' : 'bash',
    input: client === 'codex' ? { cmd: command, ...(description ? { justification: description } : {}) }
      : { command, ...(description ? { description } : {}) } });
  if (scenario === 'task') return exec('node -e "' + 'x'.repeat(2000) + '"', 'repair delivery receipt');
  if (scenario === 'lexical-only') return exec('rg WI-6512', 'repair delivery receipt');
  if (scenario === 'shell-negative') return exec('pwd && git status');
  if (scenario === 'heredoc-negative') return exec("python3 - <<'PY'\nprint('WI-6512')\nPY");
  if (scenario === 'javascript-negative' && client !== 'codex') return exec('node -e "const x = { query: 1 };"');
  if (client === 'codex') {
    if (scenario === 'symbol') return exec('rg buildMemoryContextBlock');
    if (scenario === 'path') return exec('cat src/memory/injection.ts');
    if (scenario === 'search') return exec("rg 'lost delivery receipt'");
    if (scenario === 'error') return exec('cat src/memory.ts');
    if (scenario === 'exact-id') return exec('rg WI-6512');
    if (scenario === 'serialized-json-negative') return exec("rg '{\"query\":\"WI-6512\"}'");
    if (scenario === 'truncated-json-negative') return { ...fixture, tool: 'exec_command', input: '{"cmd":"rg WI-6512"' };
  }
  if (client === 'omp') return { ...fixture, tool: fixture.tool === 'Read' ? 'read' : fixture.tool === 'Grep' ? 'grep' : fixture.tool,
    input: fixture.tool === 'Read' ? { path: (fixture.input as { file_path: string }).file_path } : fixture.input };
  return fixture;
}

for (const scenario of GROUNDED_QUERY_CASES) it(`context reliability R-3: ${scenario}`, async ({ annotate, task }) => {
  const observations: GroundedQueryCell[] = [];
  for (const client of DELIVERY_MATRIX_CLIENTS) {
    const fixture = nativeFixture(client, scenario);
    services.unavailable = fixture.unavailable ?? false;
    services.search.mockClear(); services.lexical.mockClear();
    vi.mocked(injection.prepareMemoryContextBlock).mockClear();
    const request = digest(client, fixture) as { toolCalls: Array<{ querySignals: Signals; toolInput: string }> };
    expect(request.toolCalls[0]!.querySignals).toEqual(fixture.expected);
    if (scenario === 'task') {
      expect(request.toolCalls[0]!.toolInput).toHaveLength(400);
      expect(() => JSON.parse(request.toolCalls[0]!.toolInput)).toThrow();
    }
    const response = await endpoint.handler(new Request('http://localhost/agent-mcp/mid-turn-context', { method: 'POST',
      body: JSON.stringify({ ...request, owner: `query-fixture-${++sequence}`, client,
        workspace: 'query-fixture-ws', harness: 'query-fixture-harness' }) }));
    const result = await response.json() as { ok: boolean; text: string };
    expect(result.ok).toBe(true);
    const active = !!fixture.expected.lexical;
    expect(injection.prepareMemoryContextBlock).toHaveBeenCalledTimes(active ? 1 : 0);
    if (active) {
      expect(vi.mocked(injection.prepareMemoryContextBlock).mock.calls[0]![0].queryContext).toEqual({
        userText: fixture.expected.semantic, lexicalText: fixture.expected.lexical, fingerprint: fixture.expected.fingerprint,
      });
      const lexical = !fixture.expected.semantic || fixture.unavailable;
      expect(lexical ? services.lexical : services.search).toHaveBeenCalledWith(
        lexical ? fixture.expected.lexical : fixture.expected.semantic,
        expect.objectContaining({ scope: ['query-fixture-user', 'harness:query-fixture-harness'] }));
      expect(lexical ? services.search : services.lexical).not.toHaveBeenCalled();
      expect(result.text).toContain('grounded query fixture result');
      expect(result.text).not.toContain('below lexical relevance floor');
    } else {
      expect(result.text).toBe('');
      expect(services.search).not.toHaveBeenCalled(); expect(services.lexical).not.toHaveBeenCalled();
    }
    observations.push({ client, scenario, selector: `context reliability R-3: ${scenario}`,
      evidenceRefs: [`vitest:context-injection-reliability.integration.test.ts#${client}/${scenario}`],
      inputHash: sha(fixture), signals: request.toolCalls[0]!.querySignals,
      retrievalCalls: vi.mocked(injection.prepareMemoryContextBlock).mock.calls.length,
      semanticCalls: services.search.mock.calls.length, lexicalCalls: services.lexical.mock.calls.length,
      returnedText: result.text, verdict: 'passed' });
  }
  expect(observations.map(cell => cell.client)).toEqual([...DELIVERY_MATRIX_CLIENTS]);
  const observation = { schemaVersion: 'grounded-query-observations-v1',
    evidencePlane: 'current-tree-fixture', sourceSnapshot, cells: observations };
  // JsonReporter retains task.meta; annotations are also available to blob/UI
  // reporters. Both carry these same measured cells rather than a second oracle.
  Object.assign(task.meta, { groundedQueryObservations: observation });
  await annotate(`grounded-query-v1 observations: ${scenario}`, {
    contentType: 'application/json', bodyEncoding: 'utf-8',
    body: JSON.stringify(observation),
  });
});

// Endpoint ACK tests use the real builder and cursor state machine. Storage is
// fault-injected; these are not native stdout or PostgreSQL uniqueness proofs.
async function prepareEndpointReceipt(client: typeof DELIVERY_MATRIX_CLIENTS[number], source: 'memory' | 'corpus', owner: string) {
  const sourceText = 'Use zephyrrepair only after explicit approval. Complete snowman ☃';
  const memory = { id: '11111111-1111-4111-8111-111111111111', text: sourceText, score: 0.95, scope: 'query-fixture-user' };
  services.search.mockResolvedValue(source === 'memory' ? [memory] : []);
  services.readMemory.mockResolvedValue({ entries: source === 'memory' ? [memory] : [], total: source === 'memory' ? 1 : 0 });
  if (source === 'corpus') {
    const selected = selectCorpusLines({ queryText: 'zephyrrepair', budgetChars: 3000,
      hits: [{ source: 'plan', sourceId: 'query-fixture-harness:receipt', excerpt: sourceText,
        meta: { contextUnit: sourceText }, score: 0.95 }] });
    vi.mocked(corpusIo.recallCorpusContext).mockResolvedValue({ ...selected, block: renderCorpusBlock(selected.lines),
      outcome: 'ok', embedderAvailable: true, candidateCount: 1, legs: null, retrievalDepth: 1, rerank: 'nothing-to-reorder' });
  }
  const prepared = await injection.prepareMemoryContextBlock({ userId: 'query-fixture-user', workspaceId: 'query-fixture-ws',
    queryContext: 'zephyrrepair', harnessSlugs: [], potSlugs: [], budgetChars: 8000,
    session: { sessionId: owner, port: 'mid-turn' } });
  expect(prepared?.fragments).toHaveLength(1);
  expect(prepared?.fragments[0]?.kind).toBe(source);
  vi.mocked(injection.prepareMemoryContextBlock).mockResolvedValueOnce(prepared);
  const response = await endpoint.handler(new Request('http://localhost/agent-mcp/mid-turn-context', { method: 'POST',
    body: JSON.stringify({ ...digest(client, nativeFixture(client, 'search')), owner, client,
      workspace: 'query-fixture-ws', harness: 'query-fixture-harness', memoryReceiptMode: true }) }));
  const result = await response.json() as { ok: boolean; text: string; deliveryToken: string; memoryFragmentOffers: MemoryFragmentOffer[] };
  expect(result.ok).toBe(true);
  expect(result.text).toContain(sourceText);
  expect(result.deliveryToken).toEqual(expect.any(String));
  // The host callback revalidates before staging and is not a JSON wire field.
  // Keep exact equality for every emitted identity, byte count and source version.
  const wireOffers = prepared?.fragments.map(({ revalidateSource: _host, ...offer }) => offer);
  expect(result.memoryFragmentOffers).toEqual(wireOffers);
  expect(services.writes).not.toHaveBeenCalled();
  return { token: result.deliveryToken, fragments: result.memoryFragmentOffers.map(({ rendered: _text, sourceVersion: _host, ...row }) => row),
    text: result.text, offers: result.memoryFragmentOffers };
}

async function acknowledgeWithoutQuery(client: typeof DELIVERY_MATRIX_CLIENTS[number], owner: string, proofs?: MemoryEmissionConfirmation[]) {
  const buildsBefore = vi.mocked(injection.prepareMemoryContextBlock).mock.calls.length;
  const response = await endpoint.handler(new Request('http://localhost/agent-mcp/mid-turn-context', { method: 'POST',
    body: JSON.stringify({ owner, client, workspace: 'query-fixture-ws', harness: 'query-fixture-harness',
      toolCalls: [], confirmedMemoryDeliveries: proofs }) }));
  const result = await response.json();
  expect(result).toMatchObject({ ok: true, text: '' });
  expect(result.deliveryToken).toBeUndefined();
  expect(result.memoryFragmentOffers ?? []).toEqual([]);
  expect(injection.prepareMemoryContextBlock).toHaveBeenCalledTimes(buildsBefore);
}

// Unlike the deadline matrix arm below, construction starts before the client
// wall and finishes afterwards. The deliberately uncancellable fixture models
// a backend that returns after cancellation; production receipt logic stays real.
for (const client of DELIVERY_MATRIX_CLIENTS) for (const source of ['memory', 'corpus'] as const)
it('context reliability R-1 late construction: ' + client + ' ' + source, async () => {
  const home = mkdtempSync(join(tmpdir(), 'late-endpoint-receipt-'));
  const owner = 'receipt-late-' + ++sequence;
  const sourceText = 'Use zephyrrepair only after explicit approval. Complete snowman ☃';
  const memory = { id: '11111111-1111-4111-8111-111111111111', text: sourceText, score: 0.95, scope: 'query-fixture-user' };
  services.search.mockResolvedValue(source === 'memory' ? [memory] : []);
  services.readMemory.mockResolvedValue({ entries: source === 'memory' ? [memory] : [], total: source === 'memory' ? 1 : 0 });
  if (source === 'corpus') {
    const selected = selectCorpusLines({ queryText: 'zephyrrepair', budgetChars: 3000,
      hits: [{ source: 'plan', sourceId: 'query-fixture-harness:receipt', excerpt: sourceText,
        meta: { contextUnit: sourceText }, score: 0.95 }] });
    vi.mocked(corpusIo.recallCorpusContext).mockResolvedValue({ ...selected, block: renderCorpusBlock(selected.lines),
      outcome: 'ok', embedderAvailable: true, candidateCount: 1, legs: null, retrievalDepth: 1, rerank: 'nothing-to-reorder' });
  }
  const ledger = openDeliveryLedger(owner, { PAPERCUSP_HOME: home }, 'mid-turn')!;
  const request = { ...digest(client, nativeFixture(client, 'search')), owner, client,
    workspace: 'query-fixture-ws', harness: 'query-fixture-harness', memoryReceiptMode: true };
  let releaseBuild!: () => void;
  let markStarted!: () => void;
  const blocked = new Promise<void>(resolve => { releaseBuild = resolve; });
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  let lateResponse: Promise<Response> | undefined;
  let deadlineStage: string | undefined;
  let constructionFinished = false;
  let constructionFailure: unknown;
  let markFinished!: () => void;
  const finished = new Promise<void>(resolve => { markFinished = resolve; });
  vi.mocked(injection.prepareMemoryContextBlock).mockImplementationOnce(async args => {
    markStarted();
    await blocked;
    // Fault injection only: this backend ignores the caller's expired wall.
    try {
      return await originalPrepareMemoryContextBlock({ ...args, deadline: undefined, respondByMs: undefined });
    } catch (error) {
      constructionFailure = error;
      throw error;
    } finally {
      constructionFinished = true;
      markFinished();
    }
  });
  try {
    const pending = postInjection('mid-turn', request, {
      env: { PAPERCUSP_OPERATOR_URL: 'http://receipt-fixture.invalid' },
      fetchImpl: async (_url: unknown, options?: RequestInit) => {
        const signal = options?.signal;
        if (!signal) throw new Error('Transport must provide its abort signal');
        lateResponse = endpoint.handler(new Request('http://localhost/agent-mcp/mid-turn-context', {
          method: 'POST', body: options?.body, signal,
        }));
        return new Promise<Response>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
          lateResponse!.then(response => {
            signal.removeEventListener('abort', abort);
            resolve(response);
          }, reject);
        });
      },
      onHookOutcome: (outcome: object) => {
        deadlineStage = 'stage' in outcome && typeof outcome.stage === 'string' ? outcome.stage : undefined;
      },
    });
    await started;
    const result = await pending;
    expect(deadlineStage).toBe('wall-during-fetch');
    expect(constructionFinished).toBe(false);
    expect(result?.deliveryToken ?? null).toBeNull();
    expect(result?.memoryFragmentOffers ?? []).toEqual([]);
    expect(ledger.confirmedMemoryDeliveries()).toEqual([]);
    expect(services.writes).not.toHaveBeenCalled();

    releaseBuild();
    await finished;
    expect(constructionFailure).toBeUndefined();
    const abandoned = await (await lateResponse!).json();
    expect(constructionFinished).toBe(true);
    expect(abandoned.text).toContain(sourceText);
    expect(abandoned.deliveryToken).toBeUndefined();
    expect(abandoned.memoryFragmentOffers ?? []).toEqual([]);
    // Inspecting the abandoned server result does not print it or offer it to
    // the native ledger. Late construction must not create a candidate or suppress the retry.
    expect(ledger.confirmedMemoryDeliveries()).toEqual([]);
    await acknowledgeWithoutQuery(client, owner);
    expect(services.writes).not.toHaveBeenCalled();

    if (source === 'memory') {
      // A matching search hit cannot authorize an offer when its independent
      // canonical reread is empty; a later valid retry must still be eligible.
      services.readMemory.mockResolvedValueOnce({ entries: [], total: 0 });
      const missing = await (await endpoint.handler(new Request('http://localhost/agent-mcp/mid-turn-context', {
        method: 'POST', body: JSON.stringify(request),
      }))).json();
      expect(missing.deliveryToken).toBeUndefined();
      expect(missing.memoryFragmentOffers ?? []).toEqual([]);
      expect(ledger.confirmedMemoryDeliveries()).toEqual([]);
      expect(services.writes).not.toHaveBeenCalled();
    }

    const replay = await (await endpoint.handler(new Request('http://localhost/agent-mcp/mid-turn-context', {
      method: 'POST', body: JSON.stringify(request),
    }))).json();
    expect(replay.text).toContain(sourceText);
    expect(replay.deliveryToken).toEqual(expect.any(String));
    expect(replay.memoryFragmentOffers).toEqual([expect.objectContaining({ kind: source })]);
    expect(services.writes).not.toHaveBeenCalled();
    const payload = { codex, claude, omp }[client].render('mid-turn', replay.text, {}) + '\n';
    ledger.offer(replay.deliveryToken, { payload, client, memoryFragmentOffers: replay.memoryFragmentOffers });
    expect(ledger.commit()).toBe(true); // Serializer/receipt fixture, not OS emission proof.
    const proofs = ledger.confirmedMemoryDeliveries();
    expect(proofs).toHaveLength(1);
    await acknowledgeWithoutQuery(client, owner, proofs);
    expect(services.writes).toHaveBeenCalledOnce();
    await acknowledgeWithoutQuery(client, owner, proofs);
    expect(services.writes).toHaveBeenCalledOnce();
  } finally {
    releaseBuild();
    await finished;
    await lateResponse?.catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
}, 15_000);

for (const client of DELIVERY_MATRIX_CLIENTS) for (const source of ['memory', 'corpus'] as const) {
  it(`context reliability R-1 endpoint: ${client} ${source} lost-and-invalid-receipt`, async () => {
    const owner = `receipt-lost-${++sequence}`;
    const proof = await prepareEndpointReceipt(client, source, owner);
    await acknowledgeWithoutQuery(client, owner); // Lost output / no receipt.
    const retry = await prepareEndpointReceipt(client, source, owner);
    expect(retry.token).not.toBe(proof.token); // Same query, still no emission proof.
    await acknowledgeWithoutQuery(client, `${owner}-foreign`, [proof]);
    await acknowledgeWithoutQuery(client, owner, [{ ...proof, token: 'unoffered-token' }]);
    await acknowledgeWithoutQuery(client, owner, [{ ...proof, fragments: [] }]);
    await acknowledgeWithoutQuery(client, owner, [{ ...proof,
      fragments: proof.fragments.map(row => ({ ...row, bodyBytes: row.bodyBytes - 1 })) }]);
    expect(services.writes).not.toHaveBeenCalled();
    await acknowledgeWithoutQuery(client, owner, [proof]);
    expect(services.writes).toHaveBeenCalledOnce();
    expect(services.writes.mock.calls[0]![0]).toContain(`INSERT INTO harness_shared.${source}_session_surfaced`);
    await acknowledgeWithoutQuery(client, owner, [proof]);
    expect(services.writes).toHaveBeenCalledOnce(); // Cleared only after success.
  });

  it(`context reliability R-1 endpoint: ${client} ${source} failed-stamp-retry`, async () => {
    const owner = `receipt-retry-${++sequence}`;
    const proof = await prepareEndpointReceipt(client, source, owner);
    services.writes.mockImplementationOnce(() => { throw new Error('receipt fixture: connection interrupted'); });
    await acknowledgeWithoutQuery(client, owner, [proof]);
    expect(services.writes).toHaveBeenCalledOnce();
    await acknowledgeWithoutQuery(client, owner, [proof]);
    expect(services.writes).toHaveBeenCalledTimes(2); // Same candidate survived failure.
    expect(services.writes.mock.calls[1]).toEqual(services.writes.mock.calls[0]);
    await acknowledgeWithoutQuery(client, owner, [proof]);
    expect(services.writes).toHaveBeenCalledTimes(2);
  });

  it(`context reliability R-1 endpoint: ${client} ${source} expiry-boundary`, async () => {
    const owner = `receipt-expiry-${++sequence}`;
    const preparedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(preparedAt);
    const expired = await prepareEndpointReceipt(client, source, owner);
    clock.mockReturnValue(preparedAt + MEMORY_EMISSION_TTL_MS);
    await acknowledgeWithoutQuery(client, owner, [expired]);
    expect(services.writes).not.toHaveBeenCalled();
    // A second receipt cannot revive the cleared, expired candidate.
    await acknowledgeWithoutQuery(client, owner, [expired]);
    expect(services.writes).not.toHaveBeenCalled();
    const fresh = await prepareEndpointReceipt(client, source, owner);
    expect(fresh.token).not.toBe(expired.token);
    await acknowledgeWithoutQuery(client, owner, [fresh]);
    expect(services.writes).toHaveBeenCalledOnce();
  });
}

// The exact R-1 selectors exercise the real builder, endpoint, cursor ACK and
// native serializer/receipt extractor with fixture storage. Calling commit()
// below tests extraction only: it is deliberately NOT OS stdout evidence.
// The subprocess/PostgreSQL joins remain in session-epoch-cross-port.integration.
for (const client of DELIVERY_MATRIX_CLIENTS) for (const fault of DELIVERY_MATRIX_FAULTS)
it(`context reliability R-1: ${client} ${fault}`, async ({ task, annotate }) => {
  const home = mkdtempSync(join(tmpdir(), 'endpoint-receipt-'));
  const observations: Array<Record<string, unknown>> = [];
  const adapter = { codex, claude, omp }[client];
  try {
    for (const source of ['memory', 'corpus'] as const) {
      services.writes.mockReset();
      const owner = `receipt-matrix-${++sequence}`;
      const prepared = await prepareEndpointReceipt(client, source, owner);
      const payload = adapter.render('mid-turn', prepared.text, {}) + '\n';
      const ledger = openDeliveryLedger(owner, { PAPERCUSP_HOME: home }, 'mid-turn')!;
      const confirmations = (): MemoryEmissionConfirmation[] => ledger.confirmedMemoryDeliveries().map(row => {
        expect(row).toMatchObject({ token: expect.any(String), fragments: expect.any(Array) });
        // The JS adapter declares object[]; the exact fragment contents are
        // compared to the independently prepared offers in each positive arm.
        return row as MemoryEmissionConfirmation;
      });
      const extract = (body: string) => {
        ledger.offer(prepared.token, { payload: body, client, memoryFragmentOffers: prepared.offers });
        expect(ledger.commit()).toBe(true);
        return confirmations();
      };
      let receiptCount = 0;
      let deadlineStage: string | undefined;
      if (fault === 'prepare') {
        expect(ledger.confirmedMemoryDeliveries()).toEqual([]);
        await acknowledgeWithoutQuery(client, owner, [{ token: prepared.token, fragments: [] }]);
      } else if (fault === 'lost-response') {
        await acknowledgeWithoutQuery(client, owner);
        expect(ledger.confirmedMemoryDeliveries()).toEqual([]);
        const retry = await prepareEndpointReceipt(client, source, owner);
        expect(retry.fragments).toEqual(prepared.fragments);
        expect(retry.token).not.toBe(prepared.token);
      } else if (fault === 'partial-stdout') {
        // An incomplete serialized payload is not an exact fragment, even if
        // a caller incorrectly tries to publish a receipt for that prefix.
        const prefix = payload.slice(0, Math.floor(payload.indexOf('source-evidence') / 2));
        expect(prefix.length).toBeGreaterThan(0);
        expect(Buffer.byteLength(prefix)).toBeLessThan(Buffer.byteLength(payload));
        const proofs = extract(prefix);
        expect(proofs).toEqual([]);
        await acknowledgeWithoutQuery(client, owner, proofs);
      } else if (fault === 'deadline') {
        // Exercise the maintained transport's real abort wall after the
        // endpoint has prepared its candidate. No native output is asserted.
        const result = await postInjection('mid-turn', { owner, client, workspace: 'query-fixture-ws',
          harness: 'query-fixture-harness', cwd: '/receipt-fixture' }, {
          env: { PAPERCUSP_OPERATOR_URL: 'http://receipt-fixture.invalid' },
          fetchImpl: async (_url: unknown, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            const signal = options?.signal;
            if (!signal) throw new Error('Transport must provide its abort signal');
            const abort = () => reject(signal.reason);
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          }),
          onHookOutcome: (outcome: object) => {
            deadlineStage = 'stage' in outcome && typeof outcome.stage === 'string' ? outcome.stage : undefined;
          },
        });
        expect(result?.deliveryToken ?? null).toBeNull();
        expect(result?.memoryFragmentOffers ?? []).toEqual([]);
        expect(deadlineStage).toBe('wall-during-fetch');
        await acknowledgeWithoutQuery(client, owner);
        expect(ledger.confirmedMemoryDeliveries()).toEqual([]);
      } else if (fault === 'abandon-expiry') {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + MEMORY_EMISSION_TTL_MS + 1);
        try {
          await acknowledgeWithoutQuery(client, owner, [prepared]);
          await acknowledgeWithoutQuery(client, owner, [prepared]);
        } finally { clock.mockRestore(); }
        expect(services.writes).not.toHaveBeenCalled();
        const fresh = await prepareEndpointReceipt(client, source, owner);
        expect(fresh.token).not.toBe(prepared.token);
        expect(fresh.fragments).toEqual(prepared.fragments);
      } else if (fault === 'overlapping-ports') {
        // Both candidates exist before either ACK. The fixture explicitly
        // models the existing SQL unique key; actual PG races are tested in
        // the cross-port suite, not inferred from this fixture.
        const second = await prepareEndpointReceipt(client, source, owner);
        expect(second.token).not.toBe(prepared.token);
        const inserted = new Set<string>();
        services.writes.mockImplementation((query, values) => {
          const key = JSON.stringify([query.includes('corpus_session_surfaced') ? 'corpus' : 'memory', ...values.slice(0, 3)]);
          if (inserted.has(key)) return [];
          inserted.add(key); return [{}];
        });
        const proofs = extract(payload);
        expect(proofs).toEqual([{ token: prepared.token, fragments: prepared.fragments }]);
        const secondLedger = openDeliveryLedger(owner, { PAPERCUSP_HOME: home }, 'turn-start')!;
        secondLedger.offer(second.token, { payload, client, memoryFragmentOffers: second.offers });
        expect(secondLedger.commit()).toBe(true);
        const both = confirmations();
        expect(both).toHaveLength(2);
        await acknowledgeWithoutQuery(client, owner, both);
        expect(inserted.size).toBe(1);
        expect(services.writes).toHaveBeenCalledTimes(2);
        await acknowledgeWithoutQuery(client, owner, both);
        expect(services.writes).toHaveBeenCalledTimes(2);
        receiptCount = both.length;
      } else {
        if (fault === 'retry') {
          await acknowledgeWithoutQuery(client, owner);
          expect(services.writes).not.toHaveBeenCalled();
          expect(ledger.confirmedMemoryDeliveries()).toEqual([]);
        }
        const proofs = extract(payload);
        expect(proofs).toEqual([{ token: prepared.token, fragments: prepared.fragments }]);
        await acknowledgeWithoutQuery(client, owner, proofs);
        expect(services.writes).toHaveBeenCalledOnce();
        await acknowledgeWithoutQuery(client, owner, proofs);
        expect(services.writes).toHaveBeenCalledOnce();
        receiptCount = proofs.length;
      }
      const positive = ['retry', 'duplicate-commit', 'overlapping-ports'].includes(fault);
      if (!positive) expect(services.writes).not.toHaveBeenCalled();
      observations.push({ client, sink: 'mid-turn', source, fault, selector: task.name,
        evidenceRefs: [`vitest:${task.name}#${source}`], token: prepared.token,
        fragments: prepared.fragments, payloadSha256: createHash('sha256').update(payload).digest('hex'),
        payloadBytes: Buffer.byteLength(payload), receiptCount, stampAttempts: services.writes.mock.calls.length,
        ...(deadlineStage ? { deadlineStage } : {}),
        endpointVerdict: 'passed', nativeEmission: 'UNKNOWN', postgresUniqueness: 'UNKNOWN',
        overlapScope: fault === 'overlapping-ports' ? 'same endpoint candidates, separate native receipt namespaces' : null });
    }
    expect(observations.map(cell => cell.source)).toEqual(['memory', 'corpus']);
    const observation = { schemaVersion: 'endpoint-receipt-observations-v1',
      evidencePlane: 'current-tree-builder-endpoint-serializer-cursor-fixture', sourceSnapshot, cells: observations };
    Object.assign(task.meta, { endpointReceiptObservations: observation });
    await annotate(`endpoint receipt observations: ${client}/${fault}`, {
      contentType: 'application/json', bodyEncoding: 'utf-8', body: JSON.stringify(observation),
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// Closed-population and corruption controls. These are synthetic validator
// inputs, never a substitute for the separately captured native matrix.
function deliveryValidatorFixture(): DeliveryMatrixManifest {
  return { schemaVersion: 'delivery-matrix-v1',
    identity: { planRevision: 54, planHash: '1'.repeat(64), rubricRevision: 4, rubricHash: '2'.repeat(64),
      barHash: '3'.repeat(64), specHash: '4'.repeat(64), sourceHash: '5'.repeat(64), testHash: '6'.repeat(64),
      runtimeGeneration: 'validator-fixture-only' },
    cells: deliveryMatrixPopulation().map(cell => ({ ...cell, selector: 'synthetic-validator-control',
      evidenceRefs: ['synthetic-validator-control'], terminalOracle: deliveryTerminalOracle(cell),
      verdict: 'UNKNOWN', state: 'UNKNOWN', suppressionWrites: 0 })) };
}

// The existing R-2 ledgers own the SQL/CAS behavior. Retrieval and cursor state
// remain explicit fixtures here; no native emission or migration activation is claimed.
let revisionDb: Promise<OrgTestDb> | undefined;
async function sourceRevisionDb(): Promise<OrgTestDb> {
  return revisionDb ??= (async () => {
    const { createOrgTestDb } = await import('../../test/_org-test-db');
    const db = await createOrgTestDb();
    try {
      const armed = new URL('../../../../libs/papercusp/libs/db/sql/1627-context-source-version-ledgers.sql', import.meta.url);
      await db.adminSql.unsafe(readFileSync(existsSync(armed) ? armed : new URL(armed.href + '.DRAFT'), 'utf8'));
      return db;
    } catch (error) { await db.cleanup(); throw error; }
  })();
}
afterAll(async () => { if (revisionDb) await (await revisionDb).cleanup(); });

async function sourceRevisionScenario(scenario: typeof SOURCE_REVISION_CASES[number]): Promise<SourceRevisionCell[]> {
  const db = await sourceRevisionDb();
  const { alreadySurfacedIds, memoryFragmentOffer, stageMemoryEmission, confirmMemoryEmission } = await import('./session-epoch-ledger');
  const { alreadySurfacedRefs, _resetCorpusLedgerLatchForTests } = await import('./corpus-surfaced-ledger');
  _resetCorpusLedgerLatchForTests();
  const cells: SourceRevisionCell[] = [];
  for (const source of ['memory', 'corpus'] as const) {
    const owner = `r2-${randomUUID()}`, id = source === 'memory' ? randomUUID() : `doc:${randomUUID()}`;
    const previous = contextSourceVersion({ namespace: `${source}:r2-fixture`, ref: id,
      fullText: 'same passage\nOnly after approval.', revision: 'r1', updatedAt: '2026-11-01T00:00:00.000Z',
      passage: { startByte: 0, endByte: 12 },
      validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } });
    const current = ['same-revision', 'compaction'].includes(scenario) ? previous : contextSourceVersion({
      namespace: previous.namespace, ref: id,
      fullText: scenario === 'retraction' ? '' : 'same passage\nOnly after independent approval.',
      revision: 'r2', updatedAt: '2026-11-02T00:00:00.000Z',
      ...(scenario === 'retraction' ? {} : { passage: { startByte: 0, endByte: 12 } }),
      validity: { status: scenario === 'retraction' ? 'retracted' : 'current', validAt: null,
        invalidAt: scenario === 'retraction' ? '2026-11-02T00:00:00.000Z' : null, supersededBy: null } });
    let canonical = previous;
    const first = memoryFragmentOffer(source, id, 3, 'turn-start', 'same passage', previous, async () => canonical);
    const manifest = ({ rendered: _text, sourceVersion: _version, revalidateSource: _read, ...row }: typeof first) => row;
    const confirm = (token: string, offer: typeof first) => confirmMemoryEmission(db.adminSql as never, owner, { token, fragments: [manifest(offer)] });
    await stageMemoryEmission(db.adminSql as never, owner, 'initial', [first]);
    expect(await confirm('initial', first)).toBe(1);
    const readEpoch = scenario === 'compaction' ? 4 : 3;
    const read = () => source === 'memory'
      ? alreadySurfacedIds(db.adminSql as never, owner, readEpoch, [id], new Map([[id, current.fingerprint]]))
      : alreadySurfacedRefs(db.adminSql as never, owner, readEpoch, [id], new Map([[id, current.fingerprint]]));
    if (scenario === 'concurrent-old-new') await stageMemoryEmission(db.adminSql as never, owner, 'delayed-old', [first]);
    canonical = current;
    const eligibleBefore = !(await read()).has(id);
    expect(eligibleBefore).toBe(scenario !== 'same-revision');
    let stalePreparationRejected = false;
    let notice: string | null = null;
    if (scenario === 'retraction') {
      await expect(stageMemoryEmission(db.adminSql as never, owner, 'stale-after-retraction', [first]))
        .rejects.toThrow('Memory emission source changed or is unavailable');
      stalePreparationRejected = true;
      notice = contextSourceChangeNotice(previous, current);
      expect(notice).toContain('retracted');
      expect(notice).not.toContain('Only after approval');
    }
    const next = memoryFragmentOffer(source, id, readEpoch, 'mid-turn', notice ?? 'same passage', current, async () => canonical);
    await stageMemoryEmission(db.adminSql as never, owner, 'current', [next]);
    const confirmationResults = [await confirm('current', next)];
    if (scenario === 'concurrent-old-new') {
      confirmationResults.push(await confirm('delayed-old', first), await confirm('current', next));
    }
    expect(confirmationResults).toEqual(scenario === 'same-revision' ? [0] : scenario === 'concurrent-old-new' ? [1, 0, 0] : [1]);
    const rows = source === 'memory'
      ? await db.adminSql`SELECT source_fingerprint FROM harness_shared.memory_session_surfaced WHERE session_id=${owner} AND epoch=${readEpoch}`
      : await db.adminSql`SELECT source_fingerprint FROM harness_shared.corpus_session_surfaced WHERE session_id=${owner} AND epoch=${readEpoch}`;
    expect(rows).toEqual([{ source_fingerprint: current.fingerprint }]);
    const eligibleAfter = !(await read()).has(id);
    expect(eligibleAfter).toBe(false);
    cells.push({ scenario, source, selector: `context reliability R-2: ${scenario}`,
      evidenceRefs: [`vitest:context reliability R-2: ${scenario}#${source}`], previous, current,
      initialEpoch: 3, readEpoch, eligibleBefore, eligibleAfter, confirmationResults,
      storedFingerprint: rows[0]!.source_fingerprint, stalePreparationRejected, notice, verdict: 'passed' });
  }
  return cells;
}

for (const scenario of SOURCE_REVISION_CASES) it(`context reliability R-2: ${scenario}`, async ({ task, annotate }) => {
  const cells = await sourceRevisionScenario(scenario);
  Object.assign(task.meta, { sourceRevisionCells: cells, evidencePlane: 'postgresql-ledger-with-fixture-source-and-cursors' });
  await annotate(`source revision: ${scenario}`, { contentType: 'application/json', bodyEncoding: 'utf-8', body: JSON.stringify({ sourceSnapshot, cells }) });
}, 120_000);

it('context reliability R-2: artifact-validator', async ({ task }) => {
  const cells: SourceRevisionCell[] = [];
  for (const scenario of SOURCE_REVISION_CASES) cells.push(...await sourceRevisionScenario(scenario));
  const artifact: SourceRevisionArtifact = { schemaVersion: 'source-revision-v1',
    identity: { ...deliveryValidatorFixture().identity, runtimeGeneration: 'r2-isolated-pg-fixture', sourceHash: sha(sourceSnapshot) },
    evidencePlane: 'postgresql-ledger-with-fixture-source-and-cursors', cells };
  const expected = structuredClone(artifact);
  expect(validateSourceRevisionArtifact(artifact, expected)).toEqual({ valid: true, closed: true, errors: [] });
  const corrupted = structuredClone(artifact);
  corrupted.cells.find(cell => cell.scenario === 'concurrent-old-new')!.confirmationResults[1] = 1;
  expect(validateSourceRevisionArtifact(corrupted, expected).valid).toBe(false);
  Object.assign(task.meta, { sourceRevisionArtifact: artifact });
}, 120_000);

it('context reliability R-1: closed-delivery-matrix', () => {
  const artifact = deliveryValidatorFixture();
  const keys = artifact.cells.map(deliveryMatrixCellKey);
  expect(keys).toHaveLength(432);
  expect(new Set(keys).size).toBe(432);
  expect(validateDeliveryMatrix(artifact)).toMatchObject({ closed: true, valid: true, acceptanceReady: false });
  expect(validateDeliveryMatrix(artifact).unknown).toEqual(keys);
  for (const defect of ['missing', 'duplicate', 'unexpected'] as const) {
    const copy = structuredClone(artifact);
    if (defect === 'missing') copy.cells.pop();
    else if (defect === 'duplicate') copy.cells.push(copy.cells[0]!);
    else copy.cells[0]!.sink = 'unregistered' as never;
    expect(validateDeliveryMatrix(copy)).toMatchObject({ closed: false, valid: false, acceptanceReady: false });
  }
});

it('context reliability R-1: per-sink-terminal-oracle', () => {
  const artifact = deliveryValidatorFixture();
  for (const sink of DELIVERY_MATRIX_EXTRA_SINKS) {
    const cells = artifact.cells.filter(cell => cell.sink === sink);
    expect(cells).toHaveLength(16);
    expect(cells.every(cell => cell.client === 'NONE' && cell.terminalOracle === 'NONE')).toBe(true);
    const copy = structuredClone(artifact);
    const promoted = copy.cells.find(cell => cell.sink === sink)!;
    promoted.verdict = 'passed'; promoted.state = 'emitted'; promoted.suppressionWrites = 1;
    expect(validateDeliveryMatrix(copy).errors).toContain(`${deliveryMatrixCellKey(promoted)}:uninstrumented-sink`);
  }
  // The census is capability-specific; a client's other instruments do not
  // grant terminal authority to compact or in-process MCP boundaries.
  for (const client of DELIVERY_MATRIX_CLIENTS) for (const sink of ['initialize', 'compact-reprime'] as const) {
    const cell = { client, sink, source: 'memory' as const, fault: 'prepare' as const };
    expect(deliveryTerminalOracle(cell)).toBe(client === 'omp' ? 'NONE' : 'complete-stdout');
  }
});

it('context reliability R-1: artifact-validator', () => {
  const artifact = deliveryValidatorFixture();
  const cell = artifact.cells.find(row => row.client === 'codex' && row.sink === 'mid-turn' &&
    row.source === 'memory' && row.fault === 'retry')!;
  const fragment = { kind: 'memory' as const, id: 'validator-source', epoch: 7, port: 'mid-turn',
    bodySha256: 'a'.repeat(64), bodyBytes: 30 };
  cell.verdict = 'passed'; cell.state = 'emitted'; cell.suppressionWrites = 1;
  cell.attempt = { id: 'attempt', recipient: 'recipient', workspace: 'workspace', epoch: 7, token: 'token', fragment };
  cell.proof = { event: 'complete-stdout', adapter: 'synthetic-validator-control', receiptRef: 'synthetic:receipt',
    attemptId: 'attempt', recipient: 'recipient', workspace: 'workspace', epoch: 7, token: 'token',
    client: 'codex', sink: 'mid-turn', payloadSha256: 'b'.repeat(64), payloadBytes: 90, fragment: { ...fragment } };
  expect(validateDeliveryMatrix(artifact)).toMatchObject({ valid: true, acceptanceReady: false, errors: [] });
  for (const field of ['attemptId', 'recipient', 'workspace', 'token', 'client', 'sink', 'epoch', 'payloadSha256'] as const) {
    const copy = structuredClone(artifact);
    const proof = copy.cells.find(row => deliveryMatrixCellKey(row) === deliveryMatrixCellKey(cell))!.proof!;
    Object.assign(proof, { [field]: field === 'epoch' ? 8 : 'wrong' });
    expect(validateDeliveryMatrix(copy).errors).toContain(`${deliveryMatrixCellKey(cell)}:receipt-join`);
  }
  const unproven = structuredClone(artifact);
  unproven.cells.find(row => deliveryMatrixCellKey(row) === deliveryMatrixCellKey(cell))!.state = 'prepared';
  expect(validateDeliveryMatrix(unproven).errors).toContain(`${deliveryMatrixCellKey(cell)}:unproven-suppression`);
  const wrongFault = structuredClone(artifact);
  wrongFault.cells.find(row => deliveryMatrixCellKey(row) === deliveryMatrixCellKey(cell))!.suppressionWrites = 0;
  expect(validateDeliveryMatrix(wrongFault).errors).toContain(`${deliveryMatrixCellKey(cell)}:fault-outcome`);
  const noIdentity = structuredClone(artifact);
  noIdentity.identity.sourceHash = 'invalid';
  expect(validateDeliveryMatrix(noIdentity).errors).toContain('measurement-identity');
});

// Source/terminal observations and semantic labels are explicit fixtures. These
// integration cases verify sample/persistence composition, never native emission
// or a production quality score. Real collection/independent grading stay open.
function finalContextSampleFixture(): FinalContextAttemptSnapshot {
  const body = 'Deploy only after approval.';
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return { schemaVersion: 'final-attempt-source-v1', snapshotId: 'r10-integration-fixture',
    sourceSchemaSha256: sha('r10-fixture-schema'), environmentSha256: sha('fixture-env'), configurationSha256: sha('fixture-config'),
    runtimeGeneration: 'fixture-only-not-native', measuredAt: '2026-11-12T12:00:00.000Z', capturedAt: '2026-11-12T12:00:01.000Z',
    attempts: DELIVERY_MATRIX_CLIENTS.map(client => ({ sourceStoreId: 'r10-fixture-store', attemptId: client,
      attemptSchemaVersion: 'fixture-v1', recordVersion: 1, createdAt: '2026-11-12T10:00:00.000Z', visibleAt: '2026-11-12T11:00:00.000Z',
      client, sink: 'mid-turn', recipient: `fixture-${client}`, workspace: 'fixture-workspace', epoch: 1,
      labelEvidenceRef: `fixture-labels:${client}`, taskBenefit: 'useful', context: {
        attemptId: client, sessionId: `fixture-${client}`, epoch: 1, port: 'mid-turn', block: body,
        requiredFactKeys: ['approval'], retrievedFactKeys: ['approval'], admittedFactKeys: ['approval'],
        fragments: [{ sourceRef: 'fixture-decision', factKey: 'approval', text: body, requiredQualifiers: ['only after approval'],
          correct: true, current: true, authoritative: true, scopeAllowed: true, referencesResolve: true }],
      } })),
    receipts: DELIVERY_MATRIX_CLIENTS.map(client => ({ sourceStoreId: 'r10-fixture-store', attemptId: client,
      attemptSchemaVersion: 'fixture-v1', recipient: `fixture-${client}`, workspace: 'fixture-workspace', epoch: 1,
      client, sink: 'mid-turn', event: 'complete-stdout', blockSha256: bodyHash, fragmentSha256: [bodyHash], evidenceRef: `fixture-stdout:${client}` })),
  };
}

it('context reliability R-10: deterministic-sample', async ({ annotate, task }) => {
  const source = finalContextSampleFixture(), sample = sampleFinalDeliveredContext(source);
  const { saveImmutableTextArtifact, loadImmutableTextArtifact } = await import('../text-artifacts');
  const saved = await saveImmutableTextArtifact('query-fixture-harness', sample.sourceSnapshotJson);
  const read = await loadImmutableTextArtifact('query-fixture-harness', saved.sha256);
  expect(read).toBe(sample.sourceSnapshotJson);
  expect(sampleFinalDeliveredContext(JSON.parse(read!))).toEqual(sample);
  expect(sample).toMatchObject({ attempted: 3, usefulSuccesses: 3, usefulUnknown: 0 });
  await annotate('final-attempt-sample-v1 fixture integration; not production grading');
  Object.assign(task.meta, { contextReliabilityEvidence: { sourceSnapshot, sample } });
});

it('context reliability R-10: stable-snapshot-order', () => {
  const source = finalContextSampleFixture(), before = sampleFinalDeliveredContext(source);
  source.attempts.reverse();
  expect(sampleFinalDeliveredContext(source).partitions).toEqual(before.partitions);
  const latest = structuredClone(source.attempts[0]!); latest.recordVersion = 2; latest.client = 'codex';
  source.attempts.unshift(latest);
  const after = sampleFinalDeliveredContext(source);
  expect(after.attempted).toBe(3);
  expect(after.attempts.find(row => JSON.parse(row.identity)[1] === latest.attemptId)?.recordVersion).toBe(2);
});

it('context reliability R-10: partition-census', () => {
  const source = finalContextSampleFixture();
  for (let i = 0; i < 105; i++) {
    const row = structuredClone(source.attempts[0]!); row.attemptId = `additional-${String(i).padStart(3, '0')}`;
    row.context.attemptId = row.attemptId; source.attempts.push(row);
  }
  const sample = sampleFinalDeliveredContext(source);
  expect(sample.partitions.find(row => row.key === '["codex","mid-turn"]')).toMatchObject({ population: 106 });
  expect(sample.partitions.flatMap(row => row.orderedIdentities)).toHaveLength(102);
  expect(sample.attempted).toBe(102);
});

it('context reliability R-10: unknown-client-partition', () => {
  const source = finalContextSampleFixture();
  source.attempts[0]!.client = 'new-client'; source.attempts[1]!.client = null; source.attempts[2]!.sink = 'unregistered';
  const sample = sampleFinalDeliveredContext(source);
  expect(sample).toMatchObject({ attempted: 3, usefulSuccesses: 0, usefulUnknown: 3 });
  expect(sample.attempts.filter(row => row.client === 'UNKNOWN')).toHaveLength(2);
  expect(sample.attempts.filter(row => row.sink === 'UNKNOWN')).toHaveLength(1);
});

it('context reliability R-10: fragment-receipt-join', () => {
  const source = finalContextSampleFixture();
  source.receipts[0]!.epoch++; source.receipts[1]!.fragmentSha256 = [sha('different')];
  const sample = sampleFinalDeliveredContext(source);
  expect(sample).toMatchObject({ attempted: 3, usefulSuccesses: 1, usefulUnknown: 2 });
  expect(sample.attempts.filter(row => row.assessment.finalBlockChars !== null)).toHaveLength(1);
});

it('context reliability R-10: unknown-denominator', () => {
  const source = finalContextSampleFixture();
  source.receipts = []; source.attempts[1]!.context.block = null; source.attempts[2]!.labelEvidenceRef = undefined;
  const sample = sampleFinalDeliveredContext(source);
  expect(sample).toMatchObject({ attempted: 3, usefulSuccesses: 0, usefulFailures: 0, usefulUnknown: 3 });
  expect(sample.usefulSuccesses + sample.usefulFailures + sample.usefulUnknown).toBe(sample.attempted);
});

it('context reliability R-10: quality-bands', () => {
  const source = finalContextSampleFixture();
  source.attempts[0]!.context.fragments[0]!.current = false;
  source.attempts[1]!.context.fragments[0]!.correct = undefined;
  const sample = sampleFinalDeliveredContext(source);
  expect(sample).toMatchObject({ attempted: 3, usefulSuccesses: 1, usefulFailures: 1, usefulUnknown: 1 });
  expect(sample.attempts.find(row => row.client === 'codex')!.assessment.failures).toContain('current:fixture-decision');
});

it('context reliability R-10: task-outcome', () => {
  const source = finalContextSampleFixture();
  source.attempts[0]!.taskBenefit = 'harmful'; source.attempts[1]!.taskBenefit = undefined;
  expect(sampleFinalDeliveredContext(source)).toMatchObject({ usefulSuccesses: 1, usefulFailures: 1, usefulUnknown: 1 });
});

it('context reliability R-10: client-attribution', async ({ annotate, task }) => {
  const observations = DELIVERY_MATRIX_CLIENTS.map(client => {
    const snapshot = finalContextSampleFixture();
    snapshot.attempts = snapshot.attempts.filter(attempt => attempt.client === client);
    snapshot.receipts = [];
    const attempt = snapshot.attempts[0]!, body = attempt.context.block!;
    const nativeSessionId = `fixture-native-${client}`, timestamp = '2026-11-12T10:01:00.000Z';
    attempt.nativeSessionId = nativeSessionId;
    // Literal native-shaped fixture records. Attribution must never manufacture
    // a delivery receipt or certify that a real client emitted these fixtures.
    const records = client === 'codex' ? [
      { type: 'session_meta', payload: { id: nativeSessionId } },
      { type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: 'fixture-call', output: body } },
    ] : client === 'claude' ? [
      { type: 'user', sessionId: nativeSessionId, timestamp, message: { role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'fixture-call', content: body }] } },
    ] : [
      { type: 'session', id: nativeSessionId },
      { type: 'custom_message', timestamp, customType: 'papercusp-context', content: body },
    ];
    const transcript = records.map(record => JSON.stringify(record)).join('\n') + '\n';
    const source: FinalContextTranscriptSource = { bindingEvidenceRef: `fixture-runtime-binding:${client}`,
      client, nativeSessionId, recipient: attempt.recipient, workspace: attempt.workspace, epoch: 1,
      transcript, sourceSha256: createHash('sha256').update(transcript).digest('hex') };
    const locator = { sourceStoreId: attempt.sourceStoreId, attemptId: attempt.attemptId,
      attemptSchemaVersion: attempt.attemptSchemaVersion, recordIndex: client === 'claude' ? 0 : 1, contentIndex: 0,
      ...(client === 'omp' ? {} : { callId: 'fixture-call' }), startByte: 0, endByte: Buffer.byteLength(body) };
    const attributed = attributeFinalContextTranscript(snapshot, source, [locator]);
    expect(attributed.attributions).toHaveLength(1);
    expect(attributed.attributions[0]).toMatchObject({ status: 'observed', unknown: [],
      observedSha256: createHash('sha256').update(body).digest('hex') });
    const wrongEpoch = attributeFinalContextTranscript(snapshot, { ...source, epoch: 2 }, [locator]);
    expect(wrongEpoch.attributions[0]).toMatchObject({ status: 'UNKNOWN', unknown: ['attempt-binding'] });
    const wrongBytes = attributeFinalContextTranscript(snapshot, source, [{ ...locator, endByte: locator.endByte - 1 }]);
    expect(wrongBytes.attributions[0]).toMatchObject({ status: 'UNKNOWN', unknown: ['block-mismatch'] });
    expect(snapshot.receipts).toEqual([]);
    expect(sampleFinalDeliveredContext(snapshot)).toMatchObject({ attempted: 1, usefulSuccesses: 0, usefulUnknown: 1 });
    return { client, source, locator, attributed, wrongEpoch, wrongBytes };
  });
  await annotate('native-shaped fixtures only; attribution is not native emission or independent quality evidence');
  Object.assign(task.meta, { contextReliabilityEvidence: { sourceSnapshot, observations } });
});

it('context reliability R-10: ledger-readback', async ({ annotate, task }) => {
  const db = await sourceRevisionDb();
  const rubricRef = `fixture-final-context-${randomUUID()}`;
  const subject = { kind: 'artifact', ref: `fixture-sample:${randomUUID()}` };
  const workspaceId = 'fixture-context-ledger';
  const criterion = { key: 'quality', check: { kind: 'probe', maxAgeMs: 60_000,
    probe: { expect: { path: '$.value', op: 'eq', value: 1 } } }, ratingScale: ['healthy', 'broken', 'unknown'] };
  const evidence = [];
  const variants = ['healthy', 'unlabelled', 'unattributed', 'harmful'] as const;
  for (const [index, variant] of variants.entries()) {
    const source = finalContextSampleFixture();
    if (variant === 'unlabelled') delete source.attempts[0]!.labelEvidenceRef;
    if (variant === 'unattributed') source.receipts[0]!.epoch++;
    if (variant === 'harmful') source.attempts[0]!.taskBenefit = 'harmful';
    const sample = sampleFinalDeliveredContext(source);
    expect(sample.attempted).toBe(3);
    expect(sample.usefulSuccesses + sample.usefulFailures + sample.usefulUnknown).toBe(3);
    expect(validateFinalDeliveredContextSample(sample, { sourceSnapshot: source,
      sourceSnapshotSha256: sample.sourceSnapshotSha256 })).toEqual({ valid: true, closed: true, errors: [] });
    const value = sample.usefulFailures ? 0 : sample.usefulUnknown ? null : 1;
    const measuredAt = new Date(Date.parse(source.measuredAt) + index * 1000).toISOString();
    const provenance = retainMeasurementProvenance({
      procedure: { kind: 'fixture-final-context-sample', variant, sourceSnapshotSha256: sample.sourceSnapshotSha256,
        semanticEvidence: 'explicit-fixture-only; not production or independent grading' },
      result: { value, attempted: sample.attempted, usefulSuccesses: sample.usefulSuccesses,
        usefulFailures: sample.usefulFailures, usefulUnknown: sample.usefulUnknown },
      startedAt: measuredAt, finishedAt: measuredAt, predicateInput: { path: '$.value', value },
    });
    const result: RubricCheckResult = { check: { id: 'quality:0', rubricRef, criterionKey: 'quality',
      kind: 'probe', value, unit: null, subject, provenance },
      verdict: value === null ? 'error' : value === 1 ? 'pass' : 'fail', measuredAt, durationMs: 0 };
    const ids = await recordRubricCheckResults([result], { workspaceId, harnessSlug: 'query-fixture-harness' }, db.adminSql);
    expect(ids).toHaveLength(1);
    const latest = await readLatestRubricCheckResults({ rubricRef, workspaceId, subject }, db.adminSql);
    expect(latest.size).toBe(1);
    const row = latest.get('quality:0')!;
    expect(row).toMatchObject({ testRunId: ids[0], status: result.verdict, provenanceStatus: 'retained',
      check: { value, subject, provenance: { procedure: provenance.procedure } } });
    expect(JSON.parse(row.check.provenance!.procedure.snapshot).sourceSnapshotSha256).toBe(sample.sourceSnapshotSha256);
    const grade = fillRatingsFromLedger({ criteria: [criterion], latest, callerRatings: {}, nowMs: Date.parse(measuredAt) });
    expect(grade.ok).toBe(true);
    if (!grade.ok) throw new Error(grade.error);
    const expected = variant === 'healthy' ? 'healthy' : variant === 'harmful' ? 'broken' : 'unknown';
    expect(grade.ratings.quality!.rating).toBe(expected);
    if (value === null) expect(row.lastMeasurement).toMatchObject({ status: 'pass', check: { value: 1 } });
    expect(await readLatestRubricCheckResults({ rubricRef, workspaceId: 'other-workspace', subject }, db.adminSql)).toEqual(new Map());
    expect(await readLatestRubricCheckResults({ rubricRef, workspaceId,
      subject: { ...subject, ref: 'other-subject' } }, db.adminSql)).toEqual(new Map());
    evidence.push({ variant, sample, result, testRunIds: ids, row, grade });
  }
  await annotate('fixture samples through real PostgreSQL results ledger; not production or independent acceptance');
  Object.assign(task.meta, { contextReliabilityEvidence: { sourceSnapshot, rubricRef, subject, evidence } });
});

it('context reliability R-10: artifact-validator', () => {
  const source = finalContextSampleFixture(), sample = sampleFinalDeliveredContext(source);
  const expected = { sourceSnapshot: source, sourceSnapshotSha256: sample.sourceSnapshotSha256 };
  expect(validateFinalDeliveredContextSample(sample, expected)).toEqual({ valid: true, closed: true, errors: [] });
  const missing = structuredClone(sample); missing.attempts.pop();
  expect(validateFinalDeliveredContextSample(missing, expected).valid).toBe(false);
  const forged = structuredClone(sample); forged.usefulUnknown = 100;
  expect(validateFinalDeliveredContextSample(forged, expected).valid).toBe(false);
  source.receipts[0]!.epoch++;
  expect(validateFinalDeliveredContextSample(sample, expected).valid).toBe(false);
});

const operativeConditions: Record<typeof OPERATIVE_UNIT_CONDITIONS[number], string> = {
  'late-negation': 'Do not apply it to production.',
  approval: 'Only after explicit approval.',
  exception: 'Except when the source is read-only.',
  expiry: 'This authorization expires at 2026-01-01T00:00:00Z.',
  supersession: 'Superseded by the replacement procedure; this command is obsolete.',
};

// Cover every external canonical corpus reader before invoking the real
// builder. This fixture contains plans only; report authority is absent.
async function operativeCanonicalReaders() {
  vi.spyOn(await import('../agent-tools/search/report-source'), 'revalidateReportSourceVersions').mockResolvedValue([]);
  return vi.spyOn(await import('../agent-tools/search/knowledge-sources'), 'revalidateKnowledgeSourceVersions');
}

for (const condition of OPERATIVE_UNIT_CONDITIONS) for (const boundary of OPERATIVE_UNIT_BOUNDARIES)
it(`context reliability R-4: ${condition} ${boundary}`, async ({ annotate, task }) => {
  const observations: OperativeUnitCell[] = [];
  // The endpoint stages real offers. Canonical storage is an explicit fixture;
  // a search hit alone cannot satisfy the receipt's independent source reread.
  const canonicalCorpus = await operativeCanonicalReaders();
  for (const client of DELIVERY_MATRIX_CLIENTS) for (const source of ['memory', 'corpus'] as const)
  for (const mode of ['fits', 'limited'] as const) {
    services.writes.mockClear();
    const command = 'Apply zephyrrepair recovery.';
    const padding = mode === 'fits' ? '' : 'filler '.repeat(boundary === 'entry' ? 160 : 40);
    const sourceText = `${command} ${padding}${operativeConditions[condition]}`;
    const owner = `operative-fixture-${++sequence}`;
    const id = '11111111-1111-4111-8111-111111111111';
    const memory = { id, text: sourceText, score: 0.95, scope: 'query-fixture-user' };
    services.search.mockResolvedValue(source === 'memory' ? [memory] : []);
    services.readMemory.mockResolvedValue({ entries: source === 'memory' ? [memory] : [], total: source === 'memory' ? 1 : 0 });
    if (source === 'corpus') {
      const version = contextSourceVersion({ namespace: 'corpus:plan:query-fixture-ws',
        ref: 'plan:query-fixture-harness:operative', fullText: sourceText, revision: 'r4-fixture-v1', updatedAt: null,
        validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } });
      canonicalCorpus.mockResolvedValue([version]);
      const selected = selectCorpusLines({ queryText: 'zephyrrepair', budgetChars: boundary === 'aggregate' && mode === 'limited' ? 1 : 3000,
        hits: [{ source: 'plan', sourceId: 'query-fixture-harness:operative', excerpt: sourceText,
          meta: { contextUnit: sourceText, contextSourceVersion: JSON.stringify(version) }, score: 0.95 }] });
      vi.mocked(corpusIo.recallCorpusContext).mockResolvedValue({ ...selected, block: renderCorpusBlock(selected.lines),
        outcome: 'ok', embedderAvailable: true, candidateCount: 1, legs: null, retrievalDepth: 1, rerank: 'nothing-to-reorder' });
    } else {
      vi.mocked(corpusIo.recallCorpusContext).mockResolvedValue({ lines: [], dropped: [], block: null,
        outcome: 'ok', embedderAvailable: true, candidateCount: 0, legs: null, retrievalDepth: 0, rerank: 'nothing-to-reorder' });
    }
    // Exercise the real builder first. The endpoint then receives this exact
    // prepared object, so its aggregate clamp and receipt filter remain real.
    const prepare = injection.prepareMemoryContextBlock;
    const prepared = await prepare({ userId: 'query-fixture-user', workspaceId: 'query-fixture-ws',
      queryContext: 'zephyrrepair', harnessSlugs: [], potSlugs: [], budgetChars: 8000,
      session: { sessionId: owner, port: 'mid-turn' } });
    if (source === 'memory' && boundary === 'aggregate' && mode === 'limited')
      expect(prepared?.fragments).toHaveLength(1);
    if (mode === 'fits') {
      expect(prepared?.fragments).toHaveLength(1);
      const fragment = prepared!.fragments[0]!;
      expect(await fragment.revalidateSource?.(new AbortController().signal)).toEqual(fragment.sourceVersion);
    }
    vi.mocked(prepare).mockResolvedValueOnce(prepared);
    const request = digest(client, nativeFixture(client, 'search'));
    const response = await endpoint.handler(new Request('http://localhost/agent-mcp/mid-turn-context', { method: 'POST',
      body: JSON.stringify({ ...request, owner, client, workspace: 'query-fixture-ws',
        harness: 'query-fixture-harness', memoryReceiptMode: true }) }));
    const result = await response.json() as { ok: boolean; text: string; deliveryToken?: string; memoryFragmentOffers?: MemoryFragmentOffer[] };
    Object.assign(task.meta, { operativeUnitLastResponse: { client, source, mode, result } });
    expect(result.ok).toBe(true);
    const offers = result.memoryFragmentOffers ?? [];
    if (mode === 'fits') {
      expect(result.text).toContain(`source-evidence ${JSON.stringify(sourceText)}`);
      expect(offers).toHaveLength(1);
      expect(result.deliveryToken).toBeTruthy();
    } else {
      expect(result.text).not.toContain(command);
      expect(offers).toEqual([]);
      expect(result.deliveryToken).toBeUndefined();
      // Preserve braces inside JSON strings while separating adjacent objects.
      const pointers = result.text.matchAll(/source-pointer (\{(?:[^"{}]|"(?:\\.|[^"\\])*")*\})/g);
      for (const pointer of pointers) expect(JSON.parse(pointer[1]!)).toMatchObject({
        ref: expect.any(String), revision: 'unknown', passage: 'retrieved-unit',
        unitHash: expect.stringMatching(/^[a-f0-9]{64}$/), omitted: true,
      });
    }
    expect(services.writes).not.toHaveBeenCalled();
    const committed = await confirmMemoryEmission(getOrgPg().sql, owner, {
      token: result.deliveryToken ?? `absent-${sequence}`, fragments: offers,
    });
    expect(committed).toBe(mode === 'fits' ? 1 : 0);
    expect(services.writes).toHaveBeenCalledTimes(committed);
    observations.push({ client, condition, boundary, source, mode,
      selector: `context reliability R-4: ${condition} ${boundary}`,
      evidenceRefs: [`vitest:context-injection-reliability.integration.test.ts#R-4/${client}/${condition}/${boundary}/${source}/${mode}`],
      inputHash: sha({ sourceText, client, condition, boundary, source, mode }), returnedText: result.text,
      offeredHashes: offers.map(row => row.bodySha256), committedHashes: committed ? offers.map(row => row.bodySha256) : [], verdict: 'passed' });
  }
  const observation = { schemaVersion: 'operative-unit-observations-v1',
    evidencePlane: 'current-tree-builder-endpoint-receipt-fixture', sourceSnapshot, cells: observations };
  Object.assign(task.meta, { operativeUnitObservations: observation });
  await annotate(`operative-unit-v1 observations: ${condition} ${boundary}`, {
    contentType: 'application/json', bodyEncoding: 'utf-8', body: JSON.stringify(observation),
  });
});

it.each(['memory', 'corpus'] as const)('context reliability R-4: unavailable canonical %s read cannot stage a receipt', async source => {
  const canonicalCorpus = await operativeCanonicalReaders();
  const sourceText = 'Apply zephyrrepair recovery. Only after explicit approval.';
  const id = '11111111-1111-4111-8111-111111111111';
  const owner = `operative-unavailable-${++sequence}`;
  services.search.mockResolvedValue(source === 'memory'
    ? [{ id, text: sourceText, score: 0.95, scope: 'query-fixture-user' }] : []);
  if (source === 'corpus') {
    const version = contextSourceVersion({ namespace: 'corpus:plan:query-fixture-ws',
      ref: 'plan:query-fixture-harness:operative', fullText: sourceText, revision: 'r4-fixture-v1', updatedAt: null,
      validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } });
    canonicalCorpus.mockResolvedValue([]);
    const selected = selectCorpusLines({ queryText: 'zephyrrepair', budgetChars: 3000,
      hits: [{ source: 'plan', sourceId: 'query-fixture-harness:operative', excerpt: sourceText, score: 0.95,
        meta: { contextUnit: sourceText, contextSourceVersion: JSON.stringify(version) } }] });
    vi.mocked(corpusIo.recallCorpusContext).mockResolvedValue({ ...selected, block: renderCorpusBlock(selected.lines),
      outcome: 'ok', embedderAvailable: true, candidateCount: 1, legs: null, retrievalDepth: 1, rerank: 'nothing-to-reorder' });
  }
  const prepared = await injection.prepareMemoryContextBlock({ userId: 'query-fixture-user', workspaceId: 'query-fixture-ws',
    queryContext: 'zephyrrepair', harnessSlugs: [], potSlugs: [], budgetChars: 8000,
    session: { sessionId: owner, port: 'mid-turn' } });
  expect(prepared?.fragments).toHaveLength(1);
  expect(await prepared!.fragments[0]!.revalidateSource?.(new AbortController().signal)).toBeNull();
  vi.mocked(injection.prepareMemoryContextBlock).mockResolvedValueOnce(prepared);
  const response = await endpoint.handler(new Request('http://localhost/agent-mcp/mid-turn-context', { method: 'POST',
    body: JSON.stringify({ ...digest('codex', nativeFixture('codex', 'search')), owner, client: 'codex',
      workspace: 'query-fixture-ws', harness: 'query-fixture-harness', memoryReceiptMode: true }) }));
  const result = await response.json() as { text: string; deliveryToken?: string; memoryFragmentOffers?: MemoryFragmentOffer[] };
  expect(result.text).toContain(`source-evidence ${JSON.stringify(sourceText)}`);
  expect(result.deliveryToken).toBeUndefined();
  expect(result.memoryFragmentOffers ?? []).toEqual([]);
  expect(services.writes).not.toHaveBeenCalled();
});

/** R-11 exercises the real compiler, facade, source verifier, evidence producer
 * and rating gate. Only the graph transport is a fixture. This closed fixture
 * census is not the still-required census of production delivery consumers. */
function consumerImpactFixture() {
  const root = mkdtempSync(join(tmpdir(), 'context-consumer-impact-'));
  const helper = 'packages/fixture/helper.ts';
  const bodies: Record<string, string> = {
    [helper]: 'export function deliveryHelper() { return true; }\n',
    ...Object.fromEntries(CONSUMER_IMPACT_BOUNDARIES.map(boundary => [`packages/fixture/${boundary}.ts`,
      `import { deliveryHelper } from './helper';\nexport function ${boundary.replaceAll('-', '_')}() { return deliveryHelper(); }\n`])),
  };
  mkdirSync(join(root, 'packages/fixture'), { recursive: true });
  for (const [path, body] of Object.entries(bodies)) writeFileSync(join(root, path), body, 'utf8');
  try {
    const compiler = firstPartyCallers({ ts, root, name: 'deliveryHelper', filePath: helper, paths: ['packages/fixture'], limit: 25 });
    expect(compiler.error).toBeNull();
    expect(compiler.attribution?.resolved).toBe(CONSUMER_IMPACT_BOUNDARIES.length);
    expect(compiler.evidence?.sourceScope.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(compiler.evidence?.relationships.every(edge => edge.origin === 'compiler' && edge.knowledge === 'observed')).toBe(true);
    const consumers = compiler.sites.map(site => `${site.path}:${site.line1}`).sort();
    expect(consumers).toEqual(CONSUMER_IMPACT_BOUNDARIES.map(boundary => `packages/fixture/${boundary}.ts:2`).sort());
    // Synthetic revision belongs to this fixture only, never a committed-tree claim.
    const commit = sha(Object.entries(bodies).sort()).slice(0, 40);
    const source = { root, commit, files: Object.keys(bodies).sort().map(path => ({ path,
      sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex') })) };
    const fingerprint = consumerImpactSourceFingerprint(source);
    const census: ConsumerImpactArtifact['census'] = { discovered: consumers,
      classified: CONSUMER_IMPACT_BOUNDARIES.map(boundary => ({ id: `packages/fixture/${boundary}.ts:2`, boundary })), unknown: [] };
    return { root, helper, bodies, compiler, source, fingerprint, census,
      tooling: { compiler: { generation: `typescript/${ts.version}/${compiler.evidence!.sourceScope.sourceFingerprint}`, coverage: 'bounded' as const },
        graph: { generation: 'fixture/gitnexus-context-envelope-v1', coverage: 'unverified' as const } },
      dispose: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

async function exerciseConsumerImpact(fixture: ReturnType<typeof consumerImpactFixture>, scenario: ConsumerImpactCell['scenario']): Promise<ConsumerImpactCell> {
  const intent: AssistIntent = { kind: 'change', symbol: 'deliveryHelper', path: fixture.helper, exported: true, change: 'behavior' };
  const wire = (body: unknown) => ({ content: [{ text: JSON.stringify(body) }] });
  const dispatch: GitnexusDispatch = async tool => {
    if (scenario === 'unavailable-tool') throw new Error('R-11 fixture graph unavailable');
    if (tool === 'list_repos') return wire({ repositories: [{ name: 'papercusp', lastCommit: fixture.source.commit,
      indexedAt: '2026-11-06T00:00:00.000Z', staleness: { commitsBehind: 0 } }] });
    if (scenario === 'ambiguous-symbol') return wire({ status: 'ambiguous', candidates: [
      { name: 'deliveryHelper', filePath: fixture.helper }, { name: 'deliveryHelper', filePath: 'packages/other/helper.ts' }] });
    return wire({ status: 'found', symbol: { uid: `Function:${fixture.helper}:deliveryHelper`, name: 'deliveryHelper',
      kind: 'Function', filePath: fixture.helper, startLine: 0, endLine: 0 }, epistemic: 'exact',
      incoming: { calls: scenario === 'empty-result' ? [] : fixture.compiler.sites.map(site => ({
        uid: `Function:${site.path}:consumer`, name: 'consumer', filePath: site.path, startLine: site.line1! - 1 })) }, outgoing: { accesses: [] } });
  };
  let revision = fixture.source.commit;
  if (scenario === 'stale-fingerprint') {
    writeFileSync(join(fixture.root, fixture.helper), fixture.bodies[fixture.helper] + '// source changed after capture\n', 'utf8');
    const current = { ...fixture.source, files: fixture.source.files.map(file => ({ ...file,
      sha256: createHash('sha256').update(readFileSync(join(fixture.root, file.path))).digest('hex') })) };
    expect(consumerImpactSourceFingerprint(current)).not.toBe(fixture.fingerprint);
    revision = sha(current.files).slice(0, 40);
  }
  try {
    const result = await runSelectiveAssist(intent, { dispatch, currentRevision: () => revision,
      readSource: path => readFileSync(join(fixture.root, path), 'utf8') });
    expect(result.outcome).toBe(scenario === 'current-source' ? 'graph-used' : scenario === 'stale-fingerprint' ? 'graph-stale'
      : scenario === 'empty-result' ? 'graph-empty' : 'graph-failed');
    expect(result.blocking).toBe(false);
    if (scenario !== 'current-source') {
      expect(result.verifiedSites).toEqual([]);
      expect(result.route).toBe('lsp');
    }
    const record = buildConsumerEvidence(intent, result, { sourceRevision: revision,
      behavior: { checked: ['fixture compiler binding and current-source consumer checks'], notChecked: [] },
      tests: [{ path: `fixture-case:${scenario}`, result: 'pass' }],
      fallbackUsed: scenario !== 'current-source', fallbackReason: scenario !== 'current-source' ? result.note : null });
    expect(evaluateConsumerEvidence(record).verdict).toBe(scenario === 'current-source' ? 'verified' : 'unverified');
    expect(gateConsumerRating({ proposedRating: 'healthy', passRatings: ['healthy'], ratingScale: ['healthy', 'broken', 'unknown'], record }).rating)
      .toBe(scenario === 'current-source' ? 'healthy' : 'unknown');
    return { scenario, selector: `context reliability R-11: ${scenario}`, evidenceRefs: [`fixture:${scenario}:${fixture.fingerprint}`], record, verdict: 'passed' };
  } finally { writeFileSync(join(fixture.root, fixture.helper), fixture.bodies[fixture.helper]!, 'utf8'); }
}

for (const scenario of CONSUMER_IMPACT_CASES) it(`context reliability R-11: ${scenario}`, async ({ task, annotate }) => {
  const fixture = consumerImpactFixture();
  try {
    const cell = await exerciseConsumerImpact(fixture, scenario);
    const observation = { schemaVersion: 'consumer-impact-observations-v1', scenario,
      evidencePlane: 'current-tree-compiler-and-graph-transport-fixture', sourceSnapshot,
      source: fixture.source, sourceFingerprint: fixture.fingerprint, tooling: fixture.tooling, census: fixture.census, cells: [cell],
      productionConsumerCensus: 'UNKNOWN', runtimeExecution: 'UNKNOWN', shipment: 'UNKNOWN' };
    Object.assign(task.meta, { consumerImpactObservations: observation });
    await annotate(`consumer-impact-v1 observations: ${scenario}`, { contentType: 'application/json', bodyEncoding: 'utf-8', body: JSON.stringify(observation) });
  } finally { fixture.dispose(); }
});

it('context reliability R-11: artifact-validator', async () => {
  const fixture = consumerImpactFixture();
  try {
    const cells: ConsumerImpactCell[] = [];
    for (const scenario of CONSUMER_IMPACT_CASES) cells.push(await exerciseConsumerImpact(fixture, scenario));
    const identity = { planRevision: 1, planHash: sha('validator-fixture-plan'), rubricRevision: 1, rubricHash: sha('validator-fixture-rubric'),
      barHash: sha('validator-fixture-bar'), specHash: sha('validator-fixture-spec'), sourceHash: fixture.fingerprint,
      testHash: sourceSnapshot.find(file => file.path === './context-injection-reliability.integration.test.ts')!.sha256,
      runtimeGeneration: 'fixture-only-not-production' };
    const artifact: ConsumerImpactArtifact = { schemaVersion: 'consumer-impact-v1', identity, source: fixture.source,
      sourceFingerprint: fixture.fingerprint, tooling: fixture.tooling, census: fixture.census, cells };
    const expected = structuredClone(artifact);
    expect(validateConsumerImpactArtifact(artifact, expected)).toEqual({ valid: true, closed: true, errors: [] });
    const reject = (mutate: (copy: ConsumerImpactArtifact) => void) => {
      const copy = structuredClone(artifact); mutate(copy);
      expect(validateConsumerImpactArtifact(copy, expected).valid).toBe(false);
    };
    reject(copy => { copy.cells.pop(); });
    reject(copy => { copy.cells.push(copy.cells[0]!); });
    reject(copy => { copy.cells[0]!.verdict = 'UNKNOWN'; });
    reject(copy => { copy.cells[0]!.evidenceRefs = []; });
    reject(copy => { copy.cells[0]!.record.consumers[0]!.path = 'packages/unclassified.ts'; });
    reject(copy => { copy.source.files[0]!.sha256 = sha('stale bytes'); });
    reject(copy => { copy.source.root += '/foreign-root'; });
    reject(copy => { copy.sourceFingerprint = sha('stale snapshot'); });
    reject(copy => { copy.identity.sourceHash = sha('stale identity'); });
    reject(copy => { copy.tooling.compiler.generation = 'foreign compiler'; });
    reject(copy => { copy.tooling.compiler.coverage = 'UNKNOWN'; });
    reject(copy => { copy.tooling.graph.generation = 'foreign index'; });
    reject(copy => { copy.census.discovered.push('packages/new-caller.ts:1'); });
    reject(copy => { copy.census.classified.pop(); });
    reject(copy => { copy.census.unknown.push('unresolved dynamic caller'); });
    expect(validateConsumerImpactArtifact(null, expected).valid).toBe(false);
    expect(validateConsumerImpactArtifact(artifact, { ...expected, cells: [] }).valid).toBe(false);
  } finally { fixture.dispose(); }
});

it('context reliability R-4: artifact-validator', () => {
  const identity = { planRevision: 35, planHash: '1'.repeat(64), rubricRevision: 3, rubricHash: '2'.repeat(64),
    barHash: '3'.repeat(64), specHash: '4'.repeat(64), sourceHash: '5'.repeat(64), testHash: '6'.repeat(64), runtimeGeneration: 'validator-fixture-only' };
  const cells: OperativeUnitCell[] = [];
  for (const client of DELIVERY_MATRIX_CLIENTS) for (const condition of OPERATIVE_UNIT_CONDITIONS)
  for (const boundary of OPERATIVE_UNIT_BOUNDARIES) for (const source of ['memory', 'corpus'] as const)
  for (const mode of ['fits', 'limited'] as const) cells.push({ client, condition, boundary, source, mode,
    selector: `context reliability R-4: ${condition} ${boundary}`, evidenceRefs: ['validator-control-fixture'],
    inputHash: sha({ client, condition, boundary, source, mode }), returnedText: mode === 'fits' ? 'complete quoted unit' : '',
    offeredHashes: mode === 'fits' ? ['a'.repeat(64)] : [], committedHashes: mode === 'fits' ? ['a'.repeat(64)] : [], verdict: 'passed' });
  const artifact: OperativeUnitArtifact = { schemaVersion: 'operative-unit-v1', identity, cells };
  const expected = structuredClone({ identity, cells });
  expect(validateOperativeUnitArtifact(artifact, expected)).toMatchObject({ valid: true, closed: true });
  const reject = (mutate: (copy: OperativeUnitArtifact) => void) => {
    const copy = structuredClone(artifact); mutate(copy);
    expect(validateOperativeUnitArtifact(copy, expected).valid).toBe(false);
  };
  reject(copy => { copy.cells.pop(); });
  reject(copy => { copy.cells.push(copy.cells[0]!); });
  reject(copy => { copy.cells[0]!.condition = 'unknown' as never; });
  reject(copy => { copy.identity.sourceHash = 'b'.repeat(64); });
  reject(copy => { copy.identity.runtimeGeneration = 'stale-runtime'; });
  reject(copy => { copy.cells[0]!.inputHash = 'c'.repeat(64); });
  reject(copy => { copy.cells[0]!.returnedText = 'truncated imperative'; });
  reject(copy => { copy.cells[0]!.offeredHashes = []; });
  reject(copy => { copy.cells[0]!.committedHashes = []; });
  reject(copy => { copy.cells.find(cell => cell.mode === 'limited')!.committedHashes = ['d'.repeat(64)]; });
  reject(copy => { copy.cells[0]!.verdict = 'UNKNOWN'; });
  reject(copy => { copy.cells[0]!.evidenceRefs = []; });
  expect(validateOperativeUnitArtifact(null, expected).valid).toBe(false);
  expect(validateOperativeUnitArtifact(artifact, { identity, cells: [] }).valid).toBe(false);
});

it('context reliability R-3: artifact-validator', () => {
  // Validator controls are synthetic; successful scenario evidence above is
  // separately asserted and retained by the canonical runner, not invented here.
  const identity = { planRevision: 31, planHash: '1'.repeat(64), rubricRevision: 3, rubricHash: '2'.repeat(64),
    barHash: '3'.repeat(64), specHash: '4'.repeat(64), sourceHash: '5'.repeat(64), testHash: '6'.repeat(64), runtimeGeneration: 'validator-fixture-only' };
  const cells: GroundedQueryCell[] = DELIVERY_MATRIX_CLIENTS.flatMap(client => GROUNDED_QUERY_CASES.map(scenario => {
    const fixture = fixtures[scenario], active = !!fixture.expected.lexical;
    const lexical = active && (!fixture.expected.semantic || fixture.unavailable);
    return { client, scenario, selector: `context reliability R-3: ${scenario}`, evidenceRefs: ['validator-control-fixture'],
      inputHash: sha(fixture), signals: fixture.expected, retrievalCalls: active ? 1 : 0,
      semanticCalls: active && !lexical ? 1 : 0, lexicalCalls: lexical ? 1 : 0,
      returnedText: active ? 'fixture result' : '', verdict: 'passed' as const };
  }));
  const expected = { identity, cells };
  const artifact: GroundedQueryArtifact = { schemaVersion: 'grounded-query-v1', identity, cells };
  expect(validateGroundedQueryArtifact(artifact, expected)).toMatchObject({ valid: true, closed: true });
  const reject = (mutate: (copy: GroundedQueryArtifact) => void) => {
    const copy = structuredClone(artifact); mutate(copy);
    expect(validateGroundedQueryArtifact(copy, expected).valid).toBe(false);
  };
  reject(copy => { copy.cells.pop(); });
  reject(copy => { copy.cells.push(copy.cells[0]!); });
  reject(copy => { copy.cells[0]!.scenario = 'unknown' as never; });
  reject(copy => { copy.identity.sourceHash = 'a'.repeat(64); });
  reject(copy => { copy.identity.runtimeGeneration = 'stale-runtime'; });
  reject(copy => { copy.cells[0]!.signals.fingerprint = 'b'.repeat(64); });
  reject(copy => { copy.cells[0]!.signals.semantic = 'raw shell'; });
  reject(copy => { copy.cells[0]!.inputHash = 'c'.repeat(64); });
  reject(copy => { copy.cells[0]!.retrievalCalls = 0; });
  reject(copy => { copy.cells[0]!.semanticCalls = 0; });
  reject(copy => { copy.cells[0]!.returnedText = 'unrelated history'; });
  reject(copy => { copy.cells[0]!.evidenceRefs = []; });
  reject(copy => { copy.cells[0]!.verdict = 'UNKNOWN'; });
  expect(validateGroundedQueryArtifact(null, expected).valid).toBe(false);
  expect(validateGroundedQueryArtifact(artifact, { identity, cells: [] }).valid).toBe(false);
});

for (const scenario of CACHE_IDENTITY_CASES) it(`context reliability R-5: ${scenario}`, async ({ annotate, task }) => {
  const cache = createCache();
  const base = { workspace: 'query-fixture-ws', principal: 'query-fixture-user',
    query: 'repair cache for WI-6512', task: 'cache-task', authorization: 'owner' };
  let builds = 0, source = 'source-one';
  services.search.mockImplementation(async (query: string, opts: { scope: string[] }) => [{
    id: '11111111-1111-4111-8111-111111111111', text: `${source}: ${query}: ${opts.scope[0]}`,
    score: 0.95, scope: opts.scope[0],
  }]);
  let gate: Promise<void> | undefined, lastBuild: Promise<Awaited<ReturnType<typeof injection.prepareMemoryContextBlock>>> | undefined;
  const read = (change: Partial<typeof base> = {}, softTtlMs = Infinity, deadlineMs = 500) => {
    const input = { ...base, ...change }, wait = gate;
    return getMemoryBlockBoundedResult(input.workspace, 'cache-fixture-conversation', () => {
      builds++;
      lastBuild = (async () => {
        await wait;
        return injection.prepareMemoryContextBlock({ userId: input.principal, workspaceId: input.workspace,
          queryContext: input.query, harnessSlugs: [], potSlugs: [], budgetChars: 8000 });
      })();
      return lastBuild;
    }, { cache, sessionId: 'query-fixture-session', softTtlMs, deadlineMs, retrieval: {
      principalId: input.principal, queryText: input.query, taskContext: input.task, authorizationScope: input.authorization,
    } });
  };
  const first = await read({}, scenario === 'identical-refresh' ? 0 : Infinity);
  expect(first.status).toBe('ready');
  expect(first.block?.text).toContain('source-one');
  let result = first;
  if (scenario === 'query-task-change') {
    result = await read({ query: 'repair delivery receipts WI-6513' });
    expect(result.block?.text).toContain('WI-6513');
    result = await read({ task: 'other-task' });
    expect(builds).toBe(3);
  } else if (scenario === 'authorization-widen' || scenario === 'authorization-narrow') {
    services.control.generation++;
    services.control.applied = scenario;
    services.control.scope = scenario === 'authorization-narrow' ? 'public' : 'owner-expanded';
    result = await read();
    expect(builds).toBe(2);
  } else if (scenario === 'workspace-isolation' || scenario === 'principal-isolation') {
    result = await read(scenario === 'workspace-isolation' ? { workspace: 'other-workspace' } : { principal: 'other-principal' });
    expect(builds).toBe(2);
    if (scenario === 'principal-isolation') expect(result.block?.text).toContain('other-principal');
  } else if (scenario === 'source-change') {
    source = 'source-two';
    cache.invalidateByTag(base.workspace, MEMORY_CANONICAL_CACHE_TAG);
    result = await read();
    expect(result.block?.text).toContain('source-two');
    expect(result.block?.text).not.toContain('source-one');
  } else {
    let release!: () => void;
    gate = new Promise(resolve => { release = resolve; });
    if (scenario === 'identical-refresh') {
      source = 'source-two';
      result = await read({}, 0);
      expect(result.block?.text).toBe(first.block?.text);
      expect(builds).toBe(2);
    } else {
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      result = await read({ query: 'unrelated cold query WI-6514' }, Infinity, 20);
      expect(result).toEqual({ status: 'deadline', block: null });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('20ms prompt-build deadline'));
    }
    release(); await lastBuild; await Promise.resolve();
    if (scenario === 'identical-refresh') {
      result = await read({}, 0);
      expect(result.block?.text).toContain('source-two');
    }
  }
  const cell: CacheIdentityCell = { scenario, selector: `context reliability R-5: ${scenario}`,
    evidenceRefs: [`vitest:context-injection-reliability.integration.test.ts#R-5/${scenario}`],
    inputHash: sha({ base, scenario }), authorityHash: sha(services.control), returnedHash: sha(result.block?.text ?? null),
    builds, status: result.status, verdict: 'passed' };
  const observation = { schemaVersion: 'cache-identity-observations-v1',
    evidencePlane: 'current-tree-cache-builder-fixture', sourceSnapshot, cells: [cell] };
  Object.assign(task.meta, { cacheIdentityObservations: observation });
  await annotate(`cache-identity-v1 observations: ${scenario}`, { contentType: 'application/json', bodyEncoding: 'utf-8', body: JSON.stringify(observation) });
});

it('context reliability R-5: artifact-validator', () => {
  const identity = { planRevision: 35, planHash: '1'.repeat(64), rubricRevision: 3, rubricHash: '2'.repeat(64),
    barHash: '3'.repeat(64), specHash: '4'.repeat(64), sourceHash: '5'.repeat(64), testHash: '6'.repeat(64), runtimeGeneration: 'validator-fixture-only' };
  const cells: CacheIdentityCell[] = CACHE_IDENTITY_CASES.map(scenario => ({ scenario,
    selector: `context reliability R-5: ${scenario}`, evidenceRefs: ['validator-control-fixture'],
    inputHash: sha(scenario), authorityHash: sha('authority'), returnedHash: sha(scenario), builds: 2,
    status: scenario === 'timeout-abstention' ? 'deadline' : 'ready', verdict: 'passed' }));
  const artifact: CacheIdentityArtifact = { schemaVersion: 'cache-identity-v1', identity, cells };
  expect(validateCacheIdentityArtifact(artifact, { identity, cells })).toEqual({ valid: true, closed: true, errors: [] });
  const reject = (mutate: (copy: CacheIdentityArtifact) => void) => {
    const copy = structuredClone(artifact); mutate(copy);
    expect(validateCacheIdentityArtifact(copy, { identity, cells }).valid).toBe(false);
  };
  reject(copy => { copy.cells.pop(); });
  reject(copy => { copy.cells.push(copy.cells[0]!); });
  reject(copy => { copy.cells[0]!.scenario = 'unknown' as never; });
  reject(copy => { copy.cells[0]!.verdict = 'UNKNOWN'; });
  reject(copy => { copy.cells[0]!.evidenceRefs = []; });
  reject(copy => { copy.cells[0]!.returnedHash = sha('stale source'); });
  reject(copy => { copy.cells[0]!.authorityHash = sha('other principal'); });
  reject(copy => { copy.cells[0]!.builds = 0; });
  reject(copy => { copy.cells[0]!.status = 'error'; });
  reject(copy => { copy.identity.sourceHash = sha('old tree'); });
  reject(copy => { copy.identity.runtimeGeneration = 'stale-runtime'; });
  expect(validateCacheIdentityArtifact(null, { identity, cells }).valid).toBe(false);
  expect(validateCacheIdentityArtifact(artifact, { identity, cells: [] }).valid).toBe(false);
});

it('context reliability R-8: proof-aware notice selection survives final context packing', async ({ task, annotate }) => {
  const { changedSystemNoticeDelivery, relevantSystemNoticeDelivery, systemNoticeIdentity } =
    await import('../agent-tools/coordination/inbox-visibility');
  const { renderInjection } = await import('../coord-schema');
  const { AMBIENT_PUSH_WINDOW_MS: reminderMs } = await import('../ambient-push');
  const now = 1_800_000_000_000;
  const owner = 'su-r8-packing';
  const base = { msg_id: 'r8-base', ts: new Date(now).toISOString(), from: 'system-watchdog',
    to: ['*'], kind: 'message', auto: true, category: 'severe-event', condition_key: 'r8:WI-6066',
    severity: 'warning', state_version: 1, summary: 'WI-6066 requires approval before recovery.' };
  const identity = systemNoticeIdentity(base)!;
  expect(identity).not.toBeNull();
  const critical = { ...base, msg_id: 'r8-critical', condition_key: 'other-task', severity: 'critical',
    summary: 'Critical unrelated-task condition must remain visible.' };
  const directed = { ...base, msg_id: 'r8-directed', to: [owner], condition_key: 'directed',
    summary: 'Addressed request must remain visible.' };
  const unrelated = { ...base, msg_id: 'r8-unrelated', condition_key: 'other-task',
    summary: 'Unrelated routine condition.' };
  const observations: unknown[] = [];
  for (const scenario of ['unproven', 'recent-proof', 'due-proof', 'material-change', 'cadence-change'] as const) {
    const notice = scenario === 'material-change' ? { ...base, state_version: 2 } : base;
    const cadence = scenario === 'cadence-change' ? reminderMs + 1 : reminderMs;
    const emittedAt = now - (scenario === 'due-proof' ? reminderMs : 1);
    const previous = scenario === 'unproven' ? {} : { [identity.key]: { fingerprint: identity.fingerprint, emittedAt } };
    const scoped = relevantSystemNoticeDelivery([notice, critical, directed, unrelated],
      { ownerId: owner, workItemIds: ['WI-6066'] });
    expect(scoped.excluded).toBe(1);
    const selected = changedSystemNoticeDelivery(scoped.entries, previous, 8, { now, reminderMs: cadence });
    const expectedIds = scenario === 'recent-proof' ? ['r8-critical', 'r8-directed']
      : ['r8-base', 'r8-critical', 'r8-directed'];
    expect(selected.entries.map(row => row.msg_id)).toEqual(expectedIds);
    const candidates: ContextCandidate[] = selected.entries.map(row => ({ sourceRef: row.msg_id,
      revision: systemNoticeIdentity(row, cadence)?.fingerprint ?? 'directed', class: 'ambient', required: false,
      text: renderInjection([row] as never) }));
    const input = { attemptId: `r8-packing-${scenario}`, candidates, budgetBytes: 4096 };
    const packed = packContextCandidates(input);
    expect(validateContextPackingResult(packed, input)).toEqual({ valid: true, errors: [] });
    expect(packed.receipt.candidates.filter(row => row.reason === 'selected').map(row => row.sourceRef)).toEqual(expectedIds);
    expect(packed.text).not.toContain(unrelated.summary);
    const omitted = packContextCandidates({ ...input, budgetBytes: 0 });
    expect(omitted.text).toBe('');
    // A packing/arrival fingerprint is not an emission receipt, including when
    // the final packer omitted every line. Retrying must retain all candidates.
    const retry = changedSystemNoticeDelivery(scoped.entries, selected.state, 8, { now, reminderMs: cadence });
    expect(retry.entries.map(row => row.msg_id)).toEqual(['r8-base', 'r8-critical', 'r8-directed']);
    observations.push({ scenario, cadence, emittedAt, scoped, selected, packed, omitted, retry });
  }
  const evidence = { schemaVersion: 'notice-packing-observations-v1', sourceSnapshot, observations,
    evidencePlane: 'selector + actual renderer + final packer; fixture clock and proof inputs',
    nativeEmission: 'UNKNOWN', postgres: 'UNKNOWN', authenticatedMcpHost: 'UNKNOWN', shipment: 'UNKNOWN' };
  Object.assign(task.meta, { noticePackingObservations: evidence });
  await annotate('R-8 notice selection and packing observations', { contentType: 'application/json',
    bodyEncoding: 'utf-8', body: JSON.stringify(evidence) });
});

const PACKING_CASES = ['boundary-budgets', 'alert-storm', 'mandatory-overflow', 'omission-receipt',
  'zero-one-byte-out-of-band-receipt', 'diagnostic-pagination', 'artifact-validator'] as const;
for (const scenario of PACKING_CASES) it(`context reliability R-6: ${scenario}`, async ({ annotate, task }) => {
  const scope: ContextPackingScope = { workspaceId: 'query-fixture-ws', ownerId: `packing-${scenario}`,
    harness: 'query-fixture-harness', port: 'turn-start', client: 'codex' };
  const unit = (sourceRef: string, text: string, cls: ContextCandidate['class'], required = false): ContextCandidate =>
    ({ sourceRef, text, class: cls, required, revision: 'fixture-r1' });
  const mandatory = [unit('CTRL:21', '⟦CTRL⟧ authenticated control', 'control', true),
    unit('order:14', 'Avi: preserve the current owner duty.', 'owner', true),
    unit('correction:1', '修正: do this only after approval.', 'correction', true),
    unit('policy:3', 'Retain binding policy as a complete unit.', 'policy', true)];
  const recallSources = [
    { sourceRef: 'memory:1', revision: 'memory-r1', class: 'memory' as const, rendered: 'memory '.repeat(200) },
    { sourceRef: 'corpus:WI-small', revision: 'corpus-r1', class: 'corpus' as const, rendered: '- complete unit unless waived.' },
  ];
  const optional = [...optionalRecallContextCandidates({ ...unit('recall',
    `## Recall\n\n${recallSources.map(source => source.rendered).join('\n')}`, 'memory'), sourceUnits: recallSources }),
    unit('code:1', 'exported symbol facts', 'code')];
  const budgets = scenario === 'boundary-budgets' ? [0, 1, 255, 4096, 6000, 24000, computeTurnDoors(0).injections * 4]
    : scenario === 'zero-one-byte-out-of-band-receipt' ? [0, 1] : [255];
  const observations: Array<Record<string, unknown>> = [];
  for (const [number, budgetBytes] of budgets.entries()) {
    const candidates = scenario === 'mandatory-overflow'
      ? [unit('oversized-owner-duty', '字'.repeat(1000), 'owner', true), ...optional]
      : scenario === 'alert-storm'
        ? [...Array.from({ length: 1000 }, (_, index) => unit(`alert:${index}`, 'unrelated alert '.repeat(50), 'ambient')), ...mandatory, ...optional]
        : [...mandatory, ...optional];
    const input = { attemptId: `r6-${scenario}-${number}`, budgetBytes, candidates,
      framing: { prefix: '始\n', separator: '\n—\n', suffix: '\n終' } };
    const result = packContextCandidates(input);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(budgetBytes);
    expect(validateContextPackingResult(result, input)).toEqual({ valid: true, errors: [] });
    if (scenario === 'omission-receipt') {
      expect(result.text).toContain('## Recall\n\n- complete unit unless waived.');
      expect(result.text).not.toContain(recallSources[0].rendered);
      expect(result.receipt.candidates.filter(row => row.sourceUnits).map(row => ({
        reason: row.reason, source: row.sourceUnits?.[0].sourceRef,
      }))).toEqual([{ reason: 'budget', source: 'memory:1' }, { reason: 'selected', source: 'corpus:WI-small' }]);
    }
    if (budgetBytes <= 1 || scenario === 'mandatory-overflow') {
      expect(result.text).toBe(''); expect(result.selectedIndexes).toEqual([]);
      expect(result.receipt.status).toBe('mandatory-overflow');
    } else {
      for (const row of mandatory) expect(result.text).toContain(row.text);
    }
    const nativeReservations: Array<Record<string, unknown>> = [];
    for (const [clientName, client] of [['codex', codex], ['claude', claude], ['omp', omp]] as const)
      for (const port of ['turn-start', 'mid-turn'] as const) {
      const nativeInput = { ...input, attemptId: `${input.attemptId}-${clientName}-${port}`,
        carrier: contextPackingCarrier(clientName, port) };
      const native = packContextCandidates(nativeInput);
      expect(validateContextPackingResult(native, nativeInput)).toEqual({ valid: true, errors: [] });
      const rendered = client.render(port, native.text, {});
      // Exercise the real adapter and append seam. The CLI/native runtime is
      // exercised separately; these remain preparation/fixture observations.
      const modelBody = !native.text || rendered === null ? '' : client === omp ? rendered + '\n'
        : JSON.parse(rendered).hookSpecificOutput.additionalContext;
      const stringBytes = client === omp && port === 'mid-turn' && modelBody
        ? Buffer.byteLength(appendAdvisories('ORIGINAL', modelBody) as string) - Buffer.byteLength('ORIGINAL')
        : Buffer.byteLength(modelBody);
      const arrayBytes = Buffer.byteLength(modelBody);
      expect(stringBytes).toBe(native.receipt.contextBytes);
      expect(arrayBytes).toBeLessThanOrEqual(native.receipt.contextBytes);
      expect(native.receipt.contextBytes).toBeLessThanOrEqual(budgetBytes);
      if (scenario === 'omission-receipt') {
        expect(modelBody).toContain('- complete unit unless waived.');
        expect(modelBody).not.toContain(recallSources[0].rendered);
        expect(native.receipt.candidates.filter(row => row.sourceUnits).map(row => row.reason))
          .toEqual(['budget', 'selected']);
      }
      const nativeScope = { ...scope, client: clientName, port };
      const artifact = await saveContextPackingReceipt(nativeScope, native.receipt);
      expect((await loadContextPackingReceipt(nativeScope, nativeInput.attemptId))?.receipt).toEqual(native.receipt);
      nativeReservations.push({ client: clientName, port, receipt: native.receipt, artifact, stringBytes, arrayBytes,
        bodySha256: sha(modelBody), nativeEmission: 'UNKNOWN' });
    }
    const ref = await saveContextPackingReceipt(scope, result.receipt);
    const stored = await loadContextPackingReceipt(scope, input.attemptId);
    expect(stored?.receipt).toEqual(result.receipt);
    expect(stored?.receipt.candidates).toHaveLength(candidates.length);
    if (scenario === 'diagnostic-pagination') {
      const chunks: Buffer[] = []; let offset: number | null = 0;
      do {
        const pageText = pageContextPackingReceipt(stored!, offset, 512);
        expect(Buffer.byteLength(pageText)).toBeLessThanOrEqual(512);
        const page = JSON.parse(pageText); chunks.push(Buffer.from(page.data, 'base64')); offset = page.nextOffset;
      } while (offset !== null);
      expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(stored);
    }
    if (scenario === 'artifact-validator') {
      for (const mutate of [
        (copy: typeof result) => { copy.receipt.candidates.pop(); },
        (copy: typeof result) => { copy.receipt.candidates[0].fragmentSha256 = '0'.repeat(64); },
        (copy: typeof result) => { copy.text += 'over-budget '.repeat(1000); },
        (copy: typeof result) => { copy.receipt.tokenEstimate.value = 0; },
        (copy: typeof result) => { copy.receipt.attemptId = 'foreign-attempt'; },
        (copy: typeof result) => { copy.receipt.candidates[0].reason = 'budget'; },
      ]) {
        const copy = structuredClone(result); mutate(copy); expect(validateContextPackingResult(copy, input).valid).toBe(false);
      }
    }
    observations.push({ receipt: result.receipt, artifact: ref, inputHash: sha(input), nativeReservations });
  }
  const observation = { schemaVersion: 'context-packing-observations-v1', scenario,
    evidencePlane: 'current-tree-composer-adapter-storage-fixture', sourceSnapshot, observations,
    nativeEmission: 'UNKNOWN', postgres: 'UNKNOWN', shipment: 'UNKNOWN' };
  Object.assign(task.meta, { contextPackingObservations: observation });
  await annotate(`context-packing-v1 observations: ${scenario}`, {
    contentType: 'application/json', bodyEncoding: 'utf-8', body: JSON.stringify(observation),
  });
});
