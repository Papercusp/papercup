/**
 * Per-(client, port) context-injection DELIVERY coverage — the derive-miss TRACE.
 *
 * Plan: codex-context-injection-parity-2026-08-09, P-005 / D-005 §3b.
 * Table: harness_shared.context_injection_coverage (migration 772 — its header
 * carries the full rationale, including why this is NOT a column on
 * memory_recall_stats).
 *
 * ⚠⚠ NOT `injection-coverage.ts`, WHICH IS A DIFFERENT MODULE ON A DIFFERENT
 * PLAN. The two names are close enough that one of them has already been
 * clobbered once (2026-08-09). Keep them straight:
 *
 *   injection-coverage.ts   (context-injection-retrieval-reach-…-2026-08-03 P-004)
 *     "Is retrieval still REACHING the corpus semantically?" — a PURE assessor
 *     over embed-coverage surfaces. No I/O. Exports assessInjectionReach /
 *     formatInjectionReachToast, consumed by dbos/periodic-workflows.ts.
 *
 *   THIS FILE                (codex-context-injection-parity-2026-08-09 P-005)
 *     "Is injection being DELIVERED to each client at all?" — a counter WRITER.
 *     Does I/O. Knows nothing about embeddings or corpus reach.
 *
 * One is about whether the corpus can answer; this one is about whether anybody
 * asked. A regression in either is invisible in the other.
 *
 * ── THE QUESTION THIS ANSWERS ──
 * "Is client X actually receiving per-turn context?" had no answer from the
 * outside, because the ways of getting no context are indistinguishable once
 * they have all written nothing:
 *
 *   no rows at all         the hook never fired            (install/trust bug)
 *   outcome='unknown-tool' it fired; the tool is unmapped   (VOCABULARY DRIFT)
 *   outcome='no-signal'    it fired; known tool, no signal  (expected quiet)
 *   outcome='no-recall'    it ran; nothing relevant         (healthy quiet)
 *   outcome='recalled'     it ran and returned context      (working)
 *
 * 'unknown-tool' remains actionable vocabulary drift. Reason-tagged
 * 'suppressed-*' rows distinguish fail-soft skips; duplicate and rate limits
 * are expected controls, while policy/admission failures need their own context.
 *
 * ── FAIL-SILENT, LIKE EVERY OTHER TELEMETRY WRITE ON THIS PATH ──
 * This runs inside a hook-serving request whose whole contract is that it must
 * never cost the agent's turn. It never throws and is never awaited by the
 * caller. Losing a counter is a rounding error; surfacing an error into a turn
 * is a wedged agent.
 */

/** Closed acceptance population, distinct from the two-port traffic counters below.
 * A selector must report cells it actually exercised; expanding these keys alone
 * supplies no execution or delivery evidence. Reuses this module's final-delivery
 * assessor rather than introducing another measurement service. */
import { readRecallSignals } from '../../../../apps/operator/scripts/hooks/inject/recall-query.mjs';

export const DELIVERY_MATRIX_CLIENTS = ['codex', 'claude', 'omp'] as const;
export const OPERATIVE_UNIT_CONDITIONS = ['late-negation', 'approval', 'exception', 'expiry', 'supersession'] as const;
export const OPERATIVE_UNIT_BOUNDARIES = ['entry', 'aggregate'] as const;
export type OperativeUnitCell = {
  client: typeof DELIVERY_MATRIX_CLIENTS[number];
  condition: typeof OPERATIVE_UNIT_CONDITIONS[number];
  boundary: typeof OPERATIVE_UNIT_BOUNDARIES[number];
  source: 'memory' | 'corpus'; mode: 'fits' | 'limited';
  selector: string; evidenceRefs: string[]; inputHash: string;
  returnedText: string; offeredHashes: string[]; committedHashes: string[];
  verdict: 'passed' | 'failed' | 'UNKNOWN';
};
export type OperativeUnitArtifact = {
  schemaVersion: 'operative-unit-v1'; identity: DeliveryMatrixManifest['identity']; cells: OperativeUnitCell[];
};

/** R-4 uses the existing delivery evidence surface. The caller supplies the
 * separately retained execution oracle; a self-declared pass is insufficient. */
export function validateOperativeUnitArtifact(value: unknown, expected: {
  identity: OperativeUnitArtifact['identity']; cells: OperativeUnitCell[];
}): { valid: boolean; closed: boolean; errors: string[] } {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const key = (cell: Record<string, unknown> | OperativeUnitCell) =>
    [cell.client, cell.condition, cell.boundary, cell.source, cell.mode].join('/');
  const population = DELIVERY_MATRIX_CLIENTS.flatMap(client => OPERATIVE_UNIT_CONDITIONS.flatMap(condition =>
    OPERATIVE_UNIT_BOUNDARIES.flatMap(boundary => ['memory', 'corpus'].flatMap(source =>
      ['fits', 'limited'].map(mode => [client, condition, boundary, source, mode].join('/'))))));
  const errors: string[] = [], seen = new Set<string>();
  const artifact = record(value) ? value : {};
  if (artifact.schemaVersion !== 'operative-unit-v1') errors.push('schema-version');
  const identity = record(artifact.identity) ? artifact.identity : {};
  for (const field of ['planHash', 'rubricHash', 'barHash', 'specHash', 'sourceHash', 'testHash'] as const)
    if (!hash(identity[field]) || identity[field] !== expected.identity[field]) errors.push(`identity:${field}`);
  for (const field of ['planRevision', 'rubricRevision'] as const)
    if (!Number.isSafeInteger(identity[field]) || Number(identity[field]) <= 0 || identity[field] !== expected.identity[field]) errors.push(`identity:${field}`);
  if (typeof identity.runtimeGeneration !== 'string' || !identity.runtimeGeneration.trim() ||
      identity.runtimeGeneration !== expected.identity.runtimeGeneration) errors.push('identity:runtimeGeneration');
  const oracles = new Map(expected.cells.map(cell => [key(cell), cell]));
  if (expected.cells.length !== population.length || oracles.size !== population.length ||
      population.some(id => !oracles.has(id))) errors.push('oracle-population');
  const cells = Array.isArray(artifact.cells) ? artifact.cells : [];
  for (const cell of cells) {
    if (!record(cell)) { errors.push('invalid-cell'); continue; }
    const id = key(cell), oracle = oracles.get(id);
    if (seen.has(id) || !oracle || !population.includes(id)) errors.push(`population:${id}`);
    seen.add(id);
    if (!oracle) continue;
    if (!hash(cell.inputHash) || cell.inputHash !== oracle.inputHash) errors.push(`${id}:input`);
    if (cell.verdict !== 'passed' || cell.selector !== `context reliability R-4: ${cell.condition} ${cell.boundary}` ||
        !Array.isArray(cell.evidenceRefs) || !cell.evidenceRefs.length ||
        !cell.evidenceRefs.every(ref => typeof ref === 'string' && !!ref.trim())) errors.push(`${id}:execution-evidence`);
    if (typeof cell.returnedText !== 'string' || cell.returnedText !== oracle.returnedText) errors.push(`${id}:returned-text`);
    for (const field of ['offeredHashes', 'committedHashes'] as const) {
      const hashes = cell[field];
      if (!Array.isArray(hashes) || !hashes.every(hash) || new Set(hashes).size !== hashes.length ||
          JSON.stringify(hashes) !== JSON.stringify(oracle[field])) errors.push(`${id}:${field}`);
    }
    // The negative arm must never suppress a pointer or omitted instruction.
    if (cell.mode === 'limited' && (JSON.stringify(cell.offeredHashes) !== '[]' ||
        JSON.stringify(cell.committedHashes) !== '[]')) errors.push(`${id}:abstention-commit`);
    if (cell.mode === 'fits' && (!Array.isArray(cell.offeredHashes) || cell.offeredHashes.length !== 1 ||
        JSON.stringify(cell.offeredHashes) !== JSON.stringify(cell.committedHashes))) errors.push(`${id}:complete-commit`);
  }
  const closed = cells.length === population.length && seen.size === population.length && population.every(id => seen.has(id));
  return { valid: closed && !errors.length, closed, errors };
}

