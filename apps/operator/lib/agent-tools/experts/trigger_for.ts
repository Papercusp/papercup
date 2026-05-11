/**
 * experts:trigger_for — manually fire experts whose `alwaysFireOn`
 * matches a lifecycle or event name. Best-effort; returns the per-role
 * outcome rows (`{ role, expertId? error? }`).
 *
 * Architect-only: this dispatches expert workers, which spawns real
 * subprocess work. Worker-role spawns calling this would create
 * fan-out cycles.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  fireEventTriggers,
  fireLifecycleTriggers,
} from '@/lib/expert-triggers';

export default defineTool({
  name: 'experts:trigger_for',
  guidance: {
    when: 'Fire experts whose `alwaysFireOn` configuration matches the given event/context — manually-driven version of the normal hook flow.',
    notWhen: 'For automatic firing, the harness pipeline does it on real events. Only use trigger_for when reviewing / replaying an event.',
  },
  description: 'Fire experts whose alwaysFireOn matches a lifecycle or event. Mode + event + installSlug + ctx; returns per-role dispatch outcomes.',
  capability: 'experts:write',
  requirePrincipal: false,
  roles: ['architect', 'operator'],
  rolesQuota: { architect: { perRun: 20 }, operator: { perRun: 50 } },
  args: z.discriminatedUnion('source', [
    z.object({
      source: z.literal('lifecycle'),
      lifecycle: z.string().min(1),
      installSlug: z.string().min(1),
      ctx: z.record(z.string(), z.unknown()).optional(),
    }),
    z.object({
      source: z.literal('event'),
      event: z.string().min(1),
      installSlug: z.string().min(1),
      arg: z.unknown().optional(),
    }),
  ]),
  async handler(args) {
    if (args.source === 'lifecycle') {
      const out = await fireLifecycleTriggers(args.lifecycle, args.installSlug, args.ctx ?? {});
      return { content: [{ type: 'text', text: JSON.stringify({ source: 'lifecycle', lifecycle: args.lifecycle, dispatched: out }) }] };
    }
    const out = await fireEventTriggers(args.event, args.installSlug, args.arg);
    return { content: [{ type: 'text', text: JSON.stringify({ source: 'event', event: args.event, dispatched: out }) }] };
  },
});
