/**
 * plans:set-decision-body — replace the body of an existing decision
 * (plan-templates-and-rubric-v2-2026-06-20 P-003).
 *
 * The interface audit found you could plans:add-decision but never EDIT a decision's
 * body without a plans:edit string-replace. This is the structured setter: it
 * replaces everything after the `### D-NNN — title` head line (up to the next
 * heading) with the caller's new body, PRESERVING the head line (the title is
 * unchanged) and re-emitting the existing `Date:` line (creation metadata). Any
 * `Related:`/ref line is part of the body — include it in the new body to keep it.
 * Inside the plan lock; records a revision.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { parsePlan, maskFences } from './parser';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { hardText, softText, clampText, LIMITS } from '../limits';

/**
 * Replace a decision's body. Locates the `### D-NNN` head line against the
 * fence-masked body, finds the block end (the next `###`/`##`/`#` heading or EOF),
 * and rebuilds the block as: head line + (preserved `Date:` line) + the new body.
 * `date` is the parsed decision date (re-emitted, or omitted when null). Returns the
 * prior body (minus head + date) for transparency. Exported for tests.
 */
export function setDecisionBodyInBody(
  body: string,
  decisionId: string,
  newDecisionBody: string,
  date: string | null,
): { newBody: string; found: boolean; oldBody: string } {
  const headRe = new RegExp(
    String.raw`^###\s+` + decisionId.replace(/-/g, '\\-') + String.raw`\b[^\n]*$`,
    'm',
  );
  const masked = maskFences(body);
  const hm = headRe.exec(masked);
  if (!hm) return { newBody: body, found: false, oldBody: '' };

  const headLineEnd = hm.index + hm[0].length; // end of the "### D-NNN — title" line text
  // The block runs to the next heading (### next decision / ## next section / #) or EOF.
  const restMasked = masked.slice(headLineEnd);
  const tailM = /^#{1,3}\s/m.exec(restMasked);
  const blockEnd = tailM ? headLineEnd + tailM.index : body.length;

  const oldBlock = body.slice(headLineEnd, blockEnd);
  const datePiece = date ? `Date: ${date}\n` : '';
  // One blank line before a following heading (matches add-decision's block spacing);
  // none at EOF.
  const trailing = blockEnd < body.length ? '\n' : '';
  const rebuilt = `\n${datePiece}${newDecisionBody.trim()}\n${trailing}`;
  const newBody = body.slice(0, headLineEnd) + rebuilt + body.slice(blockEnd);

  // oldBody (for the result) = the prior block minus its leading blank + Date line.
  const oldBody = oldBlock.replace(/^\s*/, '').replace(/^Date:[^\n]*\n?/i, '').trim();
  return { newBody, found: true, oldBody };
}

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).describe('Plan slug (filename stem).'),
  decisionId: z.string().regex(/^D-\d{3,}$/, 'D-NNN form required'),
  body: hardText(5000).describe(
    "The decision's new body (replaces the prior body). The `### D-NNN — title` head and the `Date:` line are preserved; everything else is replaced. To keep a `Related:` line, include it in the new body.",
  ),
  rationale: softText(LIMITS.ANNOTATION)
    .optional()
    .describe('Optional — why the decision body changed (a correction, an added caveat). Stored on the plan revision (D-009). Auto-truncated to 2000 chars if longer.'),
});

type SetDecisionBodyValue =
  | { ok: true; decisionId: string; slug: string; oldBody: string }
  | { ok: false; code: 'not_found' | 'legacy_plan' | 'decision_not_found' };

const text = (payload: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  ...(isError ? { isError: true as const } : {}),
});

export default defineTool({
  name: 'plans:set-decision-body',
  description:
    "Replace an existing decision's body — preserves the `### D-NNN — title` head and the `Date:` line, replaces everything else with the new body. Inside the plan lock, records a revision. The structured editor decisions lacked (plans:add-decision could only append; editing meant a plans:edit string-replace).",
  guidance: {
    when: "A decision's body needs revising — a correction, a clarification, an added caveat — keeping its id, title, and date. The structured alternative to a plans:edit on the decision block.",
    notWhen:
      'Recording a NEW decision (plans:add-decision). Changing a decision title (plans:edit — title lives on the head line). A whole-document rewrite (plans:set-content).',
    chaining: 'plans:get (the decision body) → plans:set-decision-body → plans:get to confirm.',
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
      clampText(args.rationale, LIMITS.ANNOTATION),
      harnessSlug ? { harnessSlug } : {},
    );

    const result = await withPlanLock<SetDecisionBodyValue>(
      ctx as never,
      {
        slug: args.slug,
        intent: `plans:set-decision-body ${args.decisionId}`,
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      async (current): Promise<{ newBody: string | null; value: SetDecisionBodyValue }> => {
        if (current === null) return { newBody: null, value: { ok: false, code: 'not_found' } };
        const parsed = parsePlan(current, { filePath: args.slug + '.md' });
        if (parsed.isLegacy) return { newBody: null, value: { ok: false, code: 'legacy_plan' } };
        const decision = parsed.decisions.find((d) => d.id === args.decisionId);
        if (!decision) return { newBody: null, value: { ok: false, code: 'decision_not_found' } };

        const { newBody, found, oldBody } = setDecisionBodyInBody(
          current,
          args.decisionId,
          args.body,
          decision.date,
        );
        if (!found) return { newBody: null, value: { ok: false, code: 'decision_not_found' } };
        return {
          newBody: bumpUpdatedDate(newBody),
          value: { ok: true, decisionId: args.decisionId, slug: args.slug, oldBody },
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
      return text({ error: result.value.code, slug: args.slug, decisionId: args.decisionId }, true);
    }

    // Refresh the plans rail so a decision-derived view updates immediately.
    try {
      const { notifySyncInvalidate } = await import('../../sync-sse');
      await notifySyncInvalidate('plans.list', undefined);
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
