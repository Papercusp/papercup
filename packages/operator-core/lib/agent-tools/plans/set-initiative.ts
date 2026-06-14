/**
 * plans:set-initiative — set/clear a plan's `initiative` grouping label
 * (shared-hive-collaboration-2026-06-14 P-015).
 *
 * An `initiative` is ONE free-text frontmatter field that ties related plans
 * into a group, surfaced as a filter facet in the plans list's my/others/all
 * saved-views (P-002). It is explicitly NOT a branch/worktree/PR hierarchy
 * (D-002 dropped that as incompatible with the staging + git-sync convention) —
 * just a label, like a tag, that several plans can share.
 *
 * Surgical frontmatter edit (only the `initiative:` line changes; every other
 * key is preserved), inside the plan lock, recording a revision and invalidating
 * the plans list so the rail facet updates. Mirrors plans:transfer-owner — and
 * reuses its `setFrontmatterScalar` primitive. Pass `initiative: null` (or the
 * empty string) to clear the field. Refuses a legacy plan (no valid
 * frontmatter) — convert it with plans:set-frontmatter first.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { parsePlan } from './parser';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { setFrontmatterScalar } from './transfer-owner';

/** Collapse whitespace/newlines so the value can never break out of its single
 *  frontmatter line; trim. Empty → null (clears the field). Exported for tests. */
export function normalizeInitiative(raw: string | null): string | null {
  if (raw === null) return null;
  const v = raw.replace(/\s+/g, ' ').trim();
  return v.length > 0 ? v : null;
}

/** Current `initiative:` value in a frontmatter body, or null. Exported for tests. */
export function currentInitiative(body: string): string | null {
  const m = body.match(/^initiative:[ \t]*(.*)$/m);
  const v = m?.[1]?.trim();
  return v && v.length > 0 ? v : null;
}

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).describe('Plan slug (filename stem) to label.'),
  initiative: z
    .string()
    .max(200)
    .nullable()
    .describe('Initiative grouping label. null or empty string clears it. Plans sharing a label group together in the list facet.'),
  rationale: z
    .string()
    .max(400)
    .optional()
    .describe('Why — stored on the plan revision.'),
});

type SetInitiativeValue =
  | { ok: true; slug: string; from: string | null; to: string | null }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'legacy_plan' };

const text = (payload: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  ...(isError ? { isError: true as const } : {}),
});

export default defineTool({
  name: 'plans:set-initiative',
  description:
    "Set or clear a plan's `initiative` grouping label — a single free-text frontmatter field that groups related plans (surfaced as a filter facet in the plans list). Surgical frontmatter edit (other keys preserved), inside the plan lock, records a revision + refreshes the plans list. Pass `initiative: null` to clear. Refuses a legacy plan — convert it with plans:set-frontmatter first.",
  guidance: {
    when: 'Grouping a set of related plans under one initiative label so they filter together in the plans list — or clearing/renaming that label.',
    notWhen:
      'Transferring ownership / co-owners — plans:transfer-owner. Converting a legacy (no-frontmatter) plan — plans:set-frontmatter. A whole-document raw edit — plans:set-content.',
    chaining: 'plans:list to see existing initiative labels → plans:set-initiative per plan → plans:list to confirm the facet.',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx);
    const next = normalizeInitiative(args.initiative);
    const rationale =
      args.rationale ?? (next ? `set initiative → ${next}` : 'clear initiative');
    const rev = planRevisionCapture(
      ctx as PlanRevisionCtx,
      args.slug,
      rationale,
      harnessSlug ? { harnessSlug } : {},
    );

    const result = await withPlanLock<SetInitiativeValue>(
      ctx as never,
      {
        slug: args.slug,
        intent: 'plans:set-initiative',
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      async (current): Promise<{ newBody: string | null; value: SetInitiativeValue }> => {
        if (current === null) return { newBody: null, value: { ok: false, code: 'not_found' } };
        if (parsePlan(current, { filePath: `${args.slug}.md` }).isLegacy) {
          return { newBody: null, value: { ok: false, code: 'legacy_plan' } };
        }
        const from = currentInitiative(current);
        let body = setFrontmatterScalar(current, 'initiative', next);
        body = bumpUpdatedDate(body);
        return { newBody: body, value: { ok: true, slug: args.slug, from, to: next } };
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
      return text({ error: result.value.code, slug: args.slug }, true);
    }

    // Refresh the rail so the initiative facet updates immediately.
    try {
      const { notifySyncInvalidate } = await import('../../sync-sse');
      await notifySyncInvalidate('plans.list', undefined);
    } catch {
      /* best-effort — the next natural refresh picks it up */
    }

    return text({
      ok: true,
      slug: result.value.slug,
      from: result.value.from,
      to: result.value.to,
      revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
    });
  },
});
