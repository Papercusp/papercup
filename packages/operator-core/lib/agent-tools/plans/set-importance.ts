/**
 * plans:set-importance — change one item's importance level.
 *
 * Importance (urgent|high|normal|low) is a 4th axis orthogonal to
 * status — see planning-attention-importance-2026-05-31 / the plan-format
 * spec §Importance. add-item sets it at creation (required); this verb
 * changes it afterward, e.g. escalating a stuck/aging item or correcting
 * a level set wrong.
 *
 * Surgical line edit: find the item line by its P-NNN id, then add /
 * replace / remove the trailing `importance:` keyword. Setting `normal`
 * (the parser default) REMOVES the keyword so routine lines stay clean.
 * Whitespace, status token, item text, blocked-by, and decision refs are
 * otherwise preserved. Writes inside the lock; auto-bumps `updated:`.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { IMPORTANCE_LEVELS, maskFences, type Importance } from './parser';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1),
  itemId: z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'),
  importance: z
    .enum([...IMPORTANCE_LEVELS] as [string, ...string[]])
    .describe('urgent | high | normal | low. Setting `normal` removes the keyword (it is the default).'),
  rationale: z
    .string()
    .optional()
    .describe('Optional — why the importance changed (e.g. "stuck 3 days, escalating"). Stored on the plan revision (D-009).'),
});

type SetImportanceValue =
  | { ok: true; oldImportance: string; newImportance: Importance; itemId: string }
  | { ok: false; code: 'not_found' | 'item_not_found' };

/**
 * Add / replace / remove the `importance:` keyword on one item line.
 * Returns the prior importance (defaulting to `normal` when the line
 * carried no keyword). Mirrors flipStatusInBody: anchor on the id,
 * match against the fence-masked body (the item line is outside any
 * fence, so captured groups equal the real text), splice by index.
 */
export function setImportanceInBody(
  body: string,
  itemId: string,
  importance: Importance,
): { newBody: string; found: boolean; oldImportance: string } {
  const re = new RegExp(
    String.raw`^(\s*[-*]\s+\*\*\s*` +
      itemId.replace(/-/g, '\\-') +
      String.raw`\s*\*\*\s+\x60[a-z-]+\x60\s+)(.*)$`,
    'm',
  );
  const m = re.exec(maskFences(body));
  if (!m) return { newBody: body, found: false, oldImportance: 'normal' };

  const prefix = m[1] ?? '';
  const rest = m[2] ?? '';

  const impRe = /\s*\bimportance\s*:\s*([a-z]+)\b/i;
  const impM = impRe.exec(rest);
  const oldImportance = impM ? (impM[1] ?? '').toLowerCase() : 'normal';

  let restNoImp = impM
    ? rest.slice(0, impM.index) + rest.slice(impM.index + impM[0].length)
    : rest;
  // Tidy any whitespace the removal left behind (keyword is normally at
  // line end; if it was mid-line, collapse the resulting double space).
  restNoImp = restNoImp.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/g, '');

  const newRest = importance === 'normal' ? restNoImp : `${restNoImp} importance: ${importance}`;
  const newLine = prefix + newRest;
  const newBody = body.slice(0, m.index) + newLine + body.slice(m.index + m[0].length);
  return { newBody, found: true, oldImportance };
}

export default defineTool({
  name: 'plans:set-importance',
  description:
    "Change one item's importance (urgent|high|normal|low). Adds/replaces the trailing `importance:` keyword; setting `normal` removes it. Auto-bumps frontmatter updated:.",
  guidance: {
    when: "An item's importance changes — escalating a stuck or aging item, or correcting a level set wrong at creation.",
    notWhen:
      "Setting importance when creating an item — that's plans:add-item's required arg. Changing lifecycle status — plans:set-status.",
    chaining: 'plans:items (sorted urgent→low) → plans:set-importance to re-rank what the human sees first.',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
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
    const result = await withPlanLock<SetImportanceValue>(
      ctx as never,
      {
        slug: args.slug,
        intent: `plans:set-importance ${args.itemId} → ${args.importance}`,
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      async (current): Promise<{ newBody: string | null; value: SetImportanceValue }> => {
        if (current === null) {
          return { newBody: null, value: { ok: false, code: 'not_found' } };
        }
        const { newBody, found, oldImportance } = setImportanceInBody(
          current,
          args.itemId,
          args.importance as Importance,
        );
        if (!found) {
          return { newBody: null, value: { ok: false, code: 'item_not_found' } };
        }
        const finalBody = bumpUpdatedDate(newBody);
        return {
          newBody: finalBody,
          value: {
            ok: true,
            oldImportance,
            newImportance: args.importance as Importance,
            itemId: args.itemId,
          },
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
