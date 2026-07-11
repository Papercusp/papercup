/**
 * messages.ts — operator host adapter for the L3 message + ack substrate.
 *
 * The envelope shapes + the inbox-filter / thread-fold logic live in
 * @papercusp/coordination/core; the per-sender-outbox I/O lives behind
 * the CoordEventLog seam (coordLog). This file keeps the original
 * function surface (sendMessage / appendAck / readInbox / readThread)
 * so every caller + test is unchanged.
 *
 * agent-coordination-architecture-v2 §6.4 (#6).
 */

import {
  newMsgId,
  filterInbox,
  foldThread,
  type CoordEnvelope,
  type CoordKind,
  type InboxOptions,
} from '@papercusp/coordination/core';
import { coordLog, coordWorkspaceId, coordSql, coordHasPgFastPath } from './log';
import { hasAudienceSelector, expandAudience } from './audience';
import { hostAudienceResolvers, audienceMode, deriveAudienceKey } from './audience-host';
import { deliverFleetDigests } from './fleet-delivery';
import { slotSelectorsIn, parseSlotSelector } from './slot-selector';
import { parkSlotMessage, drainUserMailbox } from './slot-parked-store';
import type { AgentIdentity } from './identity';
import { resolveBestEffortAgainstRoster } from './recipient-resolve';
import { resolveWorkspaceHiveScope } from './federation-scope';
import {
  CUE_AUTHORITY_FIELD,
  readCueAuthority,
  renderCueAuthorityTag,
  type CueAuthorityStamp,
} from './cue-authority';
import { resolveSenderCueAuthority } from './cue-authority-resolve';

export type { InboxOptions };

/** Options for sendMessage / generalised coord append. */
export interface SendOptions {
  /** Recipient ownerIds. Use ['*'] for broadcast, ['human'] for the human inbox. */
  to: string[];
  summary?: string;
  body?: string;
  files?: string[];
  plan_slug?: string;
  related_msg_id?: string;
  /** Originating harness slug — ALSO the coord federation key (the capture
   *  trigger only outboxes a coord_event_log row whose harness_slug names a
   *  federating harness/hive-home). Tri-state (WI-3653):
   *    string    → stamp verbatim (harness-scoped sender / MCP-resolved scope);
   *    null      → EXPLICIT machine-local (coord:send scope:'local') — never
   *                auto-stamped;
   *    undefined → AUTO: stamp the workspace's single shared Hive home when
   *                exactly one exists (the SAME rule coord:send documents for
   *                an omitted scope), else stay local.
   *  WHY the auto default lives HERE and not only in the MCP tool layer: the
   *  serve plane's system emitters (plan-clobber-watch etc.) call sendMessage
   *  directly, so on a fed-plane machine (P-059 Mac rig) every locally-emitted
   *  coord event carried harness_slug NULL and could NEVER federate — zero
   *  coord ops ever entered that machine's outbox while plan-parts/issues
   *  federated fine. The write seam is the one place every writer passes. */
  harnessSlug?: string | null;
  /** Default 'message'. Use other kinds for typed channel writes. */
  kind?: CoordKind;
  /** Ambient-classification tag (e.g. 'service-health'). A categorised message
   *  is still a message, but coord:inbox default-excludes ambient categories. */
  category?: string;
  /** Extra envelope keys merged verbatim (e.g. the auto-lifecycle markers
   *  `auto:true` + `lifecycle:'<category>'` that `coord:emit` stamps so the
   *  inbox can distinguish system-emitted lifecycle from human-authored
   *  coord:send — coord-lifecycle-automation-2026-06-04). Reserved envelope
   *  fields (ts/msg_id/from/to/kind) are NOT overridable. */
  extra?: Record<string, unknown>;
  /** The sender's ALREADY-RESOLVED cue-authority stamp (or explicit null =
   *  "resolved, sender holds none"). tools/send resolves it once per bulk call
   *  for its own down-scope/stamp logic and threads it here so the H5a seam
   *  invariant (below) doesn't re-pay the presence/fleet reads. `undefined` =
   *  not resolved yet — the seam resolves it itself for a `'*'` message-kind
   *  broadcast. */
  cueAuthorityResolved?: CueAuthorityStamp | null;
}

