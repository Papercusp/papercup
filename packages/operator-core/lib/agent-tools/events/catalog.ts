/**
 * events:catalog — "what can I wait on?" in one call
 * (event-await-discoverability-and-coverage-2026-07-03 P-002, D-001/D-005).
 *
 * The whole plan's headline is a DISCOVERABILITY gap: the await primitive works,
 * but agents poll (`dev:pipeline_position`, `dev:build_status`) because they never
 * find the event key that already fires. This tool renders the awaitable-key
 * registry (`events/await/catalog.ts` — the single source of truth) so the answer
 * to "is there an event for X?" is one read, not a code grep. It is the read-side
 * companion to `events:graph` (which shows server REACTIONS, not agent AWAITS).
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { EVENT_CATALOG, renderCatalog } from '../../events/await/catalog';

export default defineTool({
  name: 'events:catalog',
  description:
    'List the awaitable event-key families — the answer to "what can I wait on instead of polling?". Each row: the key template (+ a ready events:await example), what it means, who emits it, whether it fires TODAY, the poll it replaces, and its sugar verb (e.g. deploy:await). Check here before you poll dev:pipeline_position / dev:build_status / a peer\'s status.',
  capability: 'events:read',
  guidance: {
    when: 'Before you POLL for something (a deploy landing, the gate going green, a peer\'s work-item settling, a service recovering) — look here for an awaitable key so you can events:await + END YOUR TURN instead of re-polling. Also when you\'re unsure whether an event even exists for X.',
    notWhen: 'You already know the exact key — just events:await it. To see server REACTION wiring ("what fires what") use events:graph; to see YOUR pending awaits + recent wakes use events:status.',
    chaining: 'events:catalog → pick a family → events:await { event: <its key> } (or its sugar verb, e.g. deploy:await) → end your turn.',
    seeAlso: [
      'events:await (arm a wait on a key you found here)',
      'events:graph (server reaction wiring — a different question)',
      'deploy:await / checkpoint:await / work-item:await (named sugar for the common waits)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    family: z
      .string()
      .max(64)
      .optional()
      .describe('Filter to one family id (e.g. "deploy", "work-item"). Omit for the whole catalog.'),
    awaitable_now: z
      .boolean()
      .optional()
      .describe('true = only families whose emitter fires TODAY (hide not-yet-wired Phase-2 keys).'),
  }),
  async handler(args) {
    let rows = renderCatalog();
    if (args.family) rows = rows.filter((r) => r.family === args.family);
    if (args.awaitable_now) rows = rows.filter((r) => r.awaitable_now);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            count: rows.length,
            total: EVENT_CATALOG.length,
            note:
              'Awaiting beats polling: pick a family, events:await its key (or its sugar verb), then END YOUR TURN — you are re-invoked when it fires. awaitable_now:false = the emitter is being wired (Phase 2); the key shape is stable.',
            families: rows,
          }),
        },
      ],
    };
  },
});
