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
import { ITEM_STATUSES } from './parser';

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
});

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
  const m = re.exec(body);
  if (!m) return { newBody: body, found: false, oldStatus: null };

  const oldStatus = m[2] ?? '';
  let rest = m[3] ?? '';
  if (note) {
    // Append note at end of line, single space separator.
    rest = `${rest} (${note.replace(/[()]/g, '')})`;
  }
  const newLine = `${m[1] ?? ''}${newStatus}${rest}`;
  const newBody = body.replace(re, newLine);
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
    const result = await withPlanLock(
      ctx as never,
      {
        slug: args.slug,
        intent: `plans:set-status ${args.itemId} → ${args.status}`,
      },
      async (current) => {
        if (current === null) {
          return { newBody: null, value: { ok: false as const, code: 'not_found' as const } };
        }
        const { newBody, found, oldStatus } = flipStatusInBody(
          current,
          args.itemId,
          args.status,
          args.note,
        );
        if (!found) {
          return { newBody: null, value: { ok: false as const, code: 'item_not_found' as const } };
        }
        const finalBody = bumpUpdatedDate(newBody);
        return {
          newBody: finalBody,
          value: { ok: true as const, oldStatus, newStatus: args.status, itemId: args.itemId },
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

    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ ok: true, ...result.value, filePath: result.filePath }) },
      ],
    };
  },
});
