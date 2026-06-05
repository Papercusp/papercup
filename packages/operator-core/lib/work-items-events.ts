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

import { PgLinkStore } from '@papercusp/coordination/capabilities';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { getOrgPg } from '@papercusp/db-org';
import { emitAwaitedEvent } from './events/await/engine';
import { FEATURE_KIND } from './issue-blocks-merge';
import { getWorkItem, workItemObjectRef, type WorkItem, type WorkItemFamily } from './work-items';

const links = new PgLinkStore({
  getSql: () => getOrgPg().sql,
  ensureSchema: async () => {},
  workspaceId: DEFAULT_COORD_WORKSPACE,
});

const SETTLED_STATES: Record<WorkItemFamily, readonly string[]> = {
  feature: ['passed', 'deprecated'],
  issue: ['resolved', 'closed'],
};

export function isSettledWorkItem(wi: Pick<WorkItem, 'family' | 'state'>): boolean {
  return SETTLED_STATES[wi.family]?.includes(wi.state) ?? false;
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

/** Injectable seams for tests. */
export interface SettledEventsDeps {
  emit?: typeof emitAwaitedEvent;
  getItem?: typeof getWorkItem;
  listOut?: typeof links.listOut;
  listIn?: typeof links.listIn;
}

/**
 * Fire the settled-item events for `wi` (which has ALREADY transitioned to a
 * settled state). Never throws.
 */
export async function emitWorkItemSettledEvents(wi: WorkItem, deps: SettledEventsDeps = {}): Promise<void> {
  const emit = deps.emit ?? emitAwaitedEvent;
  const getItem = deps.getItem ?? getWorkItem;
  const listOut = deps.listOut ?? links.listOut.bind(links);
  const listIn = deps.listIn ?? links.listIn.bind(links);

  try {
    // ── work-item:done — the children-done / delegated-work signal ────────
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

    // ── work-item:unblocked — dependents whose LAST live blocker cleared ──
    const ref = workItemObjectRef(wi);
    const blockEdges = await listOut(ref, { rel: 'blocks' });
    for (const edge of blockEdges) {
      const dst = workItemIdFromRef(edge.dst);
      if (!dst) continue;
      const dependent = await getItem(dst.id, dst.harness).catch(() => null);
      if (!dependent || isSettledWorkItem(dependent)) continue;

      // All of the dependent's blockers must now be settled.
      const blockerEdges = await listIn(edge.dst, { rel: 'blocks' });
      let allClear = true;
      for (const be of blockerEdges) {
        const src = workItemIdFromRef(be.src);
        if (!src) continue;
        if (src.id === wi.id) continue; // the one that just settled
        const blocker = await getItem(src.id, src.harness).catch(() => null);
        if (blocker && !isSettledWorkItem(blocker)) {
          allClear = false;
          break;
        }
      }
      if (!allClear) continue;

      await emit({
        key: `work-item:unblocked:${dependent.id}`,
        summary: `${dependent.id} is UNBLOCKED — its last blocker (${wi.id}) settled: ${dependent.title}`,
        payload: { id: dependent.id, clearedBy: wi.id, harness: dependent.harness, title: dependent.title },
        to: dependent.assignee ? [dependent.assignee] : [],
        source: 'work-items',
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A missing event_awaits relation = pre-migration-163 substrate (or a
    // partial test schema) — expected fail-soft, not warn-worthy noise.
    if (/does not exist/.test(msg)) return;
    console.warn(`[work-items-events] settled-event emit failed for ${wi.id}: ${msg}`);
  }
}