/**
 * H5a (coord-authority-hardening-2026-07-11 P-002): the typed refusal thrown
 * when a fleet-scoped control authority attempts a hive-wide `'*'` delivery —
 * the shipped self-contradiction of the EI-9501 leak (stamped
 * `fleet-members(X)`, delivered to everyone). Carries the same error code the
 * landed coord:send guard uses so every surface teaches one lesson.
 */
export class FleetScopedBroadcastRefusedError extends Error {
  readonly code = 'fleet_scoped_cue_allhive_contradiction';
  readonly stamp: CueAuthorityStamp;
  constructor(stamp: CueAuthorityStamp) {
    super(
      `broadcast to '*' refused: your control authority is ${renderCueAuthorityTag(stamp)} — ` +
        `only fleet '${stamp.scopeRef ?? stamp.authorityRef}' members are meant to act on your cues. ` +
        `Address @fleet:${stamp.scopeRef ?? stamp.authorityRef} (leader included), or send a genuinely ` +
        `hive-wide notice from a non-fleet-authority context.`,
    );
    this.name = 'FleetScopedBroadcastRefusedError';
    this.stamp = stamp;
  }
}

/** Append a new envelope to the caller's outbox. */
export async function sendMessage(
  identity: AgentIdentity,
  opts: SendOptions,
): Promise<CoordEnvelope> {
  // Audience-selector expansion (coord-emit-subscription-scoping-2026-06-05): a
  // `to[]` carrying `@plan:`/`@topic:`/`@object:`/`@file:` selectors resolves to
  // the concrete ownerIds watching that plan/topic/work-item. Zero-overhead when
  // no selector is present (the overwhelmingly common case). The EXPANDED set is
  // stored on the envelope so the inbox filter + federation projection are
  // unchanged (D-001/D-003); an empty resolution → empty `to` → no inbox
  // delivery, but the row still persists (D-004).
  // B2 / park-for-slot: @role:/@wave:/@feature: entries address a SLOT that may
  // have no agent yet — split them off so they PARK (below) instead of resolving
  // to live ownerIds; only the non-slot addressees are delivered now.
  // Capture the durable audience KEY from the ORIGINAL `to`, BEFORE expansion
  // discards the selectors. This makes every broadcast queryable as audience-keyed
  // history (coord:feed { audience }) — the generalization of plan_slug, live +
  // retained by default. (fleet-broadcast-audience-history-integration-2026-06-30 D-003)
  const audienceKey = deriveAudienceKey(opts.to);
  const slots = slotSelectorsIn(opts.to);
  const liveAddrs = slots.length
    ? opts.to.filter((t) => parseSlotSelector(t) === null)
    : opts.to;
  const toExpanded = hasAudienceSelector(liveAddrs)
    ? await expandAudience(liveAddrs, hostAudienceResolvers, audienceMode())
    : liveAddrs;
  // owner-2026-06-17: resolve short ownerId PREFIXES to full ids so inbox delivery
  // + any inbox-wake hit the right recipient. Best-effort + fail-soft; an
  // all-selector/broadcast `to` skips the roster read entirely.
  const to = await resolveBestEffortAgainstRoster(toExpanded, identity.workspaceId);
  // H5a — the audience⊆authority INVARIANT, enforced at the ONE seam every
  // message writer passes (coord-authority-hardening-2026-07-11 P-002,
  // generalizing the EI-9501 guard that lives only in tools/send.ts): a sender
  // whose control authority is FLEET-scoped must never deliver a hive-wide
  // `'*'` message — the stamped intent (fleet-members) would contradict the
  // actual delivery (everyone), which is the exact shipped contradiction of
  // the 2026-07-11 leak. Scoped to kind 'message' (the human-authored /
  // control channel both incidents used): lifecycle kinds (plan_event / ack /
  // notify / …) legitimately broadcast `'*'` from any sender and carry no
  // control weight, so they pass untouched. tools/send.ts still refuses its
  // own allHive path with a per-item bulk error BEFORE reaching here (and
  // down-scopes bare `'*'` for fleeted senders, so its sends arrive without a
  // wildcard); THIS check catches every OTHER path — emit, dispatch, system
  // emitters, federated relays through local tools, and tomorrow's new verb.
  // The resolved stamp is ALSO written onto the envelope so a permitted
  // broadcast (hive-queen, or an unstamped ordinary sender) stays legible to
  // the receive-side defang (P-003 H1).
  const kind = opts.kind ?? 'message';
  if (kind === 'message' && to.includes('*')) {
    let stamp: CueAuthorityStamp | null;
    if (opts.cueAuthorityResolved !== undefined) {
      stamp = opts.cueAuthorityResolved;
    } else if (opts.extra && CUE_AUTHORITY_FIELD in opts.extra) {
      stamp = readCueAuthority(opts.extra);
    } else {
      try {
        stamp = await resolveSenderCueAuthority(identity);
      } catch {
        stamp = null; // presence outage must never block a send (house rule)
      }
    }
    if (stamp?.scope === 'fleet-members') {
      throw new FleetScopedBroadcastRefusedError(stamp);
    }
    if (stamp && !(opts.extra && CUE_AUTHORITY_FIELD in opts.extra)) {
      opts = { ...opts, extra: { ...opts.extra, [CUE_AUTHORITY_FIELD]: stamp } };
    }
  }
  const env: CoordEnvelope = {
    ts: new Date().toISOString(),
    msg_id: newMsgId(),
    from: identity.ownerId,
    to,
    kind: opts.kind ?? 'message',
  };
  if (audienceKey.length) env.audience = audienceKey;
  if (opts.summary !== undefined) env.summary = opts.summary;
  if (opts.body !== undefined) env.body = opts.body;
  if (opts.category !== undefined) env.category = opts.category;
  if (opts.files !== undefined) env.files = opts.files;
  if (opts.plan_slug !== undefined) env.plan_slug = opts.plan_slug;
  if (opts.related_msg_id !== undefined) env.related_msg_id = opts.related_msg_id;
  // Canonical snake_case envelope field (matches plan_slug/msg_id/related_msg_id
  // and the coord_event_log.harness_slug column PgCoordLog projects it to for
  // federation — distributed-coordination-shared-harness-2026-06-04 Track A).
  if (typeof opts.harnessSlug === 'string') {
    env.harness_slug = opts.harnessSlug;
  } else if (opts.harnessSlug === undefined) {
    // WI-3653 AUTO-stamp (see SendOptions.harnessSlug): an un-scoped writer in a
    // workspace with EXACTLY ONE shared Hive stamps that Hive's home so the
    // message federates; none/many → machine-local (byte-identical to before).
    // Fail-soft: a resolver error means "no shared hive visible here" — it must
    // never block the send. `null` (explicit scope:'local') skips this entirely.
    try {
      const ws = identity.workspaceId ?? coordWorkspaceId();
      if (ws && ws !== '*') {
        const resolved = await resolveWorkspaceHiveScope(ws);
        if (resolved.kind === 'one') env.harness_slug = resolved.homeSlug;
      }
    } catch {
      /* stay machine-local */
    }
  }
  // Merge caller-supplied extra keys LAST, but never let them clobber the
  // reserved envelope fields (identity + addressing integrity).
  if (opts.extra) {
    const RESERVED = new Set(['ts', 'msg_id', 'from', 'to', 'kind']);
    for (const [k, v] of Object.entries(opts.extra)) {
      if (!RESERVED.has(k) && v !== undefined) env[k] = v;
    }
  }
  // Park the envelope durably for each addressed slot (./slot-parked-store) —
  // drained into the spawnee's handoff when an agent spawns into the slot (P-023).
  if (slots.length) {
    // Use the coord seam's handle + workspace (NOT getOrgPg()+'default') so the
    // parked rows live on the SAME DB/workspace as the coord messages this
    // sendMessage writes — a swapped seam (tests, non-default workspace) would
    // otherwise split them. Mirrors readAckedMsgIds.
    const sql = coordSql();
    const ws = coordWorkspaceId();
    const nowMs = Date.now();
    for (const slot of slots) {
      await parkSlotMessage(sql, { slot, harnessSlug: opts.harnessSlug ?? null, envelope: env, nowMs, workspaceId: ws });
    }
  }
  // Deliver to the live inbox when there's a live audience — or when there were
  // no slots at all (preserve the legacy "audience resolved to nobody still
  // persists the row" behaviour, ./audience D-004). A purely-slot send is
  // delivered by the park alone.
  if (liveAddrs.length > 0 || slots.length === 0) {
    await coordLog.appendLine('messages', identity.ownerId, env);
  }
  // Fleet DIGEST sidecar (fleet-delivery-override-mute-digest D-001): a `@fleet:`
  // broadcast's digest members were dropped from the live `to` (listFleetMembers), so
  // deliver each a terse `digest:true` notify (the inbox hook coalesces it). Best-effort,
  // side-effect only, guarded on a `@fleet:` selector — a normal send pays nothing.
  if (opts.to.some((t) => t.startsWith('@fleet:'))) {
    await deliverFleetDigests(opts.to, env, to).catch(() => {});
  }
  return env;
}

