/**
 * coord:escalate — raise an escalation to the human.
 *
 * The channel that earns the right to interrupt. Use sparingly — only
 * for decisions the agent should not make alone. The UI surfaces open
 * escalations prominently; coord:resolve closes them out.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { openEscalation } from '../escalations';
import { COORD_ROLES } from '../roles';

const SEVERITY = ['blocker', 'question', 'advisory'] as const;

export default defineTool({
  name: 'coord:escalate',
  description:
    'Raise an escalation to the human. Provide severity (blocker | question | advisory), a one-line summary, and optionally a body and a small list of choice options to make resolution one click.',
  guidance: {
    when: 'A decision you should not make alone, a blocker that requires human input, or a risky operation that needs explicit confirmation.',
    notWhen: 'Routine status updates — use coord:send. File contention — locks:queue already names the holder.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    severity: z.enum(SEVERITY),
    summary: z.string().min(1).max(280),
    body: z.string().optional(),
    plan_slug: z.string().optional(),
    options: z
      .array(z.object({ id: z.string().min(1), label: z.string().min(1) }))
      .optional()
      .describe('Optional named choices the human can pick from. Omit for free-form.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // Record the escalating agent's harness (pipeline roles carry it) so the
    // human inbox can open a chat scoped to it. '*'/empty = operator/SU/oracle
    // wildcard ⇒ workspace-level escalation; leave harness unset there.
    const ctxHarness = (ctx as { harnessSlug?: unknown }).harnessSlug;
    const harnessSlug =
      typeof ctxHarness === 'string' && ctxHarness && ctxHarness !== '*' ? ctxHarness : undefined;
    const rec = await openEscalation(identity, {
      severity: args.severity,
      summary: args.summary,
      body: args.body,
      plan_slug: args.plan_slug,
      options: args.options,
      ...(harnessSlug ? { meta: { harnessSlug } } : {}),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, msg_id: rec.msg_id, ts: rec.ts }),
        },
      ],
    };
  },
});
