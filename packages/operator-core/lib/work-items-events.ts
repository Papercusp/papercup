/**
 * work-items-events — settled-item events through the await-event primitive
 * (await-event-primitive-2026-06-05 P-012/P-013, D-006 #4/#5).
 *
 * When a work-item SETTLES (feature → passed/deprecated; issue →
 * resolved/closed) two event families fire:
 *
 *   `work-item:done:<id>` — the children-done / delegated-work signal: the
 *   delegator (assignedBy) and the parent chunk's claimant are notified; any
 *   agent that registered `events:await` on the key is WOKEN. A parent
 *   spawning children no longer loses the thread — it awaits each child's
 *   done-key (or sleeps on the last one).
 *
 *   `work-item:unblocked:<id>` — fired for each dependent whose LAST live
 *   blocker just settled (`rel='blocks'` edges, work_items:link). Targeted at
 *   the dependent's claimant; wake-awaiters on the key are woken. The
 *   "conceptual wait" from the touch-point inventory — agents used to just
 *   lose the thread when a blocker cleared.
 *
 * Source layer per D-001: THIS module resolves who the events concern (the
 * delegator, the parent's claimant, the dependent's claimant); the delivery
 * layer stays dumb. Called fire-and-forget from setWorkItemState (lazy import
 * there — this module imports work-items statically, so the cycle is broken
 * on the caller's side); an emit failure can never break a state write.
 */

import type { LinkRow, ObjectRef } from '@papercusp/coordination/capabilities';
import { TERMINAL_STATUSES } from './dbos/frontier-readiness';
import { emitAwaitedEvent } from './events/await/engine';
import { FEATURE_KIND } from './issue-blocks-merge';
import { blockingEdgeReader, ISSUE_TERMINAL_STATUSES, type BlockingEdgeReader } from './work-item-blocking';
import { CLAIM_STATES_ALLOWLIST, getWorkItem, workItemObjectRef, type WorkItem, type WorkItemFamily } from './work-items';
// Type-only (erased at runtime) — the subscriber inject shape. The concrete
// fanoutForObject is lazy-imported inside the default seam below so this module
// keeps no static edge to the fan-out projection (cycle-safe).
import type { InjectEvent } from './agent-tools/coordination/fanout-delivery';

// WI-4034 DEFECT 2 (single-source the settled predicate): these used to be a
// SEPARATE, hand-duplicated literal set here that happened to still agree with
// work-item-blocking.ts's cross-family terminal sets (verified equal at audit
// time — feature {passed,deprecated}, issue {resolved,closed}). Reusing the
// seam's own sets means the two can never silently drift apart again.
const SETTLED_STATES: Record<WorkItemFamily, ReadonlySet<string>> = {
  feature: TERMINAL_STATUSES,
  issue: ISSUE_TERMINAL_STATUSES,
};

/**
 * Errors that are EXPECTED for a best-effort, fire-and-forget notification and
 * so must never warn (vitest-fail-on-console would then flake any rig test):
 *   - a partial test schema (a projection table the emit touches is absent →
 *     "… does not exist");
 *   - the emit's async query outliving the Postgres pool it ran on (a rig/test
 *     tearing down mid-emit → postgres.js CONNECTION_ENDED/CONNECTION_DESTROYED).
 * Anything else is a genuine surprise worth a warn.
 */
function failSoft(scope: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  if (/does not exist/.test(msg)) return;
  const code = (e as { code?: unknown } | null)?.code;
  if (
    code === 'CONNECTION_ENDED' ||
    code === 'CONNECTION_DESTROYED' ||
    /CONNECTION_ENDED|CONNECTION_DESTROYED|Connection ended/i.test(msg)
  ) {
    return;
  }
  console.warn(`[work-items-events] ${scope} emit failed: ${msg}`);
}

/**
 * `work-item:claimed:<id>` — fired when an agent claims an item
 * (plugin-system-hive-port P-004: the work_items lifecycle fire-point set).
 * Awaited-event leg only: the claim travels through the `work_items:claim` /
 * `work_items:claim_next` tools, which the reaction matcher already observes
 * via postInvoke — plugins subscribe there; this key serves `events:await`.
 * Fire-and-forget; never throws.
 */
