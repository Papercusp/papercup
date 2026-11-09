/**
 * Session-epoch surfaced-memory ledger.
 *
 * Plan: memory-delivery-unification-2026-07-12 (P-002, decisions D-002/D-006).
 *
 * The chat pre-turn path dedups re-injection with a 2-minute wall-clock
 * watermark (`last_surfaced_at`) — right for a chat transcript the model
 * re-reads every turn, wrong for a WARM session (psu/su MCP, fleet member):
 * there an injected fact stays in context until COMPACTION, so mid-epoch
 * re-injection is pure token waste, while a compaction should make
 * everything eligible to re-prime at once.
 *
 * This ledger keys dedup on (session_id, epoch, memory_id):
 *   - `epoch` = the session's compaction generation (0 = never compacted);
 *     the post-compaction hook / cold wake bumps it (`bumpSessionEpoch`)
 *     and the whole memory pool becomes injectable again — automatically.
 *   - The ledger is PORT-AGNOSTIC (D-006): initialize, turn-start, compact
 *     re-prime, wake-briefs, and the claim/create injection ports stamp and
 *     read the SAME rows, so orient-then-claim never double-injects.
 *   - `port` records WHICH injection moment surfaced each row — the P-005
 *     per-port telemetry read.
 *
 * Posture mirrors bump-last-surfaced.ts: best-effort, never-throws; a
 * missing relation (migration 581 not applied yet) caches as a process-wide
 * no-op so the injection path degrades to no-dedup rather than failing.
 */

import type { SqlTag } from './bump-last-surfaced';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { parseContextSourceVersion, type ContextSourceVersion } from './temporal-render';

/** Private host metadata; no recalled plaintext is persisted in a receipt. */
export type MemoryFragmentManifest = {
  kind: 'memory' | 'corpus'; id: string; epoch: number; port: string;
  bodySha256: string; bodyBytes: number;
  /** Canonical source identity, independent of the emitted/redacted bytes. */
  sourceFingerprint?: string;
};
export type MemoryFragmentOffer = MemoryFragmentManifest & {
  rendered: string;
  /** Host-side metadata retained in the staged receipt, never recalled prose. */
  sourceVersion?: ContextSourceVersion;
};
export type PreparedMemoryBlock = { text: string; fragments: MemoryFragmentOffer[] };
export type MemoryEmissionConfirmation = { token: string; fragments: MemoryFragmentManifest[] };

export function memoryFragmentOffer(
  kind: MemoryFragmentManifest['kind'], id: string, epoch: number, port: string, rendered: string,
  sourceVersion?: ContextSourceVersion,
): MemoryFragmentOffer {
  const canonical = sourceVersion ? parseContextSourceVersion(JSON.stringify(sourceVersion), id) : null;
  if (sourceVersion && !canonical) {
    throw new Error('Memory fragment source identity does not match its reference');
  }
  return { kind, id, epoch, port, rendered,
    ...(canonical ? { sourceFingerprint: canonical.fingerprint, sourceVersion: canonical } : {}),
    bodySha256: createHash('sha256').update(rendered).digest('hex'), bodyBytes: Buffer.byteLength(rendered) };
}

const EMISSION_SURFACE_PREFIX = 'memory-emission:';
export const MEMORY_EMISSION_TTL_MS = 24 * 60 * 60 * 1000;
const emissionToken = (token: unknown): token is string => typeof token === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(token);
function validFragment(row: MemoryFragmentManifest): boolean {
  return !!row && (row.kind === 'memory' || row.kind === 'corpus') && typeof row.id === 'string' &&
    row.id.length > 0 && row.id.length <= 1000 && Number.isSafeInteger(row.epoch) && row.epoch >= 0 &&
    typeof row.port === 'string' && row.port.length > 0 && row.port.length <= 100 &&
    /^[a-f0-9]{64}$/.test(row.bodySha256) && Number.isSafeInteger(row.bodyBytes) && row.bodyBytes > 0 &&
    (row.sourceFingerprint === undefined || (typeof row.sourceFingerprint === 'string' && /^[a-f0-9]{64}$/.test(row.sourceFingerprint)));
}
function validOffer(row: MemoryFragmentOffer): boolean {
  const source = row?.sourceVersion ? parseContextSourceVersion(JSON.stringify(row.sourceVersion), row.id) : null;
  return validFragment(row) && (row.sourceFingerprint === undefined ? row.sourceVersion === undefined :
    !!source && source.fingerprint === row.sourceFingerprint);
}
const sameFragment = (a: MemoryFragmentManifest, b: MemoryFragmentManifest) =>
  a.kind === b.kind && a.id === b.id && a.epoch === b.epoch && a.port === b.port &&
  a.bodySha256 === b.bodySha256 && a.bodyBytes === b.bodyBytes && a.sourceFingerprint === b.sourceFingerprint;

