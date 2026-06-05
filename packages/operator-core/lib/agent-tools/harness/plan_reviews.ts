/**
 * harness:plan_reviews — load all plan-review entries (verdict +
 * summary + mtime) across the workspace's harnesses.
 *
 * Useful for agents deciding whether to escalate or revisit a feature
 * before re-running plan-gate.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { loadHarnessPlanReviews } from '../../harness-plan-reviews';

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

export default defineTool({
  name: 'harness:plan_reviews',
  profile: 'engineer',
  description: 'Load all harness plan-review entries (slug, verdict, summary, mtimeMs) across the workspace.',
  guidance: {
    when: 'Cross-harness plan-review status — "what plans have been reviewed", "any verdicts?". Single-harness lookups use `harness:pending_reviews`.',
    notWhen: 'For one harness\'s pending reviews, use `harness:pending_reviews`. For all-harness LIVE health, use `harness:list` then `harness:status` per slug.',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({}),
  async handler() {
    const entries = await loadHarnessPlanReviews();
    return { content: [{ type: 'text', text: JSON.stringify({ entries }) }] };
  },
});
