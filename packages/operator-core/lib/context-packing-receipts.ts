/** Packing evidence extends the existing immutable text-artifact store. It is
 * deliberately separate from emission cursors: a receipt exists even when the
 * context budget is zero, and never acknowledges delivery. */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { withBoundedTimeout } from './bounded-timeout';
import { validateContextPackingResult, type ContextCandidate, type ContextPackingReceipt } from './context-doors';
import { getServingHostIdentity, type ServingHostIdentity } from './serving-host-identity';
import { activeWorkspaceId } from './workspace-registry';
import { claimImmutableTextArtifact, loadImmutableTextArtifact, loadImmutableTextArtifactClaim, saveImmutableTextArtifact } from './text-artifacts';
import { parseContextSourceVersion } from './memory/temporal-render';
import type { MemoryFragmentOffer } from './memory/session-epoch-ledger';
import { canonicalJson } from './external-bench/reproducibility/canonical-json';

export interface ContextPackingScope {
  workspaceId: string;
  ownerId: string;
  harness: string;
  port: 'turn-start' | 'mid-turn' | 'mcp-initialize' | 'mcp-result';
  client: string;
}
export interface StoredContextPackingReceipt {
  scope: ContextPackingScope;
  receipt: ContextPackingReceipt;
  /** Private preparation evidence, never a native emission or semantic label.
   * Legacy hash-only receipts remain readable and lack this replay source. */
  preparation?: ContextPackingPreparation & {
    schemaVersion: 'context-packing-source-v1';
    runtime: ServingHostIdentity;
    emission: 'UNKNOWN';
  };
  /** The workspace artifact store is not a private-grant destination. Retain
   * the attempted source's identity without copying any of its plaintext. */
  preparationWithheld?: { reason: 'granted-context'; createdAt: string; runtime: ServingHostIdentity;
    attribution?: ContextPackingAttribution };
}
export interface ContextPackingAttribution {
  observedAt: string;
  epoch: number | null;
  epochEvidenceRef: string | null;
  nativeSession: { backend: 'codex' | 'claude' | 'omp'; sessionId: string; advSessionId: string;
    activationEventId: string; controlGeneration: number } | null;
  unknown: ('epoch-unavailable' | 'native-session-unavailable' | 'attribution-read-failed')[];
}
export interface ContextPackingPreparation {
  createdAt: string;
  text: string;
  selectedIndexes: readonly number[];
  candidates: readonly ContextCandidate[];
  framing?: { prefix?: string; separator?: string; suffix?: string };
  /** Observed before preparation; absent only on older source records. */
  attribution?: ContextPackingAttribution;
}

/** MCP offers have no grant classification. Only an explicit allowlist of
 * identities and hashes may enter this workspace-visible artifact store. */
export interface StoredMcpContextPreparation {
  schemaVersion: 'context-mcp-preparation-v1';
  scope: ContextPackingScope;
  attemptId: string;
  createdAt: string;
  runtime: ServingHostIdentity;
  attribution: ContextPackingAttribution;
  emission: 'UNKNOWN';
  staging: 'staged' | 'empty' | 'failed';
  /** Legacy records hash JSON insertion order. New records use the existing
   * canonical serializer because native SDKs reorder object keys. String and
   * array bytes/order remain significant. No response plaintext is retained. */
  preparedResponse: { sha256: string; bytes: number; encoding?: 'canonical-json-v1' };
  fragments: (Omit<MemoryFragmentOffer, 'rendered' | 'revalidateSource'> & { selected: boolean })[];
}

