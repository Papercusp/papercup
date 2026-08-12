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
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { readFileLockIdentity } from './identity';
import { enrichBusy } from './enrich-busy';
import { inWorkspaceTxn, WorkspaceContendedError } from './in-workspace-txn';
import { acquireWithContentionRetry } from './contention-retry';
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
import { ensureGrantListener, lockGrantKey } from './lock-grant-bridge';
import { captureWakeHandleForOwner } from '../../events/await/handle';
import { registerAwait } from '../../events/await/store';
import { startAwaitSweeper } from '../../events/await/engine';
import { resolveAgentIdentity } from '../coordination/identity';
import { recordEditAttribution } from '../../edit-attribution';
import { routeFileLockOp } from '../../authority/file-lock-routing';
import {
  noteShaTokenGrant,
  shaTokenForGrant,
  type ShaTokenGrant,
} from '../../authority/sha-token-registry';
import {
  FILE_LOCK_OP_KINDS,
  emitAcquireLockEvents,
  type FileLockAcquireParams,
  type FileLockAcquireResult,
} from '../../authority/file-lock-authority-ops';
import { recordLockEvent } from '../../authority/lock-event-stream';

import { DEFAULT_LOCK_TTL_SEC as DEFAULT_TTL_SEC, MAX_LOCK_TTL_SEC as MAX_TTL_SEC, MAX_LOCK_WAIT_SEC as MAX_WAIT_SEC } from './lock-config';
import { hardText, LIMITS } from '../limits';
import { externalHomePathToLockKey } from './external-path';
import { resolveExplicitFileLockDomain } from './coordination-domain';
import { isTransientPgConnectionError } from '../../host-benign-errors';

/** wake_on_grant queue window (await-event-primitive D-005): how long a
 *  SLEEPING waiter's ticket stays grant-eligible. Much longer than the 300s
 *  blocking cap — the agent isn't holding a turn. A grant to an agent that
 *  never wakes is bounded by the lock TTL (the lease backstop, D-004 #3). */
const WAKE_QUEUE_WINDOW_SEC = Number(process.env.PAPERCUSP_LOCK_WAKE_QUEUE_SEC ?? 1800);

/** Silent-drop ceiling: every iteration of the await wakes after at
 *  most this many ms so we can re-check waiter status if the LISTEN
 *  connection died without delivering. */
const WAIT_CEILING_MS = 30_000;

/** Progress event cadence during wait — surfaces live wait state
 *  (elapsed, ahead_count, busy snapshot) to the agent's progress
 *  display so it isn't blocked silently. Independent of the wake
 *  mechanism; fires regardless of why the await woke. */
const PROGRESS_TICK_MS = 10_000;