export function emitWorkItemClaimedEvent(
  wi: WorkItem,
  assignee: string,
  deps: Pick<SettledEventsDeps, 'emit'> = {},
): void {
  const emit = deps.emit ?? emitAwaitedEvent;
  void Promise.resolve()
    .then(() =>
      emit({
        key: `work-item:claimed:${wi.id}`,
        summary: `${wi.id} claimed by ${assignee}: ${wi.title}`,
        payload: { id: wi.id, state: wi.state, kind: wi.kind, harness: wi.harness, assignee, title: wi.title },
        source: 'work-items',
      }),
    )
    .catch((e: unknown) => failSoft(`claimed-event for ${wi.id}`, e));
}

/**
 * `work-item:created[:<severity>]` — fired when a NEW work item is minted
 * (EI-8296: no creation event existed, so "alert me when a new critical-severity
 * item is filed" was inexpressible as `watch:create` and had to fall back to a
 * 15-min poll+diff plan — critical-severity-alert-2026-07-06).
 *
 * Dual-emits the GLOBAL key `work-item:created` (every new item, any severity/
 * kind/harness — payload-filtered, mirroring the `release:deployed` /
 * `release:green` global+scoped precedent, P-102/EI-7646) AND, when the item
 * carries an issue-family severity, the severity-scoped key
 * `work-item:created:<severity>` — so "wake me on a new critical item" is
 * `events:await({ event: 'work-item:created:critical' })` instead of a poll.
 * `payload` carries `{id, kind, severity, harness, title}` so a waiter on the
 * global key can filter by kind/harness itself. Fire-and-forget; never throws.
 */
export function emitWorkItemCreatedEvent(wi: WorkItem, deps: Pick<SettledEventsDeps, 'emit'> = {}): void {
  const emit = deps.emit ?? emitAwaitedEvent;
  const payload = { id: wi.id, kind: wi.kind, severity: wi.severity, harness: wi.harness, title: wi.title };
  const summary = `${wi.id} created (${wi.kind}${wi.severity ? `, ${wi.severity}` : ''}): ${wi.title}`;
  void Promise.resolve()
    .then(() => emit({ key: 'work-item:created', summary, payload, source: 'work-items' }))
    .catch((e: unknown) => failSoft(`created-event for ${wi.id}`, e));
  if (wi.severity) {
    void Promise.resolve()
      .then(() => emit({ key: `work-item:created:${wi.severity}`, summary, payload, source: 'work-items' }))
      .catch((e: unknown) => failSoft(`created-event(severity) for ${wi.id}`, e));
  }
  // P-007: a create that lands unclaimed-claimable also announces the canonical
  // pool key — co-fired HERE (not at the createWorkItem call site) so the event
  // family's semantics live in one module; the guard drops born-claimed items.
  emitWorkItemClaimableEvent(wi, 'created', deps);
}

/** The states an unassigned item can be pulled from — get_next/claim_next's floor. */
const CLAIMABLE_STATES: ReadonlySet<string> = new Set(CLAIM_STATES_ALLOWLIST);

/**
 * `work-item:claimable` — the CANONICAL "work may exist for you" key
 * (composable-event-awaits-2026-07-11 P-007). Dual-emitted alongside the
 * "returns to the pool" families (`work-item:created` on an unclaimed create,
 * `claim:released:<id>`, `work-item:unblocked:<id>`, and the bare set_state
 * requeue edge — see below) so an idle self-puller parks on ONE leaf —
 * `events:await { event: 'work-item:claimable', payload_filter:
 * { harness: { eq: … } } }` — instead of the 3-leaf composed any-spec. Sugar
 * only: the underlying families keep firing unchanged, so existing specs
 * keep working.
 *
 * The claimability guard lives HERE, single-sourced for every call site: an
 * item with an assignee, or in a non-claimable state (blocked / terminal /
 * wip), never fires — the key must never advertise work a get_next pull
 * would then refuse. `payload.reason` carries which transition made it
 * claimable. The FOURTH return-to-pool moment — a bare status flip INTO a
 * claimable state (e.g. blocked→todo via set_state) — co-fires from
 * emitWorkItemStatusEvent with reason 'requeued' (WI-4180, the P-007 audit's
 * gap (A)), so it no longer strands a parked waiter to the ~30-min timeout
 * backstop. Fire-and-forget; never throws.
 */
