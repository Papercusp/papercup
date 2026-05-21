/**
 * locks:acquire — claim a set of files for exclusive editing.
 *
 * Phase 2: wait subsystem wired. The flow when `wait: { max_sec: N }`
 * is set follows the 6-step LISTEN-before-INSERT protocol from
 * su-agent-coordination-v3-2026-05-14.md §7.4 (step 4 dropped per
 * audit 4 #4):
 *
 *   1. subscribeWorkspace (LISTEN ch_coord_<wsId>) — outside any txn
 *   2. inWorkspaceTxn → tryAcquire
 *        if granted: unsubscribe; return ok
 *   3. inWorkspaceTxn → cap check + INSERT INTO agent_lock_waiters
 *        if cap exceeded: unsubscribe; return waiter_cap_exceeded
 *   4. await notification, with 30s ceiling (audit 4 #3 — silent drop
 *      detection)
 *   5. on wake: readWaiterStatus
 *        if granted: unsubscribe; return ok
 *        if waiting: GOTO 4
 *   6. on timeout: expireWaiter; unsubscribe; return busy + ticket_id
 *
 * Critical: step 1 (LISTEN) MUST happen BEFORE step 3 (INSERT).
 * Notifications are buffered by PG between LISTEN and the first wake,
 * so a grant that fires during step 3's commit is delivered when step
 * 4 starts awaiting. Reverse the order and the wakeup is lost.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readIdentity } from './identity';
import { fireNotificationsForCaller } from '../coordination/subscriptions';
import { inWorkspaceTxn } from './in-workspace-txn';
import {
  expireWaiter,
  getTxPool,
  normalizePaths,
  pokeWorkspace,
  readQueue,
  readWaiterStatus,
  tryAcquire,
  tryInsertWaiter,
  type AcquireBusy,
} from './su-lock-store';
import {
  subscribeWorkspace,
  TooManyActiveWorkspacesError,
} from './workspace-listener';

const DEFAULT_TTL_SEC = 1200;
const MAX_TTL_SEC = 3600;
const MAX_WAIT_SEC = 300;

/** Silent-drop ceiling: every iteration of the await wakes after at
 *  most this many ms so we can re-check waiter status if the LISTEN
 *  connection died without delivering. */
const WAIT_CEILING_MS = 30_000;

/** Progress event cadence during wait — surfaces live wait state
 *  (elapsed, ahead_count, busy snapshot) to the agent's progress
 *  display so it isn't blocked silently. Independent of the wake
 *  mechanism; fires regardless of why the await woke. */
const PROGRESS_TICK_MS = 10_000;

const SU_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
] as const;

interface BusyJson {
  path: string;
  /** Holder's canonical owner id (#5 — unredacted; SU is admin-tier). */
  owner: string;
  owner_label: string | null;
  intent: string;
  expires_ts: string;
}

function busyToJson(b: AcquireBusy): BusyJson {
  return {
    path: b.path,
    owner: b.owner,
    owner_label: b.owner_label,
    intent: b.intent,
    expires_ts: b.expires_ts.toISOString(),
  };
}

