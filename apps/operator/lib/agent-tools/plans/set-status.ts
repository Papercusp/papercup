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
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { ITEM_STATUSES, maskFences } from './parser';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { fireNotificationsForCaller } from '../coordination/subscriptions';
import { planRevisionCapture } from './revisions';
import type { ResolveIdentityCtx } from '../coordination/identity';

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

const argsSchema = z.object({
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
  | { ok: true; oldStatus: string | null; newStatus: string; itemId: string }
  | { ok: false; code: 'not_found' | 'item_not_found' };

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
  roles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const rev = planRevisionCapture(ctx as ResolveIdentityCtx, args.slug, args.rationale);
    const result = await withPlanLock<SetStatusValue>(
      ctx as never,
      {
        slug: args.slug,
        intent: `plans:set-status ${args.itemId} → ${args.status}`,
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
        const finalBody = bumpUpdatedDate(newBody);
        return {
          newBody: finalBody,
          value: { ok: true, oldStatus, newStatus: args.status, itemId: args.itemId },
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
    await fireNotificationsForCaller(
      ctx,
      [`apps/operator/docs/plans/${args.slug}.md`],
      'plan_referenced',
    );

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