export function emitWorkItemClaimableEvent(
  wi: WorkItem,
  reason: 'created' | 'released' | 'unblocked' | 'requeued',
  deps: Pick<SettledEventsDeps, 'emit'> = {},
): void {
  if (wi.assignee || !CLAIMABLE_STATES.has(wi.state)) return;
  const emit = deps.emit ?? emitAwaitedEvent;
  const payload = {
    id: wi.id,
    kind: wi.kind,
    severity: wi.severity,
    harness: wi.harness,
    title: wi.title,
    state: wi.state,
    reason,
  };
  void Promise.resolve()
    .then(() =>
      emit({
        key: 'work-item:claimable',
        summary: `${wi.id} claimable (${reason}): ${wi.title}`,
        payload,
        source: 'work-items',
      }),
    )
    .catch((e: unknown) => failSoft(`claimable-event for ${wi.id}`, e));
}

/**
 * `claim:released:<id>` — fired when a work-item's claim is RELEASED and it returns
 * to the claimable pool (event-await-discoverability-and-coverage-2026-07-03 P-105).
 * The counterpart of `work-item:claimed:<id>`: an agent waiting to pick up a specific
 * orphaned / handed-back item awaits this and is WOKEN the moment it frees, instead of
 * polling. Fires from `releaseWorkItem` — the ONE path both `work_items:release` (voluntary)
 * AND the stale-claim reaper route through — so a reaper-freed item wakes waiters too.
 * Awaiter-only (no `to` push): the audience is whoever registered interest in this id.
 * Fire-and-forget; never throws.
 */
export function emitClaimReleasedEvent(wi: WorkItem, deps: Pick<SettledEventsDeps, 'emit'> = {}): void {
  const emit = deps.emit ?? emitAwaitedEvent;
  void Promise.resolve()
    .then(() =>
      emit({
        key: `claim:released:${wi.id}`,
        summary: `${wi.id} claim released — back to the pool: ${wi.title}`,
        payload: { id: wi.id, state: wi.state, kind: wi.kind, harness: wi.harness, title: wi.title },
        source: 'work-items',
      }),
    )
    .catch((e: unknown) => failSoft(`claim-released-event for ${wi.id}`, e));
  // P-007: a released item is back in the pool — co-fire the canonical claimable
  // key (the guard drops rows that released into a non-claimable end state).
  emitWorkItemClaimableEvent(wi, 'released', deps);
}

/**
 * `work-item:blocked:<id>` — fired when an item transitions INTO `blocked`
 * (the durable "I can't proceed" record — see the repo guide's don't-silently-
 * defer rule). The delegator (assignedBy) is notified so blocked work is never
 * a prose message that scrolls away. Fire-and-forget; never throws.
 */
export function emitWorkItemBlockedEvent(wi: WorkItem, deps: Pick<SettledEventsDeps, 'emit'> = {}): void {
  const emit = deps.emit ?? emitAwaitedEvent;
  const notify = wi.assignedBy && wi.assignedBy !== wi.assignee ? [wi.assignedBy] : [];
  void Promise.resolve()
    .then(() =>
      emit({
        key: `work-item:blocked:${wi.id}`,
        summary: `${wi.id} is BLOCKED: ${wi.title}`,
        payload: { id: wi.id, state: wi.state, kind: wi.kind, harness: wi.harness, title: wi.title },
        to: notify,
        source: 'work-items',
      }),
    )
    .catch((e: unknown) => failSoft(`blocked-event for ${wi.id}`, e));
}

/**
 * `work-item:status:<id>` — fired on EVERY real status transition of a work item
 * (event-await-discoverability-and-coverage-2026-07-03 P-101). The GENERAL
 * transition signal that answers "wake me on ANY change of WI-X" — a dependency's
 * progress, a peer's item, an issue moving through triage — in ONE await, instead
 * of polling `work_items:get`. It CO-fires with the specific keys
 * (`work-item:done` / `:blocked` / `:unblocked` / `:claimed`); per the catalog's
 * one-entry-one-family model those are never awaited together, so an agent picks
 * either the general key OR a specific one and is woken exactly once per
 * transition. `payload.prevState` + `payload.state` carry the edge so the waiter
 * needn't re-read. Fire-and-forget; never throws.
 */
