/**
 * Production adapters for `system:consult-expiry-sweep`.
 * EI-21559794492221235 · pattern reference: `../acceptance-grading-sweep-observe.ts`
 *
 * ── WHY THIS IS ITS OWN MODULE ─────────────────────────────────────────────────
 * `consult-expiry-core.ts` is pure and integration-tested, and that is exactly what
 * made this blind spot easy to miss: the CORE was covered, so the sweep read as
 * tested. But the three adapters that bind that core to real services —
 * `emitReplyEvent`, `reach`, `revive` — lived as lambdas inside the
 * `registerSystemAction` closure in `../harness/routines/consult-expiry-action.ts`.
 * Nothing outside that closure could reach them, so a test could only pin their
 * SOURCE TEXT, never execute them.
 *
 * That is not a hypothetical gap. It is the same shape as the defect in
 * `acceptance-grading-sweep-observe`: a closure-sealed adapter read a field that did
 * not exist, returned a falsy value on every row, and stayed invisible to 75 passing
 * tests because no test could call it.
 *
 * ── WHAT THE ADAPTERS ACTUALLY DECIDE ──────────────────────────────────────────
 * These are not pass-throughs, which is the reason they are worth executing:
 *
 *   - `consult_state` is workspace-PARTITIONED and ONE sweep serves every workspace,
 *     so the workspace must ride on each CALL. Taking it from the routine's ambient
 *     scope instead would silently address the wrong tenant — and would still pass
 *     every core test, because the core supplies the workspace and never checks where
 *     the adapter got it from.
 *   - `reach` must build its system identity per row from `opts.workspaceId`, and must
 *     narrow `notifyAgents`' richer result down to the `{ woke }` the core consumes.
 *   - `revive` must split one flat `opts` across the reviver's TWO parameters — the
 *     consult triple in the first, the workspace context in the second. Threading
 *     `workspaceId` into the wrong one is a one-word mistake with no type error.
 *
 * Dependencies arrive as parameters and the service shapes are declared structurally,
 * so a test can drive these with fakes and this module stays off the events-engine,
 * notify-agents, and reviver import graphs.
 */
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import type { SendOptions } from '../agent-tools/coordination/messages';
import type { NotifyAgentsOpts, NotifyAgentsResult } from '../agent-tools/coordination/notify-agents';
import type { EmitAwaitedEventOpts, EmitResult } from '../events/await/engine';
import type { ExpirySweepDeps, SilentResponderCandidate } from './consult-expiry-core';
import { DEAD_RESPONDER_STATES, HARD_BLOCKED_EXPIRY_MS } from './get-feedback-core';
import type { ConsultReviveContext, ConsultReviveResult } from './revive-responder';
import type { ThreadableStore } from '@papercusp/coordination/capabilities';
import { runWithWorkspace } from '../workspace-als';

/** The ownerId this sweep acts under. Exported so a test asserts the real constant
 *  rather than re-typing the string it is checking against. */
export const CONSULT_EXPIRY_SWEEP_OWNER_ID = 'system:consult-expiry-sweep';

// The service shapes below are `import type` only — erased at runtime — so this module
// binds to the REAL contracts (a drifted parameter is a compile error here) without
// pulling the events engine, notify-agents, or the reviver onto its import graph.

/** What this module needs from `emitAwaitedEvent`. */
export type AwaitedEventEmitter = (input: EmitAwaitedEventOpts) => Promise<EmitResult>;

/** What this module needs from `notifyAgents`. */
export type AgentNotifier = (
  identity: AgentIdentity,
  opts: NotifyAgentsOpts,
) => Promise<NotifyAgentsResult>;

/** What this module needs from the durable coord message writer. */
export type RequesterAlertSender = (
  identity: AgentIdentity,
  opts: SendOptions,
) => Promise<unknown>;

/** What this module needs from `reviveConsultResponder` — note the TWO-parameter
 *  shape, which is the thing the adapter has to get right. */
