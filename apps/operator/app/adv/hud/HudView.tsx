'use client';

/**
 * HudView — the data half of /adv/HUD (adv-hud-fleet-board-2026-07-25 P-004).
 *
 * Owner ask, 2026-07-25: "I want the sessions to show up there whether or not
 * they are launched with the new session button or if they are launched with the
 * psu utility." That is satisfied structurally rather than by special-casing:
 * this view reads `advRoster.list`, which is PRESENCE-PRIMARY — coord_presence
 * is the roster and adv_sessions is only a LEFT-joined enrichment, so an agent
 * with no launch record still appears. Every psu session heartbeats presence on
 * each tool call, so it lands here with no launch-path-specific code.
 *
 * REUSE, not re-derivation:
 *   - roster: the SAME `advRoster.list` sync query the Sessions roster reads
 *     (shared cache entry, SSE-invalidated on any adv_sessions write);
 *   - asks: the SAME `plans.attention` feed + `scopeInboxItems` narrowing the
 *     inbox uses — the board never invents a second asks pipeline, so an item
 *     answered here and an item answered in the inbox are the same item;
 *   - conversation: the EXISTING `SessionChatModal`. Clicking a card opens the
 *     agent's real transcript with a live composer; no second chat renderer.
 *
 * State lives in the URL (nuqs) per the repo's nuqs-by-default policy, so the
 * board is deep-linkable and agent-driveable via ui:get_state / ui:dispatch.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { parseAsArrayOf, parseAsBoolean, parseAsString, parseAsStringLiteral, useQueryState } from 'nuqs';
import SessionChatModal from '@/app/_components/chat/SessionChatModal';
import { scopeInboxItems, useInboxAttention } from '@/app/_components/inbox/use-inbox-pending';
import HudBoard from './HudBoard';
import {
  ALL_FLEETS,
  buildHudBoard,
  HUD_COLUMNS,
  type HudAsk,
  type HudColumnId,
  type HudRosterEntry,
} from './hud-board-model';

/** The roster payload shape (advRoster.list). Inlined, never imported from the
 *  server module — importing it would drag PG/node builtins into the SPA bundle
 *  (the operator-vite blank-page failure mode). The endpoint JSON is the contract. */
interface RosterPayload {
  active: HudRosterEntry[];
  pending?: HudRosterEntry[];
}

/** The board re-derives ages from a clock; without a tick, a card would say
 *  "blocked 2m" an hour later. 15s is fine — every age is rendered at
 *  minute-or-coarser granularity, so a faster tick would only cost renders. */
const CLOCK_TICK_MS = 15_000;

/* The "all fleets" sentinel is imported from hud-board-model, not re-declared:
   HudBoard raises it and this file compares against it, and while each spelled
   the literal out separately the two drifted (HudBoard's leading space became a
   raw NUL byte, so this comparison never matched). One definition, imported. */

export default function HudView({ workspaceId = null }: { workspaceId?: string | null }) {
  const [focusColumn, setFocusColumn] = useQueryState(
    'hudcol',
    parseAsStringLiteral(HUD_COLUMNS),
  );
  const [fleetParam, setFleetParam] = useQueryState(
    'hudfleet',
    parseAsArrayOf(parseAsString).withDefault([]),
  );
  const [allAgents, setAllAgents] = useQueryState(
    'hudall',
    parseAsBoolean.withDefault(false),
  );
  const [openOwner, setOpenOwner] = useQueryState('hudsession', parseAsString);

  // Ticking clock so relative ages stay honest between roster pushes.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const roster = useSyncQuery<RosterPayload>({
    queryName: 'advRoster.list',
    args: { workspaceId, endedLimit: 50 },
  });

  const attention = useInboxAttention();

  /** The asks addressed to the human, narrowed by the SAME scoping the inbox
   *  applies. Without it the raw attention feed is the whole ~15-source
   *  firehose (the "328" bug) and every agent would look like it needs you. */
  const asks: HudAsk[] = useMemo(() => {
    const scoped = scopeInboxItems(attention.items ?? []);
    return scoped
      .filter((i) => i.needsHuman && i.ownerAgentId)
      .map((i) => ({
        ownerAgentId: i.ownerAgentId,
        title: i.title,
        occurredAt: (i as { occurredAt?: string | null }).occurredAt ?? null,
      }));
  }, [attention.items]);

  const entries: HudRosterEntry[] = useMemo(() => {
    const payload = roster.data?.[0];
    if (!payload) return [];
    // Pending launches are recorded-but-not-started sessions; they belong on the
    // board (they are real, the human asked for them) and classify as parked.
    return [...(payload.active ?? []), ...(payload.pending ?? [])];
  }, [roster.data]);

  // `null` in the URL array marks the solo group — encoded as the literal
  // "solo" because a URL array cannot carry a null.
  const selectedFleets = useMemo(
    () => fleetParam.map((f) => (f === 'solo' ? null : f)),
    [fleetParam],
  );

  const board = useMemo(
    () =>
      buildHudBoard(entries, asks, {
        nowMs,
        suOnly: !allAgents,
        fleets: selectedFleets,
      }),
    [entries, asks, nowMs, allAgents, selectedFleets],
  );

  const onToggleFleet = useCallback(
    (slug: string | null) => {
      if (slug === ALL_FLEETS) {
        void setFleetParam([]);
        return;
      }
      const token = slug ?? 'solo';
      void setFleetParam((prev) =>
        prev.includes(token) ? prev.filter((f) => f !== token) : [...prev, token],
      );
    },
    [setFleetParam],
  );

  const openLabel = useMemo(
    () =>
      board.columns
        .flatMap((c) => c.sessions)
        .find((s) => s.ownerId === openOwner)?.label ?? null,
    [board, openOwner],
  );

  return (
    <>
      <HudBoard
        board={board}
        selectedFleets={selectedFleets}
        onToggleFleet={onToggleFleet}
        focusColumn={(focusColumn as HudColumnId | null) ?? null}
        onFocusColumn={(id) => void setFocusColumn(id)}
        suOnly={!allAgents}
        onToggleSuOnly={() => void setAllAgents((v) => !v)}
        onOpenSession={(ownerId) => void setOpenOwner(ownerId)}
        loading={roster.loading}
        error={roster.error ? String(roster.error) : null}
      />
      {/* The existing chat-grade session popup: real transcript + live composer.
          Reused wholesale so answering from HUD is byte-identical to answering
          from the inbox. */}
      <SessionChatModal
        sessionOwnerId={openOwner}
        ownerLabel={openLabel}
        onClose={() => void setOpenOwner(null)}
      />
    </>
  );
}
