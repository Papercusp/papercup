/**
 * plans:set-status — flip one item's stored status token.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.2.
 *
 * Surgical line edit: find the item line by its P-NNN id, swap the
 * backticked status token. Whitespace, item text, blocked-by, and
 * decision refs are preserved verbatim.
 *
 * Writes inside a lock. Auto-bumps frontmatter updated:.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { ITEM_STATUSES, maskFences, type Importance } from './parser';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';

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
  // THE UMBILICAL (local-hive): a fleet:spawn bee flips the status of the plan
  // item it's working (todo→wip→done) as part of its umbilical back to the Queen.
  // plans:set-status only mutates ONE item's status line (not plan-level launch/
  // pause/edit — those stay SU-only), so admitting the bee here is the right, narrow
  // grant. Paired with the resolveAgentIdentity fleet-spawn branch (identity.ts) so
  // the bee both passes this role gate AND resolves a coord owner for the write.
  'bee',
] as const;

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1),
  itemId: z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'),
  status: z.enum([...ITEM_STATUSES] as [string, ...string[]]),
  note: z.string().max(400).optional().describe('Optional trailing comment appended to the item line.'),
  rationale: z
    .string()
    .optional()
    .describe(
      'Optional — rarely needed: a status flip is already visible in the plan doc. Supply only when the *why* of the flip is non-obvious (e.g. an item moved to `blocked`). Stored on the plan revision (D-009).',
    ),
});

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

export default defineTool({
  name: 'plans:set-status',
  description:
    "Flip one item's stored status. Writes the exact bytes a human would type. Auto-bumps frontmatter updated:.",
  guidance: {
    when: "An item's status changes — picking up (todo→wip), completing (wip→done), gating on a human (→needs-human), or recording external blockage (→blocked).",
    notWhen:
      'You want to add a brand-new item — use plans:add-item. Or to change scope of the work — edit the item text directly in the file.',
    chaining: 'plans:items { actionable: true } → plans:set-status { itemId, status: "wip" } when picking up.',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx);
    const rev = planRevisionCapture(
      ctx as PlanRevisionCtx,
      args.slug,
      args.rationale,
      harnessSlug ? { harnessSlug } : {},
    );
    const result = await withPlanLock<SetStatusValue>(
      ctx as never,
      {
        slug: args.slug,
        intent: `plans:set-status ${args.itemId} → ${args.status}`,
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      async (current): Promise<{ newBody: string | null; value: SetStatusValue }> => {
        if (current === null) {
          return { newBody: null, value: { ok: false, code: 'not_found' } };
        }
        const { newBody, found, oldStatus } = flipStatusInBody(
          current,
          args.itemId,
          args.status,
          args.note,
        );
        if (!found) {
          return { newBody: null, value: { ok: false, code: 'item_not_found' } };
        }
        // Read importance only on a transition INTO needs-human — the sole
        // case the push gate cares about — so routine flips skip the parse.
        const importance: Importance =
          args.status === 'needs-human' && oldStatus !== 'needs-human'
            ? itemImportance(current, args.itemId)
            : 'normal';
        const finalBody = bumpUpdatedDate(newBody);
        return {
          newBody: finalBody,
          value: { ok: true, oldStatus, newStatus: args.status, itemId: args.itemId, importance },
        };
      },
    );

    if (result.kind === 'busy') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'busy',
              busy: result.busy.map((b) => ({
                path: b.path,
                owner_label: b.owner_label,
                intent: b.intent,
                expires_ts: b.expires_ts,
              })),
            }),
          },
        ],
        isError: true,
      };
    }

    if (!result.value.ok) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ error: result.value.code, slug: args.slug, itemId: args.itemId }) },
        ],
        isError: true,
      };
    }

    // `result.value` is now narrowed to the ok-variant by the guard above.
    await emitPlanEventForCaller(ctx, {
      planSlug: args.slug,
      event: 'item_status_changed',
      before: result.value.oldStatus,
      after: args.status,
      detail: args.itemId,
    });

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
          body: `${args.slug} · ${args.itemId} (${v.importance}) is waiting on you.`,
          importance: v.importance,
          data: { plan: args.slug, item: args.itemId },
        });
      })().catch((e) =>
        console.warn('[plans:set-status] needs-human push failed:', (e as Error)?.message ?? e),
      );
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ...result.value,
            filePath: result.filePath,
            revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
          }),
        },
      ],
    };
  },
});
