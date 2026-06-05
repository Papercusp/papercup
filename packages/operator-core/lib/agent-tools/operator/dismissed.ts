/**
 * operator:dismissed — record a card-id as dismissed so the suggestion
 * parser filters re-emissions during the cooldown window. Mirrors the
 * legacy /api/agent-mcp/operator-dismissed route.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { recordDismissed } from '../../operator-dismissed-cache';

export default defineTool({
  name: 'operator:dismissed',
  profile: 'engineer',
  description: 'Record a card-id as dismissed so the parser filters re-emissions during the cooldown window.',
  capability: 'operator:write',
  guidance: {
    when: `List suggestion cards the user has dismissed — for "why isn't X showing up anymore?".`,
    notWhen: `For ACTIVE pending cards, use \`panel_cards\`. dismissed is the soft-archive view.`,
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'scoper'],
  rolesQuota: {
    architect: { perRun: 50 },
    operator: { perRun: 200 },
    scoper: { perRun: 50 },
  },
  args: z.object({
    id: z.string().min(1),
  }),
  async handler(args) {
    await recordDismissed(args.id);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, id: args.id }) }],
    };
  },
});
