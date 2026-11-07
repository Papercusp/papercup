/**
 * Advisory SQL recommendations. The caller supplies authorized, unexpired evidence
 * and catalog snapshots from the existing registry/serving-build readers. This pure
 * boundary neither reads a source nor executes SQL, tools, or model-generated calls.
 * A registry pair retrieves a candidate; it does not certify its current contract.
 */
import { isDeepStrictEqual } from 'node:util';
import { createHash, createHmac } from 'node:crypto';
import { canonicalJson } from '@papercusp/hash-chain';
import { SQL_READ_PAIRS, SQL_READ_NO_PAIR_DECISIONS } from './pairs/sql-reads';
import { sqlPairClaimsAtom } from './sql-corpus';
import { fingerprintSqlIntent, type SqlIntentFeatures, type SqlIntentScope } from './sql-intent-fingerprint';
import { isSensitiveValueKey, redactSensitiveText } from '../sensitive-text';

export type SqlRecommendationKind = 'route-existing' | 'extend-existing' | 'availability-gap'
  | 'new-tool' | 'keep-sql' | 'insufficient-evidence';

/** An existing projected registry entry, never a tool inferred from its name. */
export interface SqlToolContract {
  name: string;
  /** Versioned identity of the schema, implementation AND output contract. */
  contractRef: string;
  sourceFingerprint?: string;
  args: { safeParse(value: unknown): { success: boolean } };
}

export function sqlToolContractIdentity(generation: string, registryRevision: string): string {
  return 'sql-tool-contract-v1:' + createHash('sha256').update(JSON.stringify([generation, registryRevision])).digest('hex');
}

/** Domain-separated, scoped tokens cannot disclose low-entropy private values
 * through an unkeyed digest. Non-JSON and oversized evidence stays unavailable. */
export function sqlCoverageToken(scope: SqlIntentScope, harness: string, domain: 'args' | 'rows' | 'features',
  value: unknown): string | null {
  try {
    if (!scope.workspaceId || !scope.sourceBoundary || !scope.epoch || !harness || scope.key.byteLength < 32) return null;
    const json = canonicalJson(value);
    if (Buffer.byteLength(json) > 2 * 1024 * 1024) return null;
    const sensitive = (v: unknown): boolean => Array.isArray(v) ? v.some(sensitive)
      : v !== null && typeof v === 'object' && Object.entries(v).some(([key, child]) => isSensitiveValueKey(key) || sensitive(child));
    if (domain === 'args' && sensitive(value) || redactSensitiveText(json, scope.knownSecrets) !== json
      || scope.knownSecrets?.some(secret => secret.length > 0 &&
        (json.includes(secret) || json.includes(JSON.stringify(secret).slice(1, -1))))) return null;
    return createHmac('sha256', scope.key).update(JSON.stringify([
      'sql-coverage-v1', scope.workspaceId, harness, scope.sourceBoundary, scope.epoch, domain, json,
    ])).digest('hex');
  } catch { return null; }
}

/** The maintained comparison supports complete named JSON rows only. It never
 * guesses a projection from a tool name, drops row order, or treats a clipped
 * response as complete. Other result contracts need their own measured fixture. */
export function sqlCoverageRows(value: unknown): unknown[] | null {
  try {
    const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
    const complete = (v: unknown): boolean => Array.isArray(v) ? v.every(complete) : !record(v) ||
      !(v._partial === true || v._truncated === true || v.truncated === true || v.isError === true
        || record(v._projection) && v._projection.truncated === true) && Object.values(v).every(complete);
    if (!record(value) || !complete(value)) return null;
    let body: unknown = value;
    if (value.structuredContent !== undefined) body = value.structuredContent;
    else if (value.data !== undefined) body = value.data;
    else if (Array.isArray(value.content)) {
      if (value.content.length !== 1 || !record(value.content[0]) || value.content[0].type !== 'text'
        || typeof value.content[0].text !== 'string' || Buffer.byteLength(value.content[0].text) > 2 * 1024 * 1024) return null;
      body = JSON.parse(value.content[0].text);
    }
    if (!record(body) || !complete(body) || body.truncated !== false || !Array.isArray(body.rows)
      || body.rows.length === 0 || body.rows.length > 10_000 || body.rows.some(row => !record(row))
      || body.rowCount !== undefined && body.rowCount !== body.rows.length) return null;
    canonicalJson(body.rows); // Reject non-finite numbers, BigInt, dates and cycles.
    return body.rows;
  } catch { return null; }
}
export interface SqlToolCatalog {
  /** A registry/runtime receipt; staging and served snapshots must be separate. */
  ref: string;
  buildRef: string;
  coverage: 'complete' | 'unknown' | 'truncated';
  tools: readonly SqlToolContract[];
}

