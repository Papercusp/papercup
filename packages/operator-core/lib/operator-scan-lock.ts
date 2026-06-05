/**
 * Operator scan-lock (Phase 1d of the v5 operator plan).
 *
 * Server-side dedup so that two browser tabs on the same workspace
 * (or a CLI caller racing the UI) can't burn budget on overlapping
 * scans. The route acquires the lock before spawning the LLM and
 * releases it on SSE close. The lock has a 60s TTL so a crashed
 * holder doesn't strand the workspace.
 *
 * Returns a Retry-After hint when a fresh foreign lock is held —
 * the panel surfaces this to the user as "another tab is scanning."
 */

import { withWorkspace, generated } from '@papercusp/db-org';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, gt, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from './workspace-registry';

const sl = generated.operatorScanLocksInHarnessShared;

const LOCK_TTL_MS = 60_000;

export interface AcquireResult {
  acquired: boolean;
  /** Seconds until the active lock is expected to expire (Retry-After). */
  retryAfterSec?: number;
  /** The id we hold (only present when `acquired === true`). */
  holderId?: string;
}

/**
 * Try to acquire the workspace's operator scan lock.
 * Returns `{acquired:false, retryAfterSec}` if a different `holder_id`
 * holds an unexpired lock; otherwise replaces it and returns
 * `{acquired:true, holderId}`.
 */
export async function acquireScanLock(): Promise<AcquireResult> {
  const workspaceId = activeWorkspaceId();
  const holderId = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const expiresAt = new Date(Date.now() + LOCK_TTL_MS).toISOString();

  return withWorkspace(workspaceId, async (tx) => {
    const txDb = drizzle(tx);
    const rows = await txDb
      .select({ holder_id: sl.holderId, expires_at: sl.expiresAt })
      .from(sl)
      .where(and(eq(sl.workspaceId, workspaceId), gt(sl.expiresAt, dsql`now()`)))
      .limit(1);
    if (rows.length > 0) {
      const expiresMs = new Date(rows[0].expires_at as unknown as string).getTime();
      const retryAfterSec = Math.max(1, Math.ceil((expiresMs - Date.now()) / 1000));
      return { acquired: false, retryAfterSec };
    }
    await txDb
      .insert(sl)
      .values({
        workspaceId: workspaceId,
        startedAt: dsql`now()` as any,
        holderId: holderId,
        expiresAt: dsql`${expiresAt}::timestamptz` as any,
      })
      .onConflictDoUpdate({
        target: sl.workspaceId,
        set: {
          startedAt: dsql`now()`,
          holderId: dsql`EXCLUDED.holder_id`,
          expiresAt: dsql`EXCLUDED.expires_at`,
        },
      });
    return { acquired: true, holderId };
  });
}

/** Release a held scan lock. Idempotent; only deletes if `holderId` still matches. */
export async function releaseScanLock(holderId: string): Promise<void> {
  const workspaceId = activeWorkspaceId();
  try {
    await withWorkspace(workspaceId, async (tx) => {
      const txDb = drizzle(tx);
      await txDb
        .delete(sl)
        .where(and(eq(sl.workspaceId, workspaceId), eq(sl.holderId, holderId)));
    });
  } catch {
    // Best-effort: if PG is down or the migration hasn't been applied,
    // we don't want to crash the SSE close handler. The TTL will reap
    // the lock within 60s anyway.
  }
}
