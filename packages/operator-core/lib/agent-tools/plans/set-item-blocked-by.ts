/**
 * plans:set-item-blocked-by — set/clear one OR many items' `blocked-by:` dependency
 * list (plan-templates-and-rubric-v2-2026-06-20 P-003).
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
 *
 * Bulk by default (the house keyed-array contract, bulk-endpoint-standardization-
 * 2026-06-21): single { slug, itemId, blockedBy }, many of one plan to the same list
 * { slug, itemIds:[…], blockedBy }, or heterogeneous items:[{ slug, itemId, blockedBy
 * }] → { ok, results:[{ ok, slug, itemId, from, to | error }], counts }. Correlate by
 * { slug, itemId } not array position; one failure never fails the rest.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { maskFences } from './parser';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';

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

const BLOCKED_BY = z
  .array(z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'))
  .max(40)
  .describe(
    'Item IDs that must complete before this one can effectively start. Pass [] to clear the dependency (the keyword is removed). Replaces the existing blocked-by list wholesale.',
  );

const itemSpec = z.object({
  slug: z.string().min(1).describe('Plan slug (filename stem).'),
  itemId: z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'),
  blockedBy: BLOCKED_BY.optional().describe('per-item blocked-by list (else the batch `blockedBy`)'),
  harness: harnessArg.describe('per-item harness (else the batch `harness` default)'),
  rationale: z.string().max(400).optional().describe('per-item revision rationale (else the batch `rationale`)'),
});

const argsSchema = z
  .object({
    harness: harnessArg,
    slug: z.string().min(1).optional().describe('Plan slug (filename stem).'),
    itemId: z.string().regex(/^P-\d{3,}$/, 'P-NNN form required').optional(),
    blockedBy: BLOCKED_BY.optional(),
    itemIds: z
      .array(z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'))
      .min(1)
      .max(200)
      .optional()
      .describe('set MANY items of the SAME plan `slug` to the same `blockedBy` (homogeneous)'),
    items: z
      .array(itemSpec)
      .min(1)
      .max(200)
      .optional()
      .describe('set many items at once — each { slug, itemId, blockedBy, harness?, rationale? }'),
    rationale: z
      .string()
      .max(400)
      .optional()
      .describe('Optional — why the blockers changed. Stored on the plan revision (D-009).'),
  })
  .refine(
    (a) =>
      (a.items?.length ?? 0) > 0 ||
      (Boolean(a.slug) && a.blockedBy !== undefined && ((a.itemIds?.length ?? 0) > 0 || Boolean(a.itemId))),
    { message: 'pass { slug, itemId, blockedBy } for one, { slug, itemIds:[…], blockedBy } for many of one plan, or items:[{ slug, itemId, blockedBy }] for heterogeneous' },
  );

interface BlockedByItem {
  slug: string;
  itemId: string;
  blockedBy: string[];
  harness?: string;
  rationale?: string;
}

type SetBlockedByValue =
  | { ok: true; itemId: string; from: string[]; to: string[] }
  | { ok: false; code: 'not_found' | 'item_not_found' | 'self_block' };

/** Apply one blocked-by change, returning the self-describing bulk result. PRESERVES
 *  the dedupe + self-block reject, lock, revision, and sync-invalidate per item. */
async function setBlockedByOne(it: BlockedByItem, ctx: unknown): Promise<BulkItemResult> {
  // Dedupe + reject a self-block (an item can't depend on itself).
  const blockedBy = [...new Set(it.blockedBy)];
  if (blockedBy.includes(it.itemId)) {
    return { ok: false, slug: it.slug, itemId: it.itemId, error: 'self_block' };
  }

  const sctx = harnessScopedCtx(it.harness, ctx);
  const harnessSlug = resolveCtxHarnessSlug(sctx);
  const rev = planRevisionCapture(
    ctx as PlanRevisionCtx,
    it.slug,
    it.rationale,
    harnessSlug ? { harnessSlug } : {},
  );

  const result = await withPlanLock<SetBlockedByValue>(
    ctx as never,
    {
      slug: it.slug,
      intent: `plans:set-item-blocked-by ${it.itemId}`,
      ...(harnessSlug ? { harnessSlug } : {}),
      afterWrite: rev.afterWrite,
    },
    async (current): Promise<{ newBody: string | null; value: SetBlockedByValue }> => {
      if (current === null) return { newBody: null, value: { ok: false, code: 'not_found' } };
      const { newBody, found, oldBlockedBy } = setBlockedByInBody(current, it.itemId, blockedBy);
      if (!found) return { newBody: null, value: { ok: false, code: 'item_not_found' } };
      const finalBody = bumpUpdatedDate(newBody);
      return {
        newBody: finalBody,
        value: { ok: true, itemId: it.itemId, from: oldBlockedBy, to: blockedBy },
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

  // Refresh the per-plan item rail so a blocked-by-derived view updates immediately.
  try {
    const { notifySyncInvalidate } = await import('../../sync-sse');
    await notifySyncInvalidate('planItems.byPlan', { planSlug: it.slug });
  } catch {
    /* best-effort — the next natural refresh picks it up */
  }

  return {
    ok: true,
    slug: it.slug,
    ...result.value,
    filePath: result.filePath,
    revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
  };
}

export default defineTool({
  name: 'plans:set-item-blocked-by',
  description:
    "Set or clear one OR many items' `blocked-by:` dependency list — surgical (only the target item line's keyword changes; status/text/importance preserved), inside the plan lock, records a revision. Pass blockedBy:[] to clear. Single: { slug, itemId, blockedBy }. Many of one plan: { slug, itemIds:[…], blockedBy }. Heterogeneous: items:[{ slug, itemId, blockedBy }]. Returns { ok, results:[{ ok, slug, itemId, from, to | error }], counts } — correlate by { slug, itemId }, not position; one failure never fails the rest.",
  guidance: {
    when: "An item's dependencies change — a new prerequisite surfaced, or a blocker cleared (blockedBy:[] to un-block). The structured alternative to a plans:edit on the item line. Set several at once via itemIds:[…] (one plan) or items:[…].",
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
    const list: BlockedByItem[] = args.items?.length
      ? args.items.map((it) => ({
          slug: it.slug,
          itemId: it.itemId,
          blockedBy: it.blockedBy ?? (args.blockedBy as string[]),
          harness: it.harness ?? args.harness,
          rationale: it.rationale ?? args.rationale,
        }))
      : args.itemIds?.length
        ? args.itemIds.map((itemId) => ({
            slug: args.slug as string,
            itemId,
            blockedBy: args.blockedBy as string[],
            harness: args.harness,
            rationale: args.rationale,
          }))
        : [
            {
              slug: args.slug as string,
              itemId: args.itemId as string,
              blockedBy: args.blockedBy as string[],
              harness: args.harness,
              rationale: args.rationale,
            },
          ];
    const env = await runBulk(list, (it) => setBlockedByOne(it, ctx), {
      keyOf: (it) => ({ slug: it.slug, itemId: it.itemId }),
    });
    return bulkContent(env);
  },
});
