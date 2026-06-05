/**
 * operator:standing_approvals_list — auto-refresh + return standing-
 * approval candidates (capability/target pairs the operator has
 * silently dispatched ≥3 times in 24h, eligible for "always allow").
 *
 * Wraps the GET half of /api/agent-mcp/operator-standing-approvals.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  readCandidates,
  refreshCandidates,
} from '../../operator-standing-candidates';

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
  name: 'operator:standing_approvals_list',
  profile: 'engineer',
  description: 'Standing-approval candidates: capability/target pairs the operator has silently dispatched ≥3× in 24h, eligible for "always allow".',
  capability: 'operator:read',
  guidance: {
    when: `List standing approvals — pre-authorized actions the user said "go ahead" to once.`,
    notWhen: `For one-off pending reviews, use \`harness:pending_reviews\`. Standing approvals are session-persistent autoaccepts.`,
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({}),
  async handler() {
    const candidates = await refreshCandidates().catch(async () => await readCandidates());
    return {
      content: [{ type: 'text', text: JSON.stringify({ candidates }) }],
    };
  },
});