export default defineTool({
  name: 'locks:acquire',
  description:
    'Claim repository files and/or authorized home-directory configuration files for exclusive editing. Returns ok+lock_id, or busy+contention details. Pass repo-relative POSIX `paths`; pass absolute files below your home via `external_paths` (mapped to the same reserved keys the edit hooks use). On contention prefer wake_on_grant:true — queue a waiter + one-shot wake, return immediately; END YOUR TURN, re-invoked on grant (no polling, no held turn).',
  guidance: {
    when: 'For a DELIBERATE multi-file claim held across several edits AND the commit — acquire once, release after committing. Before individual Codex writes only when that session lacks lock hooks; managed Codex/Claude/OMP homes hook apply_patch/Edit/Write automatically.',
    notWhen:
      'Read-only inspection needs no claim. A single incidental edit in a hooked session needs no manual call — do NOT wrap every hooked edit in acquire/release. Explicit locks are the fallback for unhooked Codex.',
    chaining:
      'On ok: edit → commit → locks:release { lock_id }. If the edit is still uncommitted, omit published_sha; pass published_sha only when you have actually published a lowercase 40–64-character hexadecimal commit SHA. On busy: wake_on_grant:true → end your turn; the wake carries your lock_id + running TTL — edit, then release. Only block (wait) when you need the lock THIS turn and the holder is about to finish; events:cancel + locks:cancel_wait retracts a queued wake.',
    seeAlso: [
      'locks:acquire_granular (a directory/subtree, not a single file set)',
      'locks:acquire_resource (a named shared resource — dev server, db schema)',
      'locks:release (drop the lock after committing)',
    ],
  },
  capability: 'locks:write',
  // Framework default per-tool timeoutSec is 60s. wait.max_sec can
  // be up to MAX_WAIT_SEC (the lock-config cap), so we'd be killed mid-wait at 60s.
  // Bump above MAX_WAIT_SEC with a margin for the final-busy retry
  // + unsubscribe + progress-emit work that runs after wait_until.
  timeoutSec: MAX_WAIT_SEC + 30,
  requirePrincipal: false,
  // EI-20189550491880126: the handler never reads ctx.tx. It performs its own
  // inWorkspaceTxn work and may await authority/listener paths, so retaining
  // the host ambient workspace transaction would pin an org-app pool slot for
  // the whole acquire and make unrelated lock calls time out under fleet load.
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    paths: z.array(z.string().min(1)).max(50).optional().describe('repo-relative POSIX file paths (no ./, .., backslashes, or absolute paths)'),
    coordination_domain: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe(
        'absolute canonical repository checkout root (not a harness/workspace slug) supplied by a client edit hook when its operator checkout differs from the edited tree, e.g. /workspace/papercusp',
      ),
    external_paths: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe('absolute configuration-file paths below the current user home; mapped to @external/home/* lock keys shared with automatic edit hooks'),
    intent: hardText(LIMITS.SHORT_TITLE),
    ttl_sec: z.number().int().positive().max(MAX_TTL_SEC).optional(),
    wait: z
      .object({
        max_sec: z
          .number()
          .int()
          .nonnegative()
          .describe(
            `Blocking same-turn wait in seconds. A value above ${MAX_WAIT_SEC} is CLAMPED to ${MAX_WAIT_SEC} (not rejected) — the turn cannot block longer than the tool's own timeout. For a longer wait, end your turn with wake_on_grant:true instead.`,
          ),
      })
      .optional(),
    wake_on_grant: z
      .boolean()
      .optional()
      .describe(
        'On contention: queue a waiter ticket + a one-shot wake subscription and return IMMEDIATELY (no held turn). End your turn; when the grant cascade reaches your ticket you are re-invoked with the lock_id (TTL running). Takes precedence over wait.',
      ),
    pending_edit: z
      .object({
        file: z.string().min(1).describe('The single repo-relative path to edit — MUST equal paths[0].'),
        old_string: z.string().min(1).describe('Exact text to replace — must occur EXACTLY ONCE in the current file.'),
        new_string: z.string().describe('Replacement text.'),
      })
      .optional()
      .describe(
        'APPLY-ON-GRANT: attach the concrete edit you were going to make (the Edit-tool contract). Requires wake_on_grant + a single-file claim (paths must be exactly [pending_edit.file]). On grant the server applies it iff old_string still matches exactly once, then notifies you PASSIVELY (no wake). If the holder changed that region it is NOT applied and you are woken to redo it — i.e. it degrades to plain wake_on_grant. Best for a small, provably-non-conflicting edit to a high-contention shared file. SINGLE HUNK ONLY (EI-11057): if your real change needs a COMPANION hunk elsewhere in the SAME file (e.g. adding an import alongside a new call site, or a decl+every-ref rename), do NOT use pending_edit for just one half — an apply-on-grant that lands only the body hunk while a needed import/decl is missing ships a compile-broken file to the shared tree. For a multi-hunk edit, skip pending_edit and use a plain `wake_on_grant:true` (no pending_edit) so you land ALL hunks together after the grant.',
      ),
  }).superRefine((args, ctx) => {
    const total = (args.paths?.length ?? 0) + (args.external_paths?.length ?? 0);
    if (total === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'pass at least one repo-relative `paths` entry or absolute home `external_paths` entry' });
    if (total > 50) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'at most 50 total paths may be acquired in one call' });
    if (args.pending_edit && (args.external_paths?.length ?? 0) > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pending_edit'], message: 'pending_edit supports repository paths only; edit external files after the lock grant' });
    }
  }),
  async handler(args, ctx) {
    const { ownerId, ownerLabel, coordinationDomain: defaultCoordinationDomain } = readFileLockIdentity(ctx);
    let coordinationDomain: string;
    try {
      coordinationDomain = resolveExplicitFileLockDomain(args.coordination_domain, defaultCoordinationDomain);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }

    let paths: string[];
    try {
      paths = normalizePaths([
        ...(args.paths ?? []),
        ...(args.external_paths ?? []).map((path) => externalHomePathToLockKey(path)),
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, error: msg }) },
        ],
      };
    }

    const ttlSec = args.ttl_sec ?? DEFAULT_TTL_SEC;
    // Caller-DX (watchdog P-006): an over-cap wait is CLAMPED to MAX_WAIT_SEC,
    // not zod-rejected. The 300s ceiling is a hard constraint (the tool is
    // killed at MAX_WAIT_SEC+30); a longer wait belongs to wake_on_grant. Agents
    // repeatedly bounced off the old `.max(300)` rejection — clamp + advise.
    const requestedWaitSec = args.wait?.max_sec ?? 0;
    const waitClamped = requestedWaitSec > MAX_WAIT_SEC;
    const maxWaitSec = waitClamped ? MAX_WAIT_SEC : requestedWaitSec;
    const startedAt = Date.now();

    // ── pending_edit guardrails (EI-9033) ───────────────────────────
    // Apply-on-grant is single-file + wake-only by construction. Validate the
    // shape up front so a malformed request fails loudly here rather than
    // silently queueing a waiter whose edit can never satisfy the guardrail.
    let pendingEdit: { file: string; old_string: string; new_string: string } | undefined;
    if (args.pending_edit) {
      if (!args.wake_on_grant) {
        return errorResult('pending_edit requires wake_on_grant:true (apply-on-grant runs on the wake queue, not a blocking wait).');
      }
      let editFile: string;
      try {
        editFile = normalizePaths([args.pending_edit.file])[0];
      } catch (err: unknown) {
        return errorResult(`pending_edit.file invalid: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (paths.length !== 1 || paths[0] !== editFile) {
        return errorResult('pending_edit is single-file only: paths must be exactly [pending_edit.file].');
      }
      pendingEdit = {
        file: editFile,
        old_string: args.pending_edit.old_string,
        new_string: args.pending_edit.new_string,
      };
    }

    // ── Fast path: try once, no wait ─────────────────────────────────
    // fed-reanchor-2026-06-06 P-060 (cutover 2): route the acquire DECISION through the
    // file-lock authority. On a single box (no remote peers) routeFileLockOp's cached
    // fast-path runs `op.local()` directly — byte-identical to the pre-cutover path.
    // Cross-machine, the elected Hive authority serializes the acquire (one winner across
    // Swarms editing the same physical repo). DEFENSIVE: any fault in the routing layer
    // degrades to the raw local acquire, so the worst case on the fleet's hot per-edit
    // path is exactly today's behavior. The WAIT / wake_on_grant queue below stays local
    // (cross-machine waiter coherence is a documented further step).
    const localAcquire = (): Promise<Awaited<ReturnType<typeof tryAcquire>>> =>
      inWorkspaceTxn(coordinationDomain, ownerId, async (tx) =>
        tryAcquire(tx, {
          coordinationDomain,
          owner: ownerId,
          ownerLabel,
          paths,
          intent: args.intent,
          ttlSec,
          automatic: args.intent.startsWith('PreToolUse:'),
        }),
        { paths },
      );

    let first: Awaited<ReturnType<typeof tryAcquire>> & { sha_token?: ShaTokenGrant };
    // P-015 (WI-1550): when the grant is decided LOCALLY (we are the authority, or
    // fail-open/no-peers) rather than relayed to a remote authority, this peer must
    // append the lock-event itself — a remote authority already records its own
    // grants inside buildFileLockAuthorityHandlers, so only the local/fail-open vias
    // need it here. `routedScope` is the resolved harness/hive scope key (unset for
    // an unmanaged domain, where there's no federated stream to append to anyway).
    let emitScope: string | undefined;
    try {
      // EI-13189: retry a TRANSIENT per-workspace advisory-lock timeout (pg
      // 57014/55P03 — WorkspaceContendedError) before surfacing it to the caller.
      // This is the SAME `acquireWithContentionRetry` backoff the PreToolUse
      // per-edit hook (file-lock-guard.ts) and git-sync already ride out under
      // load; the explicit `locks:acquire` MCP tool never had it wired in, so a
      // background-sync contention dip on a busy workspace produced a
      // user-visible `workspace_contended` failure with an UNKNOWN holder —
      // exactly the routine-background-sync symptom this item reported.
      const routed = await acquireWithContentionRetry(() =>
        routeFileLockOp<Awaited<ReturnType<typeof tryAcquire>> & { sha_token?: ShaTokenGrant }>(
          coordinationDomain,
          {
            local: localAcquire,
            remote: {
              kind: FILE_LOCK_OP_KINDS.acquire,
              payload: {
                owner: ownerId,
                ownerLabel,
                paths,
                intent: args.intent,
                ttlSec,
                automatic: args.intent.startsWith('PreToolUse:'),
                coordinationDomain,
              } satisfies FileLockAcquireParams,
              decode: (raw) => decodeRemoteAcquire(raw, paths, ttlSec),
            },
          },
        ),
      );
      first = routed.value;
      if (routed.via !== 'remote-authority') emitScope = routed.scope;
    } catch (err) {
      // Same-workspace contention outlasted the retries above (P-015): surface a
      // structured result rather than leaking a raw PG error to the agent.
      // EI-9478: this is NOT "held by another agent" — no holder is enumerable
      // because we never got the per-workspace serialization lock (often the
      // caller's OWN parallel edit, or a starved pool). A bare `busy: []` made
      // the edit hook fabricate a foreign-holder denial; return an explicit
      // transient reason instead so callers retry rather than queue a wake.
      if (err instanceof WorkspaceContendedError) return workspaceContended();
      // Defensive fallback: a fault in the authority-routing layer must never break the
      // live per-edit lock path — degrade to the raw local acquire (pre-cutover behavior),
      // itself contention-retried for the same reason as the primary path above.
      // (The routing layer faulted before resolving a scope, so this rare recovery path
      // doesn't emit a lock-event — best-effort capture, never worth failing the acquire.)
      try {
        first = await acquireWithContentionRetry(localAcquire);
      } catch (err2) {
        if (err2 instanceof WorkspaceContendedError) return workspaceContended();
        throw err2;
      }
    }

    if (first.ok) {
      // P-001 (deterministic-commit-workitem-attribution-2026-06-22): capture this edit's
      // attribution AT EDIT TIME (D-002) — fire-and-forget, best-effort; NEVER affects the
      // lock or the hot path (D-006: deterministic, no LLM; the work-item is read from the
      // claim the agent ALREADY holds). git-sync reads this ledger window to attribute its
      // per-agent commits (P-003).
      const attrId = resolveAgentIdentity(ctx);
      void recordEditAttribution({
        repoRoot: coordinationDomain,
        files: first.held ?? paths,
        agentId: ownerId,
        intent: args.intent,
        workspaceId: attrId.workspaceId ?? undefined,
        contributor: attrId.userId ?? undefined,
      });
      // Notify firehose removed at the source (D-002, fleet-coordination-painpoints):
      // lock_acquired had no push-consumer — an agent learns contention on its own acquire.
      //
      // G-0 (P-033) sha-token stamp: a remote-authority grant carries the
      // authority's token (sha_token via decodeRemoteAcquire); a local /
      // fail-open grant computes it from the local registry. Recorded AFTER
      // computing so this grant doesn't shadow the prior holder's state. The
      // wait/wake_on_grant queue grants below stay unstamped — that queue is
      // the documented machine-local residual.
      const held = first.held ?? paths;
      // WI-1549: pass `ownerId` so a holder re-acquiring its OWN
      // expired-but-unreleased grant isn't misreported as unsynced risk.
      const shaToken = first.sha_token ?? shaTokenForGrant(coordinationDomain, held, Date.now(), ownerId);
      noteShaTokenGrant(coordinationDomain, held, ownerId, first.expires_ts.getTime());
      // WI-1550 (P-015): append the instant-handover lock-event for a LOCALLY-decided
      // grant (see the emitScope comment above). No-ops when this scope isn't federating
      // (the installed sink degrades to a no-op) — always safe to call.
      if (emitScope) {
        emitAcquireLockEvents((event) => void recordLockEvent(event), {
          scope: emitScope,
          owner: ownerId,
          paths: held,
          expiresAtMs: first.expires_ts.getTime(),
          ts: Date.now(),
        });
      }
      return ok(
        ownerId,
        ownerLabel,
        first.lock_id,
        first.expires_ts,
        first.held,
        undefined,
        shaToken,
        first.newly_held,
      );
    }

    // ── wake_on_grant: queue + sleep instead of block/poll ──────────────
    // (await-event-primitive-2026-06-05 D-005/P-008.) Insert a long-window
    // waiter ticket + a one-shot wake await on its grant key, return NOW.
    // The grant cascade stays single-grant control-plane; the bridge turns
    // the grant NOTIFY (or the sweep's waiter-truth read) into the wake.
    if (args.wake_on_grant) {
      startAwaitSweeper();
      const inserted = await inWorkspaceTxn(coordinationDomain, ownerId, async (tx) =>
        tryInsertWaiter(tx, {
          coordinationDomain,
          owner: ownerId,
          ownerLabel,
          paths,
          intent: args.intent,
          ttlSec,
          maxWaitSec: WAKE_QUEUE_WINDOW_SEC,
          pendingEdit,
        }),
        { paths },
      );
      if (!inserted.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: false, reason: inserted.reason, busy: await enrichBusy(first.busy, { ownerId }) }),
            },
          ],
        };
      }
      if ('self_granted' in inserted) {
        return ok(ownerId, ownerLabel, inserted.lock_id, inserted.expires_ts, inserted.held);
      }

      const identity = resolveAgentIdentity(ctx);
      const { handle, note: handleNote } = await captureWakeHandleForOwner(ownerId);
      const awaitRow = await registerAwait({
        subscriberId: ownerId,
        eventKey: lockGrantKey(inserted.ticket_id),
        policy: 'wake',
        note: `lock wait: ${paths.join(', ')} — ${args.intent}`,
        wakeHandle: handle,
        // The bridge fires the key on ANY terminal ticket state, so the await
        // timeout is only the backstop behind the backstop.
        timeoutBehavior: 'wake',
        timeoutSec: WAKE_QUEUE_WINDOW_SEC + 120,
      });
      // NOTIFY fast path (best-effort; the sweep reconciler is load-bearing).
      await ensureGrantListener(coordinationDomain, identity.workspaceId ?? undefined);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              queued_for_wake: true,
              ...(pendingEdit ? { apply_on_grant: true } : {}),
              ticket_id: inserted.ticket_id,
              await_id: awaitRow.id,
              queue_window_sec: WAKE_QUEUE_WINDOW_SEC,
              wake_handle: handleNote,
              busy: await enrichBusy(first.busy, { ownerId }),
              advice: pendingEdit
                ? `Queued WITH your edit attached (apply-on-grant). END YOUR TURN. On grant the server applies your edit to ${pendingEdit.file} iff old_string still matches exactly once, then drops a PASSIVE inbox note (category lock-edit-applied) — you are NOT woken and the lock is released for you. Only if the region changed under the holder are you woken (granted:true) to redo it. Retract with locks:cancel_wait + events:cancel.`
                : 'Queued. END YOUR TURN — you will be re-invoked when the grant cascade reaches your ticket (the wake carries lock_id + TTL, already running: edit, then locks:release). If the window lapses without a grant you are woken with granted:false. Retract with locks:cancel_wait + events:cancel.',
            }),
          },
        ],
      };
    }

    if (maxWaitSec === 0) {
      return await busy(first.busy);
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
    let progressTimer: ManagedHandle | null = null;

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
          return await tooManyWorkspaces(first.busy);
        }
        throw err;
      }

      // Step 2: already attempted above (first try). It returned busy,
      // so proceed to INSERT.

      // Step 3: INSERT INTO agent_lock_waiters.
      //
      // EI-19382183884861720: same transient-connection exposure class as
      // EI-19324204900062056 below (a pgbouncer transaction-pool reclaim
      // mid-flight rejects the in-flight query with CONNECTION_CLOSED,
      // which postgres-js only recovers from on the NEXT query) — but here
      // it fires on the FIRST write of the wait path, before any ticket
      // exists, which matches the reproduced symptom (`locks:acquire` with
      // a blocking `wait` dying immediately, not after minutes of polling).
      // Nothing has committed yet (the connection dropped before/during the
      // transaction, so PG rolled it back), so a single clean retry on
      // postgres-js's auto-reconnected pool is safe — unlike the read-path
      // fix below, there is no partial ticket state to reconcile.
      const insertOnce = () =>
        inWorkspaceTxn(coordinationDomain, ownerId, async (tx) =>
          tryInsertWaiter(tx, {
            coordinationDomain,
            owner: ownerId,
            ownerLabel,
            paths,
            intent: args.intent,
            ttlSec,
            maxWaitSec,
          }),
          { paths },
        );
      let inserted: Awaited<ReturnType<typeof insertOnce>>;
      try {
        inserted = await insertOnce();
      } catch (err: unknown) {
        if (!isTransientPgConnectionError(err)) throw err;
        inserted = await insertOnce();
      }

      if (!inserted.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: false, reason: inserted.reason, busy: await enrichBusy(first.busy, { ownerId }) }),
            },
          ],
        };
      }

      // Self-grant — the path freed between our first busy-return and
      // tryInsertWaiter's pre-insert acquire attempt. No waiter was
      // queued; we already hold the lock.
      if ('self_granted' in inserted) {
        // notify firehose removed at the source (D-002)
        return ok(ownerId, ownerLabel,
          inserted.lock_id,
          inserted.expires_ts,
          inserted.held,
          Math.floor((Date.now() - startedAt) / 1000),
        );
      }

      ticketId = inserted.ticket_id;
      const waitUntilMs = inserted.wait_until.getTime();
      // EI-19921385348146413: readWaiterStatus's status union has FIVE arms
      // ('waiting' | 'granted' | 'expired' | 'cancelled' | 'missing'), but only
      // 'cancelled'/'expired' were treated as terminal below — 'missing' (the
      // waiter row itself vanished: janitor sweep, external DELETE, workspace
      // teardown) fell into the same bucket as 'waiting' and spun to the full
      // wait.max_sec deadline polling a row that no longer exists. Track WHY we
      // bail so the final response can name the real cause instead of folding
      // every non-grant outcome into an undifferentiated timeout/busy snapshot.
      let terminalReason: 'cancelled' | 'expired' | 'waiter_vanished' | undefined;

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
      progressTimer = managedSetInterval('lock-wait-progress', PROGRESS_TICK_MS, () => {
        void emitProgressTick();
      }, { category: 'lifecycle', instanced: true });
      // Emit one immediately so the agent sees state before the first
      // 10s tick fires.
      void emitProgressTick();

      // Re-check status immediately — a grant cascade could have fired
      // between our LISTEN+INSERT and now.
      //
      // EI-19382183884861720: this is the ONE `readWaiterStatus`/pooled-
      // connection call in the wait path EI-19324204900062056's transient-
      // connection treatment did not reach — it runs BEFORE the step 4-5
      // loop that fix protects, on the exact same `sqlPool`, so a pgbouncer
      // transaction-pool reclaim here threw CONNECTION_CLOSED straight out
      // of the tool handler (an opaque MCP -32603) rather than degrading
      // like every other query on this connection already does. This is
      // the most likely site for the reported "dies... immediately"
      // symptom, since it fires right after step 3's INSERT, before any
      // loop iteration has run. Treat it identically to the loop's own
      // handling below: skip this one check and fall through into the
      // step 4-5 loop, which re-polls on postgres-js's auto-reconnected
      // pool — the outer `waitUntilMs` bound still governs.
      const sqlPool = getTxPool();
      try {
        const status = await readWaiterStatus(sqlPool, ticketId);
        if (status.status === 'granted' && status.granted_lock_id) {
          return ok(ownerId, ownerLabel,
            status.granted_lock_id,
            status.granted_expires_ts ?? new Date(Date.now() + ttlSec * 1000),
            status.paths ?? paths,
            Math.floor((Date.now() - startedAt) / 1000),
          );
        }
      } catch (err: unknown) {
        if (!isTransientPgConnectionError(err)) throw err;
        // Transient connection blip — fall through to the step 4-5 loop
        // below, which re-polls on the reconnected pool.
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
        //
        // EI-19324204900062056: a long blocking wait can outlive a
        // server-side connection (pgbouncer's transaction-pooling
        // reclaim, or a PG-server-side reset) — postgres-js's pool
        // reconnects transparently on the NEXT query, but the query
        // IN FLIGHT when the connection dropped rejects with
        // CONNECTION_CLOSED/CONNECT_TIMEOUT (the same transient class
        // pg-transient-retry.ts + host-benign-errors.ts already
        // classify as self-healing elsewhere). Previously that raw
        // rejection propagated out of the tool handler and killed the
        // whole call with an opaque MCP -32603, indistinguishable at
        // the call site from a dead operator/datastore. Treat it the
        // same as a silent notification drop: skip this tick, loop
        // back and re-poll on the reconnected pool — the outer
        // `waitUntilMs` bound still governs, so this cannot spin
        // forever, and a genuinely non-transient error still rethrows.
        try {
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
          if (
            status.status === 'cancelled' ||
            status.status === 'expired' ||
            status.status === 'missing'
          ) {
            // External cancel, DB-side expiry, or the waiter row itself vanished
            // (EI-19921385348146413) — all three are TERMINAL, not transient, so
            // bail immediately instead of polling to the full deadline.
            terminalReason = status.status === 'missing' ? 'waiter_vanished' : status.status;
            break;
          }
          // status === 'waiting' → loop back, await again.
        } catch (err: unknown) {
          if (!isTransientPgConnectionError(err)) throw err;
          // Transient connection blip mid-wait — the next iteration's
          // queries run on postgres-js's auto-reconnected pool.
        }
      }

      // Step 6: timeout — mark expired and return busy snapshot.
      //
      // EI-19324204900062056: this is the SAME transient-connection
      // exposure as the poll loop above, on the tail end where a wait
      // legitimately ran to its own deadline. Degrade to a structured
      // "can't confirm final state" response instead of crashing the
      // call — the caller still has ticket_id and can retry with
      // wake_on_grant:true (which does not hold the turn/connection
      // open and so isn't exposed to this class at all).
      try {
        await inWorkspaceTxn(coordinationDomain, ownerId, async (tx) => {
          if (ticketId) await expireWaiter(tx, ticketId);
        });
      } catch (err: unknown) {
        if (!isTransientPgConnectionError(err)) throw err;
        return waitConnectionUnstable(ticketId);
      }

      // Re-read the current busy snapshot (may differ from the initial
      // first.busy if some paths freed but others didn't).
      let finalBusy: { won: true; lockId: string; expires: Date; held: string[] } | { won: false; busy: AcquireBusy[] };
      try {
        finalBusy = await inWorkspaceTxn(coordinationDomain, ownerId, async (tx) => {
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
        }, { paths });
      } catch (err: unknown) {
        if (!isTransientPgConnectionError(err)) throw err;
        return waitConnectionUnstable(ticketId);
      }

      if (finalBusy.won) {
        // notify firehose removed at the source (D-002)
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
              busy: await enrichBusy(finalBusy.busy),
              ticket_id: ticketId,
              // EI-19921385348146413: name the real terminal cause instead of an
              // undifferentiated busy/timeout snapshot. Absent ⇒ genuine wait.max_sec
              // timeout (the loop condition ran out, not a status-driven break).
              ...(terminalReason
                ? {
                    reason: terminalReason,
                    ...(terminalReason === 'waiter_vanished'
                      ? {
                          reason_detail:
                            'the waiter row disappeared mid-wait (janitor sweep, external DELETE, or workspace teardown) — nothing could ever have granted this ticket; retry acquire from scratch',
                        }
                      : {}),
                  }
                : { reason: 'timeout' }),
              ...(waitClamped
                ? {
                    wait_clamped: {
                      requested_sec: requestedWaitSec,
                      capped_sec: MAX_WAIT_SEC,
                      advice:
                        'wait was capped at 300s (the blocking ceiling). For a longer wait, retry with wake_on_grant:true and END YOUR TURN — you are re-invoked when the grant cascade reaches your ticket.',
                    },
                  }
                : {}),
            }),
          },
        ],
      };
    } finally {
      if (progressTimer) {
        progressTimer.stop();
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
  // G-0 (P-033): the sha-token stamp — requiredSha = the prior holder's
  // published head (build on it; check ancestry vs local staging via the
  // hive-git grade helpers), unsyncedRisk = the prior grant expired without a
  // release. Present on fast-path grants of hive-scoped file locks.
  shaToken?: ShaTokenGrant,
  newlyHeld?: string[],
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
          ...(newlyHeld !== undefined ? { newly_held: newlyHeld } : {}),
          ...(waitedSec !== undefined ? { waited_sec: waitedSec } : {}),
          ...(shaToken
            ? { sha_token: { required_sha: shaToken.requiredSha, unsynced_risk: shaToken.unsyncedRisk } }
            : {}),
        }),
      },
    ],
  };
}

function errorResult(error: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
  };
}

/** EI-9478: the advisory-lock wait timed out before the service could identify
 * a holder. Distinct `reason` plus an explicit unknown holder keeps readers
 * from rendering the timeout as either a foreign hold or proof of no hold. */
function workspaceContended() {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          ok: false,
          reason: 'workspace_contended',
          transient: true,
          holder: 'unknown',
          busy: [],
          advice:
            'The lock service could not serialize this call in time (advisory-lock timeout). Holder identity is unknown; this does not prove the requested files are unheld. Do NOT queue wake_on_grant for this timeout because no waiter ticket was returned; retry the operation with backoff or inspect the lock-service state.',
        }),
      },
    ],
  };
}

/** EI-19324204900062056: a blocking wait's DB connection dropped (pgbouncer
 * transaction-pooling reclaim / a PG-server-side reset) and did not
 * reconnect in time to confirm the final state. Distinct, structured
 * `reason` — never a thrown/opaque MCP error — so the caller can tell this
 * apart from "held by another agent" and retry via wake_on_grant (which
 * doesn't hold a connection open across the wait, so isn't exposed to this
 * class). The ticket may still be granted server-side later; wake_on_grant
 * picks that up. */
function waitConnectionUnstable(ticketId: string | null) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          ok: false,
          reason: 'wait_connection_unstable',
          transient: true,
          ticket_id: ticketId,
          busy: [],
          advice:
            'The lock service could not confirm the final wait state (a transient DB connection blip outlived the blocking wait). No holder is confirmed to block you. Retry with wake_on_grant:true and END YOUR TURN instead of a long blocking wait.',
        }),
      },
    ],
  };
}

async function busy(busyRows: AcquireBusy[]) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify({ ok: false, busy: await enrichBusy(busyRows) }) },
    ],
  };
}

async function tooManyWorkspaces(busyRows: AcquireBusy[]) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          ok: false,
          reason: 'too_many_active_workspaces',
          busy: await enrichBusy(busyRows),
        }),
      },
    ],
  };
}

/**
 * Map a remote-authority `FileLockAcquireResult` back to the local `tryAcquire` result
 * shape. Only runs on the cross-machine path (a remote Swarm is the authority) — never at
 * N=1, where routeFileLockOp short-circuits to `op.local()`. Busy rows cross the wire as
 * path+owner only; the caller's `enrichBusy` re-hydrates owner_label/intent from presence.
 */
function decodeRemoteAcquire(
  raw: unknown,
  paths: string[],
  ttlSec: number,
): Awaited<ReturnType<typeof tryAcquire>> & { sha_token?: ShaTokenGrant } {
  const r = raw as FileLockAcquireResult;
  if (r.ok) {
    return {
      ok: true,
      lock_id: r.lockId ?? '',
      expires_ts: r.expiresTs ? new Date(r.expiresTs) : new Date(Date.now() + ttlSec * 1000),
      held: paths,
      newly_held: r.newlyHeld ?? paths,
      // G-0 (P-033): the AUTHORITY's sha-token stamp rides the remote grant.
      ...(r.shaToken ? { sha_token: r.shaToken } : {}),
    };
  }
  const fallbackExpiry = new Date(Date.now() + ttlSec * 1000);
  return {
    ok: false,
    busy: (r.busy ?? []).map((b) => ({
      path: b.path,
      owner: b.owner,
      owner_label: null,
      intent: '',
      expires_ts: fallbackExpiry,
    })),
  };
}