// Extend the existing ledger rather than adding a parallel delivery service.
// Native tool dispatch can invoke recall through several nested helpers. Scope
// their preparations to one authenticated recipient and one final MCP response.
const emissionScope = new AsyncLocalStorage<{
  ownerId: string; active: boolean; fragments: MemoryFragmentOffer[];
}>();

export function collectsMemoryEmission(ownerId: string | undefined): boolean {
  const scope = emissionScope.getStore();
  return !!scope?.active && scope.ownerId === ownerId;
}

export function collectMemoryEmission(ownerId: string | undefined, fragments: readonly MemoryFragmentOffer[]): void {
  const scope = emissionScope.getStore();
  if (!scope?.active || scope.ownerId !== ownerId) return;
  for (const row of fragments) {
    if (scope.fragments.length >= 128) break;
    if (validOffer(row) && !scope.fragments.some(other => sameFragment(row, other))) scope.fragments.push(row);
  }
}

/** Only inspect fields the native client presents to the model. Private offer
 * metadata and structured-only diagnostic payloads cannot prove delivery. */
function modelVisibleStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    try { return modelVisibleStrings(JSON.parse(value)); } catch { return [value]; }
  }
  if (Array.isArray(value)) return value.flatMap(modelVisibleStrings);
  if (value && typeof value === 'object') return Object.entries(value)
    .filter(([key]) => key !== '_meta').flatMap(([, child]) => modelVisibleStrings(child));
  return [];
}

/** Native adapters opt in only when they can prove their completed stdout
 * write. This prepares an offer; only a subsequent exact receipt stamps it. */
export async function withMemoryEmissionReceipt<T extends object>(
  sql: SqlTag, ownerId: string, confirmations: unknown, run: () => Promise<T>,
): Promise<T & { _meta?: Record<string, unknown> }> {
  if (Array.isArray(confirmations) && confirmations.length <= 16) {
    for (const proof of confirmations) {
      try { await confirmMemoryEmission(sql, ownerId, proof); }
      catch { /* A missed confirmation permits replay, never false suppression. */ }
    }
  }
  const scope = { ownerId, active: true, fragments: [] as MemoryFragmentOffer[] };
  let result: T;
  try { result = await emissionScope.run(scope, run); }
  finally { scope.active = false; } // Late deadline losers cannot attach offers.
  const response = result as { instructions?: unknown; content?: unknown; _meta?: Record<string, unknown> };
  const content = Array.isArray(response.content) ? response.content : [];
  const visible = [response.instructions, ...content.flatMap(block =>
    block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [])]
    .flatMap(modelVisibleStrings).join('\n');
  const fragments = scope.fragments.filter(row =>
    (`\n${visible.trimEnd()}\n`).includes(`\n${row.rendered}\n`) &&
    createHash('sha256').update(row.rendered).digest('hex') === row.bodySha256 &&
    Buffer.byteLength(row.rendered) === row.bodyBytes);
  if (!fragments.length) return result;
  const token = randomUUID();
  try { await stageMemoryEmission(sql, ownerId, token, fragments); }
  catch { return result; }
  return { ...result, _meta: { ...response._meta,
    'papercusp/memoryEmission': { owner: ownerId, token, fragments } } };
}

/** Extend coord_read_cursors, with one surface per token so competing ports
 * cannot replace each other's candidate. Unsupported sinks never call this. */
export async function stageMemoryEmission(
  sql: SqlTag, ownerId: string, token: string, offers: readonly MemoryFragmentOffer[],
): Promise<void> {
  if (!emissionToken(token) || offers.length > 128) throw new Error('Invalid memory emission offer');
  const fragments = offers.filter(validOffer).map(row => ({ kind: row.kind, id: row.id, epoch: row.epoch, port: row.port,
    bodySha256: row.bodySha256, bodyBytes: row.bodyBytes,
    ...(row.sourceFingerprint ? { sourceFingerprint: row.sourceFingerprint,
      sourceVersion: parseContextSourceVersion(JSON.stringify(row.sourceVersion), row.id)! } : {}) }));
  if (!fragments.length) return;
  const { stage } = await import('../agent-tools/coordination/read-cursors');
  await stage(ownerId, EMISSION_SURFACE_PREFIX + token,
    { schemaVersion: 2, expiresAt: Date.now() + MEMORY_EMISSION_TTL_MS, fragments }, { deliveryToken: token });
  // Age-based cleanup reuses the existing cursor table and owning call, with
  // no scheduler. Expired proofs cost a replay, never a false suppression.
  try {
    const { coordScopeWorkspace } = await import('../agent-tools/coordination/log');
    await sql`DELETE FROM harness_shared.coord_read_cursors
      WHERE workspace_id = ${coordScopeWorkspace()} AND owner_id = ${ownerId} AND surface LIKE 'memory-emission:%'
        AND updated_at < now() - interval '1 day'`;
  } catch { /* optional retention cannot turn a prepared block into delivery */ }
}

