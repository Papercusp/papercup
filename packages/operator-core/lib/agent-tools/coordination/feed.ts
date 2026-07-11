/**
 * feed.ts — the WHOLE coordination firehose, read across every channel.
 *
 * The per-channel adapters (messages / escalations / handoffs / plan-events)
 * each read a single surface of `harness_shared.coord_event_log` through the
 * `coordLog` seam. The observer surfaces built on them (coord:inbox,
 * coord:escalations, coord:handoffs) are each scoped to ONE owner or ONE
 * channel. There was no read that returns the complete, cross-channel,
 * cross-owner stream — every envelope every agent has exchanged.
 *
 * `readCoordFeed` is that read. It unions the four log surfaces, folds them to
 * a single chronological stream (newest-first), and applies observer-side
 * filters (kind / owner / plan_slug / free-text / time window). It is the data
 * seam behind the `coord:feed` tool and the /adv Conversations "Feed" view.
 *
 * It reuses the SAME `CoordEnvelope` vocabulary the channels write — no parallel
 * schema. Each returned row is the raw envelope plus a `surface` tag (so the UI
 * can colour/route by origin) and a derived `broadcast` flag (`to` includes
 * '*').
 *
 * SECURITY: this exposes EVERY agent's traffic, so the tool that calls it is
 * gated high-tier (audit:read) — same trust boundary as audit:list. The seam
 * itself is unscoped on purpose; gating lives at the tool layer.
 */

import type { CoordEnvelope, CoordKind } from '@papercusp/coordination/core';
import { compareByTsThenId } from '@papercusp/coordination/core';
import { coordLog } from './log';
import { estimateTokens } from './presence-cost';
import { collectRetractedIds, suppressRetracted } from './retraction';

type CursorSurfaceState = { cursor: number | undefined; exhausted: boolean };

/** The four append-only channels that live in coord_event_log. */
export type CoordSurface = 'messages' | 'escalations' | 'handoffs' | 'plan-events';

/** Every kind that can appear in the feed, across all surfaces. The line
 *  surfaces carry message/ack/notify/subscribe/unsubscribe/contract/plan_event;
 *  the event surfaces carry handoff/handoff_accepted/escalation/
 *  escalation_resolved. (CoordKind is the canonical union — re-stated here as a
 *  literal tuple so the tool/UI can enumerate it for the kind filter chips.) */
export const ALL_COORD_KINDS = [
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
] as const satisfies readonly CoordKind[];

/** One feed row: the raw envelope + origin surface + derived broadcast flag. */
export interface CoordFeedRow extends CoordEnvelope {
  /** Which log surface this envelope came from. */
  surface: CoordSurface;
  /** True when `to` addresses everyone (`['*']`). */
  broadcast: boolean;
}

export interface ReadCoordFeedOpts {
  /** Restrict to these kinds. Empty/omitted = every kind. */
  kinds?: CoordKind[];
  /** Match an ownerId on EITHER side — `from === owner` OR `to` includes owner
   *  (broadcasts, `['*']`, match any owner filter since they reach everyone). */
  owner?: string;
  /** Match the SENDER only — `from === this` (EI-7018). Unlike `owner`, this does NOT
   *  match recipients and does NOT let broadcasts through, so it is the precise "show only
   *  what agent X SENT" filter (e.g. verifying your own coord:send landed, or reading one
   *  peer's messages) rather than the sender-OR-recipient-plus-broadcasts `owner` match. */
  from?: string;
  /** Restrict to system-origin envelopes. Used by diagnostic UI surfaces that
   * must not overlap the agent-authored curated conversation stream. */
  system_only?: boolean;
  /** Restrict to one plan slug. */
  plan_slug?: string;
  /** Restrict to envelopes addressed to this audience selector (`@fleet:<slug>` /
   *  `@topic:<slug>` / `@plan:<slug>` / `@object:…` / `@file:…` / `*`), matched
   *  against the preserved `audience` key. This is the audience-keyed HISTORY read:
   *  a late/returning member catches up on everything sent to the fleet/topic even
   *  though their ownerId was never in the resolved `to`. Fleet selectors should be
   *  passed canonicalized (slug form) to match how they were stored. */
  audience?: string;
  /** Case-insensitive substring over summary + body + from + to. */
  q?: string;
  /** Strictly-later-than this ISO ts (older bound). */
  since_ts?: string;
  /** Strictly-earlier-than this ISO ts (newer bound) — the pagination cursor. */
  before_ts?: string;
  /** Max rows returned (newest kept). */
  limit?: number;
  /** Token budget: accumulate rows newest-first until the estimated token cost of
   *  the page would exceed this, then stop (at least one row is always returned).
   *  The right knob for "give me as much history as fits in my context" — a fleet
   *  paused for a week makes a time window useless, but `last N messages` (limit) or
   *  `~N tokens` (this) is exactly what an agent wants. Bounds compose: the page
   *  stops at whichever of `limit` or `token_budget` is hit first. */
  token_budget?: number;
  /** coord:retract (WI-4176): also return messages a retraction notice has
   *  withdrawn. Default false — retracted messages are SUPPRESSED from the
   *  feed (the notice row itself is always visible). True is the forensic /
   *  audit escape hatch. */
  includeRetracted?: boolean;
}

