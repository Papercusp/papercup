/**
 * Composed event awaits — REGISTRATION (composable-event-awaits-2026-07-11 P-003).
 *
 * `registerComposedAwait` turns a threshold-tree spec into persisted rows: validate (caps +
 * no-`not`), compute each node's BIRTH state bottom-up (a leaf is born-satisfied iff its key
 * is already latched per the EI-9270 announced-gate pattern), short-circuit a born-satisfied
 * ROOT to `already_satisfied` WITHOUT registering (D-004), else insert the tree — seeding each
 * node's fired_count with its born-satisfied children and PRUNING those satisfied subtrees (a
 * pruned child is represented purely by the +1 it contributes to its parent's seed, never as a
 * live row). The fire path (engine.ts) then only ever sees the still-open part of the tree.
 *
 * Pure spec logic is in compose-spec.ts; PG is in compose-store.ts. This module has no engine
 * import (no cycle) — the wake pump is only reached from engine.ts's fire path.
 */

import { keyMatchesPattern } from './pattern';
import { findAnnouncementsForKey, listActiveAnnouncements } from './store';
import {
  classifyNode,
  flattenLeaves,
  normalizeRoot,
  resolveLeafKey,
  validateSpec,
  type ComposedLeafSpec,
  type ComposedSpec,
} from './compose-spec';
import {
  insertComposedLeaf,
  insertInteriorNode,
  insertRootAnchor,
  insertRootNode,
} from './compose-store';
import { AWAIT_DEFAULT_TIMEOUT_SEC, AWAIT_MAX_TIMEOUT_SEC, type TimeoutBehavior, type WakeHandle } from './types';

export interface RegisterComposedInput {
  subscriberId: string;
  spec: ComposedSpec;
  wakeHandle?: WakeHandle | null;
  note?: string | null;
  /** Root deadline in seconds (root-only timeout, D-003). Defaults to the shared 30-min
   *  fallback; clamped to the shared 7-day max. A composed tree always carries a deadline so a
   *  never-completing tree is auto-woken (or lapsed) rather than hanging forever. */
  timeoutSec?: number | null;
  /** What the deadline does: 'wake' (default) delivers a partial-state timeout wake; 'expire'
   *  lapses the tree silently. */
  timeoutBehavior?: TimeoutBehavior;
}

export type RegisterComposedResult =
  | { registered: true; rootId: number; anchorAwaitId: number; leafCount: number; depth: number }
  | { registered: false; alreadySatisfied: true; fired: Array<{ event: string }> };

/** Birth state of a spec node, computed bottom-up before any row is written. */
type Birth =
  | { kind: 'leaf'; satisfied: boolean; leaf: ComposedLeafSpec }
  | { kind: 'combinator'; satisfied: boolean; seed: number; required: number; spec: ComposedSpec; children: Birth[] };

/**
 * Is a leaf already satisfied at registration time? Only ANNOUNCED gates (EI-9270) are
 * retro-detectable — a plain fire-and-forget event leaves no queryable trace, so a leaf on a
 * non-announced key is (correctly) never born-satisfied and simply waits. A leaf carrying a
 * `when` payload filter is never born-satisfied either: an announcement carries no payload to
 * test the filter against, so we cannot prove it held — we wait for a real, filterable fire.
 */
async function leafBornSatisfied(leaf: ComposedLeafSpec): Promise<boolean> {
  if (leaf.when != null) return false;
  const key = resolveLeafKey(leaf.event);
  if (key.includes('*')) {
    // Glob leaf: latched iff some fired announcement's key matches the glob.
    const anns = await listActiveAnnouncements({ unfiredOnly: false, limit: 200 });
    return anns.some((a) => a.firedReason === 'event' && keyMatchesPattern(key, a.eventKey));
  }
  const anns = await findAnnouncementsForKey(key);
  return anns.some((a) => a.firedReason === 'event');
}

async function computeBirth(spec: ComposedSpec): Promise<Birth> {
  const c = classifyNode(spec);
  if (c.kind === 'leaf') {
    const leaf: ComposedLeafSpec = { event: c.event, when: c.when };
    return { kind: 'leaf', satisfied: await leafBornSatisfied(leaf), leaf };
  }
  const children = await Promise.all(c.children.map(computeBirth));
  const seed = children.filter((ch) => ch.satisfied).length;
  return { kind: 'combinator', satisfied: seed >= c.required, seed, required: c.required, spec, children };
}

