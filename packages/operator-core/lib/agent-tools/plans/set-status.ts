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
import { defineTool, SU_ROLES, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { ITEM_STATUSES, maskFences, type Importance } from './parser';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { resolveAgentIdentity, type AgentIdentity } from '../coordination/identity';
import { resolvePlanScope } from './source';
import { claimForWork, releaseOwnClaim } from '../../plan-items/claim-discipline';
import { convertPlanItem } from '../../plan-items/convert';
import { unassignItem } from '../../plan-items/assignments';
import { bestEffortOwnerUser, resolveAdoptedName } from '../../plan-items/agent-names';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';

const SU_BEE_ROLES = [...SU_ROLES, 'bee'] as const;

const STATUS = z.enum([...ITEM_STATUSES] as [string, ...string[]]);

const NOTE = z
  .string()
  .max(8000)
  .describe(
    'Optional SHORT comment appended inline to the item line. Anything beyond ~1000 chars is TRUNCATED inline (with a `…` marker + a noteTruncated flag), not rejected. For a longer explanation of WHY the status changed, use `rationale` instead — it is stored on the plan revision, not spliced into the item line.',
  );

const itemSpec = z.object({
  slug: z.string().min(1),
  itemId: z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'),
  status: STATUS.optional().describe('per-item status (else the batch `status`)'),
  note: NOTE.optional(),
  harness: harnessArg.describe('per-item harness (else the batch `harness` default)'),
  rationale: z.string().optional().describe('per-item revision rationale (else the batch `rationale`)'),
});

const argsSchema = z
  .object({
    harness: harnessArg,
    slug: z.string().min(1).optional(),
    itemId: z.string().regex(/^P-\d{3,}$/, 'P-NNN form required').optional(),
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
      .describe('flip many items at once — each { slug, itemId, status, note?, harness?, rationale? }'),
    rationale: z
      .string()
      .optional()
      .describe(
        'Optional — rarely needed: a status flip is already visible in the plan doc. Supply only when the *why* of the flip is non-obvious (e.g. an item moved to `blocked`). Stored on the plan revision (D-009).',
      ),
  })
  .refine(
    (a) =>
      (a.items?.length ?? 0) > 0 ||
      (Boolean(a.slug) && Boolean(a.status) && ((a.itemIds?.length ?? 0) > 0 || Boolean(a.itemId))),
    { message: 'pass { slug, itemId, status } for one, { slug, itemIds:[…], status } for many of one plan, or items:[{ slug, itemId, status }] for heterogeneous' },
  );

interface StatusItem {
  slug: string;
  itemId: string;
  status: string;
  note?: string;
  harness?: string;
  rationale?: string;
}

/** Result payload — explicit so `withPlanLock`'s `T` is fixed by the
 *  type argument below rather than inferred from a union-returning
 *  mutator (which TS narrows to the first branch, leaving `T` unknown). */
type SetStatusValue =
  | { ok: true; oldStatus: string | null; newStatus: string; itemId: string; importance: Importance }
  | { ok: false; code: 'not_found' | 'item_not_found' };

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

/** A terminal status — the item is finished; it is held + assigned by no one. */
export function isTerminalStatus(status: string): boolean {
  return status === 'done' || status === 'dropped';
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
    // Append note at end of line, single space separator.
    rest = `${rest} (${note.replace(/[()]/g, '')})`;
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
      return {
        ok: false,
        slug: it.slug,
        itemId: it.itemId,
        error: 'claim_conflict',
        reason: outcome.reason,
        holder: outcome.holder ?? null,
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
        intent: `plans:set-status ${it.itemId} → wip (auto-convert)`,
      }).catch((e) =>
        console.warn(
          `[plans:set-status] auto-convert ${it.slug}#${it.itemId} failed:`,
          (e as Error)?.message ?? e,
        ),
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
      // Read importance only on a transition INTO needs-human — the sole
      // case the push gate cares about — so routine flips skip the parse.
      const importance: Importance =
        it.status === 'needs-human' && oldStatus !== 'needs-human'
          ? itemImportance(current, it.itemId)
          : 'normal';
      const finalBody = bumpUpdatedDate(newBody);
      return {
        newBody: finalBody,
        value: { ok: true, oldStatus, newStatus: it.status, itemId: it.itemId, importance },
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
  }

  return {
    slug: it.slug,
    ...result.value,
    filePath: result.filePath,
    revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
    ...(claim ? { claim } : {}),
    ...(claimReleased ? { claimReleased } : {}),
    ...(assignmentReleased ? { assignmentReleased } : {}),
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
    "Flip one OR many items' stored status. Writes the exact bytes a human would type. Auto-bumps frontmatter updated:. Flipping to `wip` AUTO-CLAIMS the item for you (rejected with a per-item claim_conflict when a live peer holds it); flipping to done/dropped releases your claim AND clears the item's assignment (a finished item is held + assigned by no one). Single: { slug, itemId, status }. Many of one plan: { slug, itemIds:[…], status }. Heterogeneous: items:[{ slug, itemId, status }]. Returns { ok, results:[{ ok, slug, itemId, oldStatus, newStatus, … | error }], counts } — correlate by { slug, itemId }, not position; a claim_conflict (or any failure) on one item never fails the rest.",
  guidance: {
    when: "An item's status changes — picking up (todo→wip, which also claims the item as yours), completing (wip→done, which releases it), gating on a human (→needs-human), or recording external blockage (→blocked). Flip several at once via itemIds:[…] (one plan) or items:[…].",
    notWhen:
      'You want to add a brand-new item — use plans:add-item. Or to change scope of the work — edit the item text directly in the file.',
    chaining:
      'plans:items { actionable: true } → plans:set-status { itemId, status: "wip" } when picking up (the wip flip claims it — no separate plan_items:claim needed). On a per-item claim_conflict: coord:send the holder or pick another item.',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_BEE_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const list: StatusItem[] = args.items?.length
      ? args.items.map((it) => ({
          slug: it.slug,
          itemId: it.itemId,
          status: (it.status ?? args.status) as string,
          note: it.note ?? args.note,
          harness: it.harness ?? args.harness,
          rationale: it.rationale ?? args.rationale,
        }))
      : args.itemIds?.length
        ? args.itemIds.map((itemId) => ({
            slug: args.slug as string,
            itemId,
            status: args.status as string,
            note: args.note,
            harness: args.harness,
            rationale: args.rationale,
          }))
        : [
            {
              slug: args.slug as string,
              itemId: args.itemId as string,
              status: args.status as string,
              note: args.note,
              harness: args.harness,
              rationale: args.rationale,
            },
          ];
    const env = await runBulk(list, (it) => setStatusOne(it, ctx), {
      keyOf: (it) => ({ slug: it.slug, itemId: it.itemId }),
    });
    return bulkContent(env);
  },
});
