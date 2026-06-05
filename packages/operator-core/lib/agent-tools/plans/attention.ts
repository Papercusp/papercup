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
 *   - operator `<report>` turns (operator_turns.report) → reportTurnsToAttention
 *     (report-cards-inbox-reconciliation-2026-06-05 — the operator's
 *     structured output routes to the Inbox, not the chat stream)
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
import { planItemsToAttention, reportTurnsToAttention } from '../../attention/sources';
import { buildAttentionGroups } from '../../attention/group';
import { applyTriage, groupByTier, type AttentionItem } from '../../attention/types';
import { readTriageByWorkspace } from '../../attention/triage-store';

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
    "The Planning tab's unified attention feed: plan items + coord escalations + coord messages-to-human + smoke-fails + plan-reviews + operator <report> turns, mapped to a single AttentionItem shape, grouped by plan (+ per-harness Alerts bucket), importance-sorted. Each source best-effort.",
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
            // The escalating agent — drives the "Message owner" action (D-005).
            from: typeof e.from === 'string' ? e.from : null,
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
        const mm = m as typeof m & { auto?: unknown; lifecycle?: unknown };
        items.push(
          coordMessageToAttention({
            msgId: m.msg_id,
            summary: typeof m.summary === 'string' ? m.summary : undefined,
            body: typeof m.body === 'string' ? m.body : undefined,
            from: m.from,
            planSlug: typeof m.plan_slug === 'string' ? m.plan_slug : null,
            harnessSlug: resolveHarness(m.harness_slug, typeof m.plan_slug === 'string' ? m.plan_slug : null),
            // Structured lifecycle markers coord:emit stamps (D-003) — classify
            // an auto lifecycle broadcast as Activity, not a Decision.
            auto: mm.auto === true,
            lifecycle: typeof mm.lifecycle === 'string' ? mm.lifecycle : null,
            // A message addressed DIRECTLY to the human (not solely a `*`
            // broadcast) is a genuine ping → Decision.
            directToOwner: Array.isArray(m.to) && m.to.includes('human'),
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

    // 6. Operator `<report>` turns — the operator's structured output is an
    //    inbox surface, not chat content (report-cards-inbox-reconciliation
    //    D-002). One item per report turn at the worst-of tier (D-003); the
    //    recent window + triage (resolve → handled) keep the feed clean (D-004).
    try {
      const { readRecentOperatorReports } = await import('../../attention/operator-report-source');
      const reportTurns = await readRecentOperatorReports();
      items.push(...reportTurnsToAttention(reportTurns));
    } catch {
      /* best-effort */
    }

    // 7. Operator triage overlay (D-006): a downgrade/resolve moves the item to
    //    the auditable "Handled by operator" tier, an escalate/confirm keeps it
    //    a Decision — never a silent vanish. Best-effort: no triage table / PG
    //    offline degrades to "untriaged", never a failed feed.
    let triaged = items;
    try {
      const triage = await readTriageByWorkspace();
      if (triage.size > 0) {
        triaged = items.map((it) => {
          const rec = triage.get(it.id);
          return rec ? applyTriage(it, rec) : it;
        });
      }
    } catch {
      /* best-effort */
    }

    const groups = buildAttentionGroups(triaged);
    const tierCounts = groupByTier(triaged).counts;
    ctxAny.metadata?.({
      itemCount: triaged.length,
      groupCount: groups.length,
      decisions: tierCounts.decision,
      scope: harnessFilter ?? 'all',
    });

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ groups, tierCounts }) }],
    };
  },
});