/**
 * Append an ack for `targetMsgId`, addressed back to the message's
 * sender. The acker's own outbox is the writer.
 */
export async function appendAck(
  identity: AgentIdentity,
  targetMsgId: string,
  targetFrom: string,
): Promise<CoordEnvelope> {
  return sendMessage(identity, {
    to: [targetFrom],
    kind: 'ack',
    related_msg_id: targetMsgId,
  });
}

/** WI-3825: skew-padded lower bound subtracted from `since_ts` before it is
 *  pushed into SQL as `ts >= …`. The row `ts` column is set via `DEFAULT
 *  now()` at INSERT time (monotonic with `id`) — a DIFFERENT field from
 *  `body->>'ts'`, the client-stamped envelope time `filterInbox` filters on,
 *  which can trail the DB insert under load/retries (or, under clock skew,
 *  even lead it). Live-verified divergence: >1s on 2,317 of 53,560 rows. This
 *  pad is a PRE-filter only — generous enough that no row `filterInbox` would
 *  keep (`body.ts > since_ts`) is ever pruned before it runs; `filterInbox`
 *  remains the authoritative, byte-identical final filter over the reduced
 *  set. 10 minutes comfortably covers any plausible insert-latency /
 *  clock-skew jitter while still giving the new `coord_event_log_messages_ts_idx`
 *  (migration 545) a highly selective range to seek on the dominant "since a
 *  few minutes/hours ago" polling pattern (orient / inbox-wake / dispatch). */