export const GROUNDED_QUERY_CASES = ['task', 'symbol', 'path', 'search', 'error', 'exact-id',
  'shell-negative', 'javascript-negative', 'heredoc-negative', 'serialized-json-negative',
  'truncated-json-negative', 'lexical-only'] as const;

export type GroundedQueryCell = {
  client: typeof DELIVERY_MATRIX_CLIENTS[number];
  scenario: typeof GROUNDED_QUERY_CASES[number];
  selector: string;
  evidenceRefs: string[];
  inputHash: string;
  signals: NonNullable<ReturnType<typeof readRecallSignals>>;
  retrievalCalls: number;
  semanticCalls: number;
  lexicalCalls: number;
  returnedText: string;
  verdict: 'passed' | 'failed' | 'UNKNOWN';
};
export type GroundedQueryArtifact = {
  schemaVersion: 'grounded-query-v1';
  identity: DeliveryMatrixManifest['identity'];
  cells: GroundedQueryCell[];
};

export const CACHE_IDENTITY_CASES = ['query-task-change', 'authorization-widen', 'authorization-narrow',
  'identical-refresh', 'timeout-abstention', 'workspace-isolation', 'principal-isolation', 'source-change'] as const;
export type CacheIdentityCell = {
  scenario: typeof CACHE_IDENTITY_CASES[number]; selector: string; evidenceRefs: string[];
  inputHash: string; authorityHash: string; returnedHash: string;
  status: 'ready' | 'deadline' | 'error'; builds: number;
  verdict: 'passed' | 'failed' | 'UNKNOWN';
};
export type CacheIdentityArtifact = {
  schemaVersion: 'cache-identity-v1'; identity: DeliveryMatrixManifest['identity']; cells: CacheIdentityCell[];
};

/** Closed cache/builder fixture evidence, separate from native port delivery
 * and independent acceptance. The trusted oracle is supplied separately. */
export function validateCacheIdentityArtifact(value: unknown, expected: {
  identity: CacheIdentityArtifact['identity']; cells: CacheIdentityCell[];
}): { valid: boolean; closed: boolean; errors: string[] } {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const errors: string[] = [], seen = new Set<string>();
  const artifact = record(value) ? value : {};
  if (artifact.schemaVersion !== 'cache-identity-v1') errors.push('schema-version');
  const identity = record(artifact.identity) ? artifact.identity : {};
  for (const field of ['planHash', 'rubricHash', 'barHash', 'specHash', 'sourceHash', 'testHash'] as const)
    if (!hash(identity[field]) || identity[field] !== expected.identity[field]) errors.push(`identity:${field}`);
  for (const field of ['planRevision', 'rubricRevision'] as const)
    if (!Number.isSafeInteger(identity[field]) || Number(identity[field]) <= 0 || identity[field] !== expected.identity[field]) errors.push(`identity:${field}`);
  if (typeof identity.runtimeGeneration !== 'string' || !identity.runtimeGeneration.trim() ||
      identity.runtimeGeneration !== expected.identity.runtimeGeneration) errors.push('identity:runtimeGeneration');
  const oracles = new Map(expected.cells.map(cell => [cell.scenario, cell]));
  if (oracles.size !== CACHE_IDENTITY_CASES.length || expected.cells.length !== CACHE_IDENTITY_CASES.length ||
      CACHE_IDENTITY_CASES.some(scenario => !oracles.has(scenario))) errors.push('oracle-population');
  const cells = Array.isArray(artifact.cells) ? artifact.cells : [];
  for (const cell of cells) {
    if (!record(cell)) { errors.push('invalid-cell'); continue; }
    const scenario = String(cell.scenario);
    const oracle = expected.cells.find(entry => entry.scenario === scenario);
    if (seen.has(scenario) || !oracle) errors.push(`population:${scenario}`);
    seen.add(scenario);
    if (!oracle) continue;
    for (const field of ['inputHash', 'authorityHash', 'returnedHash'] as const)
      if (!hash(cell[field]) || cell[field] !== oracle[field]) errors.push(`${scenario}:${field}`);
    if (cell.verdict !== 'passed' || cell.selector !== `context reliability R-5: ${scenario}` ||
        !Array.isArray(cell.evidenceRefs) || !cell.evidenceRefs.length ||
        !cell.evidenceRefs.every(ref => typeof ref === 'string' && !!ref.trim())) errors.push(`${scenario}:execution-evidence`);
    if (!Number.isSafeInteger(cell.builds) || Number(cell.builds) < 0 || cell.builds !== oracle.builds ||
        cell.status !== oracle.status) errors.push(`${scenario}:outcome`);
  }
  const closed = cells.length === CACHE_IDENTITY_CASES.length && seen.size === CACHE_IDENTITY_CASES.length &&
    CACHE_IDENTITY_CASES.every(scenario => seen.has(scenario));
  return { valid: closed && !errors.length, closed, errors };
}

export type BootstrapExportCell = {
  client: typeof DELIVERY_MATRIX_CLIENTS[number];
  clientVersion: string;
  evidencePlane: 'installed-client-local-request' | 'installed-client-registration';
  before: Array<{ name: string; description: string }>;
  after: Array<{ name: string; description: string }>;
  evidenceRefs: string[];
};
export type BootstrapExportArtifact = {
  schemaVersion: 'bootstrap-export-v1';
  identity: DeliveryMatrixManifest['identity'];
  baselineArtifactHash: string;
  cells: BootstrapExportCell[];
};