export const DEFAULT_FEED_LIMIT = 100;
export const MAX_FEED_LIMIT = 500;

// WI-3869: the raw per-surface fetch is bounded, never a full-table scan. Each
// surface's readLines/readEvents used to run an unbounded `ORDER BY id ASC`
// (no LIMIT) over the WHOLE coord_event_log surface partition — fine when the
// log was small, but as it accumulates this degrades into a multi-minute scan
// (observed: a single query ran 130s, causing coord:presence/fleet:status/
// coord:orient to time out and render a live fleet as empty/paused). Switched
// to the already-existing readLinesBounded/readEventsBounded (ORDER BY id DESC
// LIMIT n, riding the coord_event_log_surface_id index) — the same bounded
// primitive escalations.ts and plan-events.ts already use for this table.
// RAW_SURFACE_FETCH_CAP matches the hard clamp those methods already enforce
// internally (1000), so this introduces no NEW truncation ceiling, just stops
// asking for more than the store would ever honor unbounded.
//
// Trade-off (disclosed, not silent): the FIRST fetch per surface is still
// capped at RAW_SURFACE_FETCH_CAP rows — every realistic caller (coord:feed's
// default page, coord:orient's fleet-catch-up fold, coord:catch-up's audience
// backlog) wants recent activity and comfortably fits inside this window
// (MAX_FEED_LIMIT is 500, well under the 1000/surface raw cap), so the common
// path pays for exactly one bounded read per surface, same as before.
//
// WI-3880 (fast-follow of WI-3869): a caller that passes `before_ts` and pages
// deeper than that first window no longer dead-ends. `readCoordFeed` reads via
// the id-CURSOR bounded methods (`read*BoundedCursor`) instead of the plain
// `read*Bounded` ones; when the assembled filtered page is still short after
// the first round AND at least one surface isn't exhausted, it fetches
// additional RAW_SURFACE_FETCH_CAP-sized rounds per surface (walking each
// surface's own `id` cursor backward), up to MAX_CURSOR_ROUNDS rounds total —
// bounding the worst case to MAX_CURSOR_ROUNDS × RAW_SURFACE_FETCH_CAP rows
// per surface instead of an unbounded scan. Deepening only ever triggers on a
// `before_ts` page past the first window; the no-`before_ts` common case does
// exactly the one round it always did.
const RAW_SURFACE_FETCH_CAP = 1000;

// WI-3880: hard cap on additional deepening rounds (see above) — the ceiling
// on how far a single `before_ts` page will walk before giving up and
// returning whatever it has (still correct: `nextCursor`/`total`/`byKind`
// simply reflect the window actually fetched, exactly as they always have).
const MAX_CURSOR_ROUNDS = 10;

const LINE_SURFACES = ['messages', 'plan-events'] as const;
const EVENT_SURFACES = ['escalations', 'handoffs'] as const;

function isBroadcast(to: unknown): boolean {
  return Array.isArray(to) && to.includes('*');
}

function matchesOwner(env: CoordEnvelope, owner: string): boolean {
  if (env.from === owner) return true;
  if (Array.isArray(env.to)) {
    if (env.to.includes(owner)) return true;
    if (env.to.includes('*')) return true; // a broadcast reaches the named owner
  }
  return false;
}

function matchesAudience(env: CoordEnvelope, audience: string): boolean {
  return Array.isArray(env.audience) && env.audience.includes(audience);
}

