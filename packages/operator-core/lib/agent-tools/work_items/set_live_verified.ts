/**
 * work_items:set_live_verified — mark a (feature-family) work-item LIVE-VERIFIED
 * (release-pipeline-resilience-2026-06-09 P-013).
 *
 * "done" on a pipeline/operator work-item means code-on-staging; its value only exists once
 * DEPLOYED + exercised (the plan's own incident: the release-fixer was "done" yet had never fired on
 * a real red). This records an ADDITIVE payload marker { at, by, deployedSha?, evidence? } that is
 * DISTINCT from the lifecycle state (the core state enum is deliberately untouched) so "shipped to
 * staging" is visibly separated from "confirmed live". Confirm deployment first (release:deploy
 * { op:'status' } / dev:pipeline_position), then record the deployedSha + what you exercised as
 * evidence. clear:true retracts it (e.g. after a rollback). Read it back via work_items:get
 * (payload.live_verified).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { setWorkItemLiveVerified, type WorkItemLiveVerified } from '../../work-items';

const json = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o) }] });

export default defineTool({
  name: 'work_items:set_live_verified',
  profile: 'engineer',
  description:
    'Mark a feature-family work-item LIVE-VERIFIED — an additive payload marker { at, by, deployedSha?, evidence? } that separates "done" (code on staging) from "confirmed live" (deployed + exercised). Does NOT change the lifecycle state. Confirm deployment first (release:deploy status / dev:pipeline_position), then record the deployedSha + evidence. clear:true retracts it (rollback). Read via work_items:get (payload.live_verified). Non-feature items return applicable:false.',
  guidance: {
    when: 'A pipeline/operator work-item is done = code-on-staging, and you have now confirmed it DEPLOYED + exercised on the live host — record the deployedSha + what you exercised so "shipped" vs "live" is no longer ambiguous.',
    notWhen: 'Not for the lifecycle state (work_items:set_state) — this is an additive live-confirmation marker, not a state. Issue-family items return applicable:false.',
    chaining: 'release:deploy { op:"status" } / dev:pipeline_position (confirm the deployed SHA) → work_items:set_live_verified { id, deployedSha, evidence }. clear:true to retract on rollback. work_items:get shows payload.live_verified.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).max(120).describe('The work-item id to mark (F-/WI-).'),
    harness: z.string().max(80).optional().describe('Harness the work-item lives in.'),
    deployedSha: z
      .string()
      .max(200)
      .optional()
      .describe('The deployed commit verified against (from release:deploy status / dev:pipeline_position).'),
    evidence: z.string().max(2000).optional().describe('What was exercised to confirm it live (the proof).'),
    clear: z.boolean().optional().describe('Retract the live_verified marker (e.g. after a rollback).'),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const marker: WorkItemLiveVerified | null = args.clear
      ? null
      : { at: Date.now(), by: ident.ownerId, deployedSha: args.deployedSha ?? null, evidence: args.evidence ?? null };
    const res = await setWorkItemLiveVerified(args.id, marker, { harness: args.harness });
    if (!res) return json({ ok: false, error: `work_item '${args.id}' not found` });
    if (!res.applicable) {
      return json({ ok: true, applicable: false, id: res.id, note: 'live_verified applies to feature-family work-items only' });
    }
    return json({ ok: true, applicable: true, id: res.id, action: args.clear ? 'clear' : 'set', liveVerified: res.liveVerified });
  },
});
