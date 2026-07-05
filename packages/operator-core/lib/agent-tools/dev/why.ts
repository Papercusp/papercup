/**
 * dev:why — "why is nothing shipping?" causal-chain explainer (EI-7349).
 *
 * Walks gate -> deploy -> pool top-down and renders one causal sentence per
 * stage plus a ROOT CAUSE line naming the upstream-most blocking leaf, instead
 * of an agent manually stitching together release:deploy status, test_runs,
 * and accounts:status by hand (the 13h 2026-07-03/04 deploy-freeze forensic
 * exercise this item was filed from). Deterministic, no LLM — see why-chain.ts.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { computeWhyChain } from '../../why-chain';

export default defineTool({
  name: 'dev:why',
  profile: 'engineer',
  description:
    '"Why is nothing shipping?" in one read: walks green-checkpoint gate health -> release-gate deploy position -> account-pool rate-limit status top-down, and returns one causal sentence per stage plus a ROOT CAUSE line naming the current blocking leaf (a red test file, a stuck promotion, a saturated pool). Deterministic — no LLM. Read-only.',
  capability: 'intel:read',
  guidance: {
    when: 'The owner or an agent asks "why is nothing shipping / deploying" or a deploy has been frozen/stalled for a while and you need the causal chain in one call instead of manually cross-referencing dev:pipeline_position, testing:flakiness, and accounts:status.',
    notWhen: 'To check ONE specific path/sha\'s position, use dev:pipeline_position. To rank flaky files over a longer window, use testing:flakiness. This is the top-down "what is the root blocker right now" read.',
    seeAlso: ['dev:pipeline_position (per-path/sha probe)', 'accounts:status (per-account detail)', 'testing:flakiness (flip-rate history)'],
  },
  requirePrincipal: false,
  agentRoles: [
    'operator', 'queen', 'architect', 'worker', 'scoper', 'validator', 'reviewer',
    'debugger', 'documenter', 'curator', 'bee', 'sentinel', 'overwatch',
    'release-fixer', 'merge-resolver', 'content-fixer', 'release-manager',
  ],
  args: z.object({
    workspace: z.string().max(200).optional().describe('Workspace id to scope the account-pool read to (default: active workspace).'),
    harness: z.string().max(120).optional().describe('Harness slug to scope the recent-test-failures read to (default: workspace-wide).'),
  }),
  async handler(args, ctx) {
    const result = await computeWhyChain({
      workspaceId: args.workspace ?? ctx.workspaceId,
      harnessSlug: args.harness ?? ctx.harnessSlug,
    });
    return { data: result };
  },
});