export function isSystemCoordActor(value: string | null | undefined): boolean {
  return /^system(?:$|[-_:/.])/i.test((value ?? '').trim());
}

function matchesText(env: CoordEnvelope, needle: string): boolean {
  const hay = [
    env.summary,
    env.body,
    env.from,
    Array.isArray(env.to) ? env.to.join(' ') : '',
    env.plan_slug,
    typeof env.event === 'string' ? env.event : '',
    typeof env.detail === 'string' ? env.detail : '',
  ]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join('\n')
    .toLowerCase();
  return hay.includes(needle);
}

/**
 * Read the complete cross-channel coordination stream, newest-first, filtered.
 *
 * Returns `{ rows, nextCursor }`. `nextCursor` is the `ts` of the oldest row
 * returned when the page was capped (more rows exist) — pass it back as
 * `before_ts` to fetch the next (older) page; `null` when the stream is
 * exhausted.
 *
 * (WI-3869) The raw per-surface read behind this is bounded to
 * RAW_SURFACE_FETCH_CAP rows per round, never a full-table scan. (WI-3880) A
 * `before_ts` page that runs past that first window walks each surface's
 * `id` cursor for up to MAX_CURSOR_ROUNDS additional rounds instead of
 * dead-ending there; `total`/`byKind` reflect whatever was actually fetched
 * (the whole surface once every surface reports `exhausted`, or the capped
 * window otherwise). See the RAW_SURFACE_FETCH_CAP / MAX_CURSOR_ROUNDS
 * comments above for the sizing rationale.
 */