/** The leaves that were already satisfied at birth (reported back on already_satisfied). */
function bornSatisfiedLeaves(birth: Birth): ComposedLeafSpec[] {
  if (birth.kind === 'leaf') return birth.satisfied ? [birth.leaf] : [];
  return birth.children.flatMap(bornSatisfiedLeaves);
}

/**
 * Register a composed threshold-tree await. Returns `already_satisfied` (no rows written) when
 * the tree is born-satisfied, otherwise the persisted { rootId, anchorAwaitId }.
 *
 * Non-transactional by design (matching the rest of the await store): a crash mid-insert leaves
 * a PARTIAL tree, but that is fail-SAFE — every node's required_count is fixed from the FULL
 * child count at insert, so a missing child can only make the tree hang (never falsely trip),
 * and the root's deadline then times it out. A false wake is impossible; a missed wake degrades
 * to the timeout backstop, exactly as a plain register-after-the-emit race does today.
 */
export async function registerComposedAwait(input: RegisterComposedInput): Promise<RegisterComposedResult> {
  const spec = normalizeRoot(input.spec);
  const { leaves, depth } = validateSpec(spec);

  const birth = await computeBirth(spec);
  if (birth.satisfied) {
    return {
      registered: false,
      alreadySatisfied: true,
      fired: bornSatisfiedLeaves(birth).map((l) => ({ event: l.event })),
    };
  }

  // birth is a combinator (a bare-leaf root was wrapped by normalizeRoot) and NOT born-satisfied.
  if (birth.kind !== 'combinator') {
    // Unreachable given normalizeRoot, but keep the types honest.
    throw new Error('registerComposedAwait: normalized root is not a combinator');
  }

  const timeoutSec = clampTimeout(input.timeoutSec);
  const root = await insertRootNode({
    subscriberId: input.subscriberId,
    requiredCount: birth.required,
    firedCount: birth.seed,
    spec,
    wakeHandle: input.wakeHandle ?? null,
    note: input.note ?? null,
    timeoutSec,
    timeoutBehavior: input.timeoutBehavior ?? 'wake',
  });
  const anchorAwaitId = await insertRootAnchor({
    subscriberId: input.subscriberId,
    rootId: root.id,
    wakeHandle: input.wakeHandle ?? null,
    note: input.note ?? null,
  });

  // Insert the still-open part of the tree under the root (satisfied subtrees are pruned —
  // already counted in the seeded fired_count above / on each interior node below).
  await insertOpenChildren(birth.children, root.id, root.id, input.subscriberId, input.note ?? null);

  return { registered: true, rootId: root.id, anchorAwaitId, leafCount: leaves.length, depth };
}

async function insertOpenChildren(
  children: Birth[],
  parentNodeId: number,
  rootId: number,
  subscriberId: string,
  note: string | null,
): Promise<void> {
  for (const child of children) {
    if (child.satisfied) continue; // pruned — represented by the parent's seed
    if (child.kind === 'leaf') {
      await insertComposedLeaf({
        subscriberId,
        eventKey: resolveLeafKey(child.leaf.event),
        nodeId: parentNodeId,
        rootId,
        when: child.leaf.when,
        note,
      });
    } else {
      const node = await insertInteriorNode({
        rootId,
        parentId: parentNodeId,
        subscriberId,
        requiredCount: child.required,
        firedCount: child.seed,
        note,
      });
      await insertOpenChildren(child.children, node.id, rootId, subscriberId, note);
    }
  }
}

function clampTimeout(sec: number | null | undefined): number {
  const v = sec == null ? AWAIT_DEFAULT_TIMEOUT_SEC : sec;
  if (!Number.isFinite(v) || v < 1) return AWAIT_DEFAULT_TIMEOUT_SEC;
  return Math.min(v, AWAIT_MAX_TIMEOUT_SEC);
}

/** Re-export the pure count helper so the tool surface (P-004) can size a spec without a DB. */
export function countLeaves(spec: ComposedSpec): number {
  return flattenLeaves(normalizeRoot(spec)).length;
}