export const INBOX_SINCE_TS_SKEW_PAD_MS = 10 * 60_000;

/** Hard backstop on rows scanned per `readInbox` PG-fast-path call, applied
 *  even with NO `since_ts` (a full-history read) — a LIMIT is the one bound
 *  that is correct regardless of any ts/id skew question. Generously above
 *  the live-observed ~12.5k-rows-per-call figure so a normal read is never
 *  truncated; only a genuinely pathological full-history backlog is capped
 *  (and logged, never silently). */
export const INBOX_FAST_PATH_ROW_CAP = 25_000;

/**
 * Read everything addressed to `ownerId` (or to '*') across all outboxes.
 * Sorted by ts ascending; forgiving of malformed/missing files.
 */
export async function readInbox(
  ownerId: string,
  opts: InboxOptions = {},
): Promise<CoordEnvelope[]> {
  // Recipient-pushdown fast path (fleet-concurrency-first P-003, round4 D-005):
  // readInbox is the dominant `coord_event_log` call — every agent fires it every
  // turn (always-armed inbox-wake + orient + manual coord:inbox). The old body
  // loaded the ENTIRE `messages` surface (~23K rows) through readLines and filtered
  // in JS, re-transferring + JSON-parsing + allocating every envelope on the
  // operator's single event loop per call — the round-3/4 "heavy work on one thread"
  // saturation, multiplied by fleet size. Push the inbox MEMBERSHIP predicate into
  // Postgres so only this owner's + broadcast rows come back. The SQL predicate is
  // exactly filterInbox's recipient+array conditions
  // (`Array.isArray(to) && (to.includes(ownerId) || to.includes('*'))`), and
  // filterInbox is STILL run as the final authority over the reduced set — so the
  // output is byte-identical to the full-scan path (it re-applies the recipient
  // check plus since/kinds/excludeOwn/sort). EI-401 precedent (readAckedMsgIds).
  //
  // WI-3825: that predicate alone was still an UNBOUNDED scan of the whole
  // `messages` surface (no since/id predicate, no LIMIT) — ~79h of cumulative
  // DB CPU, saturating the bg-host's PG pool and starving the substrate
  // outbox-drain. Two independent bounds, both safe:
  //   (a) when the caller passes `since_ts`, push a SKEW-PADDED `ts >= …`
  //       lower bound (INBOX_SINCE_TS_SKEW_PAD_MS) — a highly selective range
  //       the new coord_event_log_messages_ts_idx (migration 545) can seek on;
  //   (b) always cap rows scanned via LIMIT (INBOX_FAST_PATH_ROW_CAP) — the
  //       one bound that holds regardless of any ts/id skew question, so even
  //       a no-`since_ts` full-history read can never trigger an unbounded scan.
  // Both are PRE-filters only: `filterInbox` below remains the authoritative,
  // exact filter over the (now bounded) reduced set.
  //
  // Gated on a true PG backend (coordHasPgFastPath): an in-memory/fs seam (tests)
  // keeps using readLines, since coordSql() would otherwise read getOrgPg() and miss
  // the swapped store. Any query error falls through to the authoritative full read.
  if (coordHasPgFastPath()) {
    try {
      const sql = coordSql();
      const sinceBound = opts.since_ts
        ? new Date(new Date(opts.since_ts).getTime() - INBOX_SINCE_TS_SKEW_PAD_MS).toISOString()
        : null;
      const rows = await sql<{ body: unknown }[]>`
        SELECT body
          FROM harness_shared.coord_event_log
         WHERE workspace_id = ${coordWorkspaceId()}
           AND surface = 'messages'
           ${sinceBound ? sql`AND ts >= ${sinceBound}` : sql``}
           AND jsonb_typeof(body->'to') = 'array'
           AND (jsonb_exists(body->'to', ${ownerId}) OR jsonb_exists(body->'to', '*'))
         ORDER BY id ASC
         LIMIT ${INBOX_FAST_PATH_ROW_CAP}
      `;
      if (rows.length >= INBOX_FAST_PATH_ROW_CAP) {
        console.warn(
          `[readInbox] fast-path row cap (${INBOX_FAST_PATH_ROW_CAP}) hit for owner=${ownerId} ` +
            `since_ts=${opts.since_ts ?? '(none)'} — the oldest matching rows beyond the cap were NOT ` +
            'returned; a caller doing a genuine full-history backfill should page via since_ts.',
        );
      }
      const lines = rows.map((r) => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body) as CoordEnvelope);
      return filterInbox(lines, ownerId, opts);
    } catch {
      // Fall through to the authoritative full-surface read below.
    }
  }
  const lines = await coordLog.readLines('messages');
  return filterInbox(lines, ownerId, opts);
}

