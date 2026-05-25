/**
 * Bump memory_canonical.last_surfaced_at for a set of memory ids.
 *
 * Plan: papercusp-su-memory-2026-05-25 (Phase 5 P-021).
 *
 * Called from `injection.ts` after the fan-out merge so Layer 3
 * (deferred) can later pick "memories actually used recently AND
 * stale-validation" — the partial index in migration 085
 * (`memory_canonical_recently_surfaced_idx`) makes that picker query
 * sub-millisecond.
 *
 * Best-effort: any failure (column missing, PG down, malformed id) is
 * swallowed. The injection itself never depends on this side-effect.
 *
 * Schema dependency: requires migration 085 (`last_surfaced_at`
 * column). Probes once and caches; if the column is absent the helper
 * becomes a no-op for the rest of the process.
 */

export interface PgQueryable {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

let columnMissing = false;

/**
 * Stamp `last_surfaced_at = now()` for the provided memory ids.
 *
 * Returns true when the UPDATE ran (or there was nothing to do);
 * false on first-time column-missing detection (caller can log that
 * migration 085 hasn't applied yet).
 */
export async function bumpLastSurfaced(
  client: PgQueryable,
  memoryIds: string[],
): Promise<boolean> {
  if (memoryIds.length === 0) return true;
  if (columnMissing) return false;

  // Filter to valid uuid shape — the SQL ANY() takes a text[] so we
  // defend against an upstream caller that hands us a non-id string.
  // Mem0 always emits uuids; this is belt-and-suspenders.
  const ids = memoryIds.filter(
    (id) => typeof id === 'string' && /^[0-9a-f-]{20,}$/i.test(id),
  );
  if (ids.length === 0) return true;

  try {
    await client.query(
      `UPDATE harness_shared.memory_canonical
       SET last_surfaced_at = now()
       WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return true;
  } catch (err) {
    // Two failure cases:
    //   1. column doesn't exist (migration 085 not applied) — cache as
    //      no-op for the rest of process lifetime so we don't retry
    //   2. transient PG error — log + return false but don't poison
    const msg = (err as Error)?.message ?? '';
    if (
      msg.includes('last_surfaced_at') ||
      msg.includes('column') ||
      /relation .* does not exist/.test(msg)
    ) {
      columnMissing = true;
    }
    return false;
  }
}

/** Test hook: reset the column-missing cache. */
export function _resetForTests(): void {
  columnMissing = false;
}
