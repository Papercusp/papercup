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
import { createHash } from 'node:crypto';
import { canonicalJson } from '../external-bench/reproducibility/canonical-json';
import { isDeepStrictEqual } from 'node:util';
import { evaluateConsumerEvidence, type ConsumerEvidenceRecord } from '../code-intelligence/consumer-evidence';
import { parseContextSourceVersion, type ContextSourceVersion } from './temporal-render';
import { blockPayloadText, ompSessionHeaderIndex } from '../transcript-wire';
import type { ContextPackingReceiptCensus } from '../context-packing-receipts';

export const SOURCE_REVISION_CASES = ['update', 'retraction', 'same-revision', 'later-revision', 'concurrent-old-new', 'compaction'] as const;
export type SourceRevisionCell = {
  scenario: typeof SOURCE_REVISION_CASES[number]; source: 'memory' | 'corpus'; selector: string; evidenceRefs: string[];
  previous: ContextSourceVersion; current: ContextSourceVersion;
  initialEpoch: number; readEpoch: number; eligibleBefore: boolean; eligibleAfter: boolean;
  confirmationResults: number[]; storedFingerprint: string; stalePreparationRejected: boolean;
  notice: string | null; verdict: 'passed' | 'failed' | 'UNKNOWN';
};
export type SourceRevisionArtifact = {
  schemaVersion: 'source-revision-v1'; identity: DeliveryMatrixManifest['identity'];
  evidencePlane: 'postgresql-ledger-with-fixture-source-and-cursors'; cells: SourceRevisionCell[];
};

/** R-2 ledger observations are not native output receipts. Compare separately
 * retained execution cells as well as the fixed population and temporal oracle. */
export function validateSourceRevisionArtifact(value: unknown, expected: Omit<SourceRevisionArtifact, 'schemaVersion'>): {
  valid: boolean; closed: boolean; errors: string[];
} {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const key = (cell: { scenario: unknown; source: unknown }) => `${cell.scenario}/${cell.source}`;
  const population = SOURCE_REVISION_CASES.flatMap(scenario => ['memory', 'corpus'].map(source => key({ scenario, source })));
  const artifact = record(value) ? value : {};
  const errors: string[] = [];
  if (artifact.schemaVersion !== 'source-revision-v1') errors.push('schema-version');
  const identity = record(artifact.identity) ? artifact.identity : {};
  for (const field of ['planHash', 'rubricHash', 'barHash', 'specHash', 'sourceHash', 'testHash'] as const)
    if (typeof identity[field] !== 'string' || !/^[a-f0-9]{64}$/.test(identity[field]) || identity[field] !== expected.identity[field]) errors.push(`identity:${field}`);
  for (const field of ['planRevision', 'rubricRevision'] as const)
    if (!Number.isSafeInteger(identity[field]) || Number(identity[field]) <= 0 || identity[field] !== expected.identity[field]) errors.push(`identity:${field}`);
  if (typeof identity.runtimeGeneration !== 'string' || !identity.runtimeGeneration.trim() ||
      identity.runtimeGeneration !== expected.identity.runtimeGeneration) errors.push('identity:runtimeGeneration');
  if (artifact.evidencePlane !== 'postgresql-ledger-with-fixture-source-and-cursors' || artifact.evidencePlane !== expected.evidencePlane) errors.push('evidence-plane');
  const cells = Array.isArray(artifact.cells) ? artifact.cells : [];
  const seen = new Set<string>();
  if (expected.cells.length !== population.length || population.some(id => expected.cells.filter(cell => key(cell) === id).length !== 1)) errors.push('oracle-population');
  for (const raw of cells) {
    if (!record(raw)) { errors.push('invalid-cell'); continue; }
    const cell = raw as unknown as SourceRevisionCell, id = key(cell);
    if (!population.includes(id) || seen.has(id)) errors.push(`population:${id}`);
    seen.add(id);
    const oracle = expected.cells.find(candidate => key(candidate) === id);
    if (!oracle || !isDeepStrictEqual(cell, oracle)) errors.push(`${id}:execution-oracle`);
    if (cell.verdict !== 'passed' || cell.selector !== `context reliability R-2: ${cell.scenario}` ||
        !Array.isArray(cell.evidenceRefs) || !cell.evidenceRefs.length || cell.evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim())) errors.push(`${id}:execution-evidence`);
    const previous = record(cell.previous) && typeof cell.previous.ref === 'string'
      ? parseContextSourceVersion(JSON.stringify(cell.previous), cell.previous.ref) : null;
    const current = record(cell.current) && typeof cell.current.ref === 'string'
      ? parseContextSourceVersion(JSON.stringify(cell.current), cell.current.ref) : null;
    if (!previous || !current || previous.ref !== current.ref || previous.namespace !== current.namespace) { errors.push(`${id}:source-identity`); continue; }
    const same = ['same-revision', 'compaction'].includes(cell.scenario);
    const epochsValid = Number.isSafeInteger(cell.initialEpoch) && cell.initialEpoch >= 0 && Number.isSafeInteger(cell.readEpoch) &&
      cell.readEpoch === cell.initialEpoch + (cell.scenario === 'compaction' ? 1 : 0);
    const confirmations = cell.scenario === 'same-revision' ? [0] : cell.scenario === 'concurrent-old-new' ? [1, 0, 0] : [1];
    if (!epochsValid || (previous.fingerprint === current.fingerprint) !== same || cell.eligibleBefore !== (cell.scenario !== 'same-revision') ||
        cell.eligibleAfter !== false || cell.storedFingerprint !== current.fingerprint ||
        !isDeepStrictEqual(cell.confirmationResults, confirmations)) errors.push(`${id}:temporal-outcome`);
    if (cell.scenario === 'later-revision' && previous.passage.sha256 !== current.passage.sha256) errors.push(`${id}:unchanged-passage`);
    if (cell.scenario === 'retraction' && (!cell.stalePreparationRejected || !['retracted', 'expired'].includes(current.validity.status) ||
        typeof cell.notice !== 'string' || !cell.notice.trim())) errors.push(`${id}:tombstone`);
  }
  const closed = cells.length === population.length && seen.size === population.length && population.every(id => seen.has(id));
  return { valid: closed && !errors.length, closed, errors };
}

export const CONSUMER_IMPACT_CASES = ['current-source', 'stale-fingerprint', 'ambiguous-symbol', 'empty-result', 'unavailable-tool'] as const;
export const CONSUMER_IMPACT_BOUNDARIES = ['initialize', 'orient', 'claim', 'create', 'turn-start', 'mid-turn'] as const;
export type ConsumerImpactSource = {
  root: string; commit: string; files: Array<{ path: string; sha256: string }>;
};
/** Exact UTF-8 file hashes, repository-relative paths and root/commit are one
 * identity. A file list without its repository identity cannot establish currency. */
export function consumerImpactSourceFingerprint(source: ConsumerImpactSource): string {
  return createHash('sha256').update(JSON.stringify([source.root, source.commit,
    source.files.map(file => [file.path, file.sha256]).sort((a, b) => a[0]!.localeCompare(b[0]!))])).digest('hex');
}
export type ConsumerImpactCell = {
  scenario: typeof CONSUMER_IMPACT_CASES[number]; selector: string; evidenceRefs: string[];
  record: ConsumerEvidenceRecord; verdict: 'passed' | 'failed' | 'UNKNOWN';
};
export type ConsumerImpactArtifact = {
  schemaVersion: 'consumer-impact-v1'; identity: DeliveryMatrixManifest['identity'];
  source: ConsumerImpactSource; sourceFingerprint: string;
  tooling: {
    compiler: { generation: string; coverage: 'bounded' | 'UNKNOWN' };
    graph: { generation: string; coverage: 'unverified' | 'UNKNOWN' };
  };
  /** Discovery is an independent input, not the list the graph happened to return.
   * Additional callers must be classified explicitly, including non-port callers. */
  census: { discovered: string[]; classified: Array<{ id: string; boundary: typeof CONSUMER_IMPACT_BOUNDARIES[number] | 'additional' }>; unknown: string[] };
  cells: ConsumerImpactCell[];
};