export function emitWorkItemStatusEvent(
  wi: WorkItem,
  prevState: string,
  deps: Pick<SettledEventsDeps, 'emit'> = {},
): void {
  const emit = deps.emit ?? emitAwaitedEvent;
  void Promise.resolve()
    .then(() =>
      emit({
        key: `work-item:status:${wi.id}`,
        summary: `${wi.id} ${prevState} → ${wi.state}: ${wi.title}`,
        payload: {
          id: wi.id,
          state: wi.state,
          prevState,
          kind: wi.kind,
          harness: wi.harness,
          title: wi.title,
        },
        source: 'work-items',
      }),
    )
    .catch((e: unknown) => failSoft(`status-event for ${wi.id}`, e));
  // WI-4180 (the P-007 audit's gap (A), owner-requested close): a bare state
  // flip INTO a claimable state (blocked→todo, a done→open reopen) is the
  // fourth return-to-pool moment — it used to fire only this general key,
  // stranding a parked `work-item:claimable` waiter to its ~30-min timeout
  // backstop. Co-fired HERE, inside the sibling emitter (ONE import edge —
  // the vitest-4 same-literal-double-import paradox, EI-9658), behind an
  // ENTERING-EDGE guard: a move BETWEEN claimable states (todo→open) must not
  // re-announce an already-advertised row; the claimable emitter's own guard
  // still drops assigned rows and non-claimable landing states.
  if (!CLAIMABLE_STATES.has(prevState)) emitWorkItemClaimableEvent(wi, 'requeued', deps);
}

export function isSettledWorkItem(wi: Pick<WorkItem, 'family' | 'state'>): boolean {
  return SETTLED_STATES[wi.family]?.has(wi.state) ?? false;
}

/** Reverse of workItemObjectRef: a coord ObjectRef back to (id, harness). */
export function workItemIdFromRef(ref: { kind: string; ref: string }): { id: string; harness?: string } | null {
  if (ref.kind === FEATURE_KIND) {
    const i = ref.ref.indexOf('#');
    if (i <= 0) return null;
    return { id: ref.ref.slice(i + 1), harness: ref.ref.slice(0, i) };
  }
  if (ref.kind === 'issue') return { id: ref.ref };
  return null;
}

/** Injectable seams for tests. Edge reads go through the work-item-blocking
 *  seam (P-005) — this module owns NO store of its own. */
export interface SettledEventsDeps {
  emit?: typeof emitAwaitedEvent;
  getItem?: typeof getWorkItem;
  listOut?: BlockingEdgeReader['listOut'];
  listIn?: BlockingEdgeReader['listIn'];
  /** Batched in-edge read; when absent it is DERIVED from `listIn` (test compat). */
  listInMany?: BlockingEdgeReader['listInMany'];
  /** P-010: inject-notify a fix-target's subscribers. Default = fanoutForObject
   *  (lazy-imported to avoid a static import cycle); tests inject a stub. */
  notifySubscribers?: NotifySubscribers;
}

/** Inject-notify the subscribers of an object (P-010) — the fanoutForObject shape. */
type NotifySubscribers = (object: ObjectRef, ev: InjectEvent) => Promise<number>;

/** Default subscriber-notify: the shared best-effort fan-out. Lazy-imported so
 *  this module carries no static edge to the fan-out projection (cycle-safe). */
async function defaultNotifySubscribers(object: ObjectRef, ev: InjectEvent): Promise<number> {
  const { fanoutForObject } = await import('./sync/hyperbee/fanout-projection');
  return fanoutForObject(object, ev);
}

/**
 * Resolve the batched in-edge reader: an injected `listInMany` wins; else an
 * injected per-dst `listIn` is lifted into a batch (existing tests inject only
 * `listIn` and stay a faithful spec of the shared core); else the seam reader.
 */
function resolveListInMany(deps: Pick<SettledEventsDeps, 'listIn' | 'listInMany'>): BlockingEdgeReader['listInMany'] {
  if (deps.listInMany) return deps.listInMany;
  const listIn = deps.listIn;
  if (listIn) return async (dsts, opts) => (await Promise.all(dsts.map((d) => listIn(d, opts)))).flat();
  return blockingEdgeReader.listInMany;
}

/** (kind, ref) identity for grouping/dedup — refs are opaque, kinds disjoint. */
const refKey = (r: ObjectRef): string => `${r.kind} ${r.ref}`;

