/**
 * Corpus-handle surfaced ledger — the dedup half of the P-008 second retrieval
 * leg (context-injection-audit-2026-07-28 / D-037, migration 712).
 *
 * The exact sibling of ./session-epoch-ledger, and deliberately so: it keys on
 * (session_id, epoch, ref) with the same meaning, shares the same compaction
 * `epoch` (so one bump re-primes memories AND pointers together), and records
 * the same `port` label. What it cannot share is the TABLE — that ledger's key
 * is `memory_id uuid` and every reader filters through a UUID guard, while a
 * corpus handle is `WI-6512` or `<source_kind>:<session_id>`. See migration 712.
 *
 * Why dedup is load-bearing rather than hygiene here: the corpus leg re-runs on
 * every injection moment against a query that barely changes turn-to-turn, so
 * without it the SAME three pointers ride every single turn until the query
 * text moves. That is exactly the turn-over-turn waste D-006 was written to
 * stop — and a repeated pointer is worse than a repeated fact, because the
 * agent has already decided not to resolve it.
 *
 * Posture mirrors the sibling: best-effort, never throws. A missing relation
 * (migration 712 not applied on this box yet) latches a process-wide no-op, so
 * the leg degrades to NO dedup rather than losing the pointers entirely.
 */

import type { SqlTag } from './bump-last-surfaced';
import { parseContextSourceVersion, type ContextSourceVersion } from './temporal-render';

let relationMissing = false;

function noteMissingRelation(err: unknown): void {
  const msg = (err as Error)?.message ?? '';
  if (/relation .* does not exist/.test(msg) || msg.includes('corpus_session_surfaced')) {
    relationMissing = true;
  }
}

/** Opportunistic GC horizon for ledger rows (days) — matches the mem0 sibling. */
const SURFACED_GC_DAYS = 14;

/** Fair, bounded revalidation of confirmed sources, independent of search rank.
 * This timestamp schedules reads only; it never advances delivery or dedup.
 * A failed/denied canonical read is unknown and becomes eligible again later. */
export async function corpusSourcesDueForRevalidation(
  sql: SqlTag, sessionId: string, epoch: number, excludeRefs: readonly string[] = [],
): Promise<ContextSourceVersion[]> {
  if (!sessionId || relationMissing) return [];
  try {
    const { boundedOrgTxn } = await import('../pg-bounded-txn');
    const rows = await boundedOrgTxn(tx => tx<{ ref: string; source_fingerprint: string; source_version: unknown }[]>`
      WITH due AS (
        SELECT ref FROM harness_shared.corpus_session_surfaced
        WHERE session_id = ${sessionId} AND epoch = ${epoch} AND source_version IS NOT NULL
          AND NOT (ref = ANY(${[...excludeRefs]}::text[]))
          AND (source_checked_at IS NULL OR source_checked_at < now() - interval '1 minute')
        ORDER BY source_checked_at NULLS FIRST, ref LIMIT 8 FOR UPDATE SKIP LOCKED
      )
      UPDATE harness_shared.corpus_session_surfaced s SET source_checked_at = now()
      FROM due WHERE s.session_id = ${sessionId} AND s.epoch = ${epoch} AND s.ref = due.ref
      RETURNING s.ref, s.source_fingerprint, s.source_version
    `, { client: sql as unknown as import('postgres').Sql, statementTimeoutMs: 1_500 });
    return rows.flatMap(row => {
      const version = parseContextSourceVersion(JSON.stringify(row.source_version), row.ref);
      return version?.fingerprint === row.source_fingerprint ? [version] : [];
    });
  } catch {
    // An unarmed additive migration must not disable ordinary recall/dedup.
    return [];
  }
}

/** Test seam: clear the latched no-op. */
export function _resetCorpusLedgerLatchForTests(): void {
  relationMissing = false;
}

/**
 * Which of `refs` this (session, epoch) has ALREADY been shown. Best-effort: a
 * failure returns the empty set, i.e. no suppression — a broken ledger must
 * cost a duplicate pointer, never a lost one.
 */
