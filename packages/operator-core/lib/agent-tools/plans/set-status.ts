/**
 * plans:set-status — flip one OR many items' stored status token.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.2.
 *
 * Surgical line edit: find the item line by its P-NNN id, swap the
 * backticked status token. Whitespace, item text, blocked-by, and
 * decision refs are preserved verbatim.
 *
 * Writes inside a lock. Auto-bumps frontmatter updated:.
 *
 * Bulk by default (the house keyed-array contract, bulk-endpoint-standardization-
 * 2026-06-21): single { slug, itemId, status }, many of one plan to one status
 * { slug, itemIds:[…], status }, or heterogeneous items:[{ slug, itemId, status, …
 * }] → { ok, results:[{ ok, slug, itemId, oldStatus, newStatus, … | error }],
 * counts }. Correlate by { slug, itemId } not array position; a per-item
 * claim_conflict (or any failure) never fails the rest — top-level ok = "the batch
 * ran", counts.failed is the truth. Each result embeds what the single call returned
 * (claim, claimReleased, assignmentReleased, noteTruncated, …). The wip auto-claim,
 * auto-convert, needs-human push, and terminal-grip release run PER ITEM.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { ITEM_STATUSES, maskFences, parsePlan, NOTE_SUFFIX_RE, type Importance } from './parser';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { emitPlanItemDoneEvent } from './plan-item-events';
import { isPlanDrained, emitFleetDrainedForPlan } from '../../fleet-drained-events';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { resolveAgentIdentity, isEphemeralMcpCallIdentity, type AgentIdentity } from '../coordination/identity';
import { resolvePlanScope } from './source';
import { claimForWork, releaseOwnClaim } from '../../plan-items/claim-discipline';
import { getClaim } from '../../plan-items/claims';
import { autoConvertClaimIntent } from '../../plan-items/claim-holder';
import {
  convertPlanItem,
  findConvertedWorkItemByStamp,
  findCoverageWorkItems,
  looksLikeResidualClosure,
  TERMINAL_WORK_ITEM_STATES,
} from '../../plan-items/convert';
import { findAllLinkedWorkItems } from '../../plan-items/reconcile-linked-work-items';
import { setWorkItemState } from '../../work-items';
import { unassignItem } from '../../plan-items/assignments';
import { bestEffortOwnerUser, resolveAdoptedName } from '../../plan-items/agent-names';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';
import { holderContextReader, resolveHolderAdvisory } from '../coordination/holder-advisory';
// ⚠ THE CANONICAL MINTER, not a `${slug}#${item}` literal. `competing` is built by
// THIS function (agent-goal-ref.ts), so using it here is what makes the two sides
// of D-094's subtraction structurally unable to disagree — see the call sites below.
import { planItemRef } from '../../agent-goal-ref';
import { softText } from '../limits';

// Most-permissive (owner directive 2026-06-25): open to every role; the capability envelope is the
// real backstop. Was [...SU_ROLES, 'bee'].
const SU_BEE_ROLES = [...AGENT_ROLES] as const;

const STATUS = z.enum([...ITEM_STATUSES] as [string, ...string[]]);

const NOTE = softText(8000)
  .describe(
    'Optional SHORT comment appended inline to the item line — REQUIRED when status is `dropped` unless a nonblank `rationale` is supplied. REPLACES any note this same tool previously injected on the item (a repeat call to fix a typo overwrites, never stacks; EI-384). Anything beyond ~1000 chars is TRUNCATED inline (with a `…` marker + a noteTruncated flag), never rejected. For a longer explanation of WHY the status changed, use `rationale` instead — it is stored on the plan revision, not spliced into the item line.',
  );

const itemSpec = z.object({
  slug: z.string().min(1),
  item: z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'),
  status: STATUS.optional().describe('per-item status (else the batch `status`)'),
  note: NOTE.optional(),
  harness: harnessArg.describe('per-item harness (else the batch `harness` default)'),
  rationale: z
    .string()
    .optional()
    .describe('per-item revision rationale (else the batch `rationale`); satisfies the required reason for status `dropped`'),
  onlyIfNotTerminal: z.boolean().optional(),
  onlyIfNoOtherOpenCoverage: z.boolean().optional(),
  onlyIfNotCompleted: z.boolean().optional(),
});

const argsSchema = z
  .object({
    harness: harnessArg,
    slug: z.string().min(1).optional(),
    item: z.string().regex(/^P-\d{3,}$/, 'P-NNN form required').optional(),
    status: STATUS.optional(),
    note: NOTE.optional(),
    itemIds: z
      .array(z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'))
      .min(1)
      .max(200)
      .optional()
      .describe('flip MANY items of the SAME plan `slug` to the same `status` (homogeneous)'),
    items: z
      .array(itemSpec)
      .min(1)
      .max(200)
      .optional()
      .describe('flip many items at once — each { slug, item, status, note?, harness?, rationale? }'),
    rationale: z
      .string()
      .optional()
      .describe(
        'Optional except when status is `dropped`, where either a nonblank `note` or `rationale` is REQUIRED. Supply rationale when the *why* is too long for the inline item note. Stored on the plan revision (D-009).',
      ),
    onlyIfNotTerminal: z
      .boolean()
      .optional()
      .describe(
        'Non-destructive flip: SKIP any item that is already done/dropped instead of moving it off terminal (reported `skipped:"terminal_guard"`, ok:true). For AUTOMATED reflections that must never un-finish shipped work; a human reopening an item deliberately just omits it.',
      ),
    onlyIfNoOtherOpenCoverage: z
      .boolean()
      .optional()
      .describe(
        'Non-destructive TERMINAL flip: when flipping an item to `done` or `dropped`, SKIP it (reported `skipped:"coverage_guard"`, ok:true) if ANOTHER non-terminal work-item is still linked to this plan item (via the `implements` conversion edge, the `relates` coverage edge, or the `payload.plan_item` stamp). Stops ONE work-item closing or dropping from de-queueing a plan item other live work still covers (EI-19972048649686949; WI-38908 — a 1:N lane auto-closed on its first sibling). No effect on a non-terminal status. For AUTOMATED reflections; a human closing/abandoning the item deliberately just omits it.',
      ),
    onlyIfNotCompleted: z
      .boolean()
      .optional()
      .describe(
        'Non-destructive DROP: SKIP a `done` → `dropped` flip (reported `skipped:"completed_guard"`, ok:true) instead of downgrading finished work. Complements `onlyIfNotTerminal`, which by design permits terminal→terminal, and `onlyIfNoOtherOpenCoverage`, which only counts NON-terminal siblings and so cannot see the DONE work-item that actually completed the item (EI-20129670928216719). No effect on any status other than `dropped`. For AUTOMATED reflections; a human deliberately reclassifying finished work as abandoned just omits it.',
      ),
  })
  .refine(
    (a) =>
      (a.items?.length ?? 0) > 0 ||
      (Boolean(a.slug) && Boolean(a.status) && ((a.itemIds?.length ?? 0) > 0 || Boolean(a.item))),
    { message: 'pass { slug, item, status } for one, { slug, itemIds:[…], status } for many of one plan, or items:[{ slug, item, status }] for heterogeneous' },
  );

interface StatusItem {
  slug: string;
  itemId: string;
  status: string;
  note?: string;
  harness?: string;
  rationale?: string;
  /** Skip (don't flip) when the item is ALREADY terminal and this flip is non-terminal —
   *  for automated reflections that must never un-finish shipped work. See the guard
   *  inside the plan lock. */
  onlyIfNotTerminal?: boolean;
  /** Skip (don't flip) a →done/→dropped flip when another non-terminal work-item still
   *  covers this plan item — for automated reflections cascading a single work-item's
   *  terminal state (WI-38908 widened this from drop-only). See the coverage guard below. */
  onlyIfNoOtherOpenCoverage?: boolean;
  /** Skip (don't flip) a `done` →`dropped` flip — an automated cascade must never
   *  downgrade finished work. See `completedGuardTrips`. */
  onlyIfNotCompleted?: boolean;
}