/** Only the native stdout receipt's exact subset advances the existing ledgers.
 * Keep the candidate after a failed stamp so a later receipt can retry it. */
export async function confirmMemoryEmission(
  sql: SqlTag, ownerId: string, proof: MemoryEmissionConfirmation,
): Promise<number> {
  if (!proof || !emissionToken(proof.token) || !Array.isArray(proof.fragments) || proof.fragments.length > 128) return 0;
  const { ackAndRead, clearReadCursor } = await import('../agent-tools/coordination/read-cursors');
  const surface = EMISSION_SURFACE_PREFIX + proof.token;
  const ack = await ackAndRead(ownerId, surface, { confirmedToken: proof.token });
  const candidate = ack.committed;
  if (candidate?.schemaVersion !== 2 || !Array.isArray(candidate.fragments)) {
    // ACK creates a baseline row even when an earlier confirmation already
    // consumed this token. Replays must not leave empty receipt cursors behind.
    await clearReadCursor(ownerId, surface);
    return 0;
  }
  if (typeof candidate.expiresAt !== 'number' || !Number.isSafeInteger(candidate.expiresAt) || candidate.expiresAt <= Date.now()) {
    await clearReadCursor(ownerId, surface);
    return 0;
  }
  const delivered = (candidate.fragments as Array<MemoryFragmentManifest & { sourceVersion?: ContextSourceVersion }>).filter(row => validFragment(row) &&
    proof.fragments.some(actual => validFragment(actual) && sameFragment(row, actual)));
  if (!delivered.length) return 0;
  const { stampSurfacedRefsResult } = await import('./corpus-surfaced-ledger');
  let succeeded = true;
  let inserted = 0;
  for (const row of delivered) {
    const stamped = row.kind === 'memory'
      ? await stampSurfacedResult(sql, ownerId, row.epoch, [row.id], row.port, row.sourceFingerprint, row.sourceVersion)
      : await stampSurfacedRefsResult(sql, ownerId, row.epoch, [row.id], row.port, row.sourceFingerprint, row.sourceVersion);
    succeeded = stamped.ok && succeeded;
    inserted += stamped.inserted;
  }
  if (succeeded) await clearReadCursor(ownerId, surface);
  return succeeded ? inserted : 0;
}

let relationMissing = false;

function noteMissingRelation(err: unknown): void {
  const msg = (err as Error)?.message ?? '';
  if (/relation .* does not exist/.test(msg) || msg.includes('memory_session_')) {
    relationMissing = true;
  }
}

/** memory_session_surfaced.memory_id is `uuid NOT NULL`, so non-conforming ids
 *  are filtered BEFORE insert (they'd re-inject every port, never error).
 *  VERIFIED structurally safe (orient-recall-quality-2026-07-12 P-005): every
 *  memory-bearing table — memory_canonical.id, all memory_vec_*.memory_id —
 *  is uuid-typed, so a real memory id can never fail this shape. If a NON-uuid
 *  memory source is ever added, widen the column + this filter together. */
const UUID_SHAPE = /^[0-9a-f-]{20,}$/i;

/** Opportunistic GC horizon for ledger rows (days). */
const SURFACED_GC_DAYS = 14;

/**
 * The session's current compaction generation. 0 for a session that never
 * compacted (or was never seen). Best-effort: errors return 0.
 */
export async function currentSessionEpoch(sql: SqlTag, sessionId: string): Promise<number> {
  if (!sessionId || relationMissing) return 0;
  try {
    const rows = (await sql<{ epoch: number }[]>`
      SELECT epoch FROM harness_shared.memory_session_epochs
      WHERE session_id = ${sessionId}
    `) as unknown as { epoch: number }[];
    return rows.length > 0 ? Number(rows[0].epoch) || 0 : 0;
  } catch (err) {
    noteMissingRelation(err);
    return 0;
  }
}