/** R-11 extends the existing artifact/evaluator chain. The expected argument is
 * separately retained execution/source/discovery evidence. Closed fixture evidence
 * proves its declared scope only; compiler/index coverage is never repository-wide. */
export function validateConsumerImpactArtifact(value: unknown, expected: Omit<ConsumerImpactArtifact, 'schemaVersion'>): {
  valid: boolean; closed: boolean; errors: string[];
} {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(item => typeof item === 'string' && !!item.trim());
  const unique = (v: string[]) => new Set(v).size === v.length;
  const errors: string[] = [];
  const artifact = record(value) ? value : {};
  if (artifact.schemaVersion !== 'consumer-impact-v1') errors.push('schema-version');
  const identity = record(artifact.identity) ? artifact.identity : {};
  for (const field of ['planHash', 'rubricHash', 'barHash', 'specHash', 'sourceHash', 'testHash'] as const)
    if (!hash(identity[field]) || identity[field] !== expected.identity[field]) errors.push(`identity:${field}`);
  for (const field of ['planRevision', 'rubricRevision'] as const)
    if (!Number.isSafeInteger(identity[field]) || Number(identity[field]) <= 0 || identity[field] !== expected.identity[field]) errors.push(`identity:${field}`);
  if (typeof identity.runtimeGeneration !== 'string' || !identity.runtimeGeneration.trim() ||
      identity.runtimeGeneration !== expected.identity.runtimeGeneration) errors.push('identity:runtimeGeneration');

  const source = record(artifact.source) ? artifact.source : {};
  const files = Array.isArray(source.files) ? source.files : [];
  const sourceValid = typeof source.root === 'string' && source.root.startsWith('/') &&
    typeof source.commit === 'string' && /^[a-f0-9]{40}$/.test(source.commit) && files.length > 0 &&
    files.every(file => record(file) && typeof file.path === 'string' && !!file.path &&
      !file.path.startsWith('/') && !file.path.includes('\\') && !file.path.split('/').some(part => !part || part === '.' || part === '..') && hash(file.sha256)) &&
    unique(files.map(file => (file as { path: string }).path));
  if (!sourceValid || !isDeepStrictEqual(source, expected.source)) errors.push('source-snapshot');
  if (!sourceValid || !hash(artifact.sourceFingerprint) || artifact.sourceFingerprint !== expected.sourceFingerprint ||
      artifact.sourceFingerprint !== consumerImpactSourceFingerprint(source as ConsumerImpactSource)) errors.push('source-fingerprint');
  if (!isDeepStrictEqual(artifact.tooling, expected.tooling) || expected.tooling.compiler.coverage !== 'bounded' ||
      expected.tooling.graph.coverage !== 'unverified' || !expected.tooling.compiler.generation.trim() ||
      !expected.tooling.graph.generation.trim()) errors.push('tooling-generation-or-coverage');

  const census = record(artifact.census) ? artifact.census : {};
  const discovered = strings(census.discovered) ? census.discovered : [];
  const classified = Array.isArray(census.classified) ? census.classified : [];
  const classifiedIds = classified.flatMap(entry => record(entry) && typeof entry.id === 'string' ? [entry.id] : []);
  const censusClosed = discovered.length > 0 && unique(discovered) && unique(classifiedIds) &&
    classifiedIds.length === classified.length && classifiedIds.length === discovered.length &&
    discovered.every(id => classifiedIds.includes(id)) && classified.every(entry => record(entry) &&
      [...CONSUMER_IMPACT_BOUNDARIES, 'additional'].includes(String(entry.boundary))) &&
    CONSUMER_IMPACT_BOUNDARIES.every(boundary => classified.some(entry => record(entry) && entry.boundary === boundary)) &&
    Array.isArray(census.unknown) && census.unknown.length === 0 && isDeepStrictEqual(census, expected.census);
  if (!censusClosed) errors.push('consumer-census');

  const cells = Array.isArray(artifact.cells) ? artifact.cells : [];
  const seen = new Set<string>();
  if (expected.cells.length !== CONSUMER_IMPACT_CASES.length ||
      !CONSUMER_IMPACT_CASES.every(scenario => expected.cells.filter(cell => cell.scenario === scenario).length === 1)) errors.push('oracle-population');
  for (const cell of cells) {
    if (!record(cell)) { errors.push('invalid-cell'); continue; }
    const scenario = String(cell.scenario);
    const oracle = expected.cells.find(candidate => candidate.scenario === scenario);
    if (!oracle || seen.has(scenario)) errors.push(`population:${scenario}`);
    seen.add(scenario);
    if (!oracle) continue;
    if (cell.verdict !== 'passed' || cell.selector !== `context reliability R-11: ${scenario}` ||
        !strings(cell.evidenceRefs) || !cell.evidenceRefs.length) errors.push(`${scenario}:execution-evidence`);
    if (!isDeepStrictEqual(cell, oracle)) errors.push(`${scenario}:execution-oracle`);
    const evaluation = evaluateConsumerEvidence(cell.record);
    if (evaluation.verdict !== (scenario === 'current-source' ? 'verified' : 'unverified')) errors.push(`${scenario}:consumer-verdict`);
    if (scenario === 'current-source' && record(cell.record) && Array.isArray(cell.record.consumers) &&
        !cell.record.consumers.every(consumer => record(consumer) && discovered.includes(`${consumer.path}:${consumer.line1}`))) errors.push(`${scenario}:unclassified-consumer`);
  }
  const closed = censusClosed && cells.length === CONSUMER_IMPACT_CASES.length && seen.size === CONSUMER_IMPACT_CASES.length &&
    CONSUMER_IMPACT_CASES.every(scenario => seen.has(scenario));
  return { valid: closed && !errors.length, closed, errors };
}

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
  // Generated Claude recovery and the Codex SessionStart dispatcher both
  // retain immutable stdout receipts. OMP compact remains uninstrumented.
  return (cell.client === 'claude' || cell.client === 'codex') && cell.sink === 'compact-reprime'
    ? 'complete-stdout' : 'NONE';
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
  epoch: number | null;
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
    if (attempt.epoch === null) unknown.push('epoch-unattributed');
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

export interface FinalContextAttemptRecord {
  sourceStoreId: string;
  attemptId: string;
  attemptSchemaVersion: string;
  recordVersion: number;
  createdAt: string;
  visibleAt: string;
  client?: string | null;
  sink?: string | null;
  recipient: string;
  workspace: string;
  epoch: number | null;
  /** Explicit gaps from the enrolled source, not independently supplied labels. */
  sourceUnknown?: string[];
  nativeSessionId?: string | null;
  packingSource?: { claimPath: string; sha256: string };
  /** Preparation hashes/manifests, not terminal bytes or semantic labels. */
  mcpPreparation?: import('../context-packing-receipts').StoredMcpContextPreparation;
  /** Prompt observations and labels are not evidence of terminal emission. */
  context: DeliveredContextAttempt;
  labelEvidenceRef?: string;
  taskBenefit?: 'useful' | 'neutral' | 'harmful';
}

export interface FinalContextEmissionReceipt {
  sourceStoreId: string;
  attemptId: string;
  attemptSchemaVersion: string;
  recipient: string;
  workspace: string;
  epoch: number;
  client: string;
  sink: string;
  event: 'complete-stdout';
  blockSha256: string;
  fragmentSha256: string[];
  evidenceRef: string;
}

export interface FinalContextAttemptSnapshot {
  schemaVersion: 'final-attempt-source-v1';
  snapshotId: string;
  sourceSchemaSha256: string;
  capturedAt: string;
  measuredAt: string;
  runtimeGeneration: string;
  environmentSha256: string;
  configurationSha256: string;
  attempts: FinalContextAttemptRecord[];
  receipts: FinalContextEmissionReceipt[];
}

const finalContextHash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Bridge the production first-writer census to the existing sampler. Legacy
 * attempts with no creation time stay in population and prevent a closed export;
 * missing epoch/native identity stays nullable on otherwise placeable attempts.
 * Prepared bytes supply neither terminal receipts nor independent fact labels. */
