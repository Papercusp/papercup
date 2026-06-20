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
  MAX_FEED_LIMIT,
} from '../feed';
import { boundRowField } from '../../_bound-output';

// EI-1597: the agent-facing default is lower than the UI's DEFAULT_FEED_LIMIT (100)
// because each feed row is a full envelope (body + summary + metadata) — at 100 rows
// the metadata floor alone threatens the agent result cap. 30 recent rows + the
// before_ts cursor is a safe, paginatable default; per-row body/summary are excerpted
// on top. An explicit higher `limit` still works (bodies stay excerpted) — paginate
// with the cursor for a deep timeline.
const AGENT_FEED_DEFAULT = 30;
const FEED_BODY_CAP = 200;
const FEED_BODY_BUDGET = 8_000;
const FEED_SUMMARY_CAP = 400;
const FEED_SUMMARY_BUDGET = 10_000;

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
      .describe(`Max rows (newest kept). Agent default ${AGENT_FEED_DEFAULT} (kept small because each row is a full envelope), max ${MAX_FEED_LIMIT}. Per-row body/summary are excerpted (body_truncated/_full_chars); paginate with before_ts/next_cursor for more.`),
  }),
  async handler(args) {
    const { rows, nextCursor, total, byKind } = await readCoordFeed({
      kinds: args.kinds,
      owner: args.owner,
      plan_slug: args.plan_slug,
      q: args.q,
      since_ts: args.since_ts,
      before_ts: args.before_ts,
      limit: args.limit ?? AGENT_FEED_DEFAULT,
    });
    // EI-1597: excerpt the big per-row text fields so the firehose can't overflow the
    // agent result cap. The q-filter already ran (over full bodies) inside readCoordFeed,
    // so bounding here is display-only; full envelopes via the UI feed or a narrower query.
    let boundedRows = boundRowField(rows, 'body', FEED_BODY_CAP, FEED_BODY_BUDGET);
    boundedRows = boundRowField(boundedRows, 'summary', FEED_SUMMARY_CAP, FEED_SUMMARY_BUDGET);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            count: boundedRows.length,
            total,
            by_kind: byKind,
            next_cursor: nextCursor,
            rows: boundedRows,
          }),
        },
      ],
    };
  },
});