export async function saveMcpContextPreparation(scope: ContextPackingScope, input: {
  attemptId: string; createdAt: string; attribution: ContextPackingAttribution;
  staging: StoredMcpContextPreparation['staging']; response: unknown;
  offers: readonly MemoryFragmentOffer[]; selected: readonly MemoryFragmentOffer[];
}) {
  const response = canonicalJson(JSON.parse(JSON.stringify(input.response)));
  const stored: StoredMcpContextPreparation = JSON.parse(JSON.stringify({
    schemaVersion: 'context-mcp-preparation-v1', scope: normalizedScope(scope), attemptId: input.attemptId,
    createdAt: input.createdAt, runtime: getServingHostIdentity(), attribution: input.attribution, emission: 'UNKNOWN',
    staging: input.staging, preparedResponse: { sha256: hash(response), bytes: Buffer.byteLength(response, 'utf8'), encoding: 'canonical-json-v1' },
    fragments: input.offers.map(row => ({ kind: row.kind, id: row.id, epoch: row.epoch, port: row.port,
      bodySha256: row.bodySha256, bodyBytes: row.bodyBytes,
      ...(row.sourceFingerprint ? { sourceFingerprint: row.sourceFingerprint,
        ...(row.sourceVersion ? { sourceVersion: parseContextSourceVersion(JSON.stringify(row.sourceVersion), row.id) } : {}) } : {}),
      selected: input.selected.includes(row) })),
  }));
  validateMcpPreparation(stored);
  const path = indexPath(stored.scope, stored.attemptId);
  const artifact = await saveImmutableTextArtifact(stored.scope.harness, JSON.stringify(stored));
  await claimImmutableTextArtifact(stored.scope.harness, path, JSON.stringify({ sha256: artifact.sha256 }));
  return { attemptId: stored.attemptId, path: `immutable/claims/${hash(path)}.json`, ...artifact };
}

function validateMcpPreparation(stored: StoredMcpContextPreparation): void {
  if (stored.schemaVersion !== 'context-mcp-preparation-v1' || stored.emission !== 'UNKNOWN' ||
      !['mcp-initialize', 'mcp-result'].includes(stored.scope.port) ||
      !Number.isFinite(Date.parse(stored.createdAt)) || new Date(stored.createdAt).toISOString() !== stored.createdAt ||
      !stored.runtime?.host || !stored.attribution || !['staged', 'empty', 'failed'].includes(stored.staging) ||
      !/^[a-f0-9]{64}$/.test(stored.preparedResponse?.sha256) || !Number.isSafeInteger(stored.preparedResponse.bytes) ||
      stored.preparedResponse.bytes < 0 || !Array.isArray(stored.fragments) || stored.fragments.length > 128 ||
      (stored.preparedResponse.encoding !== undefined && stored.preparedResponse.encoding !== 'canonical-json-v1') ||
      stored.fragments.some(row => !['memory', 'corpus', 'notice'].includes(row.kind) || !row.id || !row.port ||
        !Number.isSafeInteger(row.epoch) || row.epoch < 0 || !/^[a-f0-9]{64}$/.test(row.bodySha256) ||
        !Number.isSafeInteger(row.bodyBytes) || row.bodyBytes <= 0 || typeof row.selected !== 'boolean' ||
        (row.sourceFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(row.sourceFingerprint)) ||
        (row.sourceVersion !== undefined && (!parseContextSourceVersion(JSON.stringify(row.sourceVersion), row.id) ||
          row.sourceVersion.fingerprint !== row.sourceFingerprint))) ||
      (stored.staging === 'empty' && stored.fragments.some(row => row.selected)) ||
      (stored.staging === 'staged' && !stored.fragments.some(row => row.selected))) {
    throw new Error('context_mcp_preparation_invalid');
  }
  // Reuse attribution validation without manufacturing a packing result.
  validatePreparation({ scope: stored.scope, receipt: { attemptId: stored.attemptId } as ContextPackingReceipt,
    preparationWithheld: { reason: 'granted-context', createdAt: stored.createdAt, runtime: stored.runtime,
      attribution: stored.attribution } });
}

/** Reuse the epoch ledger and applied identity journal in one statement snapshot.
 * A missing ledger row is NOT epoch zero. Never resolve a native incarnation by
 * choosing the newest directory or by falling back to a different live session. */