export type ResponderReviver = (
  opts: { ownerId: string; conversationId: string; brief: string },
  ctx: ConsultReviveContext,
) => Promise<ConsultReviveResult>;

/** Narrow seams for the post-routing silent-responder detector. Keeping these
 * as injected functions makes the adapter executable in unit tests while the
 * routine action can still lazy-load the operator services. */
export interface SilentResponderDetectorDeps {
  getPresence: (ownerId: string) => Promise<{ lastActiveAt: string | null } | null>;
  resolveSessionStates: (
    subjects: readonly { ownerId: string }[],
    opts: { hydratePerId: true },
  ) => Promise<ReadonlyMap<string, { sessionState?: string | null }>>;
  getThreadStore: (workspaceId: string) => SilentResponderThreadStore;
  /** Injectable clock for the bounded live-busy pickup window. */
  now?: () => Date;
}

/** `listRecentPosts` is a production-only bounded extension of the shared
 * ThreadableStore contract, so keep the detector's minimal reader shape local
 * instead of pretending it is part of that public interface. */
export interface SilentResponderThreadStore {
  getThreadByParent: ThreadableStore['getThreadByParent'];
  listRecentPosts: (threadId: string, limit: number) => Promise<{ total: number }>;
}

/**
 * The per-row workspace SYSTEM identity the sweep acts under.
 *
 * Identity cannot come from the routine's ALS scope: `consult_state` is
 * workspace-partitioned and one sweep serves every workspace (mirrors `probeIdentity`
 * in `coord-invariant-actions.ts`).
 */
export function sweepIdentity(workspaceId: string): AgentIdentity {
  return {
    ownerId: CONSULT_EXPIRY_SWEEP_OWNER_ID,
    ownerLabel: 'consult expiry sweep',
    source: 'omp-hook-session',
    workspaceId,
    userId: null,
  } as AgentIdentity;
}

/**
 * Latched `consult:reply:<conv>` emit → the (possibly parked) requester.
 * The emit must land in the ROW's workspace, not the routine's ambient scope.
 */
export function consultExpiryEmitReplyEvent(
  emit: AwaitedEventEmitter,
): ExpirySweepDeps['emitReplyEvent'] {
  return async (e) => {
    await emit({
      key: e.key,
      summary: e.summary,
      payload: e.payload,
      to: e.to,
      workspaceId: e.workspaceId,
      source: 'consult-expiry-sweep',
    });
  };
}

/**
 * Durable requester alert. The core derives a replay key from the consult
 * lifecycle position; passing it through to sendMessage makes a retry return
 * the stored winner instead of appending a duplicate message.
 */
export function consultExpiryNotifyRequester(
  send: RequesterAlertSender,
): NonNullable<ExpirySweepDeps['notifyRequester']> {
  return async (opts) => {
    await runWithWorkspace(opts.workspaceId, () =>
      send(sweepIdentity(opts.workspaceId), {
        msgId: opts.msgId,
        to: [opts.requesterId],
        summary: opts.summary,
        body: opts.body,
        harnessSlug: null,
        extra: { conversation_id: opts.conversationId, recovery: 'pending' },
      }),
    );
  };
}

/**
 * D-005 cascade advance: an unanswered window elapsing wakes the NEXT selectee
 * exactly like a decline does — subscribe + ping + wake, so the selectee joins the
 * consult conversation durably.
 */
export function consultExpiryReach(
  notify: AgentNotifier,
): NonNullable<ExpirySweepDeps['reach']> {
  return async (opts) => {
    const r = await runWithWorkspace(opts.workspaceId, () =>
      notify(sweepIdentity(opts.workspaceId), {
        addressees: [opts.responder],
        objectRef: { kind: 'conversation', ref: opts.conversationId },
        summary: opts.summary,
        body: opts.body,
        wake: true,
      }),
    );
    return { woke: r.woke };
  };
}

/**
 * EI-20864690354207496 refill-exhaustion revival: carry-respawn a dead above-floor
 * candidate when a due row's cascade exhausts below `selection.min`. `launchedBy` is
 * stamped as the sweep so the spawn is attributable back to it.
 */
