/**
 * coord:catch-up — pull the message HISTORY for an audience you belong to.
 *
 * The audience-keyed, member-scoped read counterpart to a fleet/topic broadcast
 * (fleet-broadcast-audience-history-integration-2026-06-30). Broadcasts are NOT
 * auto-polled, and `expandAudience` resolves a selector to the concrete ownerIds
 * live AT SEND TIME — so an agent that joins a fleet/topic later, or wakes after
 * being paused, has no way to see what was said to it via coord:inbox (its id was
 * never in the frozen `to`). This tool reads everything ever addressed to an
 * audience via the preserved `audience` key (D-003), so a late/returning member
 * catches up.
 *
 * GATE (D-006): low-tier `coord:read` — NOT the firehose `audit:read` that the
 * unscoped coord:feed carries — but the caller MUST currently BELONG to the
 * audience (a live fleet member / topic subscriber, or a `*` broadcast audience).
 * Membership is checked by resolving the audience's CURRENT members via the same
 * hostAudienceResolvers the send path uses and confirming the caller is among
 * them. "You can only catch up on a channel you're in."
 *
 * Bounds (D-005): a fleet may be paused for a week, so a time window is the wrong
 * knob — this takes `limit` (last N messages) and/or `token_budget` (as much as
 * fits in ~N tokens), newest-first, stopping at whichever is hit first; paginate
 * older with the returned next_cursor (before_ts).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { expandAudience } from '../audience';
import { hostAudienceResolvers, canonicalizeAudienceSelector } from '../audience-host';
import { fetchPresenceFleet } from '../presence-fleet';
import { readCoordFeed, MAX_FEED_LIMIT } from '../feed';
import { COORD_ROLES } from '../roles';
import { boundRowField } from '../../_bound-output';

const CATCHUP_DEFAULT_LIMIT = 50;
const BODY_CAP = 200;
const BODY_BUDGET = 8_000;
const SUMMARY_CAP = 400;
const SUMMARY_BUDGET = 10_000;

export default defineTool({
  name: 'coord:catch-up',
  description:
    "Catch up on the message HISTORY for an audience you belong to — everything broadcast to a @fleet:<slug> / @topic:<slug> (or @plan:/@object:/@file:/*) you're a member of, newest-first. This is how you get the backlog after JOINING a fleet/topic or WAKING from a pause: broadcasts are not auto-polled, and your inbox only shows messages whose recipient list named you at send time. Bound the read by `limit` (last N messages) and/or `token_budget` (as much as fits in ~N tokens); paginate older with before_ts/next_cursor. Returns { audience, count, total, tokens, next_cursor, rows }. You must currently belong to the audience (low-tier, membership-checked) — use coord:feed for the unscoped, high-tier firehose.",
  guidance: {
    when:
      'You just joined a fleet/topic, or woke after being paused/offline, and want what was said to that audience while you were away. The pull counterpart to an @fleet:/@topic: broadcast.',
    notWhen:
      'For messages addressed to YOU personally use coord:inbox; for the all-agent firehose use coord:feed (audit:read). This is scoped to ONE audience you belong to.',
    seeAlso: [
      'coord:inbox (messages addressed to you personally)',
      'coord:roster { view:"history" } (who-was-ever-here for this audience)',
      'coord:feed (the all-agent firehose)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    audience: z
      .string()
      .min(1)
      .describe('The audience selector to catch up on, e.g. @fleet:backend, @topic:federation, @plan:my-plan, or * (broadcast). Fleet names are slugified to match how they were stored.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_FEED_LIMIT)
      .optional()
      .describe(`Max messages (newest kept). Default ${CATCHUP_DEFAULT_LIMIT}, max ${MAX_FEED_LIMIT}. Paginate older with before_ts/next_cursor.`),
    token_budget: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Accumulate messages newest-first until ~this many tokens, then stop (≥1 always returned). The "as much history as fits in my context" knob — right for a long backlog. Composes with limit: stops at whichever is hit first.'),
    since_ts: z.string().optional().describe('Only messages strictly later than this ISO timestamp.'),
    before_ts: z
      .string()
      .optional()
      .describe('Only messages strictly earlier than this ISO timestamp — the pagination cursor; pass back the returned next_cursor for the next older page.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const audience = canonicalizeAudienceSelector(args.audience);

    // Membership gate (D-006): resolve the audience's CURRENT members via the same
    // resolvers the send path uses, and confirm the caller is among them — or it's a
    // '*' broadcast audience (anyone may catch up on what reached everyone). A plain
    // (non-@, non-*) value isn't an audience and is rejected.
    if (audience !== '*' && !audience.startsWith('@')) {
      return errorResult(`'${args.audience}' is not an audience selector (expected @fleet:/@topic:/@plan:/@object:/@file: or *).`);
    }
    if (audience !== '*') {
      const allowed = await callerBelongsTo(audience, identity.ownerId);
      if (!allowed) {
        return errorResult(`Not a member of ${audience} — you can only catch up on an audience you currently belong to.`);
      }
    }

    const { rows, nextCursor, total, tokens } = await readCoordFeed({
      audience,
      kinds: ['message', 'notify'],
      limit: args.limit ?? CATCHUP_DEFAULT_LIMIT,
      token_budget: args.token_budget,
      since_ts: args.since_ts,
      before_ts: args.before_ts,
    });

    let boundedRows = boundRowField(rows, 'body', BODY_CAP, BODY_BUDGET);
    boundedRows = boundRowField(boundedRows, 'summary', SUMMARY_CAP, SUMMARY_BUDGET);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            audience,
            count: boundedRows.length,
            total,
            tokens,
            next_cursor: nextCursor,
            rows: boundedRows,
          }),
        },
      ],
    };
  },
});

/**
 * Does `ownerId` belong to `audience` (already canonicalized)? For FLEET audiences,
 * check MEMBERSHIP directly via the coord_presence.fleet_slug label — NOT the delivery
 * audience (listFleetMembers) — so a member who MUTED the fleet can still catch up on
 * its history. For topic/plan/object audiences, the current subscriber/presence set is
 * the right membership signal. `*` is handled by the caller (always allowed).
 */
async function callerBelongsTo(audience: string, ownerId: string): Promise<boolean> {
  for (const prefix of ['@fleet-leader:', '@fleet:']) {
    if (audience.startsWith(prefix)) {
      const slug = audience.slice(prefix.length);
      const membership = await fetchPresenceFleet([ownerId]);
      return membership.get(ownerId)?.fleetSlug === slug;
    }
  }
  const members = await expandAudience([audience], hostAudienceResolvers, 'scoped');
  return members.includes('*') || members.includes(ownerId);
}

function errorResult(message: string) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
  };
}