export function exportContextPackingAttemptSnapshot(census: ContextPackingReceiptCensus,
  identity: Omit<FinalContextAttemptSnapshot, 'schemaVersion' | 'capturedAt' | 'attempts' | 'receipts'>) {
  const frozen = JSON.parse(JSON.stringify(census)) as ContextPackingReceiptCensus;
  const attempts: FinalContextAttemptRecord[] = [];
  const population = frozen.sources.map(source => {
    const preparation = source.stored.preparation, withheld = source.stored.preparationWithheld;
    const attribution = preparation?.attribution ?? withheld?.attribution;
    const createdAt = preparation?.createdAt ?? withheld?.createdAt ?? null;
    const unknown: string[] = [];
    if (!createdAt) unknown.push('creation-time-unavailable');
    if (attribution?.epoch == null) unknown.push('epoch-unattributed');
    if (!attribution?.nativeSession) unknown.push('native-session-unattributed');
    if (!preparation) unknown.push(withheld ? 'preparation-withheld' : 'legacy-preparation-unavailable');
    if (createdAt) attempts.push({ sourceStoreId: JSON.stringify(['context-packing', frozen.scope.workspaceId, frozen.scope.harness]),
      attemptId: source.stored.receipt.attemptId, attemptSchemaVersion: 'context-packing-source-v1', recordVersion: 0,
      createdAt, visibleAt: frozen.capturedAt, recipient: frozen.scope.ownerId, workspace: frozen.scope.workspaceId,
      client: frozen.scope.client, sink: frozen.scope.port, epoch: attribution?.epoch ?? null,
      nativeSessionId: attribution?.nativeSession?.sessionId ?? null, sourceUnknown: unknown,
      packingSource: { claimPath: source.claimPath, sha256: source.sha256 },
      context: { attemptId: source.stored.receipt.attemptId, sessionId: frozen.scope.ownerId,
        epoch: attribution?.epoch ?? null, port: frozen.scope.port, block: preparation?.text ?? null, fragments: [] } });
    return { claimPath: source.claimPath, sha256: source.sha256, attemptId: source.stored.receipt.attemptId,
      state: source.state, placed: createdAt !== null, unknown };
  });
  for (const source of frozen.mcpSources ?? []) {
    const prepared = source.stored, attribution = prepared.attribution;
    const unknown = ['preparation-plaintext-withheld',
      ...(attribution.epoch === null ? ['epoch-unattributed'] : []),
      ...(!attribution.nativeSession ? ['native-session-unattributed'] : []),
      ...(prepared.staging === 'failed' ? ['preparation-staging-failed'] : [])];
    attempts.push({ sourceStoreId: JSON.stringify(['context-packing', frozen.scope.workspaceId, frozen.scope.harness]),
      attemptId: prepared.attemptId, attemptSchemaVersion: prepared.schemaVersion, recordVersion: 0,
      createdAt: prepared.createdAt, visibleAt: frozen.capturedAt, recipient: frozen.scope.ownerId, workspace: frozen.scope.workspaceId,
      client: frozen.scope.client, sink: frozen.scope.port, epoch: attribution.epoch,
      nativeSessionId: attribution.nativeSession?.sessionId ?? null, sourceUnknown: unknown,
      packingSource: { claimPath: source.claimPath, sha256: source.sha256 }, mcpPreparation: prepared,
      context: { attemptId: prepared.attemptId, sessionId: frozen.scope.ownerId, epoch: attribution.epoch,
        port: frozen.scope.port, block: null, fragments: [] } });
    population.push({ claimPath: source.claimPath, sha256: source.sha256, attemptId: prepared.attemptId,
      state: 'withheld', placed: true, unknown });
  }
  const unknown = [...(!frozen.complete || frozen.unknown.length ? ['source-census-incomplete'] : []),
    ...(frozen.sources.length + (frozen.mcpSources?.length ?? 0) + frozen.excluded.length + frozen.unknown.length !== frozen.claimsScanned ? ['census-population-mismatch'] : []),
    ...(population.some(member => !member.placed) ? ['attempt-time-unavailable'] : [])];
  const snapshot: FinalContextAttemptSnapshot | null = unknown.length ? null : { ...identity,
    schemaVersion: 'final-attempt-source-v1', capturedAt: frozen.capturedAt, attempts, receipts: [] };
  return { complete: !unknown.length, population, unknown, snapshot };
}
const finalContextIdentity = (row: Pick<FinalContextAttemptRecord, 'sourceStoreId' | 'attemptId' | 'attemptSchemaVersion'>) =>
  JSON.stringify([row.sourceStoreId, row.attemptId, row.attemptSchemaVersion]);
const finalContextByteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

export interface FinalContextSourceEnrollment {
  snapshot: Omit<FinalContextAttemptSnapshot, 'attempts' | 'receipts'>;
  recipient: string;
  workspace: string;
  /** Explicit immutable artifacts, never a latest-file or shared-directory guess.
   * Enrollment completeness is a separate acceptance obligation. */
  sources: readonly { harness: string; sha256: string; sourceStoreIds: readonly string[] }[];
}

/** Read the enrolled population through the existing immutable artifact store.
 * A missing source blocks the combined sample rather than quietly reducing its
 * denominator. Neither storage custody nor preparation proves stdout emission. */
export async function collectFinalContextAttemptSnapshot(enrollment: FinalContextSourceEnrollment,
  readSource: (harness: string, sha256: string) => Promise<string | null> = async (harness, sha256) =>
    (await import('../text-artifacts')).loadImmutableTextArtifact(harness, sha256)) {
  // Freeze caller-owned metadata before the first asynchronous read.
  const input = JSON.parse(JSON.stringify(enrollment)) as FinalContextSourceEnrollment;
  const nonempty = (value: unknown) => typeof value === 'string' && !!value.trim();
  const keys = new Set<string>();
  if (!nonempty(input.recipient) || !nonempty(input.workspace) || !Array.isArray(input.sources) || !input.sources.length) {
    throw new Error('final-context: invalid source enrollment');
  }
  for (const source of input.sources) {
    const key = JSON.stringify([source.harness, source.sha256]);
    if (!nonempty(source.harness) || !/^[a-f0-9]{64}$/.test(source.sha256) || keys.has(key) ||
        !Array.isArray(source.sourceStoreIds) || !source.sourceStoreIds.length ||
        !source.sourceStoreIds.every(nonempty) || new Set(source.sourceStoreIds).size !== source.sourceStoreIds.length) {
      throw new Error('final-context: invalid source enrollment');
    }
    keys.add(key);
  }
  const combined: FinalContextAttemptSnapshot = { ...input.snapshot, attempts: [], receipts: [] };
  sampleFinalDeliveredContext(combined); // Validate measurement identity even for an empty population.
  type SourceResult = { source: FinalContextSourceEnrollment['sources'][number];
    status: 'loaded' | 'UNKNOWN'; reason?: string; snapshot?: FinalContextAttemptSnapshot };
  const sources: SourceResult[] = await Promise.all(input.sources.map(async source => {
    const unknown = (reason: string): SourceResult => ({ source, status: 'UNKNOWN', reason });
    let content: string | null;
    try { content = await readSource(source.harness, source.sha256); }
    catch { return unknown('read-failed'); }
    if (content === null) return unknown('source-missing');
    if (typeof content !== 'string' || finalContextHash(content) !== source.sha256) return unknown('source-hash-mismatch');
    let snapshot: FinalContextAttemptSnapshot;
    try {
      snapshot = JSON.parse(content);
      sampleFinalDeliveredContext(snapshot);
    } catch { return unknown('source-invalid'); }
    if (snapshot.measuredAt !== input.snapshot.measuredAt || snapshot.capturedAt > input.snapshot.capturedAt ||
        snapshot.sourceSchemaSha256 !== input.snapshot.sourceSchemaSha256 ||
        snapshot.runtimeGeneration !== input.snapshot.runtimeGeneration ||
        snapshot.environmentSha256 !== input.snapshot.environmentSha256 ||
        snapshot.configurationSha256 !== input.snapshot.configurationSha256) return unknown('source-identity-mismatch');
    if (![...snapshot.attempts, ...snapshot.receipts].every(row => row.recipient === input.recipient &&
        row.workspace === input.workspace && source.sourceStoreIds.includes(row.sourceStoreId))) return unknown('source-scope-mismatch');
    return { source, status: 'loaded' as const, snapshot };
  }));
  const inventory = sources.map(({ snapshot: _snapshot, ...source }) => source);
  if (sources.some(source => source.status !== 'loaded')) {
    return { complete: false as const, sources: inventory, snapshot: null, sample: null, unknown: ['enrolled-source-unavailable'] };
  }
  for (const source of sources) {
    combined.attempts.push(...source.snapshot!.attempts);
    combined.receipts.push(...source.snapshot!.receipts);
  }
  try {
    const sample = sampleFinalDeliveredContext(combined);
    return { complete: true as const, sources: inventory, snapshot: combined, sample, unknown: [] };
  } catch {
    return { complete: false as const, sources: inventory, snapshot: null, sample: null, unknown: ['combined-source-conflict'] };
  }
}