/**
 * Bump the session's epoch (the compaction boundary). Returns the NEW epoch,
 * or null on failure. Also garbage-collects via a coarse age sweep (rows older
 * than SURFACED_GC_DAYS), piggybacked here because epoch bumps are infrequent
 * (once per compaction), so no new scheduler surface is needed.
 *
 * Superseded-epoch rows are deliberately KEPT until the age sweep (rubric-
 * system-improvements-2026-07-12 P-005): they are inert for dedup (reads
 * always filter on the CURRENT epoch) but they are the forensic record the
 * memory-recall-health replication drills query — an immediate delete here
 * erased a drill subject's pre-compaction claim stamps mid-grade on
 * 2026-07-12 (recall drill 2), forcing the delivery leg to be graded from
 * secondary evidence.
 */
export async function bumpSessionEpoch(sql: SqlTag, sessionId: string): Promise<number | null> {
  if (!sessionId || relationMissing) return null;
  try {
    const rows = (await sql<{ epoch: number }[]>`
      INSERT INTO harness_shared.memory_session_epochs (session_id, epoch, bumped_at)
      VALUES (${sessionId}, 1, now())
      ON CONFLICT (session_id)
      DO UPDATE SET epoch = harness_shared.memory_session_epochs.epoch + 1, bumped_at = now()
      RETURNING epoch
    `) as unknown as { epoch: number }[];
    const epoch = rows.length > 0 ? Number(rows[0].epoch) : null;
    // Coarse age sweep — the ONLY ledger GC (superseded epochs stay readable
    // for forensics until they age out; see the function doc).
    await sql`
      DELETE FROM harness_shared.memory_session_surfaced
      WHERE surfaced_at < now() - make_interval(days => ${SURFACED_GC_DAYS})
    `;
    return epoch;
  } catch (err) {
    noteMissingRelation(err);
    return null;
  }
}

/** Schedule a bounded, fair re-read of confirmed versions in CURRENT pools.
 * Scheduling is separate from delivery: neither fingerprint nor surfaced_at
 * changes until an exact emitted-fragment receipt is confirmed. */
export async function memorySourcesDueForRevalidation(
  sql: SqlTag, sessionId: string, epoch: number, scopes: readonly string[], excludeIds: readonly string[] = [],
): Promise<ContextSourceVersion[]> {
  const namespaces = [...new Set(scopes.filter(scope => typeof scope === 'string' && scope.length > 0))]
    .map(scope => `memory:${scope}`);
  if (!sessionId || relationMissing || namespaces.length === 0) return [];
  try {
    const { boundedOrgTxn } = await import('../pg-bounded-txn');
    const rows = await boundedOrgTxn(tx => tx<{ id: string; source_fingerprint: string; source_version: unknown }[]>`
      WITH due AS (
        SELECT memory_id FROM harness_shared.memory_session_surfaced
        WHERE session_id = ${sessionId} AND epoch = ${epoch}
          AND source_version->>'namespace' = ANY(${namespaces}::text[])
          AND NOT (memory_id = ANY(${excludeIds.filter(id => UUID_SHAPE.test(id))}::uuid[]))
          AND (source_checked_at IS NULL OR source_checked_at < now() - interval '1 minute')
        ORDER BY source_checked_at NULLS FIRST, memory_id LIMIT 8 FOR UPDATE SKIP LOCKED
      )
      UPDATE harness_shared.memory_session_surfaced s SET source_checked_at = now()
      FROM due WHERE s.session_id = ${sessionId} AND s.epoch = ${epoch} AND s.memory_id = due.memory_id
      RETURNING s.memory_id::text AS id, s.source_fingerprint, s.source_version
    `, { client: sql as unknown as import('postgres').Sql, statementTimeoutMs: 1_500 });
    return rows.flatMap(row => {
      const version = parseContextSourceVersion(JSON.stringify(row.source_version), row.id);
      return version?.fingerprint === row.source_fingerprint && namespaces.includes(version.namespace) ? [version] : [];
    });
  } catch { return []; } // Unarmed migration or failed read is unknown.
}

/**
 * The subset of `memoryIds` already surfaced to this (session, epoch) —
 * the warm-session dedup read. Best-effort: errors return the EMPTY set so
 * the caller degrades to no-dedup rather than dropping the injection.
 */