export async function alreadySurfacedRefs(
  sql: SqlTag,
  sessionId: string,
  epoch: number,
  refs: readonly string[],
  sourceFingerprints?: ReadonlyMap<string, string>,
  previousVersions?: Map<string, ContextSourceVersion>,
): Promise<Set<string>> {
  const empty = new Set<string>();
  if (!sessionId || relationMissing || refs.length === 0) return empty;
  const wanted = refs.filter((r) => typeof r === 'string' && r.length > 0);
  if (wanted.length === 0) return empty;
  try {
    if (sourceFingerprints) {
      const rows = await sql<{ ref: string; source_fingerprint: string | null; source_version?: unknown }[]>`
        SELECT ref, source_fingerprint, source_version FROM harness_shared.corpus_session_surfaced
        WHERE session_id = ${sessionId} AND epoch = ${epoch}
          AND ref = ANY(${wanted as string[]}::text[])
      `;
      for (const row of rows) {
        const version = parseContextSourceVersion(JSON.stringify(row.source_version) ?? '', row.ref);
        if (version && version.fingerprint === row.source_fingerprint) previousVersions?.set(row.ref, version);
      }
      return new Set(rows.filter(row => typeof row.source_fingerprint === 'string' &&
        /^[a-f0-9]{64}$/.test(row.source_fingerprint) &&
        row.source_fingerprint === sourceFingerprints.get(row.ref)).map(row => row.ref));
    }
    const rows = (await sql<{ ref: string }[]>`
      SELECT ref FROM harness_shared.corpus_session_surfaced
       WHERE session_id = ${sessionId}
         AND epoch = ${epoch}
         AND ref = ANY(${wanted as string[]}::text[])
    `) as unknown as { ref: string }[];
    return new Set(rows.map((r) => r.ref));
  } catch (err) {
    noteMissingRelation(err);
    return empty;
  }
}

/**
 * Record that `refs` were surfaced to (session, epoch) by `port`. Idempotent —
 * a re-stamp of the same ref keeps the ORIGINAL surfaced_at, so the ledger
 * answers "when was this first shown", not "when did we last try".
 */
export async function stampSurfacedRefs(
  sql: SqlTag,
  sessionId: string,
  epoch: number,
  refs: readonly string[],
  port: string,
): Promise<boolean> {
  return (await stampSurfacedRefsResult(sql, sessionId, epoch, refs, port)).ok;
}

/** DB uniqueness decides which competing receipt commits this reference. */
export async function stampSurfacedRefsResult(
  sql: SqlTag, sessionId: string, epoch: number, refs: readonly string[], port: string,
  sourceFingerprint?: string,
  sourceVersion?: ContextSourceVersion,
  previousSourceFingerprint?: string | null,
): Promise<{ ok: boolean; inserted: number }> {
  if (!sessionId || relationMissing) return { ok: false, inserted: 0 };
  if (sourceFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(sourceFingerprint)) return { ok: false, inserted: 0 };
  if (previousSourceFingerprint !== undefined && previousSourceFingerprint !== null &&
      !/^[a-f0-9]{64}$/.test(previousSourceFingerprint)) return { ok: false, inserted: 0 };
  const wanted = [...new Set(refs.filter((r) => typeof r === 'string' && r.length > 0))];
  if (wanted.length === 0) return { ok: true, inserted: 0 };
  const version = sourceVersion && wanted.length === 1
    ? parseContextSourceVersion(JSON.stringify(sourceVersion), wanted[0]) : null;
  if (sourceVersion && (!version || version.fingerprint !== sourceFingerprint)) return { ok: false, inserted: 0 };
  try {
    const rows = sourceFingerprint !== undefined ? await sql<unknown[]>`
      INSERT INTO harness_shared.corpus_session_surfaced (session_id, epoch, ref, port, source_fingerprint, source_version)
      SELECT ${sessionId}, ${epoch}, r, ${port}, ${sourceFingerprint}, ${version ? JSON.stringify(version) : null}::text::jsonb
        FROM unnest(${wanted as string[]}::text[]) AS r
      ON CONFLICT (session_id, epoch, ref) DO UPDATE
        SET source_fingerprint = EXCLUDED.source_fingerprint, source_version = EXCLUDED.source_version,
          port = EXCLUDED.port, surfaced_at = now()
        WHERE (corpus_session_surfaced.source_fingerprint IS DISTINCT FROM EXCLUDED.source_fingerprint
          OR (corpus_session_surfaced.source_version IS NULL AND EXCLUDED.source_version IS NOT NULL))
          AND (${previousSourceFingerprint !== undefined} = false OR
            corpus_session_surfaced.source_fingerprint IS NOT DISTINCT FROM ${previousSourceFingerprint ?? null}::text)
      RETURNING ref
    ` : await sql<unknown[]>`
      INSERT INTO harness_shared.corpus_session_surfaced (session_id, epoch, ref, port)
      SELECT ${sessionId}, ${epoch}, r, ${port}
        FROM unnest(${wanted as string[]}::text[]) AS r
      ON CONFLICT (session_id, epoch, ref) DO NOTHING
      RETURNING ref
    `;
    // Opportunistic GC on the same connection — cheap, indexed, and it keeps a
    // long-lived box from accumulating dead epochs. Its failure must NOT undo
    // the stamp above, so it carries its own swallow.
    try {
      await sql`
        DELETE FROM harness_shared.corpus_session_surfaced
         WHERE surfaced_at < now() - (${String(SURFACED_GC_DAYS)} || ' days')::interval
      `;
    } catch {
      /* GC is opportunistic — never load-bearing */
    }
    return { ok: true, inserted: rows.length };
  } catch (err) {
    noteMissingRelation(err);
    return { ok: false, inserted: 0 };
  }
}