/**
 * WI-4034: for each dependent in `dstRefs` that is NOT itself settled and has
 * NO other live (non-settled) `blocks` edge into it beyond one from
 * `clearedById`, EMIT `work-item:unblocked:<dst>`.
 *
 * Single-sourced by BOTH callers below: the settle path (the just-settled
 * item's own edges are still PRESENT in the store when this runs — excluded by
 * id) and the unlink path (the triggering edge has ALREADY been removed from
 * the store by the time this runs, so nothing needs excluding — passing the
 * id is harmless either way). Extracted so the two call sites can never
 * silently diverge on what "last live blocker" means.
 *
 * Batched (P-005): ONE `listInMany` query fetches every dependent's in-edges
 * (the old shape was a per-dst listIn + per-blocker getItem — N+1 on a fan-out
 * settle), then each distinct work-item is fetched ONCE, in parallel (no bulk
 * getWorkItem exists — dedup is the available batching).
 */
async function emitUnblockedForClearedEdges(
  dstRefs: readonly ObjectRef[],
  clearedById: string,
  emit: typeof emitAwaitedEvent,
  getItem: typeof getWorkItem,
  listInMany: BlockingEdgeReader['listInMany'],
): Promise<void> {
  // Dedup dsts — a duplicate src→dst edge must not double-emit for one dependent.
  const dsts = [...new Map(dstRefs.map((r) => [refKey(r), r])).values()];
  if (dsts.length === 0) return;

  const inEdges = await listInMany(dsts, { rel: 'blocks' });
  const edgesByDst = new Map<string, LinkRow[]>();
  for (const e of inEdges) {
    const k = refKey(e.dst);
    const arr = edgesByDst.get(k);
    if (arr) arr.push(e);
    else edgesByDst.set(k, [e]);
  }

  // Every item the checks below consult — dependents + candidate blockers (the
  // cleared one never is) — fetched once per unique (id, harness), in parallel.
  const wantKey = (w: { id: string; harness?: string }) => `${w.id} ${w.harness ?? ''}`;
  const wanted = new Map<string, { id: string; harness?: string }>();
  for (const d of dsts) {
    const w = workItemIdFromRef(d);
    if (w) wanted.set(wantKey(w), w);
  }
  for (const e of inEdges) {
    const w = workItemIdFromRef(e.src);
    if (w && w.id !== clearedById) wanted.set(wantKey(w), w);
  }
  const fetched = new Map<string, WorkItem | null>();
  await Promise.all(
    [...wanted.entries()].map(async ([k, w]) => {
      fetched.set(k, await getItem(w.id, w.harness).catch(() => null));
    }),
  );
  const itemFor = (ref: ObjectRef): WorkItem | null => {
    const w = workItemIdFromRef(ref);
    return w ? (fetched.get(wantKey(w)) ?? null) : null;
  };

  for (const dstRef of dsts) {
    const dependent = itemFor(dstRef);
    if (!dependent || isSettledWorkItem(dependent)) continue;

    const stillBlocked = (edgesByDst.get(refKey(dstRef)) ?? []).some((be) => {
      const src = workItemIdFromRef(be.src);
      if (!src || src.id === clearedById) return false; // the one that just cleared
      const blocker = itemFor(be.src);
      return Boolean(blocker && !isSettledWorkItem(blocker)); // still genuinely blocked
    });
    if (stillBlocked) continue;

    await emit({
      key: `work-item:unblocked:${dependent.id}`,
      summary: `${dependent.id} is UNBLOCKED — its last blocker (${clearedById}) cleared: ${dependent.title}`,
      payload: { id: dependent.id, clearedBy: clearedById, harness: dependent.harness, title: dependent.title },
      to: dependent.assignee ? [dependent.assignee] : [],
      source: 'work-items',
    });
    // P-007: an unblocked dependent may have just become pool-claimable — the
    // canonical key co-fires here so BOTH unblock paths (settle + unlink) are
    // covered; the emitter's own guard drops assigned / non-claimable items.
    emitWorkItemClaimableEvent(dependent, 'unblocked', { emit });
  }
}

/**
 * linking-notify-family-hardening P-006: live blocked-state probe for the
 * `events:await` registration LATCH on `work-item:unblocked:<id>` keys. That
 * event fires only on a blocked→unblocked EDGE, so awaiting it for an item
 * that is ALREADY unblocked (or settled) registers a wait that can only time
 * out — the same stranding the EI-9270 announced-gate latch closes for
 * declared keys. Best-effort by contract: 'unknown' (unreadable / ambiguous
 * id, e.g. a feature id whose harness the key doesn't carry) must never block
 * a registration — callers treat it as "go ahead and register".
 */
