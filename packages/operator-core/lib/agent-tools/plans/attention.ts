/**
 * plans:attention — the unified attention reader for the Planning tab
 * (planning-attention-importance-2026-05-31, P-011 / D-004, D-008).
 *
 * Fetches every "needs the human / pick this up" surface, maps each
 * through its AttentionItem adapter, and returns them grouped by plan
 * (+ a synthetic per-harness "Alerts" bucket for unattached items),
 * importance-sorted. Sources:
 *   - plan items (non-terminal)            → planItemToAttention
 *   - open coord escalations               → coordEscalationToAttention
 *   - coord messages addressed to 'human'  → coordMessageToAttention
 *   - failing smoke tests (harness_smoke_test)  → smokeFailToAttention
 *   - plans awaiting review (harness_plan_review) → planReviewToAttention
 *
 * Each source is best-effort: one source erroring (PG offline, no coord
 * log) degrades to fewer items, never a failed read. The orchestrator's
 * needs-human DONE-gate keeps using GET /api/admin/plans/items?needsHuman
 * (unchanged) — this is a separate, additive read (P-012).
 *
 * v1 takes a single optional `harnessSlug` filter (applied to the
 * harness-scoped sources); cross-harness fan-out via the UI selector is
 * wired in Phase 4 (P-016). coord escalations/messages are workspace-
 * level and always included.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readAllPlans } from './source';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import {
  coordEscalationToAttention,
  coordMessageToAttention,
  smokeFailToAttention,
  planReviewToAttention,
} from '../../attention/adapters';
import { planItemsToAttention } from '../../attention/sources';
import { buildAttentionGroups } from '../../attention/group';
import type { AttentionItem } from '../../attention/types';

const ALL_ROLES = [
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
  harnessSlug: z
    .string()
    .min(1)
    .optional()
    .describe('Restrict the harness-scoped sources (smoke-fails, plan-reviews) to one harness. Omit for workspace-wide.'),
  includeArchived: z.boolean().optional().describe('Include items from archived plans. Default false.'),
  harness: harnessArg,
});

export default defineTool({
  name: 'plans:attention',
  description:
    "The Planning tab's unified attention feed: plan items + coord escalations + coord messages-to-human + smoke-fails + plan-reviews, mapped to a single AttentionItem shape, grouped by plan (+ per-harness Alerts bucket), importance-sorted. Each source best-effort.",
  guidance: {
    when: 'You want everything awaiting the human / pickable, in one importance-sorted feed — the Planning tab inbox, or to find the single most-urgent open thing.',
    notWhen:
      'You only need plan items (use plans:items), or the full structure of one plan (plans:get). For the orchestrator DONE-gate use plans:items { needsHuman: true }.',
    chaining: 'plans:attention → act on an item via its kind (plans:set-status for plan items, coord:resolve for escalations).',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const sctx = harnessScopedCtx(args.harness, ctx);
    const opts = await ctxToPlanSourceOpts(sctx);
    const harnessFilter = args.harnessSlug ?? null;
    const includeArchived = args.includeArchived === true;
    const items: AttentionItem[] = [];
    // plan-slug → harness, so coord escalations/messages that carry a plan_slug
    // but no recorded harness can still be scoped (backfills items raised before
    // coord:escalate/coord:send began recording the originating harness).
    const planHarness = new Map<string, string>();

    // 1. Plan items — non-terminal (todo/wip/blocked/needs-human).
    try {
      const plans = await readAllPlans({ includeArchived, ...opts });
      const planItems = planItemsToAttention(plans, harnessFilter);
      for (const it of planItems) {
        if (it.planSlug && it.harnessSlug) planHarness.set(it.planSlug, it.harnessSlug);
      }
      items.push(...planItems);
    } catch {
      /* best-effort */
    }

    // Resolve an attention item's harness: its own recorded harnessSlug (now
    // stamped by coord:escalate / coord:send for harness-scoped agents), else
    // derived from its plan_slug, else null — a genuinely workspace-level item
    // (operator/SU/oracle broadcast) where a per-harness chat doesn't apply.
    const resolveHarness = (recHarness: unknown, planSlug: string | null): string | null => {
      if (typeof recHarness === 'string' && recHarness && recHarness !== '*') return recHarness;
      return planSlug ? planHarness.get(planSlug) ?? null : null;
    };

    // 2. Open coord escalations (workspace-level).
    try {
      const { listEscalations } = await import('../coordination/escalations');
      const escs = await listEscalations({ status: 'open' });
      for (const e of escs) {
        items.push(
          coordEscalationToAttention({
            msgId: e.msg_id,
            severity: e.severity,
            summary: typeof e.summary === 'string' ? e.summary : '',
            body: typeof e.body === 'string' ? e.body : undefined,
            planSlug: typeof e.plan_slug === 'string' ? e.plan_slug : null,
            harnessSlug: resolveHarness(e.harnessSlug, typeof e.plan_slug === 'string' ? e.plan_slug : null),
            options: Array.isArray(e.options) ? e.options : [],
          }),
        );
      }
    } catch {
      /* best-effort */
    }

    // 3. Coord messages addressed to the human (most recent, capped).
    //    Drop messages acked from the human's admin coord UI so "Acknowledge"
    //    dismisses. Scoped to ADMIN_COORD_UI_OWNER (the id those acks are
    //    authored as) — NOT a global ack-set, so an agent acking a broadcast
    //    can't suppress it from the human's inbox (security review).
    try {
      const { readInbox, readAckedMsgIds } = await import('../coordination/messages');
      const { ADMIN_COORD_UI_OWNER } = await import('../coordination/identity');
      const [msgs, acked] = await Promise.all([
        readInbox('human', { kinds: ['message'] }),
        readAckedMsgIds(ADMIN_COORD_UI_OWNER),
      ]);
      for (const m of msgs.slice(-50)) {
        if (acked.has(m.msg_id)) continue;
        items.push(
          coordMessageToAttention({
            msgId: m.msg_id,
            summary: typeof m.summary === 'string' ? m.summary : undefined,
            body: typeof m.body === 'string' ? m.body : undefined,
            from: m.from,
            planSlug: typeof m.plan_slug === 'string' ? m.plan_slug : null,
            harnessSlug: resolveHarness(m.harness_slug, typeof m.plan_slug === 'string' ? m.plan_slug : null),
          }),
        );
      }
    } catch {
      /* best-effort */
    }

    // 4 + 5. Failing smoke tests + plans awaiting review (PG, workspace-scoped).
    try {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { activeWorkspaceId } = await import('../../workspace-registry');
      const { sql } = getOrgPg();
      const wid = activeWorkspaceId();
      const hf = harnessFilter;

      const smoke = await sql<{ harness_slug: string; failure_content: string | null }[]>`
        SELECT harness_slug, failure_content
          FROM harness_shared.harness_smoke_test
         WHERE workspace_id = ${wid}
           AND status = 'fail'
           AND (${hf}::text IS NULL OR harness_slug = ${hf})
      `;
      for (const r of smoke) {
        items.push(smokeFailToAttention({ harnessSlug: r.harness_slug, failureContent: r.failure_content }));
      }

      const reviews = await sql<{ harness_slug: string; content: string | null }[]>`
        SELECT harness_slug, content
          FROM harness_shared.harness_plan_review
         WHERE workspace_id = ${wid}
           AND (${hf}::text IS NULL OR harness_slug = ${hf})
      `;
      for (const r of reviews) {
        items.push(planReviewToAttention({ harnessSlug: r.harness_slug, content: r.content }));
      }
    } catch {
      /* best-effort */
    }

    const groups = buildAttentionGroups(items);
    ctxAny.metadata?.({ itemCount: items.length, groupCount: groups.length, scope: harnessFilter ?? 'all' });

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ groups }) }],
    };
  },
});