export default defineTool({
  name: 'locks:acquire',
  description:
    'Claim a set of files for exclusive editing. Returns ok+lock_id on success, or busy+contention details on failure. Set wait={max_sec:N} (≤300) to queue server-side until the locks free.',
  guidance: {
    when: 'Before any Edit/Write/MultiEdit of files in the operator codebase. Call once per logical edit set; release when done.',
    notWhen:
      'For read-only inspection, no claim needed. For a single trivial edit (<3 lines, contention vanishingly unlikely), the PreToolUse hook handles it — only call directly for plans/refactors touching >1 file.',
    chaining: 'On ok: edit → locks:release { lock_id }. On busy: read intent + expires_ts and decide retry/pivot/yield. With wait: blocks server-side; cancel_wait to abort.',
  },
  capability: 'locks:write',
  // Framework default per-tool timeoutSec is 60s. wait.max_sec can
  // be up to MAX_WAIT_SEC=300, so we'd be killed mid-wait at 60s.
  // Bump above MAX_WAIT_SEC with a margin for the final-busy retry
  // + unsubscribe + progress-emit work that runs after wait_until.
  timeoutSec: MAX_WAIT_SEC + 30,
  requirePrincipal: false,
  roles: [...SU_ROLES],
  args: z.object({
    paths: z.array(z.string().min(1)).min(1).max(50),
    intent: z.string().min(1).max(200),
    ttl_sec: z.number().int().positive().max(MAX_TTL_SEC).optional(),
    wait: z
      .object({
        max_sec: z.number().int().nonnegative().max(MAX_WAIT_SEC),
      })
      .optional(),
  }),
  async handler(args, ctx) {
    const { ownerId, ownerLabel, coordinationDomain } = readIdentity(ctx);

    let paths: string[];
    try {
      paths = normalizePaths(args.paths);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, error: msg }) },
        ],
      };
    }

    const ttlSec = args.ttl_sec ?? DEFAULT_TTL_SEC;
    const maxWaitSec = args.wait?.max_sec ?? 0;
    const startedAt = Date.now();

    // ── Fast path: try once, no wait ─────────────────────────────────
    const first = await inWorkspaceTxn(coordinationDomain, ownerId, async (tx) =>
      tryAcquire(tx, {
        coordinationDomain,
        owner: ownerId,
        ownerLabel,
        paths,
        intent: args.intent,
        ttlSec,
      }),
    );

    if (first.ok) {
      void fireNotificationsForCaller(ctx, first.held, 'lock_acquired').catch(
        () => {},
      );
      return ok(ownerId, ownerLabel, first.lock_id, first.expires_ts, first.held);
    }

    if (maxWaitSec === 0) {
      return busy(first.busy);
    }

    // ── Wait path ────────────────────────────────────────────────────
    // Step 1: subscribe to the workspace channel BEFORE we INSERT.
    // The listener is a bare wake-bus; we'll filter by our ticket_id
    // once we know it.
    let ticketId: string | null = null;
    let wakeResolve: (() => void) | null = null;
    // pendingWake buffers a notification that arrived BEFORE we
    // entered the await (e.g., cascade fired between readWaiterStatus
    // and the while loop). Without this, the callback would discard
    // the wake (wakeResolve is null) and we'd wait up to the 30s
    // ceiling to re-poll. Bug-#14 fix.
    let pendingWake = false;
    let unsubscribe: (() => Promise<void>) | null = null;
    let progressTimer: ReturnType<typeof setInterval> | null = null;

    // Capture ctx.progress safely — UnifiedToolContext exposes it
    // when the transport supports streaming; older shapes / shim
    // callers may not have it.
    const emitProgress = (ctx as { progress?: (pct: number | undefined, msg?: string) => void }).progress
      ?? (() => undefined);

    try {
      try {
        unsubscribe = await subscribeWorkspace(coordinationDomain, (tid /* ignored kind */) => {
          if (ticketId && tid === ticketId) {
            pendingWake = true;
            if (wakeResolve) {
              const r = wakeResolve;
              wakeResolve = null;
              r();
            }
          }
        });
      } catch (err: unknown) {
        if (err instanceof TooManyActiveWorkspacesError) {
          return tooManyWorkspaces(first.busy);
        }
        throw err;
      }

      // Step 2: already attempted above (first try). It returned busy,
      // so proceed to INSERT.

      // Step 3: INSERT INTO agent_lock_waiters.
      const inserted = await inWorkspaceTxn(coordinationDomain, ownerId, async (tx) =>
        tryInsertWaiter(tx, {
          coordinationDomain,
          owner: ownerId,
          ownerLabel,
          paths,
          intent: args.intent,
          ttlSec,
          maxWaitSec,
        }),
      );

      if (!inserted.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: false, reason: inserted.reason, busy: first.busy.map(busyToJson) }),
            },
          ],
        };
      }

      // Self-grant — the path freed between our first busy-return and
      // tryInsertWaiter's pre-insert acquire attempt. No waiter was
      // queued; we already hold the lock.
      if ('self_granted' in inserted) {
        void fireNotificationsForCaller(
          ctx,
          inserted.held,
          'lock_acquired',
        ).catch(() => {});
        return ok(ownerId, ownerLabel, 
          inserted.lock_id,
          inserted.expires_ts,
          inserted.held,
          Math.floor((Date.now() - startedAt) / 1000),
        );
      }

      ticketId = inserted.ticket_id;
      const waitUntilMs = inserted.wait_until.getTime();

      // Phase 2 polish: 10s progress heartbeat with elapsed +
      // ahead_count + busy snapshot. Independent of the wake mechanism
      // so the agent sees liveness even when nothing has moved.
      const emitProgressTick = async () => {
        try {
          const sql = getTxPool();
          const q = await readQueue(sql, { coordinationDomain, paths });
          const mine = ticketId
            ? q.waiting.find((w) => w.ticket_id === ticketId)
            : undefined;
          const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
          emitProgress(
            undefined,
            JSON.stringify({
              phase: 'waiting',
              ticket_id: ticketId,
              elapsed_sec: elapsedSec,
              ahead_count: mine?.ahead_count ?? null,
              busy: q.active_locks
                .filter((l) => paths.includes(l.path))
                .map((l) => ({
                  path: l.path,
                  owner_label: l.owner_label,
                  intent: l.intent,
                  expires_ts: l.expires_ts.toISOString(),
                })),
            }),
          );
        } catch {
          // Best-effort — progress events should never break the wait.
        }
      };
      progressTimer = setInterval(() => {
        void emitProgressTick();
      }, PROGRESS_TICK_MS);
      // Emit one immediately so the agent sees state before the first
      // 10s tick fires.
      void emitProgressTick();

      // Re-check status immediately — a grant cascade could have fired
      // between our LISTEN+INSERT and now.
      const sqlPool = getTxPool();
      {
        const status = await readWaiterStatus(sqlPool, ticketId);
        if (status.status === 'granted' && status.granted_lock_id) {
          return ok(ownerId, ownerLabel, 
            status.granted_lock_id,
            status.granted_expires_ts ?? new Date(Date.now() + ttlSec * 1000),
            status.paths ?? paths,
            Math.floor((Date.now() - startedAt) / 1000),
          );
        }
      }

      // Step 4-5: await loop with 30s ceiling.
      while (Date.now() < waitUntilMs) {
        // If a notification arrived BEFORE we got here (race between
        // readWaiterStatus and the await), short-circuit the wait and
        // re-read status. Bug-#14 fix.
        if (pendingWake) {
          pendingWake = false;
        } else {
          const remaining = waitUntilMs - Date.now();
          const ceiling = Math.min(remaining, WAIT_CEILING_MS);
          let ceilingTimer: ReturnType<typeof setTimeout> | null = null;
          await new Promise<void>((resolve) => {
            wakeResolve = resolve;
            ceilingTimer = setTimeout(() => {
              // Ceiling fired — fall through to re-poll.
              if (wakeResolve) {
                const r = wakeResolve;
                wakeResolve = null;
                r();
              }
            }, ceiling);
          });
          // Clear the ceiling timer in case the LISTEN wake fired first;
          // without this, a stale timer from iteration N could fire
          // during iteration N+1's await and trigger a spurious wake.
          if (ceilingTimer !== null) clearTimeout(ceilingTimer);
          wakeResolve = null;
        }

        // Bug-#13 fix: nudge the workspace before reading status.
        // If a holder's lock expired without an explicit release (TTL
        // lapse), nothing else in PG fires the cascade. The poke runs
        // the janitor + cascade for our workspace; if we should now
        // be granted, the status read below picks that up.
        await inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
          pokeWorkspace(tx, coordinationDomain),
        );

        const status = await readWaiterStatus(sqlPool, ticketId);
        if (status.status === 'granted' && status.granted_lock_id) {
          return ok(ownerId, ownerLabel, 
            status.granted_lock_id,
            status.granted_expires_ts ?? new Date(Date.now() + ttlSec * 1000),
            status.paths ?? paths,
            Math.floor((Date.now() - startedAt) / 1000),
          );
        }
        if (status.status === 'cancelled' || status.status === 'expired') {
          // External cancel or DB-side expiry; bail.
          break;
        }
        // status === 'waiting' → loop back, await again.
      }

      // Step 6: timeout — mark expired and return busy snapshot.
      await inWorkspaceTxn(coordinationDomain, ownerId, async (tx) => {
        if (ticketId) await expireWaiter(tx, ticketId);
      });

      // Re-read the current busy snapshot (may differ from the initial
      // first.busy if some paths freed but others didn't).
      const finalBusy = await inWorkspaceTxn(coordinationDomain, ownerId, async (tx) => {
        const r = await tryAcquire(tx, {
          coordinationDomain,
          owner: ownerId,
          ownerLabel,
          paths,
          intent: args.intent,
          ttlSec,
        });
        if (r.ok) {
          // Lucky race — got it after timeout fired but before re-read.
          return { won: true as const, lockId: r.lock_id, expires: r.expires_ts, held: r.held };
        }
        return { won: false as const, busy: r.busy };
      });

      if (finalBusy.won) {
        void fireNotificationsForCaller(
          ctx,
          finalBusy.held,
          'lock_acquired',
        ).catch(() => {});
        return ok(ownerId, ownerLabel, 
          finalBusy.lockId,
          finalBusy.expires,
          finalBusy.held,
          Math.floor((Date.now() - startedAt) / 1000),
        );
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              busy: finalBusy.busy.map(busyToJson),
              ticket_id: ticketId,
            }),
          },
        ],
      };
    } finally {
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
      }
      if (unsubscribe) {
        await unsubscribe().catch(() => undefined);
      }
    }
  },
});

function ok(
  owner: string,
  ownerLabel: string,
  lockId: string,
  expires: Date,
  held: string[],
  waitedSec?: number,
) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          lock_id: lockId,
          // #5 — echo the server-resolved owner so the caller can
          // verify which identity the lock was taken under.
          owner,
          owner_label: ownerLabel,
          expires_ts: expires.toISOString(),
          held,
          ...(waitedSec !== undefined ? { waited_sec: waitedSec } : {}),
        }),
      },
    ],
  };
}

function busy(busyRows: AcquireBusy[]) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify({ ok: false, busy: busyRows.map(busyToJson) }) },
    ],
  };
}

function tooManyWorkspaces(busyRows: AcquireBusy[]) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          ok: false,
          reason: 'too_many_active_workspaces',
          busy: busyRows.map(busyToJson),
        }),
      },
    ],
  };
}
