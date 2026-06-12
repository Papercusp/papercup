/**
 * improvements:triage — Queen-turn triage (P-020 from self-learning-central-2026-06-06).
 *
 * The Queen reads the digest and triages each idea:
 * - type-routes (product→place, process→gate)
 * - attaches triage decision + reason
 * - updates idea lifecycle state
 *
 * This is a working tool (not just read-only) — the Queen calls it to record her
 * triage decisions per idea.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { readImprovementItems } from '../../harness/improvements/read-items';
import { buildDigest } from '../../harness/improvements/digest';
import { triageIdea, summarizeTriages, type IdeaType, type TriageDecision } from '../../harness/improvements/triage';
import { applyTriageDecision } from '../../harness/improvements/triage-core';

export default defineTool({
  name: 'improvements:triage',
  profile: 'engineer',
  description:
    'Queen-turn triage: read the scored improvements:digest and route each idea by the D-005 taxonomy (product→place; code-bug→the policy tier\'s lane; infra-environment→owner-escalation; process-prompt→gate/gym; needs-design→plans:new draft). The safety verdict (auto vs human) comes from the risk-tier policy — triage adds only the routing dimension (D-003: one verdict chain). Updates idea lifecycle state with the Queen\'s decision. (P-010) Supports per-Hive scope filtering.',
  guidance: {
    when:
      'To triage captured ideas: read the digest summary, classify each by the D-005 taxonomy, decide (place/gate/gym/reject), and record the Queen\'s judgment. (P-010) Pass harnessSlug to triage a specific Hive\'s ideas. Routing: product→place in the target Hive; code-bug→the policy tier decides (auto place vs human gate); infra-environment→owner-escalation (D-002, never auto); process-prompt→gate or gym A/B; needs-design→plans:new draft. mode=retriage-all re-routes the whole open backlog after a taxonomy/policy change.',
    notWhen: 'You want to READ ideas — use improvements:digest. You want to CAPTURE — use improvements:capture. You want implementation status — use improvements:resolve.',
    chaining: 'improvements:triage → work_items:create/update for placed ideas, or coord:escalate for human-gate ideas.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    mode: z
      .enum(['summary', 'triage-all', 'triage-one', 'retriage-all'])
      .optional()
      .describe(
        'Summary: show triage breakdown without applying decisions. Triage-all: classify all open ideas. Triage-one: triage a single idea by id. Retriage-all: re-run the deterministic route over EVERY open idea (already-triaged included — triaged→triaged is valid) and PERSIST it; the backlog migration pass for a taxonomy change (consume-edges P-021).',
      ),
    ideaId: z.string().optional().describe('For triage-one mode, the idea to triage'),
    decision: z
      .enum(['place', 'gate', 'gym', 'reject'])
      .optional()
      .describe('For triage-one, the Queen\'s decision'),
    reason: z.string().optional().describe('Reason for the decision (required if decision is set)'),
    harnessSlug: z.string().min(1).max(80).optional().describe('(P-010) restrict to a specific Hive\'s ideas (default: all)'),
  }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);

    // Read all open ideas (P-010: filter by harnessSlug if provided)
    const items = await readImprovementItems({ state: 'open', limit: 100, harnessSlug: args.harnessSlug });
    const digest = buildDigest(items);

    // Summary mode: just show the breakdown
    if (!args.mode || args.mode === 'summary') {
      const summary = summarizeTriages(digest.humanQueue.concat(digest.autoEligible));
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: 'summary',
              digest: {
                total: digest.total,
                open: digest.open,
                byKind: digest.byKind,
                autoEligible: digest.autoEligible.length,
                humanQueue: digest.humanQueue.length,
              },
              triageSummary: summary,
            }),
          },
        ],
      };
    }

    // Triage-all: classify all open ideas and show decisions
    if (args.mode === 'triage-all') {
      const decisions = digest.humanQueue
        .concat(digest.autoEligible)
        .map((item) => {
          const triage = triageIdea(item);
          return {
            id: item.id,
            title: item.title,
            kind: item.kind,
            ideaType: item.ideaType,
            score: item.score,
            decision: triage.decision,
            reason: triage.reason,
            target: triage.target,
          };
        });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: 'triage-all',
              decisions,
              note: 'Queen, review the decisions above. Use triage-one to record each decision you choose to apply.',
            }),
          },
        ],
      };
    }

    // Retriage-all (consume-edges P-021): one deterministic pass over EVERY open
    // idea — already-triaged included (triaged→triaged is a valid transition) — so
    // a taxonomy change re-routes the standing backlog instead of only new items.
    // Decisions are persisted (by='improvement-retriage'); the Queen/owner can
    // still re-take any of them via triage-one.
    if (args.mode === 'retriage-all') {
      const all = digest.humanQueue.concat(digest.autoEligible);
      const byDecision: Record<TriageDecision, number> = { place: 0, gate: 0, gym: 0, reject: 0 };
      const byType: Record<IdeaType, number> = {
        'product': 0,
        'code-bug': 0,
        'infra-environment': 0,
        'process-prompt': 0,
        'needs-design': 0,
      };
      const failures: Array<{ id: string; error: string }> = [];
      let applied = 0;
      for (const item of all) {
        const triage = triageIdea(item);
        const res = await applyTriageDecision({
          id: item.id,
          decision: triage.decision,
          reason: triage.reason,
          by: 'improvement-retriage',
          comment: false, // batch pass — the lifecycle carries the decision, no thread spam
        });
        if (res.ok) {
          applied += 1;
          byDecision[triage.decision] += 1;
          if (item.ideaType) byType[item.ideaType] += 1;
        } else {
          failures.push({ id: item.id, error: res.error ?? 'unknown' });
        }
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: 'retriage-all',
              scanned: all.length,
              applied,
              byDecision,
              byType,
              failures: failures.slice(0, 10),
              failureCount: failures.length,
            }),
          },
        ],
      };
    }

    // Triage-one: record the Queen's decision for a single idea
    if (args.mode === 'triage-one') {
      if (!args.ideaId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'triage-one mode requires ideaId',
              }),
            },
          ],
        };
      }

      if (!args.decision || !args.reason) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'triage-one mode requires decision + reason',
              }),
            },
          ],
        };
      }

      // Persist the Queen's decision durably (learning-system-audit P-010):
      // writes payload.ideaLifecycle (state machine validated), records
      // payload.decidedReason + CLOSES the issue on reject (queue-as-memory —
      // the next same-signature capture recalls "already decided: <reason>").
      const result = await applyTriageDecision({
        id: args.ideaId,
        decision: args.decision as TriageDecision,
        reason: args.reason,
        by: 'Queen',
      });
      if (!result.ok) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ ok: false, error: result.error }) },
          ],
        };
      }

      // Generate guidance based on decision type (P-040: gym re-trigger)
      let note = '';
      if (args.decision === 'place') {
        note = 'Decision persisted. Use work_items:create to assign and track the implementation.';
      } else if (args.decision === 'gate') {
        note = 'Decision persisted. Escalate for human review before proceeding.';
      } else if (args.decision === 'gym') {
        note = 'Decision persisted. Gym A/B dispatch for verification (P-040). Next: call fleet:spawn or harness:create to instantiate the gym with the target prompt variant for evaluation.';
      } else if (args.decision === 'reject') {
        note = 'Decision persisted: issue CLOSED with decidedReason — the recall matcher surfaces it on the next same-signature capture.';
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: 'triage-one',
              ideaId: args.ideaId,
              decision: args.decision,
              reason: args.reason,
              lifecycle: result.lifecycle,
              closed: result.closed ?? false,
              note,
            }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            error: 'Unknown mode',
          }),
        },
      ],
    };
  },
});