/** Installed Claude Code expands this punctuation before its provider request.
 * Apply the measured transform to the frozen oracle only: never normalize the
 * observation, which must still match in full. Server exports stay byte-exact. */
export function bootstrapDescriptionForClient(client: string, description: string): string {
  return client === 'claude' ? description.replaceAll('…', '...') : description;
}

/** Closed export population with an independently frozen descriptor oracle.
 * OMP registration is deliberately distinct from a provider-request capture.
 * This assessor cannot turn either into production/billing evidence. */
export function validateBootstrapExportArtifact(value: unknown, expected: {
  identity: BootstrapExportArtifact['identity']; baselineArtifactHash: string;
  baseline: BootstrapExportCell['before']; exported: BootstrapExportCell['after'];
  oldPrefix: string; bootstrap: string;
}): { valid: boolean; closed: boolean; errors: string[]; missing: string[] } {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const errors: string[] = [], seen = new Set<string>();
  const artifact = record(value) ? value : {};
  if (artifact.schemaVersion !== 'bootstrap-export-v1') errors.push('schema-version');
  if (artifact.baselineArtifactHash !== expected.baselineArtifactHash || !/^[a-f0-9]{64}$/.test(expected.baselineArtifactHash)) errors.push('baseline-hash');
  const identity = record(artifact.identity) ? artifact.identity : {};
  for (const [key, wanted] of Object.entries(expected.identity)) {
    if (identity[key] !== wanted) errors.push(`identity:${key}`);
  }
  if (expected.baseline.length !== 55 || expected.exported.length !== 55 || !expected.oldPrefix || !expected.bootstrap) errors.push('oracle-population');
  const cells = Array.isArray(artifact.cells) ? artifact.cells : [];
  for (const cell of cells) {
    if (!record(cell)) { errors.push('malformed-cell'); continue; }
    const client = String(cell.client);
    if (!DELIVERY_MATRIX_CLIENTS.some(name => name === client)) errors.push(`unexpected:${client}`);
    if (seen.has(client)) errors.push(`duplicate:${client}`);
    seen.add(client);
    if (typeof cell.clientVersion !== 'string' || !cell.clientVersion.trim()) errors.push(`version:${client}`);
    if (cell.evidencePlane !== (client === 'omp' ? 'installed-client-registration' : 'installed-client-local-request')) errors.push(`plane:${client}`);
    if (!Array.isArray(cell.evidenceRefs) || !cell.evidenceRefs.length || cell.evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim())) errors.push(`evidence:${client}`);
    const before = Array.isArray(cell.before) ? cell.before : [], after = Array.isArray(cell.after) ? cell.after : [];
    if (before.length !== 55 || after.length !== 55) errors.push(`population:${client}`);
    const names = new Set<string>();
    for (let index = 0; index < before.length; index++) {
      const prior = before[index], next = after[index];
      if (!record(prior) || !record(next) || typeof prior.name !== 'string' || typeof next.name !== 'string' ||
          typeof prior.description !== 'string' || typeof next.description !== 'string') { errors.push(`descriptor:${client}/${index}`); continue; }
      if (names.has(prior.name) || prior.name !== next.name) errors.push(`names:${client}/${index}`);
      names.add(prior.name);
      const name = prior.name;
      const original = expected.baseline.find(tool => name.endsWith(tool.name));
      const exported = expected.exported.find(tool => name.endsWith(tool.name));
      if (!original || !exported ||
          prior.description !== bootstrapDescriptionForClient(client, original.description) ||
          next.description !== bootstrapDescriptionForClient(client, exported.description)) errors.push(`contract:${client}/${index}`);
    }
    const oldText = JSON.stringify(before), newText = JSON.stringify(after);
    const count = (text: string, fragment: string) => text.split(JSON.stringify(fragment).slice(1, -1)).length - 1;
    if (count(newText, '<!-- papercusp-mcp-bootstrap:v1 -->') !== 1 ||
        count(newText, bootstrapDescriptionForClient(client, expected.bootstrap)) !== 1 ||
        count(newText, bootstrapDescriptionForClient(client, expected.oldPrefix)) !== 0) errors.push(`bootstrap:${client}`);
    if (Buffer.byteLength(newText, 'utf8') >= Buffer.byteLength(oldText, 'utf8')) errors.push(`bytes:${client}`);
  }
  const missing = DELIVERY_MATRIX_CLIENTS.filter(client => !seen.has(client));
  const closed = !missing.length && cells.length === DELIVERY_MATRIX_CLIENTS.length;
  return { valid: closed && !errors.length, closed, errors, missing };
}

/** Query behavior extends the existing coverage assessor. The trusted fixture
 * contract is separate from the artifact; this never certifies native delivery. */