/**
 * Deliver any `@user:`-parked messages waiting for a returning member into their
 * live inbox — the offline-member-assign mailbox (shared-hive-collaboration P-016).
 *
 * An assignment to an absent member is parked under `@user:<actorUserKey>`
 * (slot-parked-store) and writes NO coord_event_log row (a purely-slot send is
 * delivered by the park alone — see sendMessage). When that member's session
 * RETURNS, this drains (claim-once) every pending row matching one of their
 * candidate `keys` (actorMailboxKeys) and re-appends each envelope to the message
 * log addressed to their live `ownerId`, so it surfaces as a normal inbox card —
 * the same envelope, so the original assigner (`from`) + summary/body/plan_slug are
 * preserved. The claim-once UPDATE makes a second session a no-op, so re-delivery
 * is never a duplicate. Returns the delivered envelopes (the caller may fire an
 * optimistic inbox-wake on a presence-arrival edge).
 *
 * This is the `@user:` analog of the spawn-path deliver-on-spawn (P-023) — same
 * store, a presence/inbox-read trigger instead of a spawn trigger.
 */
export async function drainAndDeliverUserMailbox(
  keys: readonly string[],
  ownerId: string,
): Promise<CoordEnvelope[]> {
  if (!ownerId || keys.length === 0) return [];
  const sql = coordSql();
  const ws = coordWorkspaceId();
  const drained = await drainUserMailbox(sql, {
    keys,
    toOwner: ownerId,
    nowMs: Date.now(),
    workspaceId: ws,
  });
  for (const env of drained) {
    await coordLog.appendLine('messages', env.from, { ...env, to: [ownerId] });
  }
  return drained;
}

