/**
 * new_subagent:request — ask the BRAIN to spin up a new sub-agent
 * (unify-agent-spawn-chokepoint-2026-06-06, P-005 / D-002 / D-008).
 *
 * Admission is the brain's judgment, not a rules budget: any agent may INITIATE a
 * spawn request (decentralized initiative), it routes to the brain as a typed,
 * brain-only-approvable request, and the requester sleeps on `events:await` until
 * the brain decides. Composed from the existing escalation request→resolve fold +
 * the wake-on-grant rail; the request carries `meta.spawnRequest`, which makes it
 * resolvable ONLY by the brain-gated `new_subagent:approve` (see resolveEscalation's
 * guard + new_subagent:approve's requireRoles).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { openEscalation } from '../coordination/escalations';

export default defineTool({
  name: 'new_subagent:request',
  description:
    'Request the brain spin up a new sub-agent. Routes a typed, brain-only-approvable request; you then events:await the grant and spawn on approval. The BRAIN decides whether it is worth it (informed by the live spawn headroom + open work) — this is judgment, not a rules budget.',
  guidance: {
    when: 'You want to spawn a sub-agent (a helper/specialist) as an autonomous initiative beyond your own role — a spawn worth a brain decision.',
    notWhen:
      'You ARE the brain/operator (you allocate directly) OR this is already-decided pipeline work (the pipeline admits its own role progression) OR a human-initiated psu session (no request needed).',
    chaining:
      'new_subagent:request → events:await { event: <await_event> } (end your turn) → on wake, if choice="approve", fleet:spawn { role, harness, feature }.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  args: z.object({
    role: z.string().min(1).describe('The child agent role to spawn (an AGENT_ROLES id or a plugin-namespaced role).'),
    harness: z.string().optional().describe('Harness slug to spawn into.'),
    feature: z.string().optional().describe('Feature id the child should work, if any.'),
    reason: z.string().min(1).describe('Why this spawn is worth it — the brain reads this to decide.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // Surface the live limit/headroom so the brain's worth-it call is informed (P-007).
    let headroom: { ceiling: number; running: number; headroom: number } | null = null;
    if (ctx.workspaceId) {
      try {
        const { getSpawnHeadroom } = await import('../../fleet/operator-spawn');
        headroom = await getSpawnHeadroom(ctx.workspaceId);
      } catch {
        /* best-effort — the brain can still decide without the live number */
      }
    }
    const rec = await openEscalation(identity, {
      severity: 'question',
      summary: `${identity.ownerLabel ?? identity.ownerId} requests a ${args.role} sub-agent${args.harness ? ` in ${args.harness}` : ''}`,
      body:
        `**Requested role:** \`${args.role}\`` +
        `${args.harness ? `  ·  **harness:** \`${args.harness}\`` : ''}` +
        `${args.feature ? `  ·  **feature:** \`${args.feature}\`` : ''}\n\n` +
        `**Why:** ${args.reason}\n\n` +
        (headroom
          ? `**Live spawn headroom:** ${headroom.running}/${headroom.ceiling} running (${headroom.headroom} free).\n\n`
          : '') +
        `Approve → the requester spawns it; deny → it does not. Only the brain may resolve this (new_subagent:approve).`,
      options: [
        { id: 'approve', label: `Approve — spawn the ${args.role}` },
        { id: 'deny', label: 'Deny — not worth it right now' },
      ],
      meta: {
        spawnRequest: true,
        requestedRole: args.role,
        harness: args.harness ?? null,
        feature: args.feature ?? null,
        reason: args.reason,
        requester: identity.ownerId,
      },
    });
    const awaitEvent = `escalation:resolved:${rec.msg_id}`;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            request_id: rec.msg_id,
            await_event: awaitEvent,
            headroom,
            next:
              `events:await { event: "${awaitEvent}" } then end your turn. On wake, if choice==="approve", ` +
              `fleet:spawn { role: "${args.role}"${args.harness ? `, harness: "${args.harness}"` : ''}${args.feature ? `, feature: "${args.feature}"` : ''} }.`,
          }),
        },
      ],
    };
  },
});