export async function liveBlockedState(
  id: string,
  deps: Pick<SettledEventsDeps, 'getItem' | 'listIn'> = {},
): Promise<'blocked' | 'unblocked' | 'settled' | 'unknown'> {
  const getItem = deps.getItem ?? getWorkItem;
  const listIn = deps.listIn ?? blockingEdgeReader.listIn;
  try {
    const item = await getItem(id, undefined).catch(() => null);
    if (!item) return 'unknown';
    if (isSettledWorkItem(item)) return 'settled';
    const edges = await listIn(workItemObjectRef(item), { rel: 'blocks' });
    for (const be of edges) {
      const src = workItemIdFromRef(be.src);
      if (!src) continue;
      const blocker = await getItem(src.id, src.harness).catch(() => null);
      if (blocker && !isSettledWorkItem(blocker)) return 'blocked';
    }
    return 'unblocked';
  } catch {
    return 'unknown';
  }
}

/**
 * WI-4034 DEFECT 1 (the unlink gap): `unlinkWorkItem` deleted a `blocks` edge
 * and returned — nothing ever re-checked whether that removal was the
 * dependent's LAST live blocker, so an `events:await('work-item:unblocked:<dep>')`
 * registrant never woke on an UNLINK (only on the blocker SETTLING) — a silent
 * strand to the awaiter's 30-min timeout-wake. Call this fire-and-forget
 * immediately after a successful `rel==='blocks'` unlink (mirrors the
 * settle-path's fire-and-forget shape in work-items.ts); `dst`'s remaining
 * blockers are re-checked with the edge ALREADY gone from the store. Never
 * throws.
 */
export async function emitUnblockedOnEdgeRemoved(
  dst: ObjectRef,
  clearedById: string,
  deps: Pick<SettledEventsDeps, 'emit' | 'getItem' | 'listIn' | 'listInMany'> = {},
): Promise<void> {
  const emit = deps.emit ?? emitAwaitedEvent;
  const getItem = deps.getItem ?? getWorkItem;
  try {
    await emitUnblockedForClearedEdges([dst], clearedById, emit, getItem, resolveListInMany(deps));
  } catch (e) {
    failSoft(`unlink-unblocked-event for ${clearedById}`, e);
  }
}

/**
 * linking-notify-family-hardening P-010 (WI-4014 Part 3 owner-fork, resolved as
 * Option A): when an item SETTLES, notify across its fixes/duplicates edges.
 * INJECT-ONLY (the wake-vs-inject axis, D-001) — settle-notify never wakes;
 * anyone who needs a WAKE uses events:await on work-item:done:<id>.
 *
 *  - `fixes` (wi FIXES target — an OUTGOING edge): the fix just landed, so
 *    inject-notify the FIXED target's existing SUBSCRIBERS ("the fix for your
 *    issue settled"). Routed through the shared subscriber fan-out, which reaches
 *    issue- AND feature-family subscribers uniformly; isResolution:true so even
 *    mention-mode followers receive this lifecycle resolution.
 *  - `duplicates` (dup DUPLICATES wi — an INCOMING edge; wi is the canonical):
 *    the canonical settled, so inject-notify each duplicate-holder's ASSIGNEE
 *    ("the item you were a duplicate of resolved"), keyed
 *    work-item:duplicate-settled:<wi> — a targeted `to`, not a subscriber fan-out.
 *
 * Fire-and-forget; the caller wraps this in its own failSoft scope (P-008) so a
 * notify failure can never drop the sibling done / unblocked emits.
 *
 * Only reads edges at settle time (no writes) — deliberately NOT the
 * subscribe{followBlockers} branch (Option B), which adds writes to the link hot
 * path and is deferred per D-003 until the work_item_deps backend flip.
 */