export async function captureContextPackingAttribution(
  scope: Pick<ContextPackingScope, 'workspaceId' | 'ownerId' | 'client'>, sql?: Sql,
): Promise<ContextPackingAttribution> {
  scope = { ...scope };
  const unavailable: ContextPackingAttribution = { observedAt: new Date().toISOString(), epoch: null,
    epochEvidenceRef: null, nativeSession: null, unknown: ['epoch-unavailable', 'native-session-unavailable'] };
  if (!scope.ownerId || scope.workspaceId !== activeWorkspaceId()) return unavailable;
  const failed: ContextPackingAttribution = { ...unavailable, unknown: [...unavailable.unknown, 'attribution-read-failed'] };
  return (await withBoundedTimeout(async signal => { try {
    const connection = sql ?? (await import('@papercusp/db-org')).getOrgPg().sql;
    if (signal.aborted) return failed;
    const query = connection<{
      observed_at_ms: string; epoch: number | null; bumped_at_ms: string | null;
      live_count: number; adv_id: string | null; agent: string | null; native_id: string | null;
      event_id: string | null; event_adv_id: string | null; event_native_id: string | null; generation: string | null;
    }[]>`
      WITH live AS (
        SELECT id, agent, CASE WHEN agent = 'omp' THEN omp_thread_id ELSE session_id END AS native_id
          FROM harness_shared.adv_sessions
         WHERE workspace_id = ${scope.workspaceId} AND coord_owner_id = ${scope.ownerId}
           AND ended_at IS NULL AND ended_by IS NULL
      )
      SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint::text AS observed_at_ms, e.epoch,
             floor(extract(epoch FROM e.bumped_at) * 1000)::bigint::text AS bumped_at_ms,
             (SELECT count(*)::int FROM live) AS live_count,
             a.id::text AS adv_id, a.agent, a.native_id,
             applied.id::text AS event_id, applied.adv_session_id::text AS event_adv_id,
             applied.native_session_id AS event_native_id, applied.control_generation::text AS generation
        FROM (SELECT 1) anchor
        LEFT JOIN harness_shared.memory_session_epochs e ON e.session_id = ${scope.ownerId}
        LEFT JOIN LATERAL (SELECT * FROM live ORDER BY id LIMIT 1) a ON true
        LEFT JOIN LATERAL (
          SELECT id, adv_session_id, native_session_id, control_generation
            FROM harness_shared.session_identity_activation_events
           WHERE workspace_id = ${scope.workspaceId} AND owner_id = ${scope.ownerId} AND phase = 'applied'
           ORDER BY recorded_at DESC, id DESC LIMIT 1
        ) applied ON true
    `;
    const cancel = () => { void Promise.resolve(query.cancel?.()).catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    const [row] = await query.finally(() => signal.removeEventListener('abort', cancel));
    if (!row) return unavailable;
    const result: ContextPackingAttribution = { ...unavailable, observedAt: new Date(Number(row.observed_at_ms)).toISOString(), unknown: [] };
    if (row.epoch !== null && Number.isSafeInteger(Number(row.epoch)) && Number(row.epoch) >= 0 && row.bumped_at_ms !== null) {
      result.epoch = Number(row.epoch);
      result.epochEvidenceRef = JSON.stringify(['memory_session_epochs', scope.ownerId, result.epoch, new Date(Number(row.bumped_at_ms)).toISOString()]);
    } else result.unknown.push('epoch-unavailable');
    const generation = row.generation === null ? null : Number(row.generation);
    if (row.live_count === 1 && row.adv_id && row.adv_id === row.event_adv_id && row.native_id?.trim() &&
        row.native_id === row.event_native_id && row.event_id && row.agent === scope.client &&
        (row.agent === 'codex' || row.agent === 'claude' || row.agent === 'omp') &&
        generation !== null && Number.isSafeInteger(generation) && generation >= 0) {
      result.nativeSession = { backend: row.agent, sessionId: row.native_id, advSessionId: row.adv_id,
        activationEventId: row.event_id, controlGeneration: generation };
    } else result.unknown.push('native-session-unavailable');
    return result;
  } catch {
    return failed;
  } }, { timeoutMs: 150, fallback: failed, label: 'context-packing-attribution', warn: false })).value;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const normalizedScope = (scope: ContextPackingScope): ContextPackingScope => ({
  workspaceId: scope.workspaceId, ownerId: scope.ownerId, harness: scope.harness, port: scope.port, client: scope.client,
});
function indexPath(scope: ContextPackingScope, attemptId: string): string {
  if (!scope.ownerId || !scope.harness || scope.workspaceId !== activeWorkspaceId() ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(attemptId)) throw new Error('context_packing_scope_invalid');
  return `evidence/context-packing/${hash(JSON.stringify(normalizedScope(scope)))}/${attemptId}.json`;
}

/** Immutable complete candidate population plus an attempt-keyed create-only
 * index. Same-attempt retries are idempotent; conflicting evidence is refused. */
export async function saveContextPackingReceipt(scope: ContextPackingScope, receipt: ContextPackingReceipt,
  preparation?: ContextPackingPreparation) {
  // Freeze all caller-owned bytes before IO. A late renderer cannot make the
  // immutable source disagree with the receipt it was supposed to explain.
  const stored: StoredContextPackingReceipt = JSON.parse(JSON.stringify({ scope: normalizedScope(scope), receipt,
    ...(preparation ? { preparation: { ...preparation, schemaVersion: 'context-packing-source-v1',
      runtime: getServingHostIdentity(), emission: 'UNKNOWN' } } : {}) }));
  validatePreparation(stored);
  if (stored.preparation?.candidates.some(candidate => candidate.class === 'granted' && candidate.text)) {
    stored.preparationWithheld = { reason: 'granted-context', createdAt: stored.preparation.createdAt,
      runtime: stored.preparation.runtime, ...(stored.preparation.attribution ? { attribution: stored.preparation.attribution } : {}) };
    delete stored.preparation;
  }
  const path = indexPath(stored.scope, stored.receipt.attemptId);
  const content = JSON.stringify(stored);
  const artifact = await saveImmutableTextArtifact(stored.scope.harness, content);
  const pointer = JSON.stringify({ sha256: artifact.sha256 });
  try {
    await claimImmutableTextArtifact(stored.scope.harness, path, pointer);
  } catch (error) {
    if (error instanceof Error && error.message === 'text_artifact_immutable_claim_conflict') {
      throw new Error('context_packing_attempt_conflict');
    }
    throw error;
  }
  return { attemptId: stored.receipt.attemptId, path: `immutable/claims/${hash(path)}.json`, ...artifact };
}

function validatePreparation(stored: StoredContextPackingReceipt): void {
  const { preparation: source, receipt, scope } = stored;
  const attribution = source?.attribution ?? stored.preparationWithheld?.attribution;
  if ((source && 'attribution' in source && source.attribution === null) ||
      (stored.preparationWithheld && 'attribution' in stored.preparationWithheld && stored.preparationWithheld.attribution === null)) {
    throw new Error('context_packing_source_attribution_invalid');
  }
  if (attribution) {
    const native = attribution.nativeSession;
    if (!Number.isFinite(Date.parse(attribution.observedAt)) ||
        new Date(attribution.observedAt).toISOString() !== attribution.observedAt ||
        !Array.isArray(attribution.unknown) || new Set(attribution.unknown).size !== attribution.unknown.length ||
        attribution.unknown.some(reason => !['epoch-unavailable', 'native-session-unavailable', 'attribution-read-failed'].includes(reason)) ||
        (attribution.epoch === null ? attribution.epochEvidenceRef !== null || !attribution.unknown.includes('epoch-unavailable')
          : !Number.isSafeInteger(attribution.epoch) || attribution.epoch < 0 || !attribution.epochEvidenceRef || attribution.unknown.includes('epoch-unavailable')) ||
        (native === null ? !attribution.unknown.includes('native-session-unavailable')
          : !native || native.backend !== scope.client || !['codex', 'claude', 'omp'].includes(native.backend) ||
            ![native.sessionId, native.advSessionId, native.activationEventId].every(value => typeof value === 'string' && !!value.trim()) ||
            !Number.isSafeInteger(native.controlGeneration) || native.controlGeneration < 0 || attribution.unknown.includes('native-session-unavailable'))) {
      throw new Error('context_packing_source_attribution_invalid');
    }
  }
  if (!source) return;
  const createdAt = Date.parse(source.createdAt);
  if (source.schemaVersion !== 'context-packing-source-v1' || source.emission !== 'UNKNOWN' ||
      !Number.isFinite(createdAt) || new Date(createdAt).toISOString() !== source.createdAt ||
      !source.runtime || typeof source.runtime.host !== 'string' || !source.runtime.host ||
      !(source.runtime.processId === null || typeof source.runtime.processId === 'string') ||
      !(source.runtime.buildSha === null || typeof source.runtime.buildSha === 'string') ||
      !Array.isArray(source.candidates) || !Array.isArray(source.selectedIndexes) || typeof source.text !== 'string' ||
      (receipt.carrier && (receipt.carrier.client !== scope.client || receipt.carrier.port !== scope.port))) {
    throw new Error('context_packing_source_invalid');
  }
  const validation = validateContextPackingResult({ text: source.text, selectedIndexes: [...source.selectedIndexes], receipt }, {
    attemptId: receipt.attemptId, budgetBytes: receipt.budgetBytes, candidates: source.candidates,
    framing: source.framing, carrier: receipt.carrier,
  });
  if (!validation.valid) throw new Error(`context_packing_source_mismatch:${validation.errors.join(',')}`);
}

export async function loadContextPackingReceipt(scope: ContextPackingScope, attemptId: string): Promise<StoredContextPackingReceipt | null> {
  const path = indexPath(scope, attemptId);
  const pointer = await loadImmutableTextArtifactClaim(scope.harness, path);
  if (!pointer) return null;
  const { sha256 } = JSON.parse(pointer);
  const content = await loadImmutableTextArtifact(scope.harness, sha256);
  if (!content) throw new Error('context_packing_artifact_missing');
  const stored = JSON.parse(content) as StoredContextPackingReceipt;
  if (JSON.stringify(normalizedScope(stored.scope)) !== JSON.stringify(normalizedScope(scope)) || stored.receipt.attemptId !== attemptId) {
    throw new Error('context_packing_artifact_scope_mismatch');
  }
  validatePreparation(stored);
  return stored;
}

export interface ContextPackingReceiptCensus {
  schemaVersion: 'context-packing-census-v1';
  scope: ContextPackingScope;
  capturedAt: string;
  isolation: 'repeatable read';
  claimsScanned: number;
  complete: boolean;
  sources: { claimPath: string; sha256: string; state: 'prepared' | 'withheld' | 'legacy'; stored: StoredContextPackingReceipt }[];
  mcpSources?: { claimPath: string; sha256: string; stored: StoredMcpContextPreparation }[];
  excluded: { claimPath: string; reason: 'other-artifact' | 'different-scope' }[];
  unknown: { claimPath: string; reason: string }[];
}

/** Inventory canonical first-writer claims, rather than sampling a directory or
 * counting every content-addressed blob (which includes failed claim writes).
 * Claims and their targets share one database snapshot. Withheld and legacy
 * attempts remain population members; an unreadable claim never disappears.
 * This establishes storage custody only, not epoch binding or emission. */
export async function collectContextPackingReceiptSources(scope: ContextPackingScope): Promise<ContextPackingReceiptCensus> {
  const frozenScope = normalizedScope(JSON.parse(JSON.stringify(scope)));
  indexPath(frozenScope, 'census'); // Validate the authenticated workspace before any read.
  const { getOrgPg, generated } = await import('@papercusp/db-org');
  const { and, eq, inArray, like } = await import('drizzle-orm');
  const t = generated.harnessTextArtifactsInHarnessShared;
  const { db } = getOrgPg();
  return db.transaction(async tx => {
    const claims = await tx.select({ path: t.relPath, content: t.content }).from(t).where(and(
      eq(t.workspaceId, frozenScope.workspaceId), eq(t.harnessSlug, frozenScope.harness),
      like(t.relPath, 'immutable/claims/%'),
    )).orderBy(t.relPath);
    const result: ContextPackingReceiptCensus = { schemaVersion: 'context-packing-census-v1', scope: frozenScope,
      capturedAt: new Date().toISOString(), isolation: 'repeatable read', claimsScanned: claims.length,
      complete: false, sources: [], excluded: [], unknown: [] };
    const pointers: { claimPath: string; sha256: string }[] = [];
    for (const claim of claims) {
      try {
        const wrapper = JSON.parse(claim.content);
        if (typeof wrapper.content !== 'string' || hash(wrapper.content) !== wrapper.sha256) throw new Error('claim-corrupt');
        let pointer: unknown;
        try { pointer = JSON.parse(wrapper.content); }
        catch { result.excluded.push({ claimPath: claim.path, reason: 'other-artifact' }); continue; }
        if (!pointer || typeof pointer !== 'object' || !('sha256' in pointer)) {
          result.excluded.push({ claimPath: claim.path, reason: 'other-artifact' }); continue;
        }
        const sha256 = (pointer as { sha256: unknown }).sha256;
        if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('pointer-invalid');
        pointers.push({ claimPath: claim.path, sha256 });
      } catch (error) {
        // JSON parser messages may quote unrelated claim contents. Only stable
        // custody codes belong in the scoped census diagnostics.
        const reason = error instanceof Error && ['claim-corrupt', 'pointer-invalid'].includes(error.message)
          ? error.message : 'claim-invalid';
        result.unknown.push({ claimPath: claim.path, reason });
      }
    }
    const targets = new Map<string, string>();
    const digests = [...new Set(pointers.map(pointer => pointer.sha256))];
    // Keep bind counts bounded without giving up the single repeatable snapshot.
    for (let offset = 0; offset < digests.length; offset += 500) {
      const rows = await tx.select({ path: t.relPath, content: t.content }).from(t).where(and(
        eq(t.workspaceId, frozenScope.workspaceId), eq(t.harnessSlug, frozenScope.harness),
        inArray(t.relPath, digests.slice(offset, offset + 500).map(sha256 => `immutable/sha256/${sha256}.json`)),
      ));
      for (const row of rows) targets.set(row.path, row.content);
    }
    for (const pointer of pointers) {
      try {
        const content = targets.get(`immutable/sha256/${pointer.sha256}.json`);
        if (content === undefined) throw new Error('source-missing');
        if (hash(content) !== pointer.sha256) throw new Error('source-corrupt');
        let stored: StoredContextPackingReceipt;
        try { stored = JSON.parse(content); }
        catch { result.excluded.push({ claimPath: pointer.claimPath, reason: 'other-artifact' }); continue; }
        if ((stored as unknown as StoredMcpContextPreparation)?.schemaVersion === 'context-mcp-preparation-v1') {
          const mcp = stored as unknown as StoredMcpContextPreparation;
          validateMcpPreparation(mcp);
          const expectedClaim = `immutable/claims/${hash(indexPath(mcp.scope, mcp.attemptId))}.json`;
          if (expectedClaim !== pointer.claimPath || mcp.scope.harness !== frozenScope.harness) throw new Error('packing-claim-mismatch');
          if (JSON.stringify(normalizedScope(mcp.scope)) !== JSON.stringify(frozenScope)) {
            result.excluded.push({ claimPath: pointer.claimPath, reason: 'different-scope' }); continue;
          }
          (result.mcpSources ??= []).push({ ...pointer, stored: mcp });
          continue;
        }
        if (!stored || typeof stored !== 'object' || (!('scope' in stored) && !('receipt' in stored))) {
          result.excluded.push({ claimPath: pointer.claimPath, reason: 'other-artifact' }); continue;
        }
        if (!stored.scope || !stored.receipt || typeof stored.receipt.attemptId !== 'string') throw new Error('packing-source-invalid');
        const expectedClaim = `immutable/claims/${hash(indexPath(stored.scope, stored.receipt.attemptId))}.json`;
        if (expectedClaim !== pointer.claimPath || stored.scope.harness !== frozenScope.harness) throw new Error('packing-claim-mismatch');
        validatePreparation(stored);
        if (JSON.stringify(normalizedScope(stored.scope)) !== JSON.stringify(frozenScope)) {
          result.excluded.push({ claimPath: pointer.claimPath, reason: 'different-scope' }); continue;
        }
        result.sources.push({ ...pointer, state: stored.preparation ? 'prepared' : stored.preparationWithheld ? 'withheld' : 'legacy', stored });
      } catch (error) {
        const reason = error instanceof Error && ['source-missing', 'source-corrupt', 'packing-source-invalid',
          'packing-claim-mismatch'].includes(error.message) ? error.message : 'source-invalid';
        result.unknown.push({ claimPath: pointer.claimPath, reason });
      }
    }
    result.complete = result.unknown.length === 0;
    return result;
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

/** Diagnostic pagination is out of band, including its JSON framing in D.
 * Base64 pages can split arbitrary metadata bytes without losing a long source
 * identity. Concatenate decoded data before parsing the complete UTF-8 ledger.
 * No candidate is discarded to fit a diagnostic page. */
export function pageContextPackingReceipt(stored: StoredContextPackingReceipt, offset = 0, maxBytes = 6000): string {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes > 6000 || maxBytes < 512) {
    throw new Error('context_packing_diagnostic_page_invalid');
  }
  const body = Buffer.from(JSON.stringify(stored), 'utf8');
  const sha256 = hash(body.toString('utf8'));
  if (offset > body.length) throw new Error('context_packing_diagnostic_offset_invalid');
  const render = (length: number) => JSON.stringify({
    schemaVersion: 'context-packing-page-v1', attemptId: stored.receipt.attemptId,
    encoding: 'base64', sha256, offset, totalBytes: body.length,
    nextOffset: offset + length < body.length ? offset + length : null,
    data: body.subarray(offset, offset + length).toString('base64'),
  });
  let low = 0, high = Math.min(body.length - offset, maxBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(render(middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (!low && offset < body.length) throw new Error('context_packing_diagnostic_framing_overflow');
  const page = render(low);
  if (Buffer.byteLength(page, 'utf8') > maxBytes) throw new Error('context_packing_diagnostic_framing_overflow');
  return page;
}
