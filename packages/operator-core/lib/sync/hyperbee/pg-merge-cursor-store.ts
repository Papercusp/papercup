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
import { longLivedPoolConnectionOptions, poolIdleTimeoutSec } from '@papercusp/db-org';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import type { MergeCursorStore } from './read-merge';

/** Lazily-opened, process-lived shared pool. `max: 2` is ample — the cursor does
 *  one load at boot + a small periodic upsert per fold, never a hot query path. */
let sharedSql: ReturnType<typeof postgres> | null = null;

function sql(): ReturnType<typeof postgres> {
  if (!sharedSql) {
    sharedSql = postgres(getHarnessAdminUrl(), {
      ...longLivedPoolConnectionOptions('pg-merge-cursor-store'),
      max: 2,
      // Transactional pool — drain idle backends (see poolIdleTimeoutSec).
      idle_timeout: poolIdleTimeoutSec(),
      prepare: false,
    });
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
 *
 * SCOPE-STAMPED (EI-18773697830188393, migration 685): each row also records the
 * `apply_binding` — the pot-home projection scope (the federation demux key) the fold
 * ran under — and `load` returns ONLY rows matching the caller's current binding. A
 * position is a claim that the ops below it were APPLIED, but an op folded through the
 * wrong hive-home binding is demux-DROPPED while the cursor still advances past it
 * (WI-559: fed-b bound the shared hive to its local slug and discarded ~49.7k rows this
 * way). Making the stamp part of the row is what lets a CORRECTED binding self-heal on a
 * cold boot — stale progress simply does not load, so the fold restarts from 0 through
 * the right scope.
 *
 * UPGRADE COST (measured, not assumed — fed-b rig 2026-07-27): pre-migration rows carry
 * NULL, which matches only a NULL binding. A genuinely non-hive harness folds under NULL
 * and is unaffected, but EVERY hive-peered harness re-folds once — the JOINER *and* the
 * OWNER's home harness, because the binding is the whole
 * `hiveHomeProjectionSlug ?? ownPotHomeSlug ?? memberHomeRebindSlug` chain and
 * `ownPotHomeSlug` is non-null for an owner (only `joinerPotHomeSlug` is
 * remote_hive-gated). On a large log that one-shot re-fold is the very shape WI-2105
 * guards against, so it is deliberately made survivable rather than cheap: positions
 * persist INTRA-pass under the NEW stamp, so the re-fold is monotonic and a watchdog
 * restart resumes it instead of restarting it.
 */
export function createPgMergeCursorStore(
  workspaceId: string,
  harnessSlug: string,
): MergeCursorStore {
  return {
    async load(applyBinding: string | null): Promise<Map<string, number>> {
      // `IS NOT DISTINCT FROM` (not `=`) so a NULL binding — a non-hive harness, or a
      // hive OWNER, whose scope is genuinely "no pot-home" — matches the NULL stamp
      // instead of the `= NULL` three-valued miss that would silently re-fold every
      // such harness on every boot. The ::text cast pins the parameter type for the
      // NULL case (postgres cannot infer it from a bare NULL parameter).
      const rows = await sql()<{ log_keyhex: string; position: string | number }[]>`
        SELECT log_keyhex, position
        FROM harness_shared.substrate_merge_cursor
        WHERE workspace_id = ${workspaceId}
          AND harness_slug = ${harnessSlug}
          AND apply_binding IS NOT DISTINCT FROM ${applyBinding}::text
      `;
      const out = new Map<string, number>();
      for (const r of rows) out.set(r.log_keyhex, Number(r.position));
      return out;
    },
    async save(positions: ReadonlyMap<string, number>, applyBinding: string | null): Promise<void> {
      if (positions.size === 0) return;
      const s = sql();
      const now = new Date();
      const values = [...positions].map(([log_keyhex, position]) => ({
        workspace_id: workspaceId,
        harness_slug: harnessSlug,
        log_keyhex,
        position,
        apply_binding: applyBinding,
        updated_at: now,
      }));
      await s`
        INSERT INTO harness_shared.substrate_merge_cursor ${s(
          values,
          'workspace_id',
          'harness_slug',
          'log_keyhex',
          'position',
          'apply_binding',
          'updated_at',
        )}
        ON CONFLICT (workspace_id, harness_slug, log_keyhex)
        DO UPDATE SET position = EXCLUDED.position,
                      -- Re-stamp on every write: after a rebind the fold re-runs under the
                      -- NEW scope, so the row must stop advertising the old one (otherwise
                      -- the healed progress would be discarded again on the next boot).
                      apply_binding = EXCLUDED.apply_binding,
                      updated_at = EXCLUDED.updated_at
      `;
    },
  };
}
