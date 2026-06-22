/**
 * scheduler:running — the live-execution view (hybrid-bee-scheduler-work-stealing-2026-06-22 P-001).
 *
 * "See the currently-executing workflows": every in-flight (taken, non-terminal) work-item in a
 * harness, with its owning bee, when it was claimed, last progress, and WHICH claim-spec revision
 * the bee is running under (null ⇒ default ordering). Read-only observability over the scheduler —
 * the answer to "what is the fleet executing right now, under which scheduling spec?".
 *
 * Distinct from `ln` (the full fleet-assignment roster / bee load / orphaned-claim detection): this
 * is the scheduler-focused slice that surfaces the per-bee SPEC each running claim executes under.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { listRunningClaims } from '../../scheduler/claim-spec-store';

export default defineTool({
  name: 'scheduler:running',
  profile: 'engineer',
  description:
    'The live-execution view: every in-flight (taken, non-terminal) work-item in a harness with its owning bee, claimed-at, last-progress, and the claim-spec revision the bee is running under (null = default ordering). Read-only — "what is the fleet executing now, under which spec".',
  guidance: {
    when: 'You (Queen / Overwatch / a human) want to see what the fleet is actively working RIGHT NOW and under which scheduling spec — the live-execution view of the scheduler.',
    notWhen:
      'Full fleet roster / bee load / orphaned-claim detection — that is ln. Claiming work — scheduler:get_next. Steering a bee — scheduler:set_claim_spec.',
    chaining:
      'scheduler:running (what is executing) → ln { agent } (drill into a bee) → scheduler:set_claim_spec (re-steer it).',
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ harness: z.string().min(1) }),
  async handler(args) {
    const running = await listRunningClaims(args.harness);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, count: running.length, running }) }],
    };
  },
});