export function validateGroundedQueryArtifact(value: unknown, expected: {
  identity: GroundedQueryArtifact['identity'];
  cells: Array<Omit<GroundedQueryCell, 'selector' | 'evidenceRefs' | 'verdict'>>;
}): { valid: boolean; closed: boolean; errors: string[]; missing: string[]; duplicates: string[]; unexpected: string[] } {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const key = (v: { client?: unknown; scenario?: unknown }) => `${v.client}/${v.scenario}`;
  const population = new Set(DELIVERY_MATRIX_CLIENTS.flatMap(client => GROUNDED_QUERY_CASES.map(scenario => key({ client, scenario }))));
  const errors: string[] = [], duplicates: string[] = [], unexpected: string[] = [];
  const actual = new Set<string>(), oracles = new Map(expected.cells.map(cell => [key(cell), cell]));
  if (expected.cells.length !== population.size || oracles.size !== population.size ||
      [...population].some(id => !oracles.has(id))) errors.push('oracle-population');
  const artifact = record(value) ? value : {};
  if (artifact.schemaVersion !== 'grounded-query-v1') errors.push('schema-version');
  const identity = record(artifact.identity) ? artifact.identity : {};
  for (const field of ['planHash', 'rubricHash', 'barHash', 'specHash', 'sourceHash', 'testHash'] as const) {
    if (!hash(identity[field]) || identity[field] !== expected.identity[field]) errors.push(`identity:${field}`);
  }
  for (const field of ['planRevision', 'rubricRevision'] as const) {
    if (!Number.isSafeInteger(identity[field]) || Number(identity[field]) <= 0 || identity[field] !== expected.identity[field]) errors.push(`identity:${field}`);
  }
  if (typeof identity.runtimeGeneration !== 'string' || !identity.runtimeGeneration.trim() ||
      identity.runtimeGeneration !== expected.identity.runtimeGeneration) errors.push('identity:runtimeGeneration');
  if (!Array.isArray(artifact.cells)) errors.push('cells-not-array');
  for (const cell of Array.isArray(artifact.cells) ? artifact.cells : []) {
    if (!record(cell)) { errors.push('invalid-cell'); continue; }
    const id = key(cell);
    if (actual.has(id)) duplicates.push(id);
    actual.add(id);
    if (!population.has(id)) { unexpected.push(id); continue; }
    const oracle = oracles.get(id);
    if (!oracle) continue;
    const reject = (reason: string) => errors.push(`${id}:${reason}`);
    if (cell.verdict !== 'passed') reject('verdict');
    if (cell.selector !== `context reliability R-3: ${cell.scenario}` || !Array.isArray(cell.evidenceRefs) ||
        !cell.evidenceRefs.length || !cell.evidenceRefs.every(ref => typeof ref === 'string' && !!ref.trim())) reject('execution-evidence');
    if (!hash(cell.inputHash) || cell.inputHash !== oracle.inputHash) reject('input-hash');
    const signals = readRecallSignals(cell.signals), oracleSignals = readRecallSignals(oracle.signals);
    if (!signals || !oracleSignals || signals.fingerprint !== oracleSignals.fingerprint) reject('normalized-query');
    for (const field of ['retrievalCalls', 'semanticCalls', 'lexicalCalls'] as const) {
      if (!Number.isSafeInteger(cell[field]) || Number(cell[field]) < 0 || cell[field] !== oracle[field]) reject(field);
    }
    if (typeof cell.returnedText !== 'string' || cell.returnedText !== oracle.returnedText) reject('returned-content');
  }
  const missing = [...population].filter(id => !actual.has(id));
  const closed = !missing.length && !duplicates.length && !unexpected.length;
  return { valid: closed && !errors.length, closed, errors, missing, duplicates, unexpected };
}
export const DELIVERY_MATRIX_PORTS = ['initialize', 'orient', 'claim', 'create', 'turn-start', 'mid-turn', 'compact-reprime'] as const;
export const DELIVERY_MATRIX_EXTRA_SINKS = ['operator', 'architect', 'oracle', 'agent-chats', 'system-launch', 'system-wake'] as const;
export const DELIVERY_MATRIX_SOURCES = ['memory', 'corpus'] as const;
export const DELIVERY_MATRIX_FAULTS = ['prepare', 'lost-response', 'partial-stdout', 'deadline', 'retry', 'duplicate-commit', 'abandon-expiry', 'overlapping-ports'] as const;

export type DeliveryMatrixCoordinate = {
  client: typeof DELIVERY_MATRIX_CLIENTS[number] | 'NONE';
  sink: typeof DELIVERY_MATRIX_PORTS[number] | typeof DELIVERY_MATRIX_EXTRA_SINKS[number];
  source: typeof DELIVERY_MATRIX_SOURCES[number];
  fault: typeof DELIVERY_MATRIX_FAULTS[number];
};
export type DeliveryTerminalOracle = 'complete-stdout' | 'NONE';

/** Only these production adapters currently expose complete native output.
 * Model-call acceptance, MCP response creation and first-turn activity are not
 * terminal events. Extend this census together with an adapter and its tests. */
export function deliveryTerminalOracle(cell: DeliveryMatrixCoordinate): DeliveryTerminalOracle {
  if (!DELIVERY_MATRIX_CLIENTS.includes(cell.client as typeof DELIVERY_MATRIX_CLIENTS[number])) return 'NONE';
  if (cell.sink === 'turn-start' || cell.sink === 'mid-turn') return 'complete-stdout';
  // ptool's stdio adapter retains the exact initialize/tool response before
  // the installed Codex/Claude client consumes it.
  if ((cell.client === 'codex' || cell.client === 'claude') &&
      ['initialize', 'orient', 'claim', 'create'].includes(cell.sink)) return 'complete-stdout';
  // The managed OMP host separately retains final tool_execution_end stdout
  // after native result hooks. Its in-process MCP callback alone is not proof,
  // and this boundary does not observe initialize's mounted instructions.
  if (cell.client === 'omp' && ['orient', 'claim', 'create'].includes(cell.sink)) return 'complete-stdout';
  // The generated Claude SessionStart recovery hook has the same immutable
  // stdout receipt boundary. Other compact hosts remain uninstrumented.
  return cell.client === 'claude' && cell.sink === 'compact-reprime' ? 'complete-stdout' : 'NONE';
}

export function deliveryMatrixCellKey(cell: DeliveryMatrixCoordinate): string {
  return [cell.client, cell.sink, cell.source, cell.fault].join('/');
}

export function deliveryMatrixPopulation(): DeliveryMatrixCoordinate[] {
  const endpoints: Pick<DeliveryMatrixCoordinate, 'client' | 'sink'>[] = [
    ...DELIVERY_MATRIX_CLIENTS.flatMap(client => DELIVERY_MATRIX_PORTS.map(sink => ({ client, sink }))),
    ...DELIVERY_MATRIX_EXTRA_SINKS.map(sink => ({ client: 'NONE' as const, sink })),
  ];
  return endpoints.flatMap(endpoint => DELIVERY_MATRIX_SOURCES.flatMap(source =>
    DELIVERY_MATRIX_FAULTS.map(fault => ({ ...endpoint, source, fault }))));
}

export type DeliveryMatrixFragment = {
  kind: 'memory' | 'corpus'; id: string; epoch: number; port: string;
  bodySha256: string; bodyBytes: number;
};
export type DeliveryMatrixCell = DeliveryMatrixCoordinate & {
  selector: string;
  evidenceRefs: string[];
  verdict: 'passed' | 'failed' | 'UNKNOWN';
  terminalOracle: DeliveryTerminalOracle;
  state: 'prepared' | 'emitted' | 'partial' | 'abandoned' | 'UNKNOWN';
  suppressionWrites: number;
  attempt?: {
    id: string; recipient: string; workspace: string; epoch: number;
    token: string; fragment: DeliveryMatrixFragment;
  };
  proof?: {
    event: 'complete-stdout'; adapter: string; receiptRef: string;
    attemptId: string; recipient: string; workspace: string; epoch: number; token: string;
    client: string; sink: string; payloadSha256: string; payloadBytes: number;
    fragment: DeliveryMatrixFragment;
  };
};
export type DeliveryMatrixManifest = {
  schemaVersion: 'delivery-matrix-v1';
  /** Acceptance identity belongs here, never in production receipt rows. */
  identity: {
    planRevision: number; planHash: string; rubricRevision: number; rubricHash: string;
    barHash: string; specHash: string; sourceHash: string; testHash: string; runtimeGeneration: string;
  };
  cells: DeliveryMatrixCell[];
};