export interface FinalContextTranscriptSource {
  /** The caller must obtain this binding from the enrolled runtime, not prose
   * inside the transcript or the latest session found in a shared directory. */
  bindingEvidenceRef: string;
  client: 'codex' | 'claude' | 'omp';
  nativeSessionId: string;
  recipient: string;
  workspace: string;
  epoch: number;
  transcript: string;
  sourceSha256: string;
}
export interface FinalContextTranscriptLocator {
  sourceStoreId: string; attemptId: string; attemptSchemaVersion: string;
  /** Physical JSONL record and content-block ordinals, including OMP title slots. */
  recordIndex: number; contentIndex: number;
  /** Claude tool_result.content can be a native array of content blocks. */
  resultContentIndex?: number;
  /** Codex text(result) serializes the MCP content container. The byte range
   * still addresses the physical native text, before this explicit decoding. */
  encoding?: 'codex-exec-mcp-json-v1';
  /** Required for tool output; absent for a native input message. */
  callId?: string;
  /** Exact UTF-8 byte range within the native text block; never fuzzy matching. */
  startByte: number; endByte: number;
}

export interface FinalContextNativeEmissionSource {
  /** Exact retained ledger JSON and stdout; collection/custody is independent. */
  receiptJson: string;
  receiptSha256: string;
  payload: string;
  evidenceRef: string;
  /** Unmodified request on the same stdio pipe. Server name comes from the
   * native launch configuration, not from a text-match guess. */
  stdioRequest?: { payload: string; sha256: string; serverName: string };
}
export type FinalContextHookEmissionSource = FinalContextNativeEmissionSource;

/** Join existing native stdout receipts to a preparation and exact
 * native prompt observation. Equal text alone never identifies an attempt.
 * Missing/legacy/ambiguous proof leaves the entire attempt population intact;
 * neither this join nor transcript observation supplies semantic labels. */