export async function alreadySurfacedIds(
  sql: SqlTag,
  sessionId: string,
  epoch: number,
  memoryIds: readonly string[],
  sourceFingerprints?: ReadonlyMap<string, string>,
  previousVersions?: Map<string, ContextSourceVersion>,
): Promise<Set<string>> {
  const empty = new Set<string>();
  if (!sessionId || relationMissing || memoryIds.length === 0) return empty;
  const ids = memoryIds.filter((id) => typeof id === 'string' && UUID_SHAPE.test(id));
  if (ids.length === 0) return empty;
  try {
    if (sourceFingerprints) {
      const rows = await sql<{ id: string; source_fingerprint: string | null; source_version?: unknown }[]>`
        SELECT memory_id::text AS id, source_fingerprint, source_version
        FROM harness_shared.memory_session_surfaced
        WHERE session_id = ${sessionId} AND epoch = ${epoch}
          AND memory_id = ANY(${ids}::uuid[])
      `;
      for (const row of rows) {
        const version = parseContextSourceVersion(JSON.stringify(row.source_version) ?? '', row.id);
        if (version && version.fingerprint === row.source_fingerprint) previousVersions?.set(row.id, version);
      }
      return new Set(rows.filter(row => typeof row.source_fingerprint === 'string' &&
        /^[a-f0-9]{64}$/.test(row.source_fingerprint) &&
        row.source_fingerprint === sourceFingerprints.get(row.id)).map(row => row.id));
    }
    const rows = (await sql<{ id: string }[]>`
      SELECT memory_id::text AS id
      FROM harness_shared.memory_session_surfaced
      WHERE session_id = ${sessionId}
        AND epoch = ${epoch}
        AND memory_id = ANY(${ids}::uuid[])
    `) as unknown as { id: string }[];
    return new Set(rows.map((r) => r.id));
  } catch (err) {
    noteMissingRelation(err);
    return empty;
  }
}

/**
 * Stamp memories as surfaced to this (session, epoch) via `port`.
 * Fire-and-forget from the injection path (mirrors bumpLastSurfacedSql).
 */
export async function stampSurfaced(
  sql: SqlTag,
  sessionId: string,
  epoch: number,
  memoryIds: readonly string[],
  port: string,
): Promise<boolean> {
  return (await stampSurfacedResult(sql, sessionId, epoch, memoryIds, port)).ok;
}

/** Expose the DB's atomic insert/revision-change count to confirmation.
 * Same-version receipts are no-ops. A delayed old receipt can permit replay of
 * a newer source, but its fingerprint cannot suppress that newer source. */
export async function stampSurfacedResult(
  sql: SqlTag, sessionId: string, epoch: number, memoryIds: readonly string[], port: string,
  sourceFingerprint?: string,
  sourceVersion?: ContextSourceVersion,
): Promise<{ ok: boolean; inserted: number }> {
  if (!sessionId || relationMissing) return { ok: false, inserted: 0 };
  if (sourceFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(sourceFingerprint)) return { ok: false, inserted: 0 };
  const ids = [...new Set(memoryIds.filter((id) => typeof id === 'string' && UUID_SHAPE.test(id)))];
  if (ids.length === 0) return { ok: true, inserted: 0 };
  // Native proofs carry only the fingerprint; source metadata comes from the
  // host's staged receipt and must remain content-free and integrity checked.
  const version = sourceVersion && ids.length === 1
    ? parseContextSourceVersion(JSON.stringify(sourceVersion), ids[0]) : null;
  if (sourceVersion && (!version || version.fingerprint !== sourceFingerprint)) return { ok: false, inserted: 0 };
  try {
    if (sourceFingerprint !== undefined) {
      const rows = await sql<unknown[]>`
        INSERT INTO harness_shared.memory_session_surfaced (session_id, epoch, memory_id, port, source_fingerprint, source_version)
        SELECT ${sessionId}, ${epoch}, unnest(${ids}::uuid[]), ${port}, ${sourceFingerprint}, ${version ? JSON.stringify(version) : null}::text::jsonb
        ON CONFLICT (session_id, epoch, memory_id) DO UPDATE
          SET source_fingerprint = EXCLUDED.source_fingerprint, source_version = EXCLUDED.source_version,
            port = EXCLUDED.port, surfaced_at = now()
          WHERE memory_session_surfaced.source_fingerprint IS DISTINCT FROM EXCLUDED.source_fingerprint
            OR (memory_session_surfaced.source_version IS NULL AND EXCLUDED.source_version IS NOT NULL)
        RETURNING memory_id
      `;
      return { ok: true, inserted: rows.length };
    }
    const rows = await sql<unknown[]>`
      INSERT INTO harness_shared.memory_session_surfaced (session_id, epoch, memory_id, port)
      SELECT ${sessionId}, ${epoch}, unnest(${ids}::uuid[]), ${port}
      ON CONFLICT (session_id, epoch, memory_id) DO NOTHING
      RETURNING memory_id
    `;
    return { ok: true, inserted: rows.length };
  } catch (err) {
    noteMissingRelation(err);
    return { ok: false, inserted: 0 };
  }
}

/** Test hook: reset the relation-missing cache. */
export function _resetSessionEpochLedgerForTests(): void {
  relationMissing = false;
}