/** Result payload — explicit so `withPlanLock`'s `T` is fixed by the
 *  type argument below rather than inferred from a union-returning
 *  mutator (which TS narrows to the first branch, leaving `T` unknown). */
type SetStatusValue =
  | {
      ok: true;
      oldStatus: string | null;
      newStatus: string;
      itemId: string;
      importance: Importance;
      /** WI-1830: computed inside the lock (race-safe) — this →done flip left the plan with
       *  zero open items, so the fleet's lane drained. False for every non-→done flip. */
      drainedPlan: boolean;
      /** memory-delivery-unification-2026-07-12 P-008: the item's text, captured
       *  inside the lock ONLY on a real →wip edge, so the claim-time recall port
       *  can query it without a second read. Undefined on every other flip. */
      wipItemText?: string;
    }
  | { ok: false; code: 'not_found' | 'item_not_found' }
  /** `onlyIfNotTerminal` tripped: the item is already done/dropped and the caller
   *  asked for a non-destructive flip. Carries the CURRENT status so the caller can
   *  report what it left alone. Not an error — see the `terminal_guard` branch below. */
  | { ok: false; code: 'terminal_guard'; currentStatus: string | null }
  /** `onlyIfNotCompleted` tripped: the item is `done` and an automated cascade tried to
   *  drop it. Not an error — see the `completed_guard` branch below. */
  | { ok: false; code: 'completed_guard'; currentStatus: string | null };

/**
 * Extract one item's `importance` from the plan body, glyph-agnostically,
 * the same way the parser does (the `importance:` keyword on the item line,
 * default `normal`). Used only on the needs-human transition to decide the
 * push gate, so the cost is bounded to that rare flip.
 */
export function itemImportance(body: string, itemId: string): Importance {
  const re = new RegExp(
    String.raw`^\s*[-*]\s+\*\*\s*` + itemId.replace(/-/g, '\\-') + String.raw`\s*\*\*[^\n]*$`,
    'm',
  );
  const m = re.exec(maskFences(body));
  if (!m) return 'normal';
  const im = /\bimportance:\s*(urgent|high|normal|low)\b/i.exec(m[0]);
  return im ? (im[1]!.toLowerCase() as Importance) : 'normal';
}

/**
 * P-020 push gate: notify only when an item TRANSITIONS into needs-human
 * (not a re-set of an already-needs-human item) and its importance is at
 * least `high`. Pure so it's unit-testable without the lock/IO path.
 */
export function shouldPushNeedsHuman(
  oldStatus: string | null,
  newStatus: string,
  importance: Importance,
): boolean {
  return (
    newStatus === 'needs-human' &&
    oldStatus !== 'needs-human' &&
    (importance === 'urgent' || importance === 'high')
  );
}

/**
 * EI-14699 — plan-item status → linked work_item state SYNC (the reverse of
 * reflect-rules.ts's work_item → plan-item direction).
 *
 * A plan item converted/promoted to a work_item stamps `payload.plan_item`; the
 * reflect rules mirror the WORK_ITEM's lifecycle onto the plan item. The reverse
 * had no path: flipping the PLAN ITEM to `blocked`/`needs-human` independently
 * (e.g. an owner-gated blocker recorded via plans:set-status) left the linked
 * work_item's own `state` untouched — so `scheduler:get_next` / the
 * `work-item:claimable` gate (which read work_item.state, not the plan item's
 * status) kept serving the item as claimable. Each fleet member then claimed it,
 * re-discovered the owner-gated blocker, released it, and the cycle repeated —
 * perpetual claim/release ping-pong that burned real fleet cycles (WI-3475,
 * WI-3467 each cycled 8+ times).
 *
 * This pure decider says which work_item state (if any) a plan-status flip must
 * reflect, given the work_item's CURRENT state so we never disturb work that is
 * already correctly placed:
 *   - plan → blocked/needs-human, while the work_item still sits CLAIMABLE
 *     (todo/open) ⇒ set the work_item `blocked` (for a feature-family item this
 *     populates the scheduler's `work_item_blocked` sidecar, ending the ping-pong).
 *   - plan reopened → todo FROM a blocked/needs-human status, while the work_item
 *     is still `blocked` (i.e. blocked by THIS sync) ⇒ return it to `todo`.
 * Every other flip maps to null — done/dropped (terminal-grip release), wip
 * (auto-claim), a re-set of the same status, or a work_item already elsewhere in
 * its lifecycle are all left to their existing owners. Transition-gated so a
 * routine re-set never yanks a work_item. Pure/injectable like shouldPushNeedsHuman
 * / reflectedStatus so the rule is unit-tested without the lock/PG path.
 */
export const PLAN_BLOCKED_STATUSES = new Set(['blocked', 'needs-human']);
/** The work_item states a claimable item can be in before we block it. work-item-status-full-unify
 *  (P-004/P-005): `open` is now the SINGLE claimable token for BOTH families; `todo` is retired but
 *  kept here as a TOLERANT read-superset so a not-yet-backfilled legacy row still blocks correctly. */
export const CLAIMABLE_WORK_ITEM_STATES = new Set(['todo', 'open']);
export function planSyncWorkItemState(
  oldPlanStatus: string | null,
  newPlanStatus: string,
  currentWorkItemState: string,
): 'blocked' | 'open' | null {
  if (newPlanStatus === oldPlanStatus) return null;
  if (PLAN_BLOCKED_STATUSES.has(newPlanStatus)) {
    return CLAIMABLE_WORK_ITEM_STATES.has(currentWorkItemState) ? 'blocked' : null;
  }
  if (
    newPlanStatus === 'todo' &&
    oldPlanStatus !== null &&
    PLAN_BLOCKED_STATUSES.has(oldPlanStatus) &&
    currentWorkItemState === 'blocked'
  ) {
    // work-item-status-full-unify (P-005): re-open onto the UNIFIED claimable token `open`
    // directly (was `todo`, which only reached 'open' via the legacy alias-fold + mis-reported
    // workItemSynced.state). The plan-item status stays `todo` (its own vocabulary is unchanged).
    return 'open';
  }
  return null;
}

/** Caller-DX (watchdog P-006): the inline note is spliced into a single plan
 *  item line, so an over-long note bloats the file. Truncate-with-marker
 *  instead of rejecting — the agent never bounces; the long form belongs in
 *  `rationale` (stored on the plan revision). */
const NOTE_INLINE_MAX = 1000;
export function truncateInlineNote(note: string | undefined): {
  note: string | undefined;
  truncated: boolean;
} {
  if (note === undefined) return { note: undefined, truncated: false };
  if (note.length <= NOTE_INLINE_MAX) return { note, truncated: false };
  return { note: note.slice(0, NOTE_INLINE_MAX - 1) + '…', truncated: true };
}

/** D-002/P-007: departing from a plan is legitimate, but never silent. Keep this
 * per-item (rather than a whole-args schema refinement) so one malformed drop in a
 * heterogeneous bulk call fails only itself under the house bulk contract. */
