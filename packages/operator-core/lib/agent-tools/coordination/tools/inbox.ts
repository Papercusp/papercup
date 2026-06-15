/**
 * coord:inbox — read the caller's coordination inbox.
 *
 * Union scan of every agent's outbox in coord/messages/, filtered to
 * entries addressed to me (or to '*'). Sorted by ts ascending.
 * Forgiving of malformed lines.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { resolveActorIdentity, actorMailboxKeys } from '../actor-identity';
import { readInbox, drainAndDeliverUserMailbox } from '../messages';
import { heartbeatPresence } from '../presence';
import { readWatermark } from '../watermarks';
import { emptyWatermark } from '@papercusp/coordination/core';
import {
  resolvePresenceScope,
  assemblePresenceSnapshot,
  renderPresenceRebootstrapBlock,
  consumePresenceRebootstrap,
} from '../presence-snapshot';
import { COORD_ROLES } from '../roles';
import { renderInjection, type CoordLineSource } from '../../../coord-schema';

const COORD_KINDS = [
  'message',
  'ack',
  'subscribe',
  'unsubscribe',
  'notify',
  'handoff',
  'handoff_accepted',
  'escalation',
  'escalation_resolved',
  'contract',
  'plan_event',
] as const;

/** Ambient system-broadcast categories excluded from the default inbox — they
 *  are high-volume status firehoses (service up/down, rate-limit pauses) that
 *  bury addressed work. Still `message`s (D-002); opt back in via include_ambient. */
const AMBIENT_CATEGORIES = new Set(['service-health', 'agent-governor']);

const DEFAULT_INBOX_LIMIT = 50;

export default defineTool({
  name: 'coord:inbox',
  description:
    'Read your coordination inbox — messages, acks, handoffs etc. addressed to you (or broadcast). Returns a summary header (counts by kind) + the most-recent `limit` entries (default 50). Ambient system broadcasts (service-health, rate-limit pauses) are excluded by default — pass include_ambient to see them. `since_ts` filters strictly later than the given ISO timestamp; `kinds` narrows to specific entry kinds.',
  guidance: {
    when: 'At turn start (the OMP hook will do this for you once it ships); whenever you suspect another agent contacted you.',
    notWhen: 'For agent-presence ("who is active?") — use coord:presence. For file locks — use locks:queue.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    since_ts: z.string().optional(),
    kinds: z.array(z.enum(COORD_KINDS)).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe(`Max entries returned (most-recent kept). Default ${DEFAULT_INBOX_LIMIT}.`),
    include_ambient: z
      .boolean()
      .optional()
      .describe('Include ambient system broadcasts (service-health, agent-governor) excluded by default.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const limit = args.limit ?? DEFAULT_INBOX_LIMIT;
    // Offline-member mailbox (shared-hive-collaboration P-016): before the read,
    // deliver any `@user:`-parked assignment waiting for THIS member into their
    // live inbox, so a returning member sees it in this very response. The drain
    // matches the member's full actorUserKey ladder (resolveActorIdentity adds the
    // async gh id; cached). Best-effort — a drain hiccup must never break the read;
    // a fully-online member with no parked mail is a single cheap no-op UPDATE.
    await resolveActorIdentity(ctx)
      .then((actor) => drainAndDeliverUserMailbox(actorMailboxKeys(actor), actor.ownerId))
      .catch(() => {});
    // Piggyback liveness: reading your inbox IS a heartbeat. Keeps a fresh
    // coord:presence row for every active agent (the read hook runs every
    // tool call) without clobbering a declared intent. Best-effort, and run
    // concurrently with the read so it adds no latency.
    // The watermark is read concurrently too — the P-010 re-bootstrap flag rides
    // it (snapshot_rebootstrap_pending), so the common no-flag path adds only one
    // cheap PK read and no extra latency.
    const [, all, wm] = await Promise.all([
      heartbeatPresence(identity).catch(() => {}),
      readInbox(identity.ownerId, { since_ts: args.since_ts, kinds: args.kinds }),
      readWatermark(identity.ownerId).catch(() => emptyWatermark()),
    ]);

    const isAmbient = (e: { category?: unknown }) =>
      typeof e.category === 'string' && AMBIENT_CATEGORIES.has(e.category);
    const ambientExcluded = args.include_ambient ? 0 : all.filter(isAmbient).length;
    const filtered = args.include_ambient ? all : all.filter((e) => !isAmbient(e));

    // readInbox returns ascending by (ts, msg_id); keep the most-recent `limit`.
    const truncated = Math.max(0, filtered.length - limit);
    const entries = truncated > 0 ? filtered.slice(filtered.length - limit) : filtered;

    const byKind: Record<string, number> = {};
    for (const e of filtered) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;

    const summary = {
      total: filtered.length,
      returned: entries.length,
      truncated,
      ambient_excluded: ambientExcluded,
      by_kind: byKind,
      oldest_returned_ts: entries.length ? entries[0]?.ts ?? null : null,
      newest_ts: entries.length ? entries[entries.length - 1]?.ts ?? null : null,
    };

    // Server-side injection render (token-efficient-coord-injection P-005): the
    // ready-to-inject positional `[coord+N]` block, computed ONCE here from the
    // single-source `coord-schema` so the cc + omp hooks are dumb pipes (they
    // echo `injection` + advance the cursor from `summary.newest_ts`). The
    // cursor/summary metadata stays OUT of the injection body, alongside it.
    const coordInjection = renderInjection(entries as unknown as CoordLineSource[]);

    // P-010 re-bootstrap-on-compaction (D-007): on the first read after a fresh
    // context / resume (a session-lifecycle start set snapshot_rebootstrap_pending),
    // the agent's cached roster baseline is gone but this cursor advanced — so
    // PREPEND a fresh presence snapshot to the injection ONCE (then the flag is
    // cleared), and the agent never coordinates off a stale baseline. Best-effort:
    // a failure leaves the flag set to retry and never breaks the inbox read. It
    // rides the same dumb-pipe `injection` echo, so no hook change is needed.
    let rebootstrap: string | null = null;
    try {
      const c = (ctx ?? {}) as { workspaceId?: string | null; harnessSlug?: string | null };
      rebootstrap = await consumePresenceRebootstrap(identity.ownerId, wm, async () => {
        const resolved = await resolvePresenceScope(c);
        const snap = await assemblePresenceSnapshot(resolved);
        return renderPresenceRebootstrapBlock(snap);
      });
    } catch {
      rebootstrap = null;
    }
    const injection = rebootstrap ? `${rebootstrap}\n${coordInjection}` : coordInjection;

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ owner_id: identity.ownerId, summary, entries, injection }),
        },
      ],
    };
  },
});
