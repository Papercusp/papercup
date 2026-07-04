/**
 * pg-merge-cursor-store.ts — WI-2105 REV fix: a Postgres-backed `MergeCursorStore`
 * over `harness_shared.substrate_merge_cursor`.
 *
 * The substrate boot merge folds each admitted peer log via an IN-MEMORY cursor
 * that reset to 0 on every bg-host restart. A large orphaned log (e06b8704, 70k
 * ops) then re-folded from scratch each boot, CPU-starving `routinesTick` past
 * the 240s bghost-watchdog bound → the watchdog restarted bg-host → the fold
 * never reached tail (the REV restart loop). Persisting per-log positions here
 * makes fold progress MONOTONIC across restarts. The write is persist-AFTER-apply
 * (see `read-merge.persistCursor` / the boot `onCursorAdvance` hook): a crash
 * between apply and persist re-folds the last batch idempotently (LWW put/del)
 * rather than skipping it.
 *
 * Pool policy: ONE small module-scoped pool shared across every harness boot in
 * this process (like `pg-listen-hub.ts` / `dock-layouts.ts`), NOT a pool per slug
 * or per op (the perf anti-pattern). DSN resolves via `getHarnessAdminUrl()` —
 * never a hardcoded `localhost:5432` (embedded-pg is the ship target).
 */

import postgres from 'postgres';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import type { MergeCursorStore } from './read-merge';

/** Lazily-opened, process-lived shared pool. `max: 2` is ample — the cursor does
 *  one load at boot + a small periodic upsert per fold, never a hot query path. */
let sharedSql: ReturnType<typeof postgres> | null = null;

function sql(): ReturnType<typeof postgres> {
  if (!sharedSql) {
    sharedSql = postgres(getHarnessAdminUrl(), { max: 2, prepare: false });
  }
  return sharedSql;
}

/** Test seam: reset the shared pool (so a test can point it at a fresh DSN /
 *  close it between cases). Not used in production. */
export async function _resetPgMergeCursorPoolForTests(): Promise<void> {
  const s = sharedSql;
  sharedSql = null;
  if (s) await s.end({ timeout: 5 }).catch(() => {});
}

/**
 * WI-2105 — a `MergeCursorStore` scoped to one `(workspaceId, harnessSlug)`,
 * backed by `harness_shared.substrate_merge_cursor`. `load` returns keyHex →
 * position for a boot seed; `save` upserts the current positions (unconditional
 * last-write-wins — persist-after-apply already guarantees a persisted position
 * never points past a durably-applied op, and a truncated/forked log MUST be
 * able to write a LOWER position so the next boot re-folds it from there).
 */
export function createPgMergeCursorStore(
  workspaceId: string,
  harnessSlug: string,
): MergeCursorStore {
  return {
    async load(): Promise<Map<string, number>> {
      const rows = await sql()<{ log_keyhex: string; position: string | number }[]>`
        SELECT log_keyhex, position
        FROM harness_shared.substrate_merge_cursor
        WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
      `;
      const out = new Map<string, number>();
      for (const r of rows) out.set(r.log_keyhex, Number(r.position));
      return out;
    },
    async save(positions: ReadonlyMap<string, number>): Promise<void> {
      if (positions.size === 0) return;
      const s = sql();
      const now = new Date();
      const values = [...positions].map(([log_keyhex, position]) => ({
        workspace_id: workspaceId,
        harness_slug: harnessSlug,
        log_keyhex,
        position,
        updated_at: now,
      }));
      await s`
        INSERT INTO harness_shared.substrate_merge_cursor ${s(
          values,
          'workspace_id',
          'harness_slug',
          'log_keyhex',
          'position',
          'updated_at',
        )}
        ON CONFLICT (workspace_id, harness_slug, log_keyhex)
        DO UPDATE SET position = EXCLUDED.position, updated_at = EXCLUDED.updated_at
      `;
    },
  };
}
