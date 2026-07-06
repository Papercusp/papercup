/**
 * fleet:bee_mail — read one bee's coord INBOX + OUTBOX by ownerId
 * (pui-bee-dossier-pane-2026-06-06).
 *
 * The bee-dossier dock pane's bottom half: UPPER = messages addressed TO the
 * bee (inbox), LOWER = messages FROM the bee (outbox). Unlike coord:inbox (which
 * reads the CALLER's own inbox via ctx identity), this reads an ARBITRARY bee's
 * mail by ownerId — the dock's bee pane is not that bee, it's an observer.
 *
 * Read-only over the coord message log; no heartbeat side effect (we're not the
 * bee). Each side is capped + newest-last (ascending by ts, like coord:inbox).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { readInbox, readOutbox } from '../coordination/messages';

const DEFAULT_LIMIT = 50;

export default defineTool({
  name: 'fleet:bee_mail',
  profile: 'engineer',
  description:
    "Read one bee's coordination mail by ownerId: its INBOX (messages addressed to it, or broadcast) and its OUTBOX (messages it sent). The observer view behind the bee-dossier dock pane — distinct from coord:inbox, which reads YOUR own inbox. Read-only; no heartbeat.",
  guidance: {
    when: 'Rendering the cup-dossier pane, or inspecting what a specific cup has received/sent without being that cup.',
    notWhen:
      'Reading YOUR own inbox (use coord:inbox — it also heartbeats your presence). Deriving fleet state / who is on what (use fleet:assignments).',
    chaining:
      'fleet:selected_bee {} (poll the selection) → fleet:bee_mail { owner_id } + fleet:assignments { agent: owner_id } for the full dossier.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    owner_id: z
      .string()
      .min(1)
      .max(200)
      .describe("The cup's ownerId (from fleet:assignments / the swarm roster)."),
    since_ts: z
      .string()
      .optional()
      .describe('Only entries strictly later than this ISO timestamp (both sides).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe(`Max entries per side, most-recent kept. Default ${DEFAULT_LIMIT}.`),
  }),
  async handler(args) {
    const limit = args.limit ?? DEFAULT_LIMIT;
    const [inboxAll, outboxAll] = await Promise.all([
      readInbox(args.owner_id, { since_ts: args.since_ts }),
      readOutbox(args.owner_id, { since_ts: args.since_ts }),
    ]);
    // Both readers return ascending by (ts, msg_id); keep the most-recent `limit`.
    const tail = (arr: typeof inboxAll) =>
      arr.length > limit ? arr.slice(arr.length - limit) : arr;
    const inbox = tail(inboxAll);
    const outbox = tail(outboxAll);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            owner_id: args.owner_id,
            inbox: {
              total: inboxAll.length,
              returned: inbox.length,
              entries: inbox,
            },
            outbox: {
              total: outboxAll.length,
              returned: outbox.length,
              entries: outbox,
            },
          }),
        },
      ],
    };
  },
});