export function consultExpiryRevive(
  revive: ResponderReviver,
): NonNullable<ExpirySweepDeps['revive']> {
  return async (opts) =>
    revive(
      { ownerId: opts.ownerId, conversationId: opts.conversationId, brief: opts.brief },
      {
        workspaceId: opts.workspaceId,
        harnessSlug: null,
        launchedBy: CONSULT_EXPIRY_SWEEP_OWNER_ID,
      },
    );
}

/** Detect post-routing no-pickup failures that otherwise wait for the full
 * expiry window. Three observations are safe enough to advance as an implicit
 * decline when the consult thread is still empty:
 *
 *  - the selected owner became active after routing and re-parked; or
 *  - the owner is still live or parked after one hard-blocked expiry window.
 *    This is the continuously-busy or queued-but-never-picked-up case: a queued
 *    wake can sit behind unrelated work for the four-hour `proceed` window even
 *    though no consult turn was picked up; or
 *  - the owner terminalized after routing, which makes waiting for expiry
 *    pointless because the queued wake can no longer be consumed.
 *
 * Reusing HARD_BLOCKED_EXPIRY_MS gives a live responder the same bounded pickup
 * opportunity a blocking requester already accepts, while still cutting the
 * `proceed` dead end from hours to minutes. The original responder remains in
 * the digest and the existing cascade refill/revival machinery owns recovery.
 * Presence and liveness are batched by owner; thread reads are partitioned by
 * row workspace.
 */
export function consultExpiryFindSilentResponders(
  deps: SilentResponderDetectorDeps,
): NonNullable<ExpirySweepDeps['findSilentResponders']> {
  return async (rows: readonly SilentResponderCandidate[]) => {
    if (rows.length === 0) return new Set<string>();

    const checkedAtMs = (deps.now ? deps.now() : new Date()).getTime();

    const responderIds = [...new Set(rows.map((row) => row.responderId))];
    const [presenceEntries, verdicts] = await Promise.all([
      Promise.all(
        responderIds.map(async (ownerId) => [ownerId, await deps.getPresence(ownerId)] as const),
      ),
      deps.resolveSessionStates(
        responderIds.map((ownerId) => ({ ownerId })),
        { hydratePerId: true },
      ),
    ]);
    const presenceByOwner = new Map(presenceEntries);
    const stores = new Map<string, SilentResponderThreadStore>();
    const getStore = (workspaceId: string) => {
      let store = stores.get(workspaceId);
      if (!store) {
        store = deps.getThreadStore(workspaceId);
        stores.set(workspaceId, store);
      }
      return store;
    };

    const silent = new Set<string>();
    await Promise.all(
      rows.map(async (row) => {
        const lastActiveAt = presenceByOwner.get(row.responderId)?.lastActiveAt;
        const activeMs = lastActiveAt == null ? Number.NaN : Date.parse(String(lastActiveAt));
        const routedMs = Date.parse(row.routedAt);
        if (!Number.isFinite(routedMs)) return;
        const sessionState = verdicts.get(row.responderId)?.sessionState;
        const terminalAfterRoute = DEAD_RESPONDER_STATES.has(sessionState ?? '');
        const reparkedAfterRoute =
          sessionState === 'parked' && Number.isFinite(activeMs) && activeMs > routedMs;
        const inactivePastPickupWindow =
          (sessionState === 'live' || sessionState === 'parked') &&
          Number.isFinite(checkedAtMs) &&
          checkedAtMs - routedMs >= HARD_BLOCKED_EXPIRY_MS;
        if (!terminalAfterRoute && !reparkedAfterRoute && !inactivePastPickupWindow) return;

        const store = getStore(row.workspaceId);
        const thread = await store.getThreadByParent({ kind: 'conversation', ref: row.conversationId });
        const total = thread == null ? 0 : (await store.listRecentPosts(thread.thread_id, 1)).total;
        if (total === 0) silent.add(row.conversationId);
      }),
    );
    return silent;
  };
}