/**
 * Produced by maintained equivalence checks, not similarity or an LLM. The exact
 * keyed fingerprint binds predicates, JSON semantics, joins, grouping, projection,
 * order/limit and typed input relationships. Required features are checked as well.
 * Private fixture SQL/arguments must stay behind the source's ACL/expiry boundary.
 */
export interface SqlCoverageAudit {
  toolName: string;
  contractRef: string;
  parserVersion: string;
  fingerprint: string;
  requiredFeatures: SqlIntentFeatures;
  fixtureRef: string;
  resultRef: string;
  verdict: 'exact' | 'partial' | 'none';
  /** Typed input example whose semantics were checked by the fixture. Never returned. */
  args: unknown;
  /** Missing input/output/query features from an executed counterexample. */
  missingFeatures: readonly string[];
}

export interface SqlRecommendationInput {
  sql: string;
  scope: SqlIntentScope;
  sourceCoverage: 'complete' | 'unknown' | 'truncated';
  /** Must be revalidated on each read, including reads of derived examples. */
  sourceAuthorized: boolean;
  exampleExpiresAt: number;
  now: number;
  current: SqlToolCatalog;
  served: SqlToolCatalog;
  audits: readonly SqlCoverageAudit[];
  /** Retrieved by semantic search/lineage; retrieval is not equivalence evidence. */
  candidateTools?: readonly string[];
  /** Completeness of deterministic candidate comparison, not just a catalog page. */
  candidateCoverage: 'complete' | 'unknown' | 'truncated';
  /** Reviewed decision for THIS exact shape, not a table-wide exclusion. */
  keepSql?: { fingerprint: string; decisionRef: string };
}
export interface SqlToolRecommendation {
  kind: SqlRecommendationKind;
  reason: string;
  toolName: string | null;
  /** Material contract/decision identity for review editions, independent of run receipts. */
  contractRef?: string;
  /** Only route-existing is immediately callable; SQL/args are never emitted. */
  immediatelyCallable: boolean;
  fingerprint: string | null;
  requiredFeatures: SqlIntentFeatures | null;
  evidenceRefs: string[];
  missingFeatures: string[];
}

/** Return registry-backed retrieval hints without changing historical pair verdicts. */
export function sqlRecommendationCandidates(sql: string): string[] {
  return [...new Set(SQL_READ_PAIRS.filter(pair => sqlPairClaimsAtom(pair, sql))
    .map(pair => pair.toolName))].sort();
}