/** Structural and receipt-join validation; never infers execution from titles.
 * Closed != accepted: UNKNOWN native cells remain in the denominator and block
 * acceptance. Explicit NONE/UNKNOWN extra sinks are the reviewed exception. */
export function validateDeliveryMatrix(manifest: DeliveryMatrixManifest): {
  closed: boolean; valid: boolean; acceptanceReady: boolean;
  missing: string[]; duplicates: string[]; unexpected: string[];
  unknown: string[]; failed: string[]; errors: string[];
} {
  const expected = new Set(deliveryMatrixPopulation().map(deliveryMatrixCellKey));
  const actual = new Set<string>();
  const duplicates: string[] = [], unexpected: string[] = [], unknown: string[] = [], failed: string[] = [], errors: string[] = [];
  const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
  const fragmentValid = (v: DeliveryMatrixFragment | undefined, cell: DeliveryMatrixCoordinate) => !!v &&
    v.kind === cell.source && text(v.id) && Number.isSafeInteger(v.epoch) && v.epoch >= 0 &&
    v.port === (cell.sink === 'compact-reprime' ? 'compact' : cell.sink) && hash(v.bodySha256) && positive(v.bodyBytes);
  const sameFragment = (a: DeliveryMatrixFragment, b: DeliveryMatrixFragment) =>
    a.kind === b.kind && a.id === b.id && a.epoch === b.epoch && a.port === b.port &&
    a.bodySha256 === b.bodySha256 && a.bodyBytes === b.bodyBytes;
  if (manifest?.schemaVersion !== 'delivery-matrix-v1') errors.push('schema-version');
  const identity = manifest?.identity;
  if (!identity || !positive(identity.planRevision) || !positive(identity.rubricRevision) || !text(identity.runtimeGeneration) ||
      ![identity.planHash, identity.rubricHash, identity.barHash, identity.specHash, identity.sourceHash, identity.testHash].every(hash)) {
    errors.push('measurement-identity');
  }
  if (!Array.isArray(manifest?.cells)) errors.push('cells-not-array');
  for (const cell of Array.isArray(manifest?.cells) ? manifest.cells : []) {
    if (!cell || typeof cell !== 'object') { errors.push('invalid-cell'); continue; }
    const key = deliveryMatrixCellKey(cell);
    if (actual.has(key)) duplicates.push(key);
    actual.add(key);
    if (!expected.has(key)) { unexpected.push(key); continue; }
    const reject = (reason: string) => errors.push(`${key}:${reason}`);
    const oracle = deliveryTerminalOracle(cell);
    if (cell.terminalOracle !== oracle) reject('terminal-oracle');
    if (!['passed', 'failed', 'UNKNOWN'].includes(cell.verdict)) reject('verdict');
    if (!['prepared', 'emitted', 'partial', 'abandoned', 'UNKNOWN'].includes(cell.state)) reject('state');
    if (!Number.isSafeInteger(cell.suppressionWrites) || cell.suppressionWrites < 0 || cell.suppressionWrites > 1) reject('suppression-count');
    if (cell.verdict === 'UNKNOWN') unknown.push(key);
    if (cell.verdict === 'failed') failed.push(key);
    if (!text(cell.selector) || !Array.isArray(cell.evidenceRefs) || !cell.evidenceRefs.length || !cell.evidenceRefs.every(text)) reject('execution-evidence');
    if (oracle === 'NONE' && (cell.state !== 'UNKNOWN' || cell.verdict !== 'UNKNOWN' || cell.proof || cell.suppressionWrites !== 0)) reject('uninstrumented-sink');
    if (oracle !== 'NONE' && cell.verdict === 'passed') {
      // A valid receipt join alone cannot establish that the named fault was
      // exercised successfully. In particular, a prepared retry is no proof of
      // delivery, and lost/partial output must never become an emitted pass.
      const requiresEmission = ['retry', 'duplicate-commit', 'overlapping-ports'].includes(cell.fault);
      const states: readonly DeliveryMatrixCell['state'][] = requiresEmission ? ['emitted']
        : cell.fault === 'prepare' ? ['prepared']
        : cell.fault === 'partial-stdout' ? ['partial', 'abandoned']
        : cell.fault === 'abandon-expiry' ? ['abandoned'] : ['prepared', 'abandoned'];
      if (!states.includes(cell.state) || cell.suppressionWrites !== (requiresEmission ? 1 : 0)) reject('fault-outcome');
    }
    if (cell.state !== 'emitted' && (cell.suppressionWrites !== 0 || cell.proof)) reject('unproven-suppression');
    if (cell.state === 'emitted') {
      const a = cell.attempt, p = cell.proof;
      if (!a || !p || p.event !== 'complete-stdout' || !text(p.adapter) || !text(p.receiptRef) ||
          !text(a.id) || !text(a.recipient) || !text(a.workspace) || !text(a.token) ||
          !Number.isSafeInteger(a.epoch) || a.epoch < 0 ||
          p.attemptId !== a.id || p.recipient !== a.recipient || p.workspace !== a.workspace ||
          p.epoch !== a.epoch || p.token !== a.token || p.client !== cell.client || p.sink !== cell.sink ||
          !hash(p.payloadSha256) || !positive(p.payloadBytes) ||
          !fragmentValid(a.fragment, cell) || !fragmentValid(p.fragment, cell) ||
          a.fragment.epoch !== a.epoch || !sameFragment(a.fragment, p.fragment) || p.payloadBytes < p.fragment.bodyBytes) reject('receipt-join');
    }
  }
  const missing = [...expected].filter(key => !actual.has(key));
  const closed = !missing.length && !duplicates.length && !unexpected.length;
  const valid = closed && !errors.length;
  const nativeUnknown = unknown.some(key => !key.startsWith('NONE/'));
  return { closed, valid, acceptanceReady: valid && !failed.length && !nativeUnknown,
    missing, duplicates, unexpected, unknown, failed, errors };
}

/**
 * The injection PORTS, as ONE source of truth. Matches memory_recall_stats.surface
 * vocabulary.
 *
 * ⚠⚠ EVERY PORT LISTED HERE MUST HAVE A PRODUCTION WRITER, or this vocabulary
 * lies. Until WI-37597 only `mid-turn` did: `recordInjectionCoverage` was called
 * from `mid-turn-context.ts` and nowhere else, so `context_injection_coverage`
 * had never held a single `turn-start` row for any client — while this type
 * cheerfully declared the value, and the reader below blended both ports into one
 * per-client number that healthy mid-turn traffic kept green.
 *
 * A turn-start outage was therefore STRUCTURALLY invisible, not merely unlikely —
 * the same shape as the defect this whole plan exists to fix (D-005 §1: a
 * Claude-only deriveQuery made non-Claude rows impossible rather than rare), and
 * the reason EI-20001110634702380 closed cause-undetermined.
 *
 * So: adding a port here OBLIGES you to add its writer in the same change.
 * `injection-delivery-coverage.test.ts` fails if a port has no writer.
 */