/**
 * Msg-ids that `ackerOwnerId` has acknowledged — the `related_msg_id` of every
 * `ack` envelope THEY authored. Acks were always written (appendAck) but never
 * folded out of any view, so a coord-message inbox "Acknowledge" had no visible
 * effect. The Planning inbox uses this to dismiss acked messages.
 *
 * SECURITY: scoped to the acker's own acks (`l.from === ackerOwnerId`) — never
 * global. A global set would let ANY agent's ack of a broadcast (to:['*'])
 * suppress that message from the human's inbox even though the human never
 * acked it (visibility suppression). Callers pass the principal whose inbox is
 * being rendered, so only that principal's own acks dismiss their view.
 *
 * Optimized to query database directly (EI-401): avoid loading all messages
 * when table is large; use WHERE kind='ack' AND from=? filter at DB level.
 */
export async function readAckedMsgIds(ackerOwnerId: string): Promise<Set<string>> {
  const acked = new Set<string>();
  if (!ackerOwnerId) return acked;
  try {
    // Run on the SAME handle + workspace the coordLog seam reads/writes (NOT
    // getOrgPg()+'default'): the acks were written through the seam, so a swapped
    // seam (tests, non-default workspace) would otherwise query the wrong DB /
    // scope and find nothing. Matches readInbox exactly.
    const sql = coordSql();
    const rows = await sql<{ related_msg_id: string | null }[]>`
      SELECT body->>'related_msg_id' AS related_msg_id
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${coordWorkspaceId()}
         AND surface = 'messages'
         AND body->>'kind' = 'ack'
         AND body->>'from' = ${ackerOwnerId}
    `;
    for (const row of rows) {
      if (typeof row.related_msg_id === 'string') {
        acked.add(row.related_msg_id);
      }
    }
  } catch {
    // Fallback to the slow path if the query fails
    const lines = await coordLog.readLines('messages');
    for (const l of lines) {
      if (l.kind === 'ack' && l.from === ackerOwnerId && typeof l.related_msg_id === 'string') {
        acked.add(l.related_msg_id);
      }
    }
  }
  return acked;
}

