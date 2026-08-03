/**
 * read-cursors.ts — server-side per-agent read cursors with two-phase
 * ACK-ON-NEXT-READ (fleet-deltas-leader-primitives-2026-07-10 P-004; the
 * owner-ratified D-002 design; mig 537 `harness_shared.coord_read_cursors`).
 *
 * The problem this solves: every delta protocol in this system so far failed on
 * the CALLER leg — clients never carry cursors (`_meta.delta` inert per WI-514;
 * `since_ts` seeded wrong loses messages forever, WI-1600). So the cursor lives
 * SERVER-side, keyed (workspace, owner, surface), and the caller passes nothing.
 *
 * Two-phase semantics (the loop-wake-turn-death fix):
 *   call N   : deliver delta(committed → current); store pending = current.
 *   call N+1 : its ARRIVAL is the ack — promote pending → committed, then
 *              deliver delta(committed → current) as usual.
 * A caller that dies after call N never makes call N+1, so pending is never
 * promoted: the next call re-diffs against the OLD committed and re-delivers
 * call N's content. At-least-once, never a skip — the same recovery contract as
 * coord_watermarks' deliberately non-monotonic ts cursors (watermarks.ts),
 * generalized from timestamps to arbitrary compact state fingerprints.
 *
 * Store shape mirrors watermarks.ts: a module-level default Pg store with
 * configure/reset seams so tests inject the in-memory variant and never touch
 * the live row.
 */

import { getOrgPg } from '@papercusp/db-org';
import { coordScopeWorkspace } from './log';

/** A compact JSON-serializable state fingerprint. Keep it SMALL (the point is
 *  to diff against it, not to archive state) — per-member scalars, not payloads. */
export type CursorState = Record<string, unknown>;

export interface AckResult {
  /** The state the caller has provably seen (post-promotion) — diff against
   *  THIS. Null on the very first call for a surface: deliver a full baseline. */
  committed: CursorState | null;
  /** True when no committed state exists yet — the caller must receive a full
   *  snapshot, not a delta. */
  baseline: boolean;
}

export interface ReadCursorStore {
  /** Phase 1+2 in one round-trip: promote pending→committed (the ack for the
   *  previous delivery), persist `next` as the new pending, and return the
   *  post-promotion committed to diff against. */
  ackAndAdvance(ownerId: string, surface: string, next: CursorState): Promise<AckResult>;
  /** Drop a surface's cursor (e.g. a schema change invalidates fingerprints). */
  clear(ownerId: string, surface: string): Promise<void>;
}

class PgReadCursorStore implements ReadCursorStore {
  async ackAndAdvance(ownerId: string, surface: string, next: CursorState): Promise<AckResult> {
    const { sql } = getOrgPg();
    const ws = coordScopeWorkspace();
    // Single-writer-per-(owner,surface) — the owning agent's own turn is the only
    // writer, the same no-lock invariant coord_watermarks relies on. One statement:
    // promote pending→committed (ack) and install the new pending, returning the
    // PRE-UPDATE promotion result via a CTE over the old row.
    const rows = await sql<Array<{ committed: CursorState | null }>>`
      WITH old AS (
        SELECT committed, pending FROM harness_shared.coord_read_cursors
         WHERE workspace_id = ${ws} AND owner_id = ${ownerId} AND surface = ${surface}
      ), up AS (
        INSERT INTO harness_shared.coord_read_cursors
               (workspace_id, owner_id, surface, committed, pending, pending_at, updated_at)
        VALUES (${ws}, ${ownerId}, ${surface},
                (SELECT COALESCE(pending, committed) FROM old),
                -- WI-7092 / EI-607: this sql is getOrgPg's client (line 53) -- sql.json(next)
                -- THROWS on it in production (a postgres-js CJS/ESM dual-package
                -- module-instance mismatch; see
                -- agent-insights/sql-json-throws-on-getorgpg-client). Bind as
                -- JSON.stringify(next)::jsonb instead -- portable, server-side cast, and
                -- correct under vitest too (vitest's module transform does not reproduce
                -- the CJS/ESM split, so a vitest-run test cannot tell the two forms apart --
                -- this comment plus lint:no-sql-json are what actually guard the class).
                ${JSON.stringify(next)}::jsonb, now(), now())
        ON CONFLICT (workspace_id, owner_id, surface) DO UPDATE
           SET committed  = COALESCE(harness_shared.coord_read_cursors.pending,
                                     harness_shared.coord_read_cursors.committed),
               pending    = EXCLUDED.pending,
               pending_at = now(),
               updated_at = now()
        RETURNING committed
      )
      SELECT committed FROM up
    `;
    const committed = rows[0]?.committed ?? null;
    return { committed, baseline: committed === null };
  }

  async clear(ownerId: string, surface: string): Promise<void> {
    const { sql } = getOrgPg();
    const ws = coordScopeWorkspace();
    await sql`
      DELETE FROM harness_shared.coord_read_cursors
       WHERE workspace_id = ${ws} AND owner_id = ${ownerId} AND surface = ${surface}`;
  }
}

/** In-memory variant for tests (mirrors watermarks.ts's injection contract). */
export class InMemoryReadCursorStore implements ReadCursorStore {
  private rows = new Map<string, { committed: CursorState | null; pending: CursorState | null }>();
  async ackAndAdvance(ownerId: string, surface: string, next: CursorState): Promise<AckResult> {
    const key = `${ownerId}\0${surface}`;
    const row = this.rows.get(key) ?? { committed: null, pending: null };
    const committed = row.pending ?? row.committed;
    this.rows.set(key, { committed, pending: next });
    return { committed, baseline: committed === null };
  }
  async clear(ownerId: string, surface: string): Promise<void> {
    this.rows.delete(`${ownerId}\0${surface}`);
  }
}

let store: ReadCursorStore = new PgReadCursorStore();

/** Swap the backing store (tests inject InMemoryReadCursorStore). */
export function configureReadCursorStore(next: ReadCursorStore): void {
  store = next;
}

/** Restore the default Pg store (afterEach in tests). */
export function resetReadCursorStore(): void {
  store = new PgReadCursorStore();
}

/** The module-level entry consumers call — see ReadCursorStore.ackAndAdvance. */
export async function ackAndAdvance(
  ownerId: string,
  surface: string,
  next: CursorState,
): Promise<AckResult> {
  return store.ackAndAdvance(ownerId, surface, next);
}

/** Drop a surface's cursor for an owner. */
export async function clearReadCursor(ownerId: string, surface: string): Promise<void> {
  return store.clear(ownerId, surface);
}