export const INJECTION_PORTS = ['turn-start', 'mid-turn'] as const;
export type InjectionPort = (typeof INJECTION_PORTS)[number];

/** Independent source annotations accompany the EXACT emitted text, not a pre-clipping excerpt. */
export interface DeliveredContextFragment {
  sourceRef: string;
  /** Independent equivalent-fact label; distinct source IDs can carry the same fact. */
  factKey: string;
  text: string;
  requiredQualifiers?: readonly string[];
  correct?: boolean;
  current?: boolean;
  authoritative?: boolean;
  scopeAllowed?: boolean;
  referencesResolve?: boolean;
}

export interface DeliveredContextAttempt {
  attemptId: string;
  sessionId: string;
  epoch: number;
  port: string;
  /** null means the final block was not observed; '' is an observed abstention. */
  block: string | null;
  fragments: readonly DeliveredContextFragment[];
  /** Independently checked headings/notices; all other block text needs annotation. */
  framingText?: readonly string[];
  /** undefined = unlabelled opportunity, [] = independently confirmed no needed context. */
  requiredFactKeys?: readonly string[];
  alreadyInContext?: readonly string[];
  retrievedFactKeys?: readonly string[];
  admittedFactKeys?: readonly string[];
  /** Content budget and final framing overhead are separate contracts. */
  contentBudgetChars?: number;
  firstEntryException?: boolean;
  deliveredTokens?: number;
  harmfulTaskEffect?: boolean;
}

/**
 * Grade delivery from prompt records. A unique ledger is deliberately NOT an input:
 * stamp uniqueness cannot distinguish one delivery from two concurrent/retried deliveries.
 * Fact labels and authority/currentness verdicts come from an independent evaluator;
 * their absence remains unknown. This does not infer semantic truth from word overlap.
 */
export function assessDeliveredContext(attempts: readonly DeliveredContextAttempt[]) {
  const seen = new Map<string, string>();
  const results = attempts.map((attempt) => {
    const failures: string[] = [], unknown: string[] = [];
    const delivered = new Set<string>();
    let contentChars = 0, observedFragments = 0;
    let remaining = attempt.block ?? '';
    if (attempt.block === null) unknown.push('final-block-unobserved');
    for (const fragment of attempt.fragments) {
      if (!fragment.text.trim() || attempt.block === null || !remaining.includes(fragment.text)) {
        unknown.push(`fragment-not-observed:${fragment.sourceRef}`); continue;
      }
      remaining = remaining.replace(fragment.text, '');
      contentChars += fragment.text.length;
      observedFragments++;
      delivered.add(fragment.factKey);
      const identity = JSON.stringify([attempt.sessionId, attempt.epoch, fragment.factKey]);
      const prior = seen.get(identity);
      if (prior !== undefined) failures.push(`duplicate-delivery:${fragment.factKey}:${prior}`);
      else seen.set(identity, attempt.attemptId);
      if (attempt.alreadyInContext?.includes(fragment.factKey)) failures.push(`already-in-context:${fragment.factKey}`);
      for (const field of ['correct', 'current', 'authoritative', 'scopeAllowed', 'referencesResolve'] as const) {
        if (fragment[field] === false) failures.push(`${field}:${fragment.sourceRef}`);
        else if (fragment[field] !== true) unknown.push(`${field}:${fragment.sourceRef}`);
      }
      if (fragment.requiredQualifiers === undefined) unknown.push(`qualifiers-unlabelled:${fragment.sourceRef}`);
      for (const qualifier of fragment.requiredQualifiers ?? []) {
        if (!fragment.text.includes(qualifier)) failures.push(`condition-lost:${fragment.sourceRef}:${qualifier}`);
      }
    }
    const missing = [...new Set(attempt.block === null ? [] : attempt.requiredFactKeys ?? [])]
      .filter((key) => !delivered.has(key) && !attempt.alreadyInContext?.includes(key))
      .map((factKey) => ({ factKey, stage: attempt.retrievedFactKeys === undefined ? 'unknown'
        : !attempt.retrievedFactKeys.includes(factKey) ? 'retrieval'
        : attempt.admittedFactKeys === undefined ? 'unknown'
        : !attempt.admittedFactKeys.includes(factKey) ? 'admission' : 'delivery' }));
    if (attempt.requiredFactKeys === undefined) unknown.push('opportunity-unlabelled');
    else if (missing.length) failures.push(...missing.map((m) => `missing-required:${m.factKey}:${m.stage}`));
    else if (attempt.requiredFactKeys.length === 0 && delivered.size > 0) failures.push('unneeded-context');
    for (const framing of attempt.framingText ?? []) remaining = remaining.replace(framing, '');
    if (remaining.trim()) unknown.push('block-content-unlabelled');
    if (attempt.contentBudgetChars !== undefined && contentChars > attempt.contentBudgetChars &&
      !(attempt.firstEntryException === true && observedFragments === 1)) failures.push('content-budget-exceeded');
    if (attempt.harmfulTaskEffect === true) failures.push('harmful-task-effect');
    return { attemptId: attempt.attemptId, failures, unknown, missing, contentChars,
      finalBlockChars: attempt.block?.length ?? null,
      usefulFactsPerToken: attempt.block !== null && attempt.deliveredTokens && attempt.requiredFactKeys !== undefined
        ? [...delivered].filter((key) => attempt.requiredFactKeys!.includes(key)).length / attempt.deliveredTokens : null,
      usefulSuccess: failures.length ? false : unknown.length ? null : true,
      verdict: failures.length ? 'broken' : unknown.length ? 'unknown' : 'healthy' };
  });
  return { attempted: results.length, usefulSuccesses: results.filter((r) => r.usefulSuccess === true).length,
    usefulFailures: results.filter((r) => r.usefulSuccess === false).length,
    usefulUnknown: results.filter((r) => r.usefulSuccess === null).length, results };
}

