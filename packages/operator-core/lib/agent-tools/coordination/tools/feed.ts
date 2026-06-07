/**
 * coord:feed — the WHOLE coordination firehose, read across every channel.
 *
 * Unlike coord:inbox (one owner) / coord:escalations (one channel), this is the
 * complete observer stream: every envelope every agent has exchanged — messages,
 * acks, notifies, broadcasts, handoffs + acceptances, escalations + resolutions,
 * plan events — folded chronological (newest-first) with a next-page cursor.
 *
 * It exposes ALL agents' traffic, so it is gated `audit:read` (high-tier) — the
 * same trust boundary as `audit:list`, NOT the low-tier `coord:read` the
 * per-owner readers use. Read-only.
 *
 * Backs the /adv Conversations "Feed" view (also reachable directly here for
 * diagnostics / forensic timelines).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../roles';
import {
  readCoordFeed,
  ALL_COORD_KINDS,
  DEFAULT_FEED_LIMIT,
  MAX_FEED_LIMIT,
} from '../feed';

export default defineTool({
  name: 'coord:feed',
  description:
    'Read the COMPLETE coordination stream across every agent and channel — messages, acks, notifies, broadcasts, handoffs, escalations, resolutions, plan events — newest-first with a next-page cursor. Filter by kinds, owner (matches sender OR recipient; broadcasts match any owner), plan_slug, free-text `q` (over summary/body/from/to), and a since_ts/before_ts time window. before_ts is the pagination cursor (pass back the returned `nextCursor`). Returns `{ count, total, by_kind, next_cursor, rows }`; each row is the raw envelope plus `surface` (messages|escalations|handoffs|plan-events) and a derived `broadcast` flag.',
  guidance: {
    when:
      'You need the full fleet-wide coordination timeline — auditing what agents said to each other, tracing a broadcast/handoff/escalation chain, or backing an observer UI. The all-traffic counterpart to the per-owner coord:inbox.',
    notWhen:
      'For YOUR addressed messages use coord:inbox; for open human escalations use coord:escalations; for live "who is active" use coord:presence. coord:feed is the read-everything firehose, not a working inbox.',
  },
  // High-tier: this surfaces every agent's traffic — same trust boundary as
  // audit:list (a forensic, all-actor read), NOT the low-tier coord:read the
  // per-owner inbox/outbox readers use.
  capability: 'audit:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    kinds: z
      .array(z.enum(ALL_COORD_KINDS))
      .optional()
      .describe('Restrict to these envelope kinds. Omitted = every kind.'),
    owner: z
      .string()
      .optional()
      .describe('An ownerId. Matches envelopes where this owner is the sender OR a recipient; broadcasts match any owner.'),
    plan_slug: z.string().optional().describe('Restrict to one plan slug.'),
    q: z.string().optional().describe('Case-insensitive substring over summary/body/from/to/plan_slug.'),
    since_ts: z.string().optional().describe('Strictly later than this ISO timestamp (older bound).'),
    before_ts: z
      .string()
      .optional()
      .describe('Strictly earlier than this ISO timestamp (newer bound) — the pagination cursor; pass back the returned next_cursor.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_FEED_LIMIT)
      .optional()
      .describe(`Max rows (newest kept). Default ${DEFAULT_FEED_LIMIT}, max ${MAX_FEED_LIMIT}.`),
  }),
  async handler(args) {
    const { rows, nextCursor, total, byKind } = await readCoordFeed({
      kinds: args.kinds,
      owner: args.owner,
      plan_slug: args.plan_slug,
      q: args.q,
      since_ts: args.since_ts,
      before_ts: args.before_ts,
      limit: args.limit,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            count: rows.length,
            total,
            by_kind: byKind,
            next_cursor: nextCursor,
            rows,
          }),
        },
      ],
    };
  },
});