export function droppedReasonMissing(input: {
  status: string;
  note?: string;
  rationale?: string;
}): boolean {
  return (
    input.status === 'dropped' &&
    !(typeof input.note === 'string' && input.note.trim().length > 0) &&
    !(typeof input.rationale === 'string' && input.rationale.trim().length > 0)
  );
}

/** A terminal status — the item is finished; it is held + assigned by no one. */
export function isTerminalStatus(status: string): boolean {
  return status === 'done' || status === 'dropped';
}

/**
 * Should a non-destructive flip be SKIPPED because the item is already finished?
 *
 * Pure + exported (same posture as `terminalFlipConflict` below) so the rule is unit-tested
 * without the PG/lock path. True ⇒ leave the item exactly as it is.
 *
 * The invariant: an AUTOMATED reflection must never move a plan item from terminal to
 * NON-terminal, because the event driving it may carry no information about completion at
 * all — `work_items:release` is ownership, not doneness. Terminal→terminal (done→dropped)
 * is a legitimate reclassification and is NOT skipped; a caller that omits the flag (a human
 * deliberately reopening an item) is unaffected.
 */
export function terminalGuardTrips(opts: {
  onlyIfNotTerminal: boolean | undefined;
  currentStatus: string | null;
  nextStatus: string;
}): boolean {
  if (!opts.onlyIfNotTerminal) return false;
  if (opts.currentStatus === null) return false;
  return isTerminalStatus(opts.currentStatus) && !isTerminalStatus(opts.nextStatus);
}

/**
 * Should an AUTOMATED drop be SKIPPED because the plan item is already FINISHED?
 *
 * EI-20129670928216719. The invariant: a cascade must never downgrade `done` → `dropped`.
 * A `done` plan item is shipped, verified work; the drop of SOME linked work-item is never
 * evidence that it became abandoned.
 *
 * This is a THIRD guard because the case falls between the existing two, by each one's own
 * contract — patching either in isolation is wrong:
 *   - `terminalGuardTrips` deliberately permits terminal→terminal (see its docstring), and
 *     that behaviour is PINNED by set-status.test.ts ('done'→'dropped' ⇒ false). Widening it
 *     would break a deliberate, tested contract.
 *   - the coverage guard counts only NON-terminal siblings, so the DONE work-item that
 *     actually completed the plan item never registers as coverage.
 *
 * Observed live: dropping WI-37872 — a follow-on merely `relates`-linked to
 * fix-0014-platform-defects-2026-08-10#P-005 — flipped that already-`done` item to
 * `dropped` 67ms later. P-005's real completer, the sibling WI-37735, was `done` and so
 * invisible to the coverage guard. The same asymmetry was already fixed for the sibling
 * `plan-item-reflect:release` rule (EI-19295826179470465); this closes it for the drop path.
 *
 * SAFETY (why this can never fire on the item that triggered it): the reflect drop cascade
 * only runs when the triggering work-item's state maps to `dropped` — `deprecated|closed|
 * dropped`, never `done` (plan-items/reflect-rules.ts `reflectedStatus`). So the guard needs
 * no self-exclusion, unlike the coverage guard.
 *
 * Pure + exported so the rule is unit-tested without the PG/lock path. Evaluated INSIDE the
 * plan lock, where `currentStatus` is race-safe — the coverage guard's pre-lock read would
 * not be. True ⇒ leave the item exactly as it is.
 */
export function completedGuardTrips(opts: {
  onlyIfNotCompleted: boolean | undefined;
  currentStatus: string | null;
  nextStatus: string;
}): boolean {
  if (!opts.onlyIfNotCompleted) return false;
  return opts.currentStatus === 'done' && opts.nextStatus === 'dropped';
}

/** The minimal claim shape the terminal-flip guard reads (a subset of PlanItemClaim). */
export interface HolderInfo {
  owner: string;
  ownerLabel: string | null;
  intent: string;
  expiresTs: string;
  expired: boolean;
}

/**
 * WI-2156 (completion-integrity, terminal-flip holdership): decide whether an AGENT's
 * terminal flip (done/dropped) must be REFUSED because a LIVE peer holds the item's
 * claim. The `wip` path claims-before-work and rejects a live peer claim, but the close
 * path historically skipped the check — so any agent could terminal-flip an item a live
 * peer was mid-verifying, voiding its lease and recording a completion the flipper never
 * did (ornith run-10: one member bulk-flipped 6 items its sibling held). This is the
 * prevention leg; the behaviour-suite only catches such bare flips post-hoc.
 *
 * Pure + injectable (like shouldPushNeedsHuman / releaseTerminalGrips) so the rule is
 * unit-tested without the PG/lock path. Returns the blocking holder, or null to ALLOW.
 * Allow when: the flip is non-terminal; there is no agent caller (a human / `principal`
 * session — the guard binds agents, not the owner); the item is unheld; the claim is
 * expired/lapsed (a dead peer must never wedge closure — the SAME liveness the wip path
 * uses); or the caller IS the holder (closing your own held item is the completion path).
 */
export function terminalFlipConflict(opts: {
  status: string;
  agentOwnerId: string | null;
  holder: HolderInfo | null;
}): { owner: string; ownerLabel: string | null; intent: string; expiresTs: string } | null {
  if (!isTerminalStatus(opts.status)) return null;
  if (!opts.agentOwnerId) return null;
  const h = opts.holder;
  if (!h || h.expired || h.owner === opts.agentOwnerId) return null;
  return { owner: h.owner, ownerLabel: h.ownerLabel, intent: h.intent, expiresTs: h.expiresTs };
}

/**
 * Terminal-flip cleanup (claim-discipline + EI-2298). A done/dropped item must
 * carry NEITHER a live claim NOR a durable assignment:
 *  - the CLAIM is the caller's live lease — only an attributable agent holds one,
 *    so it's released by the caller's ownerId (null caller / principal → skip);
 *  - the ASSIGNMENT is item-level and may belong to a DIFFERENT agent than the
 *    one closing the item (e.g. a verify-first `done` set by a peer). If it is
 *    left dangling the item sits done+assigned-idle forever and any dispatcher
 *    that re-pokes assigned-idle items re-targets the stale assignee endlessly
 *    (EI-2298). So clear it UNCONDITIONALLY on a terminal flip.
 * Deps are injected so the invariant is unit-testable without the lock/PG path
 * (mirrors shouldPushNeedsHuman / truncateInlineNote). Both legs are fail-safe:
 * a release hiccup is logged and reported as not-released, never thrown.
 */
export async function releaseTerminalGrips(opts: {
  status: string;
  agentOwnerId: string | null;
  scope: { workspaceId: string; harnessSlug: string };
  slug: string;
  itemId: string;
  releaseClaim: (
    workspaceId: string,
    harnessSlug: string,
    planSlug: string,
    itemId: string,
    owner: string,
  ) => Promise<boolean>;
  clearAssignment: (
    workspaceId: string,
    harnessSlug: string,
    planSlug: string,
    itemId: string,
  ) => Promise<unknown | null>;
}): Promise<{ claimReleased: boolean; assignmentReleased: boolean }> {
  if (!isTerminalStatus(opts.status)) {
    return { claimReleased: false, assignmentReleased: false };
  }
  let claimReleased = false;
  if (opts.agentOwnerId) {
    claimReleased = await opts
      .releaseClaim(opts.scope.workspaceId, opts.scope.harnessSlug, opts.slug, opts.itemId, opts.agentOwnerId)
      .catch((e) => {
        console.warn('[plans:set-status] claim release failed:', (e as Error)?.message ?? e);
        return false;
      });
  }
  const assignmentReleased = await opts
    .clearAssignment(opts.scope.workspaceId, opts.scope.harnessSlug, opts.slug, opts.itemId)
    .then((released) => released != null)
    .catch((e) => {
      console.warn('[plans:set-status] assignment release failed:', (e as Error)?.message ?? e);
      return false;
    });
  return { claimReleased, assignmentReleased };
}

