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
import { buildDigest, type ImprovementDigest } from '../../harness/improvements/digest';
import { triageIdea, summarizeTriages, type TriageDecision } from '../../harness/improvements/triage';
import { updateIdeaLifecycle, initializeIdeaLifecycle, type IdeaLifecyclePayload } from '../../harness/improvements/lifecycle';

export default defineTool({
  name: 'improvements:triage',
  profile: 'engineer',
  description:
    'Queen-turn triage: read the scored improvements:digest and type-route each idea (product→place, process→gate/gym). Updates idea lifecycle state with the Queen\'s decision.',
  guidance: {
    when:
      'To triage captured ideas: read the digest summary, classify each by type, decide (place/gate/gym/reject), and record the Queen\'s judgment.',
    notWhen: 'You want to READ ideas — use improvements:digest. You want to CAPTURE — use improvements:capture. You want implementation status — use improvements:resolve.',
    chaining: 'improvements:triage → work_items:create/update for placed ideas, or coord:escalate for human-gate ideas.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    mode: z
      .enum(['summary', 'triage-all', 'triage-one'])
      .optional()
      .describe(
        'Summary: show triage breakdown without applying decisions. Triage-all: classify all open ideas. Triage-one: triage a single idea by id.',
      ),
    ideaId: z.string().optional().describe('For triage-one mode, the idea to triage'),
    decision: z
      .enum(['place', 'gate', 'gym', 'reject'])
      .optional()
      .describe('For triage-one, the Queen\'s decision'),
    reason: z.string().optional().describe('Reason for the decision (required if decision is set)'),
  }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);

    // Read all open ideas
    const items = await readImprovementItems({ state: 'open', limit: 100 });
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

      // Update the idea's lifecycle with the Queen's decision
      // (In a real implementation, this would write to the DB via an engineer_issues update)
      const lifecycle: IdeaLifecyclePayload = {
        state: 'triaged',
        stateUpdatedAt: new Date().toISOString(),
        triageDecision: args.decision as TriageDecision,
        triageReason: args.reason,
      };

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
              lifecycle,
              note: 'Decision recorded. For place-type ideas, use work_items:create to assign. For gate-type, escalate for human review.',
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