export async function readCoordFeed(
  opts: ReadCoordFeedOpts = {},
): Promise<{ rows: CoordFeedRow[]; nextCursor: string | null; total: number; byKind: Record<string, number>; tokens: number }> {
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_FEED_LIMIT), MAX_FEED_LIMIT);

  // Union every surface. Tag each envelope with its origin surface.
  const tagged: CoordFeedRow[] = [];
  // Push kinds/since_ts/plan_slug down to the store where the bounded methods
  // support it — fewer rows fetched+held in memory, not just a bounded count.
  const kindsForPushdown = opts.kinds && opts.kinds.length > 0 ? opts.kinds : undefined;

  // Per-surface id-cursor state (WI-3880) — undefined cursor = read the
  // newest window; `exhausted` once a surface has nothing older left.
  const lineState = new Map<(typeof LINE_SURFACES)[number], CursorSurfaceState>(
    LINE_SURFACES.map((s) => [s, { cursor: undefined, exhausted: false }]),
  );
  const eventState = new Map<(typeof EVENT_SURFACES)[number], CursorSurfaceState>(
    EVENT_SURFACES.map((s) => [s, { cursor: undefined, exhausted: false }]),
  );

  // Filter predicate — extracted so the deepening loop below can cheaply
  // check "do we have enough yet?" without duplicating the filter logic.
  const kindSet = opts.kinds && opts.kinds.length > 0 ? new Set<CoordKind>(opts.kinds) : null;
  const needle = opts.q?.trim().toLowerCase();
  const sinceMs = opts.since_ts ? new Date(opts.since_ts).getTime() : null;
  const beforeMs = opts.before_ts ? new Date(opts.before_ts).getTime() : null;
  const passesFilter = (env: CoordFeedRow): boolean => {
    if (kindSet && !kindSet.has(env.kind)) return false;
    if (opts.owner && !matchesOwner(env, opts.owner)) return false;
    if (opts.from && env.from !== opts.from) return false; // EI-7018: strict sender-only filter
    if (opts.system_only && !isSystemCoordActor(env.from)) return false;
    if (opts.plan_slug && env.plan_slug !== opts.plan_slug) return false;
    if (opts.audience && !matchesAudience(env, opts.audience)) return false;
    if (needle && !matchesText(env, needle)) return false;
    if (sinceMs !== null || beforeMs !== null) {
      const ms = new Date(env.ts).getTime();
      if (sinceMs !== null && !(ms > sinceMs)) return false;
      if (beforeMs !== null && !(ms < beforeMs)) return false;
    }
    return true;
  };

  // One round: fetch each not-yet-exhausted surface's next RAW_SURFACE_FETCH_CAP
  // window (from its current cursor), tag + accumulate, advance the cursor.
  const fetchRound = async (): Promise<void> => {
    const lineReads = LINE_SURFACES.map(async (surface) => {
      const st = lineState.get(surface)!;
      if (st.exhausted) return;
      const page = await coordLog.readLinesBoundedCursor(surface, {
        limit: RAW_SURFACE_FETCH_CAP,
        ...(kindsForPushdown ? { kinds: kindsForPushdown } : {}),
        ...(opts.since_ts ? { sinceTs: opts.since_ts } : {}),
        ...(opts.plan_slug ? { planSlug: opts.plan_slug } : {}),
        ...(st.cursor !== undefined ? { beforeId: st.cursor } : {}),
      });
      for (const row of page.rows) {
        tagged.push({ ...row.envelope, surface, broadcast: isBroadcast(row.envelope.to) });
      }
      st.exhausted = page.exhausted;
      if (page.rows.length > 0) st.cursor = page.rows[page.rows.length - 1]!.id;
    });
    const eventReads = EVENT_SURFACES.map(async (surface) => {
      const st = eventState.get(surface)!;
      if (st.exhausted) return;
      const page = await coordLog.readEventsBoundedCursor(surface, {
        limit: RAW_SURFACE_FETCH_CAP,
        ...(kindsForPushdown ? { kinds: kindsForPushdown } : {}),
        ...(st.cursor !== undefined ? { beforeId: st.cursor } : {}),
      });
      for (const row of page.rows) {
        tagged.push({ ...row.envelope, surface, broadcast: isBroadcast(row.envelope.to) });
      }
      st.exhausted = page.exhausted;
      if (page.rows.length > 0) st.cursor = page.rows[page.rows.length - 1]!.id;
    });
    await Promise.all([...lineReads, ...eventReads]);
  };

  await fetchRound();

  // WI-3880: only a caller paging DEEPER than the first window pays for more
  // rounds — the common (no before_ts, or before_ts within the first window)
  // case never enters this loop. Keep widening while the filtered page is
  // still short of `limit` AND at least one surface has more history, capped
  // at MAX_CURSOR_ROUNDS so a query with no realistic match still terminates.
  if (opts.before_ts) {
    const allExhausted = () =>
      [...lineState.values(), ...eventState.values()].every((s) => s.exhausted);
    for (let round = 1; round < MAX_CURSOR_ROUNDS && !allExhausted(); round += 1) {
      const filteredSoFar = tagged.filter(passesFilter).length;
      if (filteredSoFar >= limit) break;
      await fetchRound();
    }
  }

  // Filter.
  const filtered = tagged.filter(passesFilter);

  // coord:retract (WI-4176): suppress withdrawn messages unless the caller
  // asked for the forensic view. Markers are collected from the RAW tagged
  // window (pre-filter) so a notice a kinds/owner/q filter would drop still
  // suppresses its target; the notice row itself always survives (distinct
  // msg_id). Applied BEFORE the byKind histogram so the chips match what is
  // shown. Deep before_ts pages older than the notice can still show the
  // original — the documented v1 in-window caveat (see ../retraction.ts).
  const visible = opts.includeRetracted
    ? filtered
    : suppressRetracted(filtered, collectRetractedIds(tagged));

  // Kind histogram over the WHOLE visible set (the filter-chip counts) —
  // computed before the page cap so the chips reflect everything, not the page.
  const byKind: Record<string, number> = {};
  for (const env of visible) byKind[env.kind] = (byKind[env.kind] ?? 0) + 1;

  // Newest-first. compareByTsThenId is ascending; reverse for descending.
  visible.sort((a, b) => compareByTsThenId(b, a));

  // Build the page newest-first, bounded by BOTH limit (count) and token_budget —
  // stop at whichever is hit first. At least one row is always returned (so a single
  // over-budget envelope still comes back). Per-row token cost is estimated from the
  // serialized envelope via estimateTokens (presence-cost; ~3.5–4 chars/token).
  const tokenBudget = opts.token_budget && opts.token_budget > 0 ? opts.token_budget : null;
  const page: CoordFeedRow[] = [];
  let tokens = 0;
  for (const row of visible) {
    page.push(row);
    tokens += estimateTokens(JSON.stringify(row).length);
    if (page.length >= limit) break;
    if (tokenBudget !== null && tokens >= tokenBudget) break;
  }
  const nextCursor = visible.length > page.length ? (page[page.length - 1]?.ts ?? null) : null;

  return { rows: page, nextCursor, total: visible.length, byKind, tokens };
}