export type InjectionDeliveryOutcome =
  /** The injection ran and returned context. */
  | 'recalled'
  /** It ran, and found nothing relevant. Healthy quiet. */
  | 'no-recall'
  /** Reached the endpoint; a KNOWN tool carried no query signal. Expected. */
  | 'no-signal'
  /** Reached the endpoint; the tool is absent from the shared vocabulary. */
  | 'unknown-tool'
  /** Malformed JSON was fail-soft rejected before caller fields were readable. */
  | 'suppressed-invalid-json'
  /** Ambient-context policy denied or could not resolve this session. */
  | 'suppressed-ambient-policy'
  /** The process-local query guard skipped an identical consecutive query. */
  | 'suppressed-duplicate-query'
  /** The process-local rolling ceiling skipped this query. */
  | 'suppressed-rate-limit'
  /** Applied identity recall bounds could not be read. */
  | 'suppressed-identity-unreadable'
  /** The shared admission resource was unavailable. */
  | 'suppressed-admission-unavailable'
  /** The shared admission resource had reached capacity. */
  | 'suppressed-admission-capacity'
  /** This worker already had an optional memory recall in flight. */
  | 'suppressed-admission-local-in-flight'
  /** An admission reason was not recognized by this caller. */
  | 'suppressed-admission-other'
  /** An unexpected handler error returned the contract's empty context block. */
  | 'suppressed-handler-error';

export interface InjectionDeliveryEvent {
  port: InjectionPort;
  outcome: InjectionDeliveryOutcome;
  /** '' when the caller sent none — a real reading (a host without the P-005
   *  threading), deliberately not defaulted to a client name. */
  client?: string | null;
  /** The tool name, for the tool-specific outcomes. '' otherwise. */
  tool?: string | null;
  workspaceId?: string | null;
}

/**
 * A tool name is part of the primary key, so an unbounded one would be an
 * unbounded key. Nothing legitimate is close to this.
 */
const TOOL_CLAMP = 120;

/** Only these outcomes are about a specific tool; the others store ''. */
function toolFor(ev: InjectionDeliveryEvent): string {
  if (ev.outcome !== 'unknown-tool' && ev.outcome !== 'no-signal') return '';
  return (ev.tool ?? '').trim().slice(0, TOOL_CLAMP);
}

function keyOf(ev: InjectionDeliveryEvent, tool: string): string {
  return [ev.workspaceId ?? '', ev.client ?? '', ev.port, ev.outcome, tool].join(' ');
}

/**
 * Record one or more delivery-coverage events. Never throws; never
 * load-bearing. Call WITHOUT awaiting.
 *
 * Events are AGGREGATED IN JS FIRST. A codex mid-turn batch can carry a dozen
 * calls that all miss the same way, and one upsert carrying n=12 is both
 * cheaper and more honest than twelve racing increments.
 */
export async function recordInjectionCoverage(
  events: readonly InjectionDeliveryEvent[],
): Promise<void> {
  try {
    if (!events.length) return;

    const counts = new Map<string, { ev: InjectionDeliveryEvent; tool: string; n: number }>();
    for (const ev of events) {
      if (!ev?.port || !ev?.outcome) continue;
      const tool = toolFor(ev);
      const key = keyOf(ev, tool);
      const prior = counts.get(key);
      if (prior) prior.n += 1;
      else counts.set(key, { ev, tool, n: 1 });
    }
    if (counts.size === 0) return;

    const { getOrgPg } = await import('@papercusp/db-org');
    const sql = getOrgPg().sql;

    for (const { ev, tool, n } of counts.values()) {
      await sql`
        INSERT INTO harness_shared.context_injection_coverage
          (day, workspace_id, client, port, outcome, tool, n, first_seen_at, last_seen_at)
        VALUES (
          CURRENT_DATE,
          ${ev.workspaceId ?? ''},
          ${ev.client ?? ''},
          ${ev.port},
          ${ev.outcome},
          ${tool},
          ${n},
          now(),
          now()
        )
        ON CONFLICT (day, workspace_id, client, port, outcome, tool)
        DO UPDATE SET
          n = harness_shared.context_injection_coverage.n + EXCLUDED.n,
          last_seen_at = now()
      `;
    }
  } catch {
    /* swallow — see the fail-silent note in the header. */
  }
}

// ── the READ side: the detector's data source ────────────────────────────────

/**
 * The frozen injection client set (D-001). The denominator is deliberately
 * restricted to these three: `agent_chat` and harness-chat sessions never had a
 * hook layer and never will, so counting them would manufacture a permanent
 * "gap" for a client that is working exactly as designed.
 */
export const INJECTION_CLIENTS = ['claude', 'codex', 'omp'] as const;
export type InjectionClient = (typeof INJECTION_CLIENTS)[number];

/**
 * ⚠⚠ THE TWO `workspace_id`s ARE NOT INTERCHANGEABLE — DO NOT "FIX" THIS INTO A JOIN.
 *
 * `harness_shared.session_turns` (the denominator) is written under the LITERAL
 * string 'default' — the session-transcript CORPUS namespace, which is NOT a
 * tenant (session-ingest.ts:1075/1458/1781 hardcode it; the warning at
 * session-ingest.ts:1703 explains why).
 * `harness_shared.context_injection_coverage` (the numerator) is written under
 * the REAL tenant (activeWorkspaceId(), 'papercusp-workspace' here).
 *
 * Measured 2026-08-09: session_turns held 53,936 rows in 7d, 100% under
 * 'default' and ZERO under 'papercusp-workspace'. So scoping the sessions leg to
 * the tenant — the obviously-correct-looking thing, and what the multi-tenant
 * SQL advisory actively suggests — returns zero sessions ALWAYS, which makes the
 * detector structurally incapable of ever firing while looking perfectly
 * healthy. That is the same shape as the defect this whole plan exists to fix
 * (D-005 §1: a Claude-only deriveQuery made non-Claude rows structurally
 * impossible, not merely rare), and it is the second time this corpus-vs-tenant
 * confusion has bitten this codebase — the first cost the substitution registry
 * every bucket count.
 */
const SESSION_CORPUS_NAMESPACE = 'default';

/**
 * One (client, port) cell — the grain at which an outage is actually visible.
 *
 * Reporting only the per-client total is what made a turn-start outage
 * undetectable: a client whose turn-start port has gone completely silent still
 * shows healthy `events` as long as its mid-turn port is working, so the failure
 * is MASKED by the traffic of the port that still works. Every field here exists
 * to be read per port, never summed back up.
 */
export interface PortInjectionCoverage {
  port: InjectionPort;
  /** Coverage events recorded for this port in the window. */
  events: number;
  byOutcome: Record<string, number>;
  /** Tool names behind `unknown-tool` on this port — the actionable drift. */
  driftTools: string[];
  /**
   * Has THIS PORT ever produced a row for this client, at any time? Per-port for
   * the same reason the client-level flag exists: a port with no baseline gives
   * no evidence its writer is deployed, so it can never be a REGRESSION — only a
   * known gap. This is what stops the turn-start writer's own rollout from
   * paging every client the moment the reader learns to look for it.
   */
  everObserved: boolean;
}