async function emitFixDuplicateSettledNotify(
  wi: WorkItem,
  emit: typeof emitAwaitedEvent,
  getItem: typeof getWorkItem,
  listOut: BlockingEdgeReader['listOut'],
  listIn: BlockingEdgeReader['listIn'],
  notifySubscribers: NotifySubscribers,
): Promise<void> {
  const ref = workItemObjectRef(wi);

  // fixes: wi FIXES dst (outgoing) → tell the fixed target's subscribers.
  const fixEdges = await listOut(ref, { rel: 'fixes' });
  for (const fe of fixEdges) {
    const t = workItemIdFromRef(fe.dst);
    const target = t ? await getItem(t.id, t.harness).catch(() => null) : null;
    await notifySubscribers(fe.dst, {
      from: wi.assignee ?? 'substrate',
      subject: `${fe.dst.kind}:${fe.dst.ref}`,
      summary: `${target?.id ?? t?.id ?? fe.dst.ref} — its fix ${wi.id} settled → ${wi.state}: ${wi.title}`,
      notify_kind: 'work_item_fix_settled',
      isResolution: true,
    });
  }

  // duplicates: dup DUPLICATES wi (incoming); wi is the canonical → tell each
  // distinct duplicate-holder's assignee (never the canonical's own agent).
  const dupEdges = await listIn(ref, { rel: 'duplicates' });
  const dupAssignees = new Set<string>();
  for (const de of dupEdges) {
    const s = workItemIdFromRef(de.src);
    const dup = s ? await getItem(s.id, s.harness).catch(() => null) : null;
    if (dup?.assignee && dup.assignee !== wi.assignee) dupAssignees.add(dup.assignee);
  }
  if (dupAssignees.size > 0) {
    await emit({
      key: `work-item:duplicate-settled:${wi.id}`,
      summary: `${wi.id} (the canonical item) settled → ${wi.state}: ${wi.title}`,
      payload: { id: wi.id, state: wi.state, kind: wi.kind, harness: wi.harness, title: wi.title },
      to: [...dupAssignees],
      source: 'work-items',
    });
  }
}

/**
 * Fire the settled-item events for `wi` (which has ALREADY transitioned to a
 * settled state). Never throws.
 */
export async function emitWorkItemSettledEvents(wi: WorkItem, deps: SettledEventsDeps = {}): Promise<void> {
  const emit = deps.emit ?? emitAwaitedEvent;
  const getItem = deps.getItem ?? getWorkItem;
  const listOut = deps.listOut ?? blockingEdgeReader.listOut;
  const listIn = deps.listIn ?? blockingEdgeReader.listIn;
  const listInMany = resolveListInMany(deps);
  const notifySubscribers = deps.notifySubscribers ?? defaultNotifySubscribers;

  // P-008 (linking-notify-family-hardening) durability split: the done-emit and
  // the unblocked loop each run in their OWN fail-soft scope. A single try used
  // to wrap BOTH, so a throw while resolving/emitting `work-item:done` (a parent
  // getItem, or the emit itself) silently skipped the unblocked loop — every
  // dependent whose last blocker just cleared went un-woken because a SIBLING
  // notification failed. They are independent signals; one failing must not drop
  // the other. (Full outbox durability is deferred — D-003; this is the bounded
  // fix.) Both scopes route through the shared `failSoft` so expected teardown
  // noise (CONNECTION_ENDED / partial-schema "does not exist") stays silent.

  // ── work-item:done — the children-done / delegated-work signal ────────
  try {
    const notifyDone = new Set<string>();
    if (wi.assignedBy && wi.assignedBy !== wi.assignee) notifyDone.add(wi.assignedBy);
    if (wi.parent) {
      const parent = await getItem(wi.parent, wi.harness ?? undefined).catch(() => null);
      if (parent?.assignee && parent.assignee !== wi.assignee) notifyDone.add(parent.assignee);
    }
    await emit({
      key: `work-item:done:${wi.id}`,
      summary: `${wi.id} settled → ${wi.state}: ${wi.title}`,
      payload: { id: wi.id, state: wi.state, kind: wi.kind, harness: wi.harness, title: wi.title },
      to: [...notifyDone],
      source: 'work-items',
    });
  } catch (e) {
    failSoft(`settled done-event for ${wi.id}`, e);
  }

  // ── work-item:unblocked — dependents whose LAST live blocker cleared ──
  try {
    const ref = workItemObjectRef(wi);
    const blockEdges = await listOut(ref, { rel: 'blocks' });
    await emitUnblockedForClearedEdges(blockEdges.map((e) => e.dst), wi.id, emit, getItem, listInMany);
  } catch (e) {
    failSoft(`settled unblocked-loop for ${wi.id}`, e);
  }

  // ── fix/duplicate settle-notify (P-010) — its own fail-soft scope ─────
  try {
    await emitFixDuplicateSettledNotify(wi, emit, getItem, listOut, listIn, notifySubscribers);
  } catch (e) {
    failSoft(`settled fix/dup-notify for ${wi.id}`, e);
  }
}