export function recommendSqlTool(input: SqlRecommendationInput): SqlToolRecommendation {
  const result = (kind: SqlRecommendationKind, reason: string,
    extra: Partial<SqlToolRecommendation> = {}): SqlToolRecommendation => ({
    kind, reason, toolName: null, immediatelyCallable: false, fingerprint: null,
    requiredFeatures: null, evidenceRefs: [], missingFeatures: [], ...extra,
  });
  // Fail closed BEFORE parsing or echoing private identifiers/evidence references.
  if (!input.sourceAuthorized || !Number.isFinite(input.now)
    || !Number.isFinite(input.exampleExpiresAt) || input.now >= input.exampleExpiresAt) {
    return result('insufficient-evidence', 'source-unavailable');
  }
  const shape = fingerprintSqlIntent(input.sql, input.scope, input.sourceCoverage);
  if (shape.status !== 'supported') return result('insufficient-evidence', shape.reason);
  if (shape.secretValuesDropped) return result('insufficient-evidence', 'secret-bearing-source');
  const base = { fingerprint: shape.fingerprint, requiredFeatures: shape.features };
  const answer = (kind: SqlRecommendationKind, reason: string,
    extra: Partial<SqlToolRecommendation> = {}) => result(kind, reason, { ...base, ...extra });
  const validCatalog = (catalog: SqlToolCatalog): boolean => catalog.coverage === 'complete'
    && Boolean(catalog.ref && catalog.buildRef)
    && catalog.tools.every(t => Boolean(t.name && t.contractRef))
    && new Set(catalog.tools.map(t => t.name)).size === catalog.tools.length;
  if (!validCatalog(input.current) || !validCatalog(input.served)) {
    return answer('insufficient-evidence', 'incomplete-catalog-or-runtime');
  }
  const refs = [input.current.ref, input.current.buildRef, input.served.ref, input.served.buildRef];
  const audits = input.audits.filter(a => a.fingerprint === shape.fingerprint
    && a.parserVersion === shape.version && isDeepStrictEqual(a.requiredFeatures, shape.features)
    && Boolean(a.fixtureRef && a.resultRef && a.contractRef)
    && (a.verdict === 'exact' ? a.missingFeatures.length === 0 : a.missingFeatures.length > 0));
  const auditFor = (tool: SqlToolContract) => {
    const matching = audits.filter(a => a.toolName === tool.name && a.contractRef === tool.contractRef);
    // Contradictory fixture verdicts cannot be resolved by array order.
    if (new Set(matching.map(a => a.verdict)).size !== 1) return undefined;
    return matching.find(a => {
    // A stale/invalid input cannot certify equivalence. Never invoke a handler.
    try { return a.verdict !== 'exact' || tool.args.safeParse(a.args).success; }
    catch { return false; }
    });
  };
  const proofRefs = (a: SqlCoverageAudit) => [...refs, a.contractRef, a.fixtureRef, a.resultRef];
  // Prefer any verified served alternative, even when current source has drifted.
  for (const tool of [...input.served.tools].sort((a, b) => a.name.localeCompare(b.name))) {
    const audit = auditFor(tool);
    if (audit?.verdict === 'exact') return answer('route-existing', 'tested-served-contract', {
      toolName: tool.name, contractRef: audit.contractRef, immediatelyCallable: true, evidenceRefs: proofRefs(audit),
    });
  }
  for (const tool of [...input.current.tools].sort((a, b) => a.name.localeCompare(b.name))) {
    const audit = auditFor(tool);
    if (audit?.verdict === 'exact') return answer('availability-gap', 'tested-current-contract-not-served', {
      toolName: tool.name, contractRef: audit.contractRef, evidenceRefs: proofRefs(audit),
    });
  }
  if (input.keepSql?.fingerprint === shape.fingerprint && input.keepSql.decisionRef) {
    return answer('keep-sql', 'reviewed-exact-shape-decision', {
      contractRef: input.keepSql.decisionRef, evidenceRefs: [...refs, input.keepSql.decisionRef],
    });
  }
  // Table-level historical no-pair decisions remain hints, never exact-shape rulings.
  // Do not upgrade absence of a pair, bounded lineage, or retrieval to a complete census.
  const candidates = [...new Set([...sqlRecommendationCandidates(input.sql),
    ...(input.candidateTools ?? []), ...audits.map(a => a.toolName)])].sort();
  for (const name of candidates) {
    const tool = input.current.tools.find(t => t.name === name);
    const audit = tool && auditFor(tool);
    if (audit?.verdict === 'partial') return answer('extend-existing', 'tested-contract-feature-gap', {
      toolName: name, contractRef: audit.contractRef, evidenceRefs: proofRefs(audit), missingFeatures: [...audit.missingFeatures],
    });
  }
  // No new-tool proposal until every retrieved candidate has measured noncoverage
  // against both snapshots. Missing audits/availability stay UNKNOWN, never "no tool".
  const evaluated = input.candidateCoverage === 'complete' && candidates.length > 0 && candidates.every(name => {
    const contracts = [...input.current.tools, ...input.served.tools].filter(t => t.name === name);
    return contracts.length > 0 && contracts.every(t => auditFor(t)?.verdict === 'none');
  });
  if (evaluated) return answer('new-tool', 'tested-candidate-noncoverage', {
    contractRef: 'sql-compared-contracts:' + createHash('sha256').update(JSON.stringify(
      [...new Set(audits.map(a => JSON.stringify([a.toolName, a.contractRef])))].sort())).digest('hex'),
    evidenceRefs: [...new Set([...refs, ...audits.flatMap(a => [a.fixtureRef, a.resultRef])])],
  });
  return answer('insufficient-evidence', 'unmeasured-exact-coverage', { evidenceRefs: refs });
}

/** Existing no-pair decisions are available to reviewers, not silently applied. */
export { SQL_READ_NO_PAIR_DECISIONS };