export interface ClientInjectionCoverage {
  client: string;
  /** Sessions seen for this client in the window — the DENOMINATOR. */
  sessions: number;
  /** Coverage events recorded in the window, ACROSS ALL PORTS. */
  events: number;
  byOutcome: Record<string, number>;
  /** Tool names behind `unknown-tool` — the actionable drift, named. */
  driftTools: string[];
  /**
   * Has this client EVER produced a coverage row, at any time? A client with no
   * baseline gives us no evidence that its recording path is even deployed, so
   * it can never be a REGRESSION — only a known gap. See the status function.
   */
  everObserved: boolean;
  /**
   * Per-port breakdown — ALWAYS one entry per INJECTION_PORTS, in that order,
   * present even when the port recorded nothing. A missing entry and a zeroed
   * entry read identically to a consumer looping over what it was given, and the
   * zeroed one is the whole signal here, so absence is never an option.
   */
  ports: PortInjectionCoverage[];
}

/** A window row as the numerator query returns it (one per client/port/outcome/tool). */
export interface CoverageWindowRow {
  client: string;
  port: string;
  outcome: string;
  tool: string;
  n: number;
}

/** A baseline row — this (client, port) has been observed at some point, ever. */
export interface CoverageEverRow {
  client: string;
  port: string;
}

export interface InjectionDeliveryCoverageReading {
  windowHours: number;
  clients: ClientInjectionCoverage[];
  /** Total events across all clients in the window. */
  totalEvents: number;
}

const ZERO_OUTCOMES = (): Record<string, number> => ({
  recalled: 0, 'no-recall': 0, 'no-signal': 0, 'unknown-tool': 0,
});

/**
 * Read per-client injection-delivery coverage for the health panel.
 *
 * THROWS on an unreadable source — the caller runs under `panelSafe`, which
 * turns a throw into a greyed `unknown` panel. That is the correct degradation:
 * a detector that cannot read its inputs must not report health.
 */
export async function readInjectionDeliveryCoverage(opts: {
  workspaceId: string;
  windowHours?: number;
}): Promise<InjectionDeliveryCoverageReading> {
  const windowHours = opts.windowHours ?? 24;
  const { getOrgPg } = await import('@papercusp/db-org');
  const sql = getOrgPg().sql;

  // A plain JS array — postgres.js serialises this to a real text[]. Do NOT wrap
  // it in sql.array() with a ::text[] cast: that path stringifies to the bare
  // literal `claude,codex,omp` and the query dies on "malformed array literal".
  // Caught only by running this against the live DB (2026-08-09); no unit test
  // touches the SQL, so a green suite says nothing about it.
  const clients: string[] = [...INJECTION_CLIENTS];

  // Denominator — corpus namespace, NOT the tenant (see the block comment above).
  const sessionRows = await sql<{ client: string; sessions: number }[]>`
    SELECT source_kind AS client, count(DISTINCT session_id)::int AS sessions
      FROM harness_shared.session_turns
     WHERE workspace_id = ${SESSION_CORPUS_NAMESPACE}
       AND source_kind = ANY(${clients})
       AND ts > now() - (${windowHours}::text || ' hours')::interval
     GROUP BY 1
  `;

  // Numerator — real tenant. GROUPED BY PORT: without `port` in the grouping the
  // two ports are summed before anything can compare them, and a dead port is
  // arithmetically indistinguishable from a quiet one.
  const windowRows = await sql<CoverageWindowRow[]>`
    SELECT client, port, outcome, tool, sum(n)::int AS n
      FROM harness_shared.context_injection_coverage
     WHERE workspace_id = ${opts.workspaceId}
       AND day >= (now() - (${windowHours}::text || ' hours')::interval)::date
     GROUP BY 1, 2, 3, 4
  `;

  // Baseline — has this (client, PORT) EVER been observed, at any time?
  const everRows = await sql<CoverageEverRow[]>`
    SELECT DISTINCT client, port
      FROM harness_shared.context_injection_coverage
     WHERE workspace_id = ${opts.workspaceId}
  `;

  const sessionsBy = new Map(sessionRows.map((r) => [r.client, Number(r.sessions) || 0]));

  return {
    windowHours,
    ...foldInjectionCoverage({ clients, windowRows, everRows, sessionsBy }),
  };
}

/**
 * Fold raw rows into the per-client / per-port reading. PURE — no I/O.
 *
 * Extracted from the reader so the property that actually matters can be tested
 * without a database: mid-turn traffic must NEVER make the turn-start port look
 * observed. That is the exact masking this module shipped with, and no unit test
 * could reach it while the folding lived inside a function whose first statement
 * opens a PG connection.
 */
export function foldInjectionCoverage(input: {
  clients: readonly string[];
  windowRows: readonly CoverageWindowRow[];
  everRows: readonly CoverageEverRow[];
  sessionsBy: ReadonlyMap<string, number>;
}): { clients: ClientInjectionCoverage[]; totalEvents: number } {
  // Keyed on client AND port together — keying on either alone is precisely the
  // blend this function exists to prevent.
  const ever = new Set(input.everRows.map((r) => `${r.client}\x00${r.port}`));

  const out: ClientInjectionCoverage[] = input.clients.map((client) => {
    const clientOutcomes = ZERO_OUTCOMES();
    const clientDrift: string[] = [];
    let clientEvents = 0;

    const ports: PortInjectionCoverage[] = INJECTION_PORTS.map((port) => {
      const byOutcome = ZERO_OUTCOMES();
      const driftTools: string[] = [];
      let events = 0;
      for (const r of input.windowRows) {
        if (r.client !== client || r.port !== port) continue;
        const n = Number(r.n) || 0;
        events += n;
        byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + n;
        if (r.outcome === 'unknown-tool' && r.tool) driftTools.push(r.tool);
      }
      // Roll the port up into the client totals, so the two views cannot drift
      // apart the way two independently-computed sums would.
      clientEvents += events;
      for (const [outcome, count] of Object.entries(byOutcome)) {
        clientOutcomes[outcome] = (clientOutcomes[outcome] ?? 0) + count;
      }
      clientDrift.push(...driftTools);
      return {
        port,
        events,
        byOutcome,
        driftTools: [...new Set(driftTools)].sort(),
        everObserved: ever.has(`${client}\x00${port}`),
      };
    });

    return {
      client,
      sessions: input.sessionsBy.get(client) ?? 0,
      events: clientEvents,
      byOutcome: clientOutcomes,
      driftTools: [...new Set(clientDrift)].sort(),
      // Client-level baseline stays ANY-port on purpose: it answers "has this
      // client's recording path ever worked at all", which the per-port flags
      // then refine.
      everObserved: ports.some((p) => p.everObserved),
      ports,
    };
  });

  return { clients: out, totalEvents: out.reduce((a, c) => a + c.events, 0) };
}
