/**
 * plans:set-item-blocked-by — set/clear an item's `blocked-by:` dependency list
 * (plan-templates-and-rubric-v2-2026-06-20 P-003).
 *
 * The interface audit found no item-field edit beyond status/importance — to change
 * an item's blocked-by you had to plans:edit string-replace the line. This is the
 * structured, surgical, revisioned setter: it rewrites ONLY the `blocked-by:` keyword
 * on the target item line (every other token — status, text, importance, risk,
 * authority, decision refs — preserved), inside the plan lock. Pass an empty array to
 * clear the dependency (the keyword is removed, like setting importance to `normal`).
 *
 * Mirrors plans:set-importance's setImportanceInBody: anchor on the P-NNN id against
 * the fence-masked body, strip the existing keyword, splice the line back by index.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { maskFences } from './parser';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';

const PNN = /P-\d{3,}/g;

/**
 * Add / replace / remove the `blocked-by:` keyword on one item line. Returns the
 * prior dependency list (empty when the line carried no keyword). Mirrors
 * setImportanceInBody: anchor on the id, match against the fence-masked body (the
 * item line is outside any fence, so captured groups equal the real text), splice by
 * index. The new keyword is appended at line end (parser is order-agnostic; matches
 * how set-importance re-emits its keyword). Exported for tests.
 */
export function setBlockedByInBody(
  body: string,
  itemId: string,
  blockedBy: string[],
): { newBody: string; found: boolean; oldBlockedBy: string[] } {
  const re = new RegExp(
    String.raw`^(\s*[-*]\s+\*\*\s*` +
      itemId.replace(/-/g, '\\-') +
      String.raw`\s*\*\*\s+\x60[a-z-]+\x60\s+)(.*)$`,
    'm',
  );
  const m = re.exec(maskFences(body));
  if (!m) return { newBody: body, found: false, oldBlockedBy: [] };

  const prefix = m[1] ?? '';
  const rest = m[2] ?? '';

  // Strip the existing `blocked-by:` keyword (and the whitespace before it).
  // The grammar (parser ITEM_LINE blockedByRe): blocked-by: P-001, P-002, ...
  const bbRe = /\s*\bblocked-by\s*:\s*(?:P-\d{3,}(?:\s*,\s*)?)+/i;
  const bbM = bbRe.exec(rest);
  const oldBlockedBy = bbM ? ((bbM[0].match(PNN) ?? []) as string[]) : [];

  let restClean = bbM
    ? rest.slice(0, bbM.index) + rest.slice(bbM.index + bbM[0].length)
    : rest;
  // Tidy whitespace the removal left behind (keyword is normally at line end; if it
  // was mid-line, collapse the resulting double space).
  restClean = restClean.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/g, '');

  const newRest =
    blockedBy.length > 0 ? `${restClean} blocked-by: ${blockedBy.join(', ')}` : restClean;
  const newLine = prefix + newRest;
  const newBody = body.slice(0, m.index) + newLine + body.slice(m.index + m[0].length);
  return { newBody, found: true, oldBlockedBy };
}

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).describe('Plan slug (filename stem).'),
  itemId: z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'),
  blockedBy: z
    .array(z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'))
    .max(40)
    .describe(
      'Item IDs that must complete before this one can effectively start. Pass [] to clear the dependency (the keyword is removed). Replaces the existing blocked-by list wholesale.',
    ),
  rationale: z
    .string()
    .max(400)
    .optional()
    .describe('Optional — why the blockers changed. Stored on the plan revision (D-009).'),
});

type SetBlockedByValue =
  | { ok: true; itemId: string; from: string[]; to: string[] }
  | { ok: false; code: 'not_found' | 'item_not_found' | 'self_block' };

const text = (payload: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  ...(isError ? { isError: true as const } : {}),
});

export default defineTool({
  name: 'plans:set-item-blocked-by',
  description:
    "Set or clear an item's `blocked-by:` dependency list — surgical (only the target item line's keyword changes; status/text/importance preserved), inside the plan lock, records a revision. Pass blockedBy:[] to clear. The structured setter the surface lacked (vs a plans:edit string-replace).",
  guidance: {
    when: "An item's dependencies change — a new prerequisite surfaced, or a blocker cleared (blockedBy:[] to un-block). The structured alternative to a plans:edit on the item line.",
    notWhen:
      'Flipping lifecycle status (plans:set-status) or importance (plans:set-importance). Moving an item to another phase (plans:set-item-phase).',
    chaining: 'plans:get-item { slug, itemId } to see current blockers → plans:set-item-blocked-by.',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    // Dedupe + reject a self-block (an item can't depend on itself).
    const blockedBy = [...new Set(args.blockedBy)];
    if (blockedBy.includes(args.itemId)) {
      return text({ error: 'self_block', slug: args.slug, itemId: args.itemId }, true);
    }

    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx);
    const rev = planRevisionCapture(
      ctx as PlanRevisionCtx,
      args.slug,
      args.rationale,
      harnessSlug ? { harnessSlug } : {},
    );

    const result = await withPlanLock<SetBlockedByValue>(
      ctx as never,
      {
        slug: args.slug,
        intent: `plans:set-item-blocked-by ${args.itemId}`,
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      async (current): Promise<{ newBody: string | null; value: SetBlockedByValue }> => {
        if (current === null) return { newBody: null, value: { ok: false, code: 'not_found' } };
        const { newBody, found, oldBlockedBy } = setBlockedByInBody(current, args.itemId, blockedBy);
        if (!found) return { newBody: null, value: { ok: false, code: 'item_not_found' } };
        const finalBody = bumpUpdatedDate(newBody);
        return {
          newBody: finalBody,
          value: { ok: true, itemId: args.itemId, from: oldBlockedBy, to: blockedBy },
        };
      },
    );

    if (result.kind === 'busy') {
      return text(
        {
          error: 'busy',
          busy: result.busy.map((b) => ({
            path: b.path,
            owner_label: b.owner_label,
            intent: b.intent,
            expires_ts: b.expires_ts,
          })),
        },
        true,
      );
    }

    if (!result.value.ok) {
      return text({ error: result.value.code, slug: args.slug, itemId: args.itemId }, true);
    }

    // Refresh the per-plan item rail so a blocked-by-derived view updates immediately.
    try {
      const { notifySyncInvalidate } = await import('../../sync-sse');
      await notifySyncInvalidate('planItems.byPlan', { planSlug: args.slug });
    } catch {
      /* best-effort — the next natural refresh picks it up */
    }

    return text({
      ...result.value,
      filePath: result.filePath,
      revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
    });
  },
});