/**
 * →todo claim release (EI-5822). A →todo flip is the documented "hand it back
 * to the pool" affordance, but historically only released the item's stored
 * STATUS token — the caller's live coord CLAIM LEASE (what actually blocks a
 * peer's next wip-flip with claim_conflict) survived until its TTL expired.
 * Net: "released via →todo, all yours" was a false affordance — the next
 * claimant had to wait out the lease or ask for an explicit release.
 *
 * Release ONLY the caller's OWN claim (releaseClaim no-ops if the caller
 * doesn't hold it — this must never void a LIVE PEER's lease); unlike a
 * terminal flip, do NOT touch the durable assignment: →todo means "I'm done
 * working it right now", not "I'm done owning it" — the item may legitimately
 * stay assigned while its lease frees up for the assignee (or anyone) to
 * re-claim. Deps injected so this is unit-testable without the PG/lock path
 * (mirrors releaseTerminalGrips). Fail-safe: a release hiccup is logged and
 * reported as not-released, never thrown.
 */
export async function releaseTodoClaim(opts: {
  status: string;
  agentOwnerId: string | null;
  scope: { workspaceId: string; harnessSlug: string };
  slug: string;
  itemId: string;
  releaseClaim: (
    workspaceId: string,
    harnessSlug: string,
    planSlug: string,
    itemId: string,
    owner: string,
  ) => Promise<boolean>;
}): Promise<{ claimReleased: boolean }> {
  if (opts.status !== 'todo' || !opts.agentOwnerId) {
    return { claimReleased: false };
  }
  const claimReleased = await opts
    .releaseClaim(opts.scope.workspaceId, opts.scope.harnessSlug, opts.slug, opts.itemId, opts.agentOwnerId)
    .catch((e) => {
      console.warn('[plans:set-status] todo claim release failed:', (e as Error)?.message ?? e);
      return false;
    });
  return { claimReleased };
}

/** The marker `flipStatusInBody` injects for a caller-supplied `note` (EI-384) —
 *  matches from the marker to end-of-line so a REPEAT call replaces the whole
 *  previously-injected note instead of appending another one. Re-exported (as
 *  the historical local name) from the canonical `@papercusp/plan-parser`
 *  definition (EI-522) — the parser needs this SAME pattern to exclude a
 *  note's free prose from structured D-NNN ref extraction, so it is now the
 *  single source of truth; this file must never redefine its own copy. */
export const NOTE_MARKER_RE = NOTE_SUFFIX_RE;

export function flipStatusInBody(
  body: string,
  itemId: string,
  newStatus: string,
  note?: string,
): { newBody: string; found: boolean; oldStatus: string | null } {
  // Match a specific item id by anchoring on it.
  const re = new RegExp(
    String.raw`^(\s*[-*]\s+\*\*\s*` + itemId.replace(/-/g, '\\-') + String.raw`\s*\*\*\s+\x60)([a-z-]+)(\x60\s+.*)$`,
    'm',
  );
  // Search the fence-masked body so a `- **P-NNN**` line inside a
  // worked-example code fence is never targeted. Match index is valid
  // against the real body (maskFences preserves length); the item line
  // is outside any fence, so captured groups equal the real text.
  const m = re.exec(maskFences(body));
  if (!m) return { newBody: body, found: false, oldStatus: null };

  const oldStatus = m[2] ?? '';
  let rest = m[3] ?? '';
  if (note) {
    // EI-384: two bugs in the old `rest = \`${rest} (${note.replace(/[()]/g, '')})\``
    // form — (1) it silently stripped parens from the caller's OWN note text
    // (turning "(a)" into "a" — a meaning-changing mangle, not cosmetic), and
    // (2) a repeat set-status call on the same item (e.g. fixing a typo'd note)
    // APPENDED a second parenthetical instead of replacing the first, so notes
    // accumulated without bound. Fixed by (1) never touching the note's own
    // characters, and (2) using a distinctive, unambiguous " — note: " marker so
    // an existing INJECTED note (this function's own prior output) can be found
    // and replaced — never appended to — while ordinary item text that happens
    // to end in parens is left alone (it never matches this marker).
    rest = rest.replace(NOTE_MARKER_RE, '');
    rest = `${rest} — note: ${note}`;
  }
  const newLine = `${m[1] ?? ''}${newStatus}${rest}`;
  // Index-based splice rather than body.replace(re, newLine): a string
  // replacement argument would interpret dollar-sign substitution
  // sequences in the item text as patterns, and body.replace would
  // re-scan the real body and could hit a fenced match first. m.index
  // and m[0].length come from the masked body but are valid against
  // the real body since maskFences preserves length.
  const newBody = body.slice(0, m.index) + newLine + body.slice(m.index + m[0].length);
  return { newBody, found: true, oldStatus };
}

/**
 * Flip ONE item's status, returning the self-describing bulk result. This carries the
 * FULL single-call logic per item — wip auto-claim (+ claim_conflict reject as a
 * per-item failure), best-effort auto-convert, the surgical line edit inside the
 * lock, the needs-human push gate, terminal-grip release, and the sync invalidate.
 * The prior early-returns (claim_conflict, busy, not_found/item_not_found) all become
 * this item's { ok:false, … } result; one failure never fails the rest.
 */