export function joinFinalContextNativeEmissions(snapshot: FinalContextAttemptSnapshot,
  source: FinalContextTranscriptSource, locators: readonly FinalContextTranscriptLocator[],
  emissions: readonly FinalContextNativeEmissionSource[]) {
  sampleFinalDeliveredContext(snapshot); // Reject malformed enrollment before joining.
  const joined = JSON.parse(JSON.stringify(snapshot)) as FinalContextAttemptSnapshot;
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  const parsed = emissions.map(emission => {
    let receipt: Record<string, unknown> | null = null;
    try { const value: unknown = JSON.parse(emission.receiptJson); if (object(value)) receipt = value; } catch { /* UNKNOWN */ }
    return { emission, receipt };
  });
  // Durable MCP preparation contains only hashes. Recover a candidate block
  // from enrolled native stdout, then require the ordinary transcript/receipt
  // join before adding those bytes to the returned snapshot. Failed joins keep
  // the original null block and the full preparation population.
  const candidates = JSON.parse(JSON.stringify(joined)) as FinalContextAttemptSnapshot;
  const preparationUnknown = new Map<number, string[]>();
  for (const [index, attempt] of candidates.attempts.entries()) {
    if (attempt.attemptSchemaVersion !== 'context-mcp-preparation-v1') continue;
    const unknown: string[] = [], prepared = attempt.mcpPreparation;
    preparationUnknown.set(index, unknown);
    const matches = parsed.filter(({ receipt }) => receipt?.token === attempt.attemptId);
    if (!prepared || !attempt.packingSource || !object(prepared.scope) || !object(prepared.attribution) ||
        !object(prepared.preparedResponse) || !Array.isArray(prepared.fragments) ||
        prepared.fragments.some(fragment => !object(fragment))) { unknown.push('mcp-preparation-unavailable'); continue; }
    const scope = prepared.scope, native = prepared.attribution?.nativeSession;
    const scopeJson = JSON.stringify({ workspaceId: scope.workspaceId, ownerId: scope.ownerId,
      harness: scope.harness, port: scope.port, client: scope.client });
    const claimKey = `evidence/context-packing/${finalContextHash(scopeJson)}/${attempt.attemptId}.json`;
    if (prepared.schemaVersion !== attempt.attemptSchemaVersion || prepared.attemptId !== attempt.attemptId ||
        prepared.createdAt !== attempt.createdAt || prepared.emission !== 'UNKNOWN' ||
        prepared.staging !== 'staged' || scope.port !== 'mcp-result' ||
        !['codex', 'claude', 'omp'].includes(scope.client) || scope.client !== attempt.client ||
        scope.ownerId !== attempt.recipient || scope.workspaceId !== attempt.workspace ||
        prepared.attribution.epoch !== attempt.epoch || !native || native.backend !== attempt.client ||
        native.sessionId !== attempt.nativeSessionId ||
        attempt.sourceStoreId !== JSON.stringify(['context-packing', attempt.workspace, scope.harness]) ||
        attempt.packingSource.claimPath !== `immutable/claims/${finalContextHash(claimKey)}.json` ||
        finalContextHash(JSON.stringify(prepared)) !== attempt.packingSource.sha256) unknown.push('mcp-preparation-binding');
    if (matches.length !== 1) continue; // The common join reports missing/ambiguous receipts.
    try {
      const frame: unknown = JSON.parse(matches[0]!.emission.payload);
      const result = object(frame) && object(frame.result) ? frame.result : null;
      const details = object(result?.details) ? result.details : null;
      const response = attempt.client === 'omp' ? details : result;
      const meta = object(response?._meta) ? response._meta : null;
      const custody = object(meta?.['papercusp/contextPreparation']) ? meta['papercusp/contextPreparation'] : null;
      const offer = object(meta?.['papercusp/memoryEmission']) ? meta['papercusp/memoryEmission'] : null;
      if (!response || !meta || custody?.attemptId !== attempt.attemptId || custody.status !== 'stored' ||
          custody.sha256 !== attempt.packingSource.sha256) { unknown.push('mcp-preparation-custody'); continue; }
      const original = { ...response, _meta: { ...meta } };
      delete original._meta['papercusp/contextPreparation'];
      if (attempt.client === 'omp') delete (original as Record<string, unknown>).nativeMcp;
      const serialized = prepared.preparedResponse.encoding === 'canonical-json-v1'
        ? canonicalJson(original) : JSON.stringify(original);
      if (finalContextHash(serialized) !== prepared.preparedResponse.sha256 ||
          (prepared.preparedResponse.encoding !== undefined && prepared.preparedResponse.encoding !== 'canonical-json-v1') ||
          Buffer.byteLength(serialized) !== prepared.preparedResponse.bytes ||
          (attempt.client === 'omp' && !isDeepStrictEqual(result?.content, response.content))) unknown.push('mcp-prepared-response');
      const selected = prepared.fragments.filter(fragment => fragment.selected);
      const offered = Array.isArray(offer?.fragments) ? offer.fragments : [];
      const sink = selected[0]?.port;
      const keys = ['kind', 'id', 'epoch', 'port', 'bodySha256', 'bodyBytes', 'sourceFingerprint', 'sourceVersion'] as const;
      if (!selected.length || !['orient', 'claim', 'create'].includes(sink ?? '') || selected.length !== offered.length ||
          selected.some((fragment, i) => fragment.port !== sink || fragment.epoch !== attempt.epoch ||
            !object(offered[i]) || keys.some(key => !isDeepStrictEqual(fragment[key], offered[i]![key])))) {
        unknown.push('mcp-prepared-fragments');
      }
      const blocks = Array.isArray(result?.content) ? result.content : [];
      if (blocks.length !== 1 || !object(blocks[0]) || blocks[0].type !== 'text' || typeof blocks[0].text !== 'string') {
        unknown.push('mcp-prepared-content');
      } else if (!unknown.length) {
        attempt.sink = sink; attempt.context.port = sink!; attempt.context.block = blocks[0].text;
      }
    } catch { unknown.push('mcp-preparation-invalid'); }
  }
  const attribution = attributeFinalContextTranscript(candidates, source, locators);
  const joins = candidates.attempts.map((attempt, index) => {
    const identity = finalContextIdentity(attempt), unknown = [...preparationUnknown.get(index) ?? []];
    const observation = attribution.attributions[index]!;
    if (observation.status !== 'observed') unknown.push('native-observation-unavailable');
    if (!attempt.nativeSessionId || attempt.nativeSessionId !== source.nativeSessionId || attempt.epoch === null)
      unknown.push('native-binding-unavailable');
    const durableMcp = attempt.attemptSchemaVersion === 'context-mcp-preparation-v1';
    const mcp = durableMcp || attempt.attemptSchemaVersion === 'memory-emission-v2';
    if (mcp) {
      if (!['codex', 'omp', 'claude'].includes(attempt.client ?? '') || !['orient', 'claim', 'create'].includes(attempt.sink ?? ''))
        unknown.push('emission-carrier-unsupported');
      if (!durableMcp && attempt.sourceStoreId !== JSON.stringify(['coord_read_cursors', attempt.recipient, 'memory-emission:' + attempt.attemptId]))
        unknown.push('preparation-source-binding');
    } else if (!attempt.packingSource) unknown.push('packing-source-unavailable');
    const matches = parsed.filter(({ receipt }) => mcp ? receipt?.token === attempt.attemptId
      : object(receipt?.packingReceipt) && receipt.packingReceipt.attemptId === attempt.attemptId &&
        receipt.packingReceipt.sha256 === attempt.packingSource?.sha256);
    if (matches.length !== 1) unknown.push(matches.length ? 'emission-ambiguous' : 'emission-unmatched');
    const match = matches.length === 1 ? matches[0]! : null;
    if (match) {
      const { emission, receipt } = match;
      const time = typeof receipt?.recordedAt === 'string' ? Date.parse(receipt.recordedAt) : NaN;
      if (receipt?.version !== 1 || receipt.stage !== 'stdout-emitted' || receipt.owner !== attempt.recipient ||
          receipt.client !== attempt.client || receipt.nativeSessionId !== attempt.nativeSessionId ||
          typeof receipt.token !== 'string' || !receipt.token.trim()) unknown.push('emission-binding');
      if (!/^[a-f0-9]{64}$/.test(emission.receiptSha256) || finalContextHash(emission.receiptJson) !== emission.receiptSha256 ||
          !emission.evidenceRef.trim() || receipt?.payloadSha256 !== finalContextHash(emission.payload) ||
          receipt.payloadBytes !== Buffer.byteLength(emission.payload) || !emission.payload.endsWith('\n')) unknown.push('emission-bytes');
      if (!Number.isFinite(time) || time < Date.parse(attempt.createdAt) || time > Date.parse(joined.capturedAt)) unknown.push('emission-time');
      let text: unknown = null;
      if (mcp) try {
        const frame: unknown = JSON.parse(emission.payload);
        const result = object(frame) && object(frame.result) ? frame.result : null;
        const details = object(result?.details) ? result.details : null;
        const meta = attempt.client === 'omp' ? object(details?._meta) ? details._meta : null
          : object(result?._meta) ? result._meta : null;
        const offer = object(meta?.['papercusp/memoryEmission']) ? meta['papercusp/memoryEmission'] : null;
        const blocks = Array.isArray(result?.content) ? result.content : [];
        const nativeLocator = locators.find(locator => finalContextIdentity(locator) === identity);
        let carrierBound = object(frame) && frame.type === 'tool_execution_end' && frame.isError === false && result?.isError !== true &&
          frame.toolCallId === nativeLocator?.callId;
        if (attempt.client === 'claude' || attempt.client === 'codex') {
          carrierBound = false;
          const wire = emission.stdioRequest;
          if (wire && wire.payload.endsWith('\n') && finalContextHash(wire.payload) === wire.sha256 &&
              /^[A-Za-z0-9_-]+$/.test(wire.serverName)) {
            const request: unknown = JSON.parse(wire.payload);
            const params = object(request) && object(request.params) ? request.params : null;
            const meta = object(params?._meta) ? params._meta : null;
            const turn = object(meta?.['x-codex-turn-metadata']) ? meta['x-codex-turn-metadata'] : null;
            const nativeRecords: unknown[] = source.transcript.trimEnd().split('\n').map(line => JSON.parse(line));
            // Retain the native call identity as well as the RPC id. Equal
            // result text, or two calls with equal arguments, cannot bind it.
            const calls = nativeRecords.flatMap<Record<string, unknown>>((record, recordIndex) => {
              if (!object(record)) return [];
              if (attempt.client === 'codex') {
                const call = object(record.payload) ? record.payload : null;
                if (record.type === 'response_item' && call?.type === 'custom_tool_call' &&
                    call.name === 'exec' && (call.namespace === undefined || call.namespace === 'functions') &&
                    typeof call.input === 'string' && typeof meta?.itemId === 'string' && call.id === meta.itemId)
                  return [{ id: call.call_id, recordIndex, codeMode: true }];
                if (record.type !== 'response_item' || call?.type !== 'function_call' ||
                    !((call.namespace === `mcp__${wire.serverName}` && call.name === params?.name) ||
                      (call.namespace === undefined && call.name === `mcp__${wire.serverName}__${String(params?.name)}`)) ||
                    typeof call.arguments !== 'string') return [];
                const args: unknown = JSON.parse(call.arguments);
                return isDeepStrictEqual(args, params?.arguments ?? {}) ? [{ id: call.call_id, recordIndex }] : [];
              }
              if (record.type !== 'assistant' || !object(record.message) ||
                  !Array.isArray(record.message.content)) return [];
              return record.message.content.filter((block): block is Record<string, unknown> =>
                object(block) && block.type === 'tool_use' &&
                block.name === `mcp__${wire.serverName}__${String(params?.name)}` &&
                isDeepStrictEqual(block.input, params?.arguments ?? {}));
            });
            carrierBound = object(frame) && frame.jsonrpc === '2.0' && !('error' in frame) && result?.isError !== true &&
              object(request) && request.jsonrpc === '2.0' && request.method === 'tools/call' &&
              (typeof request.id === 'string' || typeof request.id === 'number') && frame.id === request.id &&
              typeof params?.name === 'string' && calls.length === 1 && calls[0]!.id === nativeLocator?.callId &&
              (attempt.client !== 'codex' || (calls[0]!.recordIndex as number) < nativeLocator!.recordIndex);
            if (attempt.client === 'codex') {
              carrierBound &&= [meta?.sessionId, meta?.threadId, turn?.session_id, turn?.thread_id]
                .every(id => id === attempt.nativeSessionId);
              if (calls[0]?.codeMode) {
                // The inner exec UUID is NOT the parent's call_id. The native
                // RPC metadata binds its parent item; the completed native MCP
                // event binds its server/tool/arguments/result and exact UUID.
                const events = nativeRecords.flatMap((record, recordIndex) => {
                  const payload = object(record) && object(record.payload) ? record.payload : null;
                  const item = object(payload?.item) ? payload.item : null;
                  return object(record) && record.type === 'event_msg' && payload?.type === 'item_completed' &&
                    item?.type === 'McpToolCall' ? [{ record, payload, item, recordIndex }] : [];
                });
                const exact = events.filter(event => event.item.id === meta?.callId);
                const event = exact.length === 1 ? exact[0] : undefined;
                const eventResult = object(event?.item.result) ? event.item.result : null;
                const output = nativeRecords[nativeLocator!.recordIndex];
                const outputMeta = object(output) && object(output.metadata) ? output.metadata : null;
                const provenance = object(outputMeta?.mcp_attribution) ? outputMeta.mcp_attribution : null;
                const sources = Array.isArray(provenance?.sources) ? provenance.sources : [];
                const equalResults = events.filter(candidate => candidate.recordIndex > (calls[0]!.recordIndex as number) &&
                  candidate.recordIndex < nativeLocator!.recordIndex && object(candidate.item.result) &&
                  isDeepStrictEqual(candidate.item.result.content, result?.content));
                carrierBound &&= typeof meta?.callId === 'string' && meta.callId.startsWith('exec-') &&
                  meta.callId !== nativeLocator?.callId && !!event && equalResults.length === 1 &&
                  event.recordIndex > (calls[0]!.recordIndex as number) && event.recordIndex < nativeLocator!.recordIndex &&
                  event.payload.thread_id === source.nativeSessionId && typeof turn?.turn_id === 'string' &&
                  event.payload.turn_id === turn.turn_id && event.item.status === 'completed' &&
                  event.item.server === wire.serverName && event.item.tool === params?.name &&
                  isDeepStrictEqual(event.item.arguments, params?.arguments ?? {}) &&
                  isDeepStrictEqual(eventResult?.content, result?.content) && isDeepStrictEqual(eventResult?._meta, result?._meta) &&
                  provenance?.status === 'complete' && sources.filter(value => object(value) &&
                    value.server_name === wire.serverName && value.tool_name === params?.name &&
                    value.first_turn_id === turn.turn_id).length === 1;
              } else carrierBound &&= meta?.callId === nativeLocator?.callId;
            }
          }
        }
        if (!carrierBound || offer?.owner !== attempt.recipient || offer.token !== attempt.attemptId ||
            blocks.length !== 1 || !object(blocks[0]) || blocks[0].type !== 'text' || typeof blocks[0].text !== 'string') {
          unknown.push('emission-mcp-binding');
        } else {
          text = blocks[0].text;
          const body: unknown = JSON.parse(blocks[0].text);
          const rendered = object(body) ? body[attempt.sink!] : null;
          const offered = Array.isArray(offer.fragments) ? offer.fragments : [];
          const fragments = Array.isArray(receipt?.memoryFragments) ? receipt.memoryFragments : [];
          const keys = ['kind', 'id', 'epoch', 'port', 'bodySha256', 'bodyBytes', 'sourceFingerprint'] as const;
          if (typeof rendered !== 'string' || !fragments.length || fragments.length !== offered.length ||
              fragments.some((fragment, index) => {
                const expected = offered[index];
                return !object(fragment) || !object(expected) || !['memory', 'corpus', 'notice'].includes(String(fragment.kind)) ||
                  fragment.epoch !== attempt.epoch || fragment.port !== attempt.sink ||
                  keys.some(key => fragment[key] !== expected[key]) || typeof expected.rendered !== 'string' ||
                  !rendered.includes(expected.rendered) || fragment.bodySha256 !== finalContextHash(expected.rendered) ||
                  fragment.bodyBytes !== Buffer.byteLength(expected.rendered);
              })) unknown.push('emission-mcp-fragments');
        }
      } catch { unknown.push('emission-mcp-binding'); }
      else if (attempt.client === 'omp') text = emission.payload.slice(0, -1);
      else try {
        const payload: unknown = JSON.parse(emission.payload);
        if (object(payload) && object(payload.hookSpecificOutput)) {
          const hook = payload.hookSpecificOutput;
          const event = attempt.sink === 'turn-start' ? 'UserPromptSubmit'
            : attempt.sink === 'mid-turn' ? attempt.client === 'codex' ? 'PostToolUse' : 'PostToolBatch' : null;
          if (event !== null && hook.hookEventName === event) text = hook.additionalContext;
        }
      } catch { /* Unsupported/malformed carriers remain UNKNOWN. */ }
      if ((!mcp && !['turn-start', 'mid-turn'].includes(attempt.sink ?? '')) || text === null || text !== attempt.context.block)
        unknown.push('emission-context');
      if (!unknown.length) {
        if (durableMcp) {
          attempt.sourceUnknown = (attempt.sourceUnknown ?? []).filter(reason => reason !== 'preparation-plaintext-withheld');
          joined.attempts[index] = attempt;
        }
        joined.receipts.push({ sourceStoreId: attempt.sourceStoreId, attemptId: attempt.attemptId,
        attemptSchemaVersion: attempt.attemptSchemaVersion, recipient: attempt.recipient, workspace: attempt.workspace,
        epoch: attempt.epoch!, client: attempt.client!, sink: attempt.sink!, event: 'complete-stdout',
        blockSha256: finalContextHash(attempt.context.block!),
        fragmentSha256: attempt.context.fragments.map(fragment => finalContextHash(fragment.text)),
        evidenceRef: JSON.stringify([emission.evidenceRef, emission.receiptSha256, observation.sourceRef]) });
      }
    }
    return { identity, recordVersion: attempt.recordVersion, status: unknown.length ? 'UNKNOWN' as const : 'joined' as const, unknown };
  });
  return { snapshot: joined, attribution, joins };
}
/** Compatibility for callers of the original hook-only join. */
export const joinFinalContextHookEmissions = joinFinalContextNativeEmissions;