/**
 * Read everything `ownerId` SENT — every envelope whose `from === ownerId`,
 * across the whole message log. The outbox half of the per-bee mail view
 * (pui-bee-dossier-pane-2026-06-06). Sorted by ts ascending; `since_ts` filters
 * strictly later than the given ISO timestamp.
 */
export async function readOutbox(
  ownerId: string,
  opts: { since_ts?: string } = {},
): Promise<CoordEnvelope[]> {
  const lines = await coordLog.readLines('messages');
  const sinceMs = opts.since_ts ? new Date(opts.since_ts).getTime() : 0;
  return lines
    .filter((l) => l.from === ownerId)
    .filter((l) => !sinceMs || new Date(l.ts).getTime() > sinceMs)
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id));
}

/**
 * Look up a single message envelope by its `msg_id` (the `messages` surface).
 * Used by the wake-on-reply path (coord:send) to find the ORIGINAL message a
 * reply points at via `related_msg_id` — so a peer's reply can wake the original
 * sender. Returns null when no such message exists. Fail-soft at the call site:
 * a lookup miss/error must never block the send.
 *
 * WI-3832: previously called `coordLog.getEvent('messages', msgId)` — but
 * `messages` is a `LineSurface` (append-only, via `appendLine`/`readLines`), not
 * an `EventSurface` (single-record-per-id upsert, via `putEvent`/`getEvent` —
 * `handoffs`/`escalations` only). That was a real TS2345 compile error (`npx tsc
 * --noEmit` in packages/operator-core), AND a genuine runtime gap on the
 * in-memory/fs test backends (InMemoryCoordLog / FsCoordLog keep `lines` and
 * `events` as separate stores; nothing ever `putEvent`s a message, so
 * `getEvent('messages', …)` always returned null there) — only PgCoordLog's
 * `getEvent` happened to work by accident, since `handoffs`/`escalations`/
 * `messages` all share the one `coord_event_log` table and its `msg_id` column.
 * Implemented directly here instead of widening `EventSurface` (which would let
 * `putEvent`/`putEvents` be miscalled on `messages` too — its ON CONFLICT target
 * is a partial index scoped to `handoffs`/`escalations` only, so a stray
 * `putEvent('messages', …)` would silently insert a duplicate row instead of
 * upserting). PG fast path mirrors readInbox's convention above and rides the
 * (workspace_id, msg_id) index a peer already landed on this same plan
 * (migration 543 — WI-3817 — built exactly for this `WHERE workspace_id = $1 AND
 * msg_id = $2` shape); the readLines fallback covers the test/dev backends
 * (small in-memory datasets, a scan is fine) and is now also the CORRECT
 * behavior there, not just the compiling one.
 */
export async function getMessageById(msgId: string): Promise<CoordEnvelope | null> {
  if (!msgId) return null;
  if (coordHasPgFastPath()) {
    try {
      const sql = coordSql();
      const rows = await sql<{ body: unknown }[]>`
        SELECT body
          FROM harness_shared.coord_event_log
         WHERE workspace_id = ${coordWorkspaceId()}
           AND surface = 'messages'
           AND msg_id = ${msgId}
         LIMIT 1
      `;
      if (rows.length) return (typeof rows[0].body === 'string' ? JSON.parse(rows[0].body) : rows[0].body) as CoordEnvelope;
      return null;
    } catch {
      // Fall through to the authoritative full-surface read below.
    }
  }
  const lines = await coordLog.readLines('messages');
  return lines.find((l) => l.msg_id === msgId) ?? null;
}

/**
 * Reconstruct a thread rooted at `rootMsgId` by walking the
 * `related_msg_id` chain in both directions. Sorted by ts ascending.
 */
export async function readThread(rootMsgId: string): Promise<CoordEnvelope[]> {
  const all = await coordLog.readLines('messages');
  return foldThread(all, rootMsgId);
}