async function setStatusOne(it: StatusItem, ctx: UnifiedToolContext): Promise<BulkItemResult> {
  if (droppedReasonMissing(it)) {
    return {
      ok: false,
      slug: it.slug,
      itemId: it.itemId,
      error: 'dropped_reason_required',
      hint:
        "status:'dropped' records an intentional departure from the plan and requires a nonblank `note` (preferred; visible inline forever) or `rationale` (stored on the plan revision)",
    };
  }

  const sctx = harnessScopedCtx(it.harness, ctx);
  const harnessSlug = resolveCtxHarnessSlug(sctx);

  // Caller-DX (P-006): truncate an over-long inline note instead of rejecting.
  const { note: inlineNote, truncated: noteTruncated } = truncateInlineNote(it.note);

  // Claim discipline (claim-discipline-enforcement-2026-06-10): the flip IS
  // the claim. An agent flipping an item to `wip` auto-claims it here, and a
  // LIVE peer claim rejects the flip — the collision the lease exists to
  // stop. Terminal flips (done/dropped) release the caller's claim: a
  // finished item is held by no one (and done NEVER auto-claims — owner
  // decision). Humans are exempt: a caller with no attributable agent
  // identity OR a `principal` one (the kanban drag / in-process UI path)
  // skips the discipline entirely — it binds agents, not the owner.
  let agentId: AgentIdentity | null = null;
  try {
    agentId = resolveAgentIdentity(ctx);
  } catch {
    agentId = null;
  }
  if (agentId?.source === 'principal') agentId = null;
  // EI-8509: a →wip flip auto-claims the item under the CALLER's own identity — refuse
  // it outright when the caller is scripts/mcp-call.mjs's auto-generated fallback
  // identity (`mcp-call-<pid>`), a one-shot stateless process with no liveness behind
  // it. Left unguarded, the very same "placed but nothing ever executes it" failure
  // EI-8509 found on work_items:claim happens here too (this tool auto-claims on wip).
  if (agentId && it.status === 'wip' && isEphemeralMcpCallIdentity(agentId.ownerId)) {
    return {
      ok: false,
      slug: it.slug,
      itemId: it.itemId,
      error: 'ephemeral_mcp_call_identity',
      hint:
        'Refused: →wip auto-claims under the caller\'s identity, and this call arrived as scripts/mcp-call.mjs\'s auto-generated fallback (mcp-call-<pid>) — a one-shot process with no heartbeat/liveness and no fleet cup behind it (EI-8509). Spawn a real cup and let IT flip this item to wip.',
    };
  }
  let claim: { claimId: string; autoClaimed: boolean } | null = null;
  if (agentId && it.status === 'wip') {
    const scope = await resolvePlanScope(harnessSlug ? { harnessSlug } : {});
    const ownerName = await resolveAdoptedName(scope.workspaceId, agentId.ownerId).catch(() => null);
    const outcome = await claimForWork({
      workspaceId: scope.workspaceId,
      harnessSlug: scope.harnessSlug,
      planSlug: it.slug,
      itemId: it.itemId,
      owner: agentId.ownerId,
      ownerLabel: agentId.ownerLabel,
      ownerName,
      ownerUser: bestEffortOwnerUser(ctx),
      intent: `plans:set-status ${it.itemId} → wip`,
    });
    if (!outcome.ok) {
      // P-027 / D-055 A5 — the PLAN-ITEM analog of the work-item claim conflict.
      // Today this reports only THAT a live peer holds the item; the reader's
      // actual question is whether to wait for them. Advisory + total: the
      // refusal above is already decided and cannot be changed here.
      //
      // D-094: the plan-item ref is the subject, so the holder is never reported
      // as also competing on the very item whose refusal is being explained.
      const holderContext = await resolveHolderAdvisory({
        holder: outcome.holder?.owner,
        reader: holderContextReader(ctx as Parameters<typeof holderContextReader>[0]),
        // ⚠ THE QUALIFIED REF, NOT THE BARE ITEM ID — found by the LIVE exercise,
        // invisible to every fixture. `competing` holds plan-item refs in
        // `<planSlug>#<itemId>` form, so passing `it.itemId` ('P-006') compared a
        // bare id against a qualified ref, the subtraction never fired, and the
        // holder was reported as competing on the very item being refused: D-094's
        // exact defect, surviving at this surface because the SUBJECT was in a
        // different notation than the REF. A fixture cannot catch it — the author
        // picks both sides of the comparison.
        subjectRef: planItemRef(it.slug, it.itemId),
      });
      return {
        ok: false,
        slug: it.slug,
        itemId: it.itemId,
        error: 'claim_conflict',
        reason: outcome.reason,
        holder: outcome.holder ?? null,
        ...(holderContext ? { holderContext } : {}),
        hint: 'the item is being worked by a live peer — coordinate with the holder (coord:send) or pick another item; fleet:assignments { plan } shows who holds what',
      };
    }
    claim = { claimId: outcome.claimId, autoClaimed: !outcome.alreadyHeld };

    // work-queue-completeness Phase A (ENFORCEMENT): when the auto-convert flag is ON,
    // the wip flip's auto-claim ALSO mints (or idempotently resumes) a tracked work_item
    // via convertPlanItem — so flipping an item to wip never leaves untracked work.
    // convertPlanItem re-runs the policy-checked lease (idempotent against the claim we
    // just took above), so it is safe here. BEST-EFFORT: wrapped so a convert failure
    // (or a flag-IO error) NEVER breaks the status flip — the claim already succeeded.
    // Fail-safe to OFF on a flag-read error.
    const autoConvert = await getFlag(FLAGS.PLAN_ITEM_CLAIM_AUTO_CONVERT, 'system').catch(() => false);
    if (autoConvert) {
      await convertPlanItem({
        workspaceId: scope.workspaceId,
        harnessSlug: scope.harnessSlug,
        planSlug: it.slug,
        itemId: it.itemId,
        owner: agentId.ownerId,
        ownerLabel: agentId.ownerLabel,
        ownerName,
        ownerUser: bestEffortOwnerUser(ctx),
        // Built by the shared helper, not a literal, so the non-conflict holder
        // projection can tell this MECHANISM string apart from a declared goal
        // (P-029/D-060) without a detector that drifts from the writer.
        intent: autoConvertClaimIntent(it.itemId),
      }).catch((e) =>
        console.warn(
          `[plans:set-status] auto-convert ${it.slug}#${it.itemId} failed:`,
          (e as Error)?.message ?? e,
        ),
      );
    }
  }

  // WI-2156 (completion-integrity, terminal-flip holdership): a done/dropped flip by an
  // AGENT who is NOT the item's live claim holder is REFUSED with the same per-item
  // claim_conflict shape as the wip path — you cannot close (and silently void the lease
  // on) an item a live peer is mid-verifying. Humans/principal callers are exempt
  // (agentId is null for them, above). Read-then-decide: the plan lock below still
  // serializes the actual byte write; this pre-lock read matches the wip path's own
  // claim-before-flip ordering, and the TTL liveness means a dead peer's lapsed claim
  // never wedges closure. A getClaim hiccup fails OPEN (holder null → allow) so a
  // coordination-store blip never blocks a legitimate completion.
  if (agentId && isTerminalStatus(it.status)) {
    const scope = await resolvePlanScope(harnessSlug ? { harnessSlug } : {});
    const holder = await getClaim(scope.workspaceId, scope.harnessSlug, it.slug, it.itemId).catch(
      () => null,
    );
    const conflict = terminalFlipConflict({ status: it.status, agentOwnerId: agentId.ownerId, holder });
    if (conflict) {
      // P-027: the same disclosure on the TERMINAL-flip refusal. This is the
      // sharper of the two cases — you believe the item is finished and the
      // holder does not, so what they are still doing on it is exactly the
      // disagreement to resolve before escalating.
      const holderContext = await resolveHolderAdvisory({
        holder: conflict.owner,
        reader: holderContextReader(ctx as Parameters<typeof holderContextReader>[0]),
        // The qualified ref — same reason as the wip-claim path above.
        subjectRef: planItemRef(it.slug, it.itemId),
      });
      return {
        ok: false,
        slug: it.slug,
        itemId: it.itemId,
        error: 'claim_conflict',
        reason: `${it.status} refused — ${conflict.ownerLabel ?? conflict.owner} holds a live claim on this item; only the holder closes it`,
        holder: conflict,
        ...(holderContext ? { holderContext } : {}),
        hint: 'a live peer is working this item — coordinate with the holder (coord:send) and let them close it, or pick another item; fleet:assignments { plan } shows who holds what',
      };
    }
  }

  // EI-19972048649686949: dropping ONE work-item linked to a plan item must not
  // cascade `dropped` onto the plan item when ANOTHER non-terminal work-item still
  // covers it (e.g. dropping a hand-filed duplicate of an already-claimed
  // implementer left the real coverage silently de-queued). Opt-in — automated
  // reflections only, see plan-items/reflect-rules.ts — and read-only, so it is
  // checked OUTSIDE the plan lock, before it, like the claim-conflict check above.
  // `findAllLinkedWorkItems` unions all three linkage truth sources (`implements`
  // conversion edge, `relates` coverage edge, `payload.plan_item` stamp), unlike
  // the residual-coverage advisory below which only reads `relates`. By the time
  // this reaction fires, the triggering work-item's OWN state is already committed
  // terminal, so it self-excludes from `stillCovered` without any special-casing.
  // Best-effort: a lookup hiccup must never block a legitimate flip.
  //
  // WI-38908 WIDENED THIS FROM `dropped` TO EITHER TERMINAL STATUS. It was originally
  // drop-only on the assumption that a `done` cascade means the work genuinely finished
  // — true only when ONE work-item implements the plan item. For a 1:N lane (a fix-loop
  // item with many bugs stamped to it) completing the FIRST sibling flipped the whole
  // item `done` while the rest were still open, which both hides open blockers from the
  // release criteria and — because a plan-scoped claim spec admits through that item —
  // stops anyone claiming them. Live: sidestage-public-release-testing-2026-08-14#P-009
  // auto-closed 3x in ~1h with 8+ non-terminal stamped bugs; a leader hand-restored it
  // each time. Marking terminal and abandoning are the same hazard here: both de-queue
  // an item other live work still covers, so both take the guard. When the LAST sibling
  // goes terminal, coverage is empty and the flip proceeds — 1:1 behaviour is unchanged.
  if (it.onlyIfNoOtherOpenCoverage && (it.status === 'dropped' || it.status === 'done')) {
    try {
      const linked = await findAllLinkedWorkItems(it.slug, it.itemId);
      const stillCovered = linked.filter((wi) => !TERMINAL_WORK_ITEM_STATES.has(wi.state));
      if (stillCovered.length > 0) {
        return {
          ok: true,
          slug: it.slug,
          itemId: it.itemId,
          skipped: 'coverage_guard',
          coveredBy: stillCovered.map((wi) => wi.id),
          reason:
            `left open — ${stillCovered.length} other linked work-item(s) ` +
            `(${stillCovered.map((wi) => wi.id).join(', ')}) still cover this plan item; ` +
            `marking it ${it.status} would de-queue work that is not finished`,
        };
      }
    } catch (e) {
      console.warn(
        `[plans:set-status] coverage guard ${it.slug}#${it.itemId} failed:`,
        (e as Error)?.message ?? e,
      );
    }
  }

  const rev = planRevisionCapture(
    ctx as PlanRevisionCtx,
    it.slug,
    it.rationale,
    harnessSlug ? { harnessSlug } : {},
  );
  const result = await withPlanLock<SetStatusValue>(
    ctx as never,
    {
      slug: it.slug,
      intent: `plans:set-status ${it.itemId} → ${it.status}`,
      ...(harnessSlug ? { harnessSlug } : {}),
      afterWrite: rev.afterWrite,
    },
    async (current): Promise<{ newBody: string | null; value: SetStatusValue }> => {
      if (current === null) {
        return { newBody: null, value: { ok: false, code: 'not_found' } };
      }
      const { newBody, found, oldStatus } = flipStatusInBody(current, it.itemId, it.status, inlineNote);
      if (!found) {
        return { newBody: null, value: { ok: false, code: 'item_not_found' } };
      }
      // Non-destructive flip: refuse to move an item OFF a terminal status.
      // Read INSIDE the lock (like drainedPlan/wipItemText above) so the decision is
      // race-safe against a concurrent flip rather than a stale pre-lock read.
      //
      // Why this exists: an AUTOMATED reflection must never un-finish shipped work.
      // `work_items:release` is an OWNERSHIP event — it carries no information about
      // completion — but plan-items/reflect-rules.ts reflected it as a flat
      // `status:'todo'`, guarded only on the WORK-ITEM's state, never the plan item's.
      // So releasing a stale non-terminal work-item silently de-completed an already
      // `done` plan item, which then re-entered the claimable pool (duplicate work) and
      // dragged every item blocked-by it into a false `blocked`. Observed live on
      // memory-write-latency-2026-07-26#P-007 (deployed and serving, reverted to `todo`
      // by the release of WI-6211).
      //
      // Only NON-terminal targets are guarded: a terminal→terminal correction
      // (done→dropped) is a legitimate reclassification and still goes through.
      if (
        terminalGuardTrips({
          onlyIfNotTerminal: it.onlyIfNotTerminal,
          currentStatus: oldStatus,
          nextStatus: it.status,
        })
      ) {
        return { newBody: null, value: { ok: false, code: 'terminal_guard', currentStatus: oldStatus } };
      }
      // EI-20129670928216719: an automated cascade must never downgrade FINISHED work.
      // Checked here, inside the lock, because it reads the PLAN ITEM's current status —
      // the coverage guard's pre-lock read would race a concurrent flip. See
      // `completedGuardTrips` for why neither existing guard covers this.
      if (
        completedGuardTrips({
          onlyIfNotCompleted: it.onlyIfNotCompleted,
          currentStatus: oldStatus,
          nextStatus: it.status,
        })
      ) {
        return { newBody: null, value: { ok: false, code: 'completed_guard', currentStatus: oldStatus } };
      }
      // Read importance only on a transition INTO needs-human — the sole
      // case the push gate cares about — so routine flips skip the parse.
      const importance: Importance =
        it.status === 'needs-human' && oldStatus !== 'needs-human'
          ? itemImportance(current, it.itemId)
          : 'normal';
      const finalBody = bumpUpdatedDate(newBody);
      // WI-1830: on a real →done edge, does this flip leave the plan with zero open
      // (non-terminal) items? Computed here, INSIDE the lock, off the just-written body so
      // it is race-safe against concurrent flips (the plan lock serializes writes). The
      // parse runs only on a →done edge, so routine flips skip it.
      const drainedPlan =
        it.status === 'done' && oldStatus !== 'done' ? isPlanDrained(parsePlan(finalBody).items) : false;
      // P-008: capture the item text ONLY on a real →wip edge (the "picking up
      // work" signal) so the claim-time recall port can query it — no second
      // read, and no parse cost on routine flips.
      const wipItemText =
        it.status === 'wip' && oldStatus !== 'wip'
          ? parsePlan(finalBody).items.find((pi) => pi.id === it.itemId)?.text
          : undefined;
      return {
        newBody: finalBody,
        value: {
          ok: true,
          oldStatus,
          newStatus: it.status,
          itemId: it.itemId,
          importance,
          drainedPlan,
          ...(wipItemText ? { wipItemText } : {}),
        },
      };
    },
  );

  if (result.kind === 'busy') {
    return {
      ok: false,
      slug: it.slug,
      itemId: it.itemId,
      error: 'busy',
      busy: result.busy.map((b) => ({
        path: b.path,
        owner_label: b.owner_label,
        intent: b.intent,
        expires_ts: b.expires_ts,
      })),
    };
  }

  if (!result.value.ok) {
    // A tripped terminal guard is a deliberate NO-OP, not a failure: the caller asked
    // for a non-destructive flip and the item was already finished. Reported ok:true so
    // an automated reflection does not read as broken (and does not get retried), but
    // with `skipped` so the no-op is visible rather than silent.
    if (result.value.code === 'terminal_guard') {
      return {
        ok: true,
        slug: it.slug,
        itemId: it.itemId,
        skipped: 'terminal_guard',
        currentStatus: result.value.currentStatus,
        reason: `left at \`${result.value.currentStatus}\` — already terminal, and this flip (\`${it.status}\`) would have un-finished it`,
      };
    }
    // Same posture as the terminal guard: a deliberate NO-OP, reported ok:true with
    // `skipped` so the automated reflection neither reads as broken nor gets retried.
    if (result.value.code === 'completed_guard') {
      return {
        ok: true,
        slug: it.slug,
        itemId: it.itemId,
        skipped: 'completed_guard',
        currentStatus: result.value.currentStatus,
        reason:
          'left at `done` — finished work is never downgraded to `dropped` by an automated ' +
          'cascade; the work-item being dropped is not the one that completed this item',
      };
    }
    return { ok: false, slug: it.slug, itemId: it.itemId, error: result.value.code };
  }

  // `result.value` is now narrowed to the ok-variant by the guard above.
  await emitPlanEventForCaller(ctx, {
    planSlug: it.slug,
    event: 'item_status_changed',
    before: result.value.oldStatus,
    after: it.status,
    detail: it.itemId,
  });

  // P-105: plan-item:done:<slug>:<id> — wake anyone awaiting this item (a peer's lane,
  // a cross-plan blocking dependency) the moment it flips to done, instead of polling
  // plans:get. Transition-gated: a real →done edge only, never a re-set of an
  // already-done item. Fire-and-forget; never fails the flip.
  if (it.status === 'done' && result.value.oldStatus !== 'done') {
    emitPlanItemDoneEvent(it.slug, it.itemId);
    // WI-1830: if that →done flip drained the whole plan (zero open items left, computed
    // race-safe inside the lock above), fire `fleet:drained:<slug>` for each fleet whose
    // lane thereby drained — so a leader awaiting it wakes exactly once, instead of polling
    // fleet:assignments. Fire-and-forget; never fails the flip.
    if (result.value.drainedPlan) {
      emitFleetDrainedForPlan(it.slug);
    }
  }

  // EI-14699: reflect a plan-item block/unblock onto its linked work_item so the
  // two tracking surfaces can't drift apart. Without this, flipping the plan item
  // to blocked/needs-human left the converted work_item's own `state` claimable,
  // so scheduler:get_next / work-item:claimable kept re-serving it → perpetual
  // claim/release ping-pong (WI-3475/WI-3467 each cycled 8+ times). Transition- and
  // current-state-gated by planSyncWorkItemState so a routine re-set never disturbs
  // a work_item already placed correctly (wip/terminal/etc). Awaited but fully
  // fail-safe: a lookup/write hiccup NEVER fails the plan-status flip.
  let workItemSynced: { id: string; state: 'blocked' | 'open' } | undefined;
  {
    // Cheap pre-gate: only a block/unblock EDGE can ever sync, so skip the PG lookup
    // for every other flip (done/wip/re-set) — the vast majority. The authoritative
    // decision is planSyncWorkItemState re-run below with the work_item's REAL state.
    const isBlockEdge = PLAN_BLOCKED_STATUSES.has(it.status) && result.value.oldStatus !== it.status;
    const isUnblockEdge =
      it.status === 'todo' &&
      result.value.oldStatus !== null &&
      PLAN_BLOCKED_STATUSES.has(result.value.oldStatus);
    if (isBlockEdge || isUnblockEdge) {
      try {
        const scope = await resolvePlanScope(harnessSlug ? { harnessSlug } : {});
        const linked = await findConvertedWorkItemByStamp(it.slug, it.itemId, scope.harnessSlug);
        if (linked && !TERMINAL_WORK_ITEM_STATES.has(linked.state)) {
          const target = planSyncWorkItemState(result.value.oldStatus, it.status, linked.state);
          if (target && target !== linked.state) {
            const updated = await setWorkItemState(linked.id, target, {
              harness: linked.harness ?? undefined,
              by: 'plan-item-status-sync',
            });
            if (updated) workItemSynced = { id: linked.id, state: target };
          }
        }
      } catch (e) {
        console.warn(
          `[plans:set-status] work_item block-sync ${it.slug}#${it.itemId} → ${it.status} failed:`,
          (e as Error)?.message ?? e,
        );
      }
    }
  }

  // Push the new item state to any live `useSyncQuery('planItems.byPlan')`
  // subscriber (the Create-tab kanban). The `items` jsonb was already
  // re-projected synchronously inside the lock above, so a re-pull is fresh.
  // Fire-and-forget + fail-safe: a sync-bus hiccup never fails a status flip,
  // and this is the SAME path the UI drag and an agent's plans:set-status both
  // take, so the board moves live for either.
  void (async () => {
    const { notifySyncInvalidate } = await import('../../sync-sse');
    await notifySyncInvalidate('planItems.byPlan', { planSlug: it.slug });
  })().catch((e) =>
    console.warn('[plans:set-status] sync invalidate failed:', (e as Error)?.message ?? e),
  );

  // P-020 (planning-attention-importance): push a notification when an
  // item transitions INTO needs-human at importance >= high — the
  // urgent/high human-decision signal that has no push trigger today (the
  // device-intervention-watcher only covers escalation / smoke / plan-
  // review, which are all already high-importance). Additive: a plan item
  // is a source the watcher never polls, so there's no overlap and no
  // double-fire. Transition-gated (a re-set of an already-needs-human item
  // won't re-push) and fully fail-safe (a push error never fails the
  // status flip). Reuses the proven mobile notifyWorkspace delivery, which
  // is a no-op when no device is paired. Retiring the watcher's 60s poll
  // in favour of producer-time emits for its own triggers is P-021; a
  // desktop-native Tauri notification channel is D-007 — both still open.
  const v = result.value;
  if (shouldPushNeedsHuman(v.oldStatus, v.newStatus, v.importance)) {
    void (async () => {
      const { notifyAttention } = await import('../../attention-notify');
      await notifyAttention({
        kind: 'needs-human',
        title: v.importance === 'urgent' ? 'Urgent: needs your decision' : 'Needs your attention',
        body: `${it.slug} · ${it.itemId} (${v.importance}) is waiting on you.`,
        importance: v.importance,
        data: { plan: it.slug, item: it.itemId },
      });
    })().catch((e) =>
      console.warn('[plans:set-status] needs-human push failed:', (e as Error)?.message ?? e),
    );
  }

  // EI-18655063958515097 (residual-coverage guard): "a residual split off a closing
  // plan item silently leaves the lane — no plan link, not claimable, parent reads
  // done while its acceptance ask is unmet". Non-blocking (mirrors the
  // duplicateOfWarning convention in work_items/complete.ts) — never refuses the
  // flip, just surfaces the mismatch in the response the instant it happens instead
  // of it surfacing later as an orphaned untracked item at release time. Two cases:
  //   1. A work-item already COVERS this plan item (via plan_item/targetPlanItem's
  //      `relates` edge) but is still non-terminal — closing anyway means the plan
  //      will read as fully satisfied while that linked work remains open.
  //   2. Nothing covers this plan item, but the closer's own note/rationale reads
  //      like an unmet acceptance criterion was split off — the exact "bare residual,
  //      no plan link" failure the bug describes.
  // Best-effort: a lookup hiccup never fails the status flip.
  let residualWarning: string | undefined;
  if (isTerminalStatus(it.status) && result.value.oldStatus !== it.status) {
    try {
      const coverage = await findCoverageWorkItems(it.slug, it.itemId);
      const openCoverage = coverage.filter((wi) => !TERMINAL_WORK_ITEM_STATES.has(wi.state));
      if (openCoverage.length > 0) {
        residualWarning =
          `${it.itemId} is closing (${it.status}) while ${openCoverage.length} linked coverage work-item(s) ` +
          `(${openCoverage.map((w) => w.id).join(', ')}) remain non-terminal — the plan will read as fully ` +
          `satisfied even though that work is still open. Confirm they're genuinely out of scope, or hold this ` +
          `item open until they close.`;
      } else if (looksLikeResidualClosure(`${it.note ?? ''} ${it.rationale ?? ''}`)) {
        residualWarning =
          `${it.itemId}'s note/rationale reads like an unmet acceptance criterion was split off, but no ` +
          `linked work-item covers this plan item — file it via work_items:create { plan_item: { slug: ` +
          `'${it.slug}', item: '${it.itemId}' } } (or targetPlanItem) so the residual stays claimable and ` +
          `tracked instead of surfacing later as an orphaned, untracked item (EI-18655063958515097).`;
      }
    } catch (e) {
      console.warn(
        `[plans:set-status] residual-coverage check ${it.slug}#${it.itemId} failed:`,
        (e as Error)?.message ?? e,
      );
    }
  }

  // Terminal flip → release the caller's claim AND clear the item's durable
  // assignment (claim-discipline: done means nobody holds it; EI-2298: a
  // done/dropped item must also be assigned to no one — otherwise it sits
  // assigned-idle forever and a dispatcher that re-pokes assigned-idle items
  // re-targets the stale assignee endlessly). Scope is resolved only on a
  // terminal flip; both legs are awaited but fail-safe.
  let claimReleased = false;
  let assignmentReleased = false;
  if (isTerminalStatus(it.status)) {
    const scope = await resolvePlanScope(harnessSlug ? { harnessSlug } : {});
    ({ claimReleased, assignmentReleased } = await releaseTerminalGrips({
      status: it.status,
      agentOwnerId: agentId?.ownerId ?? null,
      scope,
      slug: it.slug,
      itemId: it.itemId,
      releaseClaim: releaseOwnClaim,
      clearAssignment: unassignItem,
    }));
  } else if (agentId && it.status === 'todo') {
    const scope = await resolvePlanScope(harnessSlug ? { harnessSlug } : {});
    ({ claimReleased } = await releaseTodoClaim({
      status: it.status,
      agentOwnerId: agentId.ownerId,
      scope,
      slug: it.slug,
      itemId: it.itemId,
      releaseClaim: releaseOwnClaim,
    }));
  }

  // Claim-time recall port (memory-delivery-unification-2026-07-12 P-008 /
  // D-006): a →wip flip auto-claims the item — the "picking up work" signal —
  // so piggyback a targeted memory recall for that item on the response.
  // Deadline-bounded, epoch-deduped (port 'claim'), never-throws. Only when the
  // flip actually auto-claimed (agentId + wip) and captured the item text.
  let memory: string | null = null;
  if (agentId && claim && result.value.ok && result.value.wipItemText) {
    memory = await import('../../memory/claim-port')
      .then((m) =>
        m.buildClaimRecallBlock({
          sessionId: agentId.ownerId,
          workspaceId: agentId.workspaceId,
          items: [{ id: it.itemId, title: result.value.ok ? result.value.wipItemText : undefined, harness: harnessSlug ?? null }],
        }),
      )
      .catch(() => null);
  }

  return {
    slug: it.slug,
    ...result.value,
    filePath: result.filePath,
    revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
    ...(claim ? { claim } : {}),
    ...(claimReleased ? { claimReleased } : {}),
    ...(assignmentReleased ? { assignmentReleased } : {}),
    ...(workItemSynced ? { workItemSynced } : {}),
    ...(memory ? { memory } : {}),
    ...(residualWarning ? { residualWarning } : {}),
    ...(noteTruncated
      ? {
          noteTruncated: true,
          noteHint:
            'inline note truncated to 1000 chars — put the long form in `rationale` (stored on the plan revision, not the item line).',
        }
      : {}),
  };
}