/** Attribute supplied attempts to a frozen native source without manufacturing
 * an emission receipt or semantic labels. All attempts remain in the result,
 * including missing/ambiguous locators and unsupported native shapes. A prompt
 * observation establishes only these exact bytes in this exact source. */
export function attributeFinalContextTranscript(snapshot: FinalContextAttemptSnapshot,
  source: FinalContextTranscriptSource, locators: readonly FinalContextTranscriptLocator[]) {
  const sourceErrors: string[] = [];
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  const nonempty = (value: unknown) => typeof value === 'string' && !!value.trim();
  const bytes = Buffer.from(source.transcript, 'utf8');
  if (!nonempty(source.bindingEvidenceRef) || !nonempty(source.nativeSessionId) ||
      !nonempty(source.recipient) || !nonempty(source.workspace) ||
      !Number.isSafeInteger(source.epoch) || source.epoch < 0) sourceErrors.push('runtime-binding');
  if (!/^[a-f0-9]{64}$/.test(source.sourceSha256) || finalContextHash(source.transcript) !== source.sourceSha256)
    sourceErrors.push('source-hash');
  let records: Record<string, unknown>[] = [], lines: string[] = [];
  try {
    if (!bytes.length || bytes.length > 16 * 1024 * 1024 || !source.transcript.endsWith('\n') ||
        bytes.toString('utf8') !== source.transcript) throw new Error('incomplete source');
    lines = source.transcript.slice(0, -1).split('\n');
    records = lines.map(line => { const value: unknown = JSON.parse(line); if (!object(value)) throw new Error('invalid record'); return value; });
  } catch { sourceErrors.push('source-incomplete'); }
  if (!sourceErrors.includes('source-incomplete')) {
    if (source.client === 'codex') {
      const headers = records.filter(row => row.type === 'session_meta');
      if (headers.length !== 1 || records[0] !== headers[0] || !object(headers[0]?.payload) ||
          headers[0].payload.id !== source.nativeSessionId) sourceErrors.push('native-session');
      if (records.some(row => row.type === 'session' || row.type === 'message' || row.sessionId !== undefined)) sourceErrors.push('mixed-client');
    } else if (source.client === 'omp') {
      const header = ompSessionHeaderIndex(lines);
      if (header === null || records[header]?.id !== source.nativeSessionId ||
          records.filter(row => row.type === 'session').length !== 1) sourceErrors.push('native-session');
      if (records.some(row => row.type === 'session_meta' || row.type === 'response_item' || row.sessionId !== undefined)) sourceErrors.push('mixed-client');
    } else if (source.client === 'claude') {
      const messages = records.filter(row => row.type === 'user' || row.type === 'assistant');
      if (!messages.length || messages.some(row => row.sessionId !== source.nativeSessionId)) sourceErrors.push('native-session');
      if (records.some(row => row.type === 'session_meta' || row.type === 'response_item' || row.type === 'session' || row.type === 'message')) sourceErrors.push('mixed-client');
    } else sourceErrors.push('client-unsupported');
  }
  const attributions = snapshot.attempts.map(attempt => {
    const identity = finalContextIdentity(attempt), unknown = [...sourceErrors];
    const matches = locators.filter(locator => finalContextIdentity(locator) === identity);
    const locator = matches.length === 1 ? matches[0]! : null;
    if (!locator) unknown.push(matches.length ? 'locator-ambiguous' : 'locator-missing');
    if (attempt.client !== source.client || attempt.recipient !== source.recipient || attempt.workspace !== source.workspace ||
        attempt.epoch !== source.epoch || attempt.context.sessionId !== attempt.recipient ||
        attempt.context.epoch !== attempt.epoch || attempt.context.attemptId !== attempt.attemptId ||
        attempt.context.port !== attempt.sink) unknown.push('attempt-binding');
    if (attempt.nativeSessionId !== undefined && attempt.nativeSessionId !== source.nativeSessionId) unknown.push('native-session-binding');
    let text: string | null = null, nativeText: string | null = null, at: string | null = null;
    if (locator && !unknown.length) {
      if (![locator.recordIndex, locator.contentIndex, locator.startByte, locator.endByte]
          .every(n => Number.isSafeInteger(n) && n >= 0) || locator.endByte < locator.startByte ||
          (locator.resultContentIndex !== undefined && (!Number.isSafeInteger(locator.resultContentIndex) || locator.resultContentIndex < 0))) unknown.push('locator-range');
      const record = records[locator.recordIndex];
      let content: unknown, callId: unknown, toolOutput = false;
      if (record && !unknown.length) {
        if (source.client === 'codex' && record.type === 'response_item' && object(record.payload)) {
          const payload = record.payload;
          if (payload.type === 'message' && ['user', 'developer', 'system'].includes(String(payload.role))) content = payload.content;
          else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
            content = payload.output; callId = payload.call_id; toolOutput = true;
          }
        } else if (source.client === 'omp' && record.type === 'message' && object(record.message)) {
          if (record.message.role === 'user') content = record.message.content;
          else if (record.message.role === 'toolResult') { content = record.message.content; callId = record.message.toolCallId; toolOutput = true; }
        } else if (source.client === 'omp' && record.type === 'custom_message' && record.customType === 'papercusp-context') {
          // before_agent_start persists this native entry, not a user message
          // or tool result. Other extensions' custom entries remain unobserved.
          content = record.content;
        } else if (source.client === 'claude' && record.type === 'user' && object(record.message) && record.message.role === 'user') {
          content = record.message.content;
        }
        const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
        let block: unknown = blocks[locator.contentIndex];
        let nestedResult = false;
        if (source.client === 'claude' && object(block) && block.type === 'tool_result') {
          callId = block.tool_use_id; toolOutput = true;
          const result = block.content;
          // Preserve both physical ordinals; never flatten several text blocks
          // or silently select the first block from an installed client array.
          nestedResult = Array.isArray(result);
          block = typeof result === 'string' ? { type: 'text', text: result }
            : Array.isArray(result) && locator.resultContentIndex !== undefined ? result[locator.resultContentIndex] : undefined;
        }
        if (locator.resultContentIndex !== undefined && !nestedResult) unknown.push('tool-result-content-binding');
        if ((toolOutput || callId !== undefined || locator.callId !== undefined) &&
            (!nonempty(callId) || callId !== locator.callId)) unknown.push('tool-call-binding');
        if (object(block) && ['text', 'input_text', 'output_text'].includes(String(block.type)) && typeof block.text === 'string') {
          const full = Buffer.from(blockPayloadText([block]), 'utf8');
          const selected = full.subarray(locator.startByte, locator.endByte);
          const decoded = selected.toString('utf8');
          if (locator.endByte <= full.length && Buffer.from(decoded, 'utf8').equals(selected) &&
              Buffer.from(block.text, 'utf8').toString('utf8') === block.text) {
            nativeText = decoded;
            if (locator.encoding === undefined) text = decoded;
            else if (locator.encoding === 'codex-exec-mcp-json-v1' && source.client === 'codex' &&
                object(record.payload) && record.payload.type === 'custom_tool_call_output') {
              try {
                const container: unknown = JSON.parse(decoded);
                const content = object(container) && Object.keys(container).length === 1 && Array.isArray(container.content)
                  ? container.content : [];
                if (content.length === 1 && object(content[0]) && Object.keys(content[0]).length === 2 &&
                    content[0].type === 'text' && typeof content[0].text === 'string' && JSON.stringify(container) === decoded)
                  text = content[0].text;
                else unknown.push('native-encoding');
              } catch { unknown.push('native-encoding'); }
            } else unknown.push('native-encoding');
          }
          else unknown.push('locator-bytes');
        } else unknown.push('native-text-unobserved');
        const time = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
        const createdAt = Date.parse(attempt.createdAt), capturedAt = Date.parse(snapshot.capturedAt);
        if (![time, createdAt, capturedAt].every(Number.isFinite) || time < createdAt || time > capturedAt) unknown.push('native-time');
        else at = new Date(time).toISOString();
      } else if (!unknown.length) unknown.push('record-missing');
      if (text !== null && (attempt.context.block === null || text !== attempt.context.block)) unknown.push('block-mismatch');
    }
    return { identity, recordVersion: attempt.recordVersion, status: unknown.length ? 'UNKNOWN' as const : 'observed' as const,
      unknown, locator, observedAt: at, observedSha256: text === null ? null : finalContextHash(text),
      nativeBytes: nativeText === null ? null : Buffer.byteLength(nativeText),
      nativeSha256: nativeText === null ? null : finalContextHash(nativeText),
      sourceRef: locator ? `${source.sourceSha256}#record=${locator.recordIndex}&content=${locator.contentIndex}`
        + (locator.resultContentIndex === undefined ? '' : `&resultContent=${locator.resultContentIndex}`)
        + `&bytes=${locator.startByte}:${locator.endByte}`
        + (locator.encoding === undefined ? '' : `&encoding=${locator.encoding}`) : null };
  });
  return { schemaVersion: 'final-context-transcript-attribution-v1' as const, sourceSha256: source.sourceSha256,
    sourceBytes: bytes.length, bindingEvidenceRef: source.bindingEvidenceRef, client: source.client,
    nativeSessionId: source.nativeSessionId, attributions };
}

