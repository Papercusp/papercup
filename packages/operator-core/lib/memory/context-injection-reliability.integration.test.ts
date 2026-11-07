/** Production adapter -> endpoint -> real query/builder integration. External
 * storage/index/identity services are deterministic fixtures. These query tests
 * do not certify native emission. The database-independent R-7 cases live in
 * native-mcp-export.integration.test.ts. Neither suite proves shipment. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createCache } from '@papercusp/cache';
import { getMemoryBlockBoundedResult, MEMORY_CANONICAL_CACHE_TAG } from './injection-block-cache';
import * as codex from '../../../../apps/operator/scripts/hooks/inject/adapters/codex.mjs';
import * as claude from '../../../../apps/operator/scripts/hooks/inject/adapters/claude.mjs';
import * as omp from '../../../../apps/operator/scripts/hooks/inject/adapters/omp.mjs';
import * as injection from './injection';
import * as corpusIo from './corpus-recall-io';
import * as recallStats from './recall-stats';
import { setSessionConfinementResolver } from '../capability-envelope/session-confinement-port';
import { resetMemoryDegradedForTest } from './op-deadline';
import { _resetSessionEpochLedgerForTests, confirmMemoryEmission, type MemoryFragmentOffer } from './session-epoch-ledger';
import { getOrgPg } from '@papercusp/db-org';
import { selectCorpusLines, renderCorpusBlock } from './corpus-recall';
import { configureReadCursorStore, InMemoryReadCursorStore, resetReadCursorStore } from '../agent-tools/coordination/read-cursors';
import routes from '../endpoint-route/routes/agent-mcp/mid-turn-context';
import { DELIVERY_MATRIX_CLIENTS, GROUNDED_QUERY_CASES, validateGroundedQueryArtifact,
  CACHE_IDENTITY_CASES, validateCacheIdentityArtifact, type CacheIdentityCell, type CacheIdentityArtifact,
  OPERATIVE_UNIT_CONDITIONS, OPERATIVE_UNIT_BOUNDARIES, validateOperativeUnitArtifact,
  type OperativeUnitCell, type OperativeUnitArtifact,
  type GroundedQueryArtifact, type GroundedQueryCell } from './injection-delivery-coverage';

const services = vi.hoisted(() => ({
  unavailable: false,
  control: { generation: 1, applied: 'cache-fixture-identity', scope: 'cache-fixture-task' },
  search: vi.fn(), lexical: vi.fn(), coverage: vi.fn(), writes: vi.fn(),
}));
vi.mock('@papercusp/db-org', async orig => ({ ...await orig<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join('');
    if (query.includes('control_generation AS generation')) return [{ ...services.control }];
    if (/INSERT INTO harness_shared\.(memory|corpus)_session_surfaced/.test(query)) {
      services.writes(query, values);
      return [{}];
    }
    return [];
  } }),
}));
vi.mock('./backend', () => ({ getMemoryBackend: () => ({ name: 'query-integration-fixture',
  available: async () => ({ ok: !services.unavailable }), search: services.search, searchLexical: services.lexical,
}) }));
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
let sequence = 0;
// Retain actual observations using the test framework's attachment surface.
// These hashes identify a current-tree fixture run, never a serving build or
// independent acceptance receipt. The runner records the invocation separately.
const sourceSnapshot = [
  './injection.ts', './injection-delivery-coverage.ts', './context-injection-reliability.integration.test.ts',
  './injection-block-cache.ts', '../auth.ts', '../agent-tools/coordination/control-anchor.ts',
  './temporal-render.ts', './corpus-recall.ts', './session-epoch-ledger.ts', './corpus-surfaced-ledger.ts',
  '../endpoint-route/routes/agent-mcp/operator-converse.ts', '../agent-tools/operator/converse-prompt.ts',
  '../endpoint-route/routes/agent-mcp/turn-start-memory.ts', '../../../../libs/generic/cache/src/cache.ts',
  '../endpoint-route/routes/agent-mcp/mid-turn-context.ts', '../../vitest.config.ts',
  '../../../../apps/operator/scripts/hooks/inject/core.mjs',
  '../../../../apps/operator/scripts/hooks/inject/recall-query.mjs',
  '../../../../apps/operator/scripts/hooks/inject/ports.mjs',
  ...['codex', 'claude', 'omp'].map(client => `../../../../apps/operator/scripts/hooks/inject/adapters/${client}.mjs`),
].map(path => ({ path, sha256: createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex') }));

beforeEach(() => {
  vi.stubEnv('PAPERCUSP_SID', 'query-fixture-session');
  setSessionConfinementResolver(() => null);
  configureReadCursorStore(new InMemoryReadCursorStore());
  _resetSessionEpochLedgerForTests();
  resetMemoryDegradedForTest();
  services.unavailable = false;
  services.writes.mockClear();
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

const operativeConditions: Record<typeof OPERATIVE_UNIT_CONDITIONS[number], string> = {
  'late-negation': 'Do not apply it to production.',
  approval: 'Only after explicit approval.',
  exception: 'Except when the source is read-only.',
  expiry: 'This authorization expires at 2026-01-01T00:00:00Z.',
  supersession: 'Superseded by the replacement procedure; this command is obsolete.',
};

for (const condition of OPERATIVE_UNIT_CONDITIONS) for (const boundary of OPERATIVE_UNIT_BOUNDARIES)
it(`context reliability R-4: ${condition} ${boundary}`, async ({ annotate, task }) => {
  const observations: OperativeUnitCell[] = [];
  for (const client of DELIVERY_MATRIX_CLIENTS) for (const source of ['memory', 'corpus'] as const)
  for (const mode of ['fits', 'limited'] as const) {
    services.writes.mockClear();
    const command = 'Apply zephyrrepair recovery.';
    const padding = mode === 'fits' ? '' : 'filler '.repeat(boundary === 'entry' ? 160 : 40);
    const sourceText = `${command} ${padding}${operativeConditions[condition]}`;
    const owner = `operative-fixture-${++sequence}`;
    const id = '11111111-1111-4111-8111-111111111111';
    services.search.mockResolvedValue(source === 'memory'
      ? [{ id, text: sourceText, score: 0.95, scope: 'query-fixture-user' }] : []);
    if (source === 'corpus') {
      const selected = selectCorpusLines({ queryText: 'zephyrrepair', budgetChars: boundary === 'aggregate' && mode === 'limited' ? 1 : 3000,
        hits: [{ source: 'plan', sourceId: 'query-fixture-harness:operative', excerpt: sourceText,
          meta: { contextUnit: sourceText }, score: 0.95 }] });
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
      queryContext: 'zephyrrepair', harnessSlugs: [], hiveSlugs: [], budgetChars: 8000,
      session: { sessionId: owner, port: 'mid-turn' } });
    if (source === 'memory' && boundary === 'aggregate' && mode === 'limited')
      expect(prepared?.fragments).toHaveLength(1);
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
          queryContext: input.query, harnessSlugs: [], hiveSlugs: [], budgetChars: 8000 });
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