export default defineTool({
  name: 'plans:set-status',
  description:
    "Flip one OR many items' stored status. Writes the exact bytes a human would type. Auto-bumps frontmatter updated:. A `dropped` flip REQUIRES a nonblank note or rationale so intentional departures stay recorded. Flipping to `wip` AUTO-CLAIMS the item for you; flipping to done/dropped releases your claim AND clears the item's assignment. Both reject with per-item claim_conflict if a LIVE peer holds the item; coordinate or let the holder close it. Single: { slug, item, status }. Many of one plan: { slug, itemIds:[…], status }. Heterogeneous: items:[{ slug, item, status }]. Returns { ok, results:[{ ok, slug, itemId, oldStatus, newStatus, … | error }], counts } — correlate by { slug, itemId }, not position; a claim_conflict (or any failure) on one item never fails the rest.",
  guidance: {
    when: "An item's status changes — picking up (todo→wip, which also claims it), completing (wip→done), intentionally departing (→dropped with `note` preferred or `rationale` required), gating on a human (→needs-human), or recording external blockage (→blocked). Flip several at once via itemIds:[…] (one plan) or items:[…].",
    notWhen:
      'You want to add a brand-new item — use plans:add-item. Or to change scope of the work — edit the item text directly in the file.',
    chaining:
      'plans:items { actionable: true } → plans:set-status { item, status: "wip" } when picking up (the wip flip claims it — no separate plan_items:claim needed). On a per-item claim_conflict: coord:send the holder or pick another item.',
    seeAlso: [
      'plans:set-now (narrate the state change for the human-facing Now)',
      'plans:add-item (add a brand-new item rather than flip an existing one)',
      'plans:set-importance (re-rank an item without changing its status)',
    ],
  },
  capability: 'plans:write',
  // Idempotent-completion (backend-reliability-100pct-2026-07-03 W6/P-007): a status flip
  // sets the item's status token to a FIXED value (todo/wip/done/…) — re-applying is a
  // no-op, so a write that COMMITTED but whose wall-clock beat the deadline under load is
  // surfaced as its truthful success instead of a spurious `timeout`. This is the fix for
  // the ~280 `plans:set-status` false-timeouts (the write landed; the agent was told it
  // failed and re-dispatched). Inert except in the dispatch abort-race branch.
  idempotent: true,
  requirePrincipal: false,
  agentRoles: [...SU_BEE_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const list: StatusItem[] = args.items?.length
      ? args.items.map((it) => ({
          slug: it.slug,
          itemId: it.item,
          status: (it.status ?? args.status) as string,
          note: it.note ?? args.note,
          harness: it.harness ?? args.harness,
          rationale: it.rationale ?? args.rationale,
          onlyIfNotTerminal: it.onlyIfNotTerminal ?? args.onlyIfNotTerminal,
          onlyIfNoOtherOpenCoverage: it.onlyIfNoOtherOpenCoverage ?? args.onlyIfNoOtherOpenCoverage,
          onlyIfNotCompleted: it.onlyIfNotCompleted ?? args.onlyIfNotCompleted,
        }))
      : args.itemIds?.length
        ? args.itemIds.map((itemId) => ({
            slug: args.slug as string,
            itemId,
            status: args.status as string,
            note: args.note,
            harness: args.harness,
            rationale: args.rationale,
            onlyIfNotTerminal: args.onlyIfNotTerminal,
            onlyIfNoOtherOpenCoverage: args.onlyIfNoOtherOpenCoverage,
            onlyIfNotCompleted: args.onlyIfNotCompleted,
          }))
        : [
            {
              slug: args.slug as string,
              itemId: args.item as string,
              status: args.status as string,
              note: args.note,
              harness: args.harness,
              rationale: args.rationale,
              onlyIfNotTerminal: args.onlyIfNotTerminal,
              onlyIfNoOtherOpenCoverage: args.onlyIfNoOtherOpenCoverage,
              onlyIfNotCompleted: args.onlyIfNotCompleted,
            },
          ];
    const env = await runBulk(list, (it) => setStatusOne(it, ctx), {
      keyOf: (it) => ({ slug: it.slug, itemId: it.itemId }),
    });
    return bulkContent(env);
  },
});