/**
 * Pure R-10 sampling/evaluation seam over a separately collected immutable source.
 * Retain sourceSnapshotJson with its hash for replay. Collection, semantic labels
 * and ledger-backed acceptance remain the caller's independently verified work.
 * A malformed snapshot is rejected, never silently reduced to a smaller census.
 */
export function sampleFinalDeliveredContext(source: FinalContextAttemptSnapshot) {
  const sourceSnapshotJson = JSON.stringify(source);
  const snapshot = JSON.parse(sourceSnapshotJson) as FinalContextAttemptSnapshot;
  const timestamp = (value: string) => {
    const time = Date.parse(value);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error('final-context: UTC millisecond timestamp required');
    return time;
  };
  const nonempty = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (snapshot.schemaVersion !== 'final-attempt-source-v1' || !nonempty(snapshot.snapshotId) ||
      !nonempty(snapshot.runtimeGeneration) || ![snapshot.sourceSchemaSha256, snapshot.environmentSha256,
        snapshot.configurationSha256].every(hash) || !Array.isArray(snapshot.attempts) || !Array.isArray(snapshot.receipts)) {
    throw new Error('final-context: invalid snapshot identity');
  }
  const measuredAt = timestamp(snapshot.measuredAt), capturedAt = timestamp(snapshot.capturedAt);
  if (capturedAt < measuredAt) throw new Error('final-context: snapshot predates measurement');
  const windowStart = measuredAt - 24 * 60 * 60 * 1000;
  const versions = new Map<string, Map<number, FinalContextAttemptRecord>>();
  for (const row of snapshot.attempts) {
    if (![row.sourceStoreId, row.attemptId, row.attemptSchemaVersion, row.recipient, row.workspace].every(nonempty) ||
        !Number.isSafeInteger(row.recordVersion) || row.recordVersion < 0 ||
        !(row.epoch === null || Number.isSafeInteger(row.epoch) && row.epoch >= 0) ||
        row.sourceUnknown !== undefined && (!Array.isArray(row.sourceUnknown) || !row.sourceUnknown.every(nonempty)) ||
        timestamp(row.visibleAt) > capturedAt || !row.context || !Array.isArray(row.context.fragments)) {
      throw new Error('final-context: invalid snapshot row');
    }
    timestamp(row.createdAt);
    const identity = finalContextIdentity(row), sightings = versions.get(identity) ?? new Map<number, FinalContextAttemptRecord>();
    const prior = sightings.get(row.recordVersion);
    if (prior && !isDeepStrictEqual(prior, row)) throw new Error('final-context: conflicting row version');
    sightings.set(row.recordVersion, row);
    versions.set(identity, sightings);
  }
  const groups = new Map<string, FinalContextAttemptRecord[]>();
  const classification = (row: FinalContextAttemptRecord) => ({
    client: DELIVERY_MATRIX_CLIENTS.find(client => client === row.client) ?? 'UNKNOWN',
    sink: [...DELIVERY_MATRIX_PORTS, ...DELIVERY_MATRIX_EXTRA_SINKS].find(sink => sink === row.sink) ?? 'UNKNOWN',
  });
  for (const sightings of versions.values()) {
    const row = [...sightings.values()].reduce((a, b) => a.recordVersion > b.recordVersion ? a : b);
    const createdAt = timestamp(row.createdAt);
    if (createdAt < windowStart || createdAt >= measuredAt) continue;
    const { client, sink } = classification(row), key = JSON.stringify([client, sink]);
    const group = groups.get(key) ?? [];
    group.push(row); groups.set(key, group);
  }
  const partitions = [...groups].sort(([a], [b]) => finalContextByteOrder(a, b)).map(([key, rows]) => {
    rows.sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt) || finalContextByteOrder(a.attemptId, b.attemptId) ||
      finalContextByteOrder(finalContextIdentity(a), finalContextIdentity(b)));
    return { key, population: rows.length, sampled: rows.slice(0, 100) };
  });
  const selected = partitions.flatMap(group => group.sampled).map(row => {
    const { client, sink } = classification(row), unknown: string[] = [...row.sourceUnknown ?? []];
    if (row.epoch === null && !unknown.includes('epoch-unattributed')) unknown.push('epoch-unattributed');
    if (client === 'UNKNOWN') unknown.push('client-unattributed');
    if (sink === 'UNKNOWN') unknown.push('sink-unattributed');
    const fragmentSha256 = row.context.fragments.map(fragment => finalContextHash(fragment.text));
    const instrumented = deliveryTerminalOracle({ client: client as DeliveryMatrixCoordinate['client'],
      sink: sink as DeliveryMatrixCoordinate['sink'], source: 'memory', fault: 'prepare' }) !== 'NONE';
    const receipts = snapshot.receipts.filter(receipt => row.epoch !== null && instrumented && receipt.event === 'complete-stdout' &&
      finalContextIdentity(receipt) === finalContextIdentity(row) && receipt.recipient === row.recipient &&
      receipt.workspace === row.workspace && receipt.epoch === row.epoch && receipt.client === client && receipt.sink === sink &&
      row.context.attemptId === row.attemptId && row.context.sessionId === row.recipient && row.context.epoch === row.epoch &&
      row.context.port === sink && row.context.block !== null && receipt.blockSha256 === finalContextHash(row.context.block) &&
      isDeepStrictEqual(receipt.fragmentSha256, fragmentSha256) && nonempty(receipt.evidenceRef));
    if (!receipts.length) unknown.push('terminal-receipt-unmatched');
    if (!nonempty(row.labelEvidenceRef)) unknown.push('independent-label-evidence-missing');
    if (!['useful', 'neutral', 'harmful'].includes(row.taskBenefit ?? '')) unknown.push('task-benefit-unlabelled');
    return { row, client, sink, unknown, fragmentSha256, receipts };
  });
  // Duplicate detection follows actual time across partitions, never map/group order.
  selected.sort((a, b) => timestamp(a.row.createdAt) - timestamp(b.row.createdAt) ||
    finalContextByteOrder(a.row.attemptId, b.row.attemptId) || finalContextByteOrder(finalContextIdentity(a.row), finalContextIdentity(b.row)));
  const assessment = assessDeliveredContext(selected.map(({ row, receipts }) => ({ ...row.context,
    attemptId: finalContextIdentity(row), sessionId: JSON.stringify([row.workspace, row.recipient]), epoch: row.epoch,
    block: receipts.length ? row.context.block : null,
    harmfulTaskEffect: receipts.length ? row.taskBenefit === 'harmful' || row.context.harmfulTaskEffect === true : undefined,
  })));
  const attempts = selected.map((entry, index) => {
    const result = assessment.results[index]!;
    const unknown = [...entry.unknown, ...result.unknown];
    const usefulSuccess = result.failures.length ? false : unknown.length ? null : true;
    return { identity: finalContextIdentity(entry.row), recordVersion: entry.row.recordVersion,
      client: entry.client, sink: entry.sink, createdAt: entry.row.createdAt,
      rowSha256: finalContextHash(JSON.stringify(entry.row)), fragmentSha256: entry.fragmentSha256,
      receiptRefs: [...new Set(entry.receipts.map(receipt => receipt.evidenceRef))].sort(finalContextByteOrder),
      taskBenefit: entry.row.taskBenefit ?? null, labelEvidenceRef: entry.row.labelEvidenceRef ?? null,
      assessment: { ...result, unknown, usefulSuccess, verdict: usefulSuccess === false ? 'broken' : usefulSuccess === null ? 'unknown' : 'healthy' } };
  });
  return { schemaVersion: 'final-attempt-sample-v1' as const, sourceSnapshotJson,
    sourceSnapshotSha256: finalContextHash(sourceSnapshotJson), snapshotId: snapshot.snapshotId,
    sourceSchemaSha256: snapshot.sourceSchemaSha256, runtimeGeneration: snapshot.runtimeGeneration,
    environmentSha256: snapshot.environmentSha256, configurationSha256: snapshot.configurationSha256,
    measuredAt: snapshot.measuredAt, windowStart: new Date(windowStart).toISOString(),
    timestampPrecision: 'UTC milliseconds', identityEncoding: 'JSON tuple of UTF-8 strings; C byte order; no normalization',
    order: 'createdAt ASC, attemptId UTF-8 bytes ASC, identity UTF-8 bytes ASC', perGroupLimit: 100,
    sightings: snapshot.attempts.length, distinctAttempts: versions.size,
    partitions: partitions.map(group => ({ key: group.key, population: group.population,
      orderedIdentities: group.sampled.map(finalContextIdentity), rowVersions: group.sampled.map(row => row.recordVersion) })),
    attempted: attempts.length, usefulSuccesses: attempts.filter(row => row.assessment.usefulSuccess === true).length,
    usefulFailures: attempts.filter(row => row.assessment.usefulSuccess === false).length,
    usefulUnknown: attempts.filter(row => row.assessment.usefulSuccess === null).length, attempts };
}

/** Compare a saved measurement with an independently retained source snapshot.
 * Neither a claimed sample hash nor caller-authored totals can prove coverage. */
export function validateFinalDeliveredContextSample(value: unknown, expected: {
  sourceSnapshot: FinalContextAttemptSnapshot; sourceSnapshotSha256: string;
}): { valid: boolean; closed: boolean; errors: string[] } {
  const errors: string[] = [];
  try {
    const replay = sampleFinalDeliveredContext(expected.sourceSnapshot);
    if (replay.sourceSnapshotSha256 !== expected.sourceSnapshotSha256) errors.push('source-snapshot-hash');
    if (!isDeepStrictEqual(value, replay)) errors.push('sample-replay-mismatch');
  } catch { errors.push('invalid-source-snapshot'); }
  return { valid: !errors.length, closed: !errors.length, errors };
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
