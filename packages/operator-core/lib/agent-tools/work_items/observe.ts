/**
 * work_items:observe — the tuple-space `rd` (D-004).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04. Observe a work-item WITHOUT claiming
 * it — the read primitive kept distinct from the `in` of claim. Reports claimability so
 * a self-selecting agent can decide before taking.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { observeWorkItem } from '../../work-items';

export default defineTool({
  name: 'work_items:observe',
  profile: 'engineer',
  description: 'Observe a work-item WITHOUT claiming it (tuple-space `rd`): reports availability + who holds it. Distinct from claim (`in`).',
  guidance: {
    when: 'Inspect a work-item\'s claimability before deciding to claim it — read without taking.',
    chaining: 'work_items:observe → work_items:claim (if available).',
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1),
    harness: z.string().max(80).optional(),
  }),
  async handler(args) {
    const obs = await observeWorkItem(args.id, { harness: args.harness });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(obs ? { ok: true, ...obs } : { ok: false, error: `work_item '${args.id}' not found` }) }],
    };
  },
});
