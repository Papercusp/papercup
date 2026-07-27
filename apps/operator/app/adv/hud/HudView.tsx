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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { useDebouncedValue } from '@/app/harness/picker-kit';
import { parseAsArrayOf, parseAsBoolean, parseAsString, parseAsStringLiteral, useQueryState } from 'nuqs';
import SessionChatModal from '@/app/_components/chat/SessionChatModal';
import { scopeInboxItems, useInboxAttention } from '@/app/_components/inbox/use-inbox-pending';
import NewSessionLauncher from '@/app/adv/sessions/NewSessionLauncher';
import { usePlanList } from '@/app/admin/plans/plans-api';
import { useResolvedHarnessSlug } from '@/app/adv/create/use-create-data';
import HudBoard from './HudBoard';
import HudEntityColumns from './HudEntityColumns';
import {
  ALL_FLEETS,
  ALL_PLANS,
  NO_PLAN_TOKEN,
  buildHudBoard,
  HUD_COLUMNS,
  type HudAsk,
  type HudColumnId,
  type HudRosterEntry,
} from './hud-board-model';
import {
  buildPlanBoard,
  buildWorkItemBoard,
  HUD_ENTITY_COLUMNS,
  HUD_TABS,
  type HudEntityColumnId,
  type HudTabId,
  type HudWorkItemInput,
} from './hud-entity-board';

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

/** How many work-item rows the Work items tab pulls. The store carries ~1800
 *  in this harness; the board caps what it RENDERS per column anyway, so this
 *  is about how much of the tail the counts are honest over, not about DOM
 *  size. Matches the work-items panel's own page size rather than inventing a
 *  second number. */
const WORK_ITEM_FETCH_LIMIT = 500;

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
  /* P-004 — the plan axis. An ARRAY param like `hudfleet`, not a scalar, so the
     two filters have one URL contract rather than two: the model already takes
     `plans` as an array (same shape as `fleets`), and a later multi-select
     control would then be a control change with no URL migration. */
  const [planParam, setPlanParam] = useQueryState(
    'hudplan',
    parseAsArrayOf(parseAsString).withDefault([]),
  );
  const [allAgents, setAllAgents] = useQueryState(
    'hudall',
    parseAsBoolean.withDefault(false),
  );
  const [openOwner, setOpenOwner] = useQueryState('hudsession', parseAsString);

  /* P-009 — the board's tab axis, and the two controls the non-session tabs
     need. All three in the URL per the repo's nuqs-by-default policy: which
     board you are looking at is exactly the "reasonably user-meaningful state"
     that has to be deep-linkable and reachable from ui:get_state/ui:dispatch. */
  const [tab, setTab] = useQueryState(
    'hudtab',
    parseAsStringLiteral(HUD_TABS).withDefault('sessions'),
  );
  const [entityColumn, setEntityColumn] = useQueryState(
    'hudecol',
    parseAsStringLiteral(HUD_ENTITY_COLUMNS),
  );
  // Separate from the sessions board's own filter state: `hudcol` is typed to
  // the SESSION column ids and shares none of its members with the entity
  // columns (`ready`/`done`), so one param cannot serve both without silently
  // dropping a value on every tab switch.
  const [entityQuery, setEntityQuery] = useQueryState(
    'hudq',
    parseAsString.withDefault(''),
  );

  /* The SESSIONS board's own search (owner ask 2026-07-26). Separate param from
     `hudq`: that one filters the entity tabs' loaded rows, this one searches
     something the roster payload does not even contain, and sharing a param
     would drop a value on every tab switch (same reasoning as `hudecol`). */
  const [rawSessionQuery, setSessionQuery] = useQueryState(
    'hudsq',
    parseAsString.withDefault(''),
  );
  const sessionQuery = useDebouncedValue(rawSessionQuery, 300);

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

  /**
   * Owner ask 2026-07-27: "when you click +new session the gui chat with them
   * should show up". The launcher hands back the `adv_sessions` id it just
   * recorded; the chat is keyed by ROSTER OWNER ID.
   *
   * WI-6363: that owner id is now known AT LAUNCH — `launch-su` pre-pins it via
   * `psu --owner-id=` and returns it — so the launch handler sets `hudsession`
   * directly (see `headerAction` below) and there is nothing to park here.
   *
   * This deliberately does NOT wait for the roster to carry a row first. The
   * previous version parked an `advSessionId` and resolved it against the roster,
   * which could never fire: on the terminal path launch-su records no
   * adv_sessions row at all, so the id was always null. Opening the chat straight
   * away is also the better behaviour — the modal is a live sync surface, so it
   * populates as the session boots rather than making the human wait for it.
   */

  const attention = useInboxAttention();

  /** The asks addressed to the human, narrowed by the SAME scoping the inbox
   *  applies. Without it the raw attention feed is the whole ~15-source
   *  firehose (the "328" bug) and every agent would look like it needs you.
   *
   * hud-consolidation-2026-07-26 P-002: this INCLUDES items with no
   * `ownerAgentId` (previously filtered out here) — `buildHudBoard` splits
   * them into `board.unattributed` on its own (`asksByOwner` already ignores
   * the ownerless ones for per-session columns, so this is additive, not a
   * behavior change to the existing needs-you column). See HudAsk's doc for
   * why an ownerless Decision is structural, not an edge case. */
  const asks: HudAsk[] = useMemo(() => {
    const scoped = scopeInboxItems(attention.items ?? []);
    return scoped
      .filter((i) => i.needsHuman)
      .map((i) => ({
        ownerAgentId: i.ownerAgentId,
        title: i.title,
        occurredAt: (i as { occurredAt?: string | null }).occurredAt ?? null,
        id: i.id,
        kind: i.kind,
        itemRef: i.itemRef,
        planSlug: i.planSlug,
        harnessSlug: i.harnessSlug,
      }));
  }, [attention.items]);

  const entries: HudRosterEntry[] = useMemo(() => {
    const payload = roster.data?.[0];
    if (!payload) return [];
    // Pending launches are recorded-but-not-started sessions; they belong on the
    // board (they are real, the human asked for them) and classify as `needs-you`
    // — owner ask 2026-07-27, "all fresh sessions start as needs you". They used
    // to land in `parked`; see deriveColumn step 1c for why that was backwards.
    return [...(payload.active ?? []), ...(payload.pending ?? [])];
  }, [roster.data]);

  // `null` in the URL array marks the solo group — encoded as the literal
  // "solo" because a URL array cannot carry a null.
  const selectedFleets = useMemo(
    () => fleetParam.map((f) => (f === 'solo' ? null : f)),
    [fleetParam],
  );

  /* The no-plan group travels as NO_PLAN_TOKEN for the same reason the solo
     fleet travels as "solo": a URL array cannot carry a null. Unlike the fleet
     path, the token has exactly one definition (see NO_PLAN_TOKEN's docblock)
     — it is imported here, not re-spelled. */
  const selectedPlans = useMemo(
    () => planParam.map((p) => (p === NO_PLAN_TOKEN ? null : p)),
    [planParam],
  );

  /* ── Sessions transcript search ──────────────────────────────────────────
     The owner asked for the entity tabs' filter on the Sessions tab, searching
     the FULL TURN HISTORY of every returned session — not the roster metadata.
     That text is not in the roster payload at all, so this cannot be a client
     filter like `hudq`: it reuses the EXISTING
     GET /api/adv/sessions/search-transcripts route (the shared @papercusp/search
     `session_turn` source that also backs the agents pill and `sessions:search`),
     exactly as PlanSessionsTab does — never a forked searcher.

     Matches roll up to ownerIds and filter the roster BEFORE buildHudBoard, so
     the column counts keep describing what is actually on screen — the same
     model-not-view rule the entity boards' search already follows. */
  const [searchOwners, setSearchOwners] = useState<Set<string> | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchSeq = useRef(0);

  useEffect(() => {
    const q = sessionQuery.trim();
    // <2 chars is "not searching yet", NOT "no matches" — it must clear the
    // filter rather than empty the board.
    if (q.length < 2) {
      setSearchOwners(null);
      setSearchError(null);
      setSearching(false);
      return;
    }
    const seq = ++searchSeq.current;
    const ctl = new AbortController();
    setSearching(true);
    setSearchError(null);
    (async () => {
      try {
        const r = await fetch(
          `/api/adv/sessions/search-transcripts?q=${encodeURIComponent(q)}&limit=100`,
          { signal: ctl.signal },
        );
        const body = (await r.json()) as {
          ok?: boolean;
          sessions?: {
            active: { ownerId?: string | null } | null;
            session: { coordOwnerId?: string | null } | null;
          }[];
          error?: string;
        };
        if (seq !== searchSeq.current) return; // superseded by a newer keystroke
        if (!r.ok || body.ok === false) {
          setSearchError(body.error ?? `search failed (${r.status})`);
          setSearchOwners(new Set());
          return;
        }
        const owners = new Set<string>();
        for (const s of body.sessions ?? []) {
          const id = s.active?.ownerId ?? s.session?.coordOwnerId ?? null;
          if (id) owners.add(id);
        }
        setSearchOwners(owners);
      } catch (e) {
        if (ctl.signal.aborted || seq !== searchSeq.current) return;
        setSearchError(e instanceof Error ? e.message : 'search failed');
        setSearchOwners(new Set());
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    })();
    return () => ctl.abort();
  }, [sessionQuery]);

  const searchedEntries = useMemo(
    () => (searchOwners ? entries.filter((e) => searchOwners.has(e.ownerId)) : entries),
    [entries, searchOwners],
  );

  const board = useMemo(
    () =>
      buildHudBoard(searchedEntries, asks, {
        nowMs,
        suOnly: !allAgents,
        fleets: selectedFleets,
        plans: selectedPlans,
      }),
    [searchedEntries, asks, nowMs, allAgents, selectedFleets, selectedPlans],
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

  /* Single-select: picking a plan REPLACES the selection, the "All plans" row
     clears it. Deliberately not a toggle — re-picking the row you are already
     filtered to reads as "yes, this one", not "undo". */
  const onSelectPlan = useCallback(
    (slug: string | null) => {
      if (slug === ALL_PLANS) {
        void setPlanParam([]);
        return;
      }
      void setPlanParam([slug ?? NO_PLAN_TOKEN]);
    },
    [setPlanParam],
  );

  const openLabel = useMemo(
    () =>
      board.columns
        .flatMap((c) => c.sessions)
        .find((s) => s.ownerId === openOwner)?.label ?? null,
    [board, openOwner],
  );

  /* ── Plans tab ─────────────────────────────────────────────────────────── */

  // The SAME `plans.list` read NewSessionLauncher's plan picker already makes
  // (it renders in this board's header). useSyncQuery dedupes on
  // ['sync', name, args], so this second caller costs one memo, not one fetch —
  // and the two views can never disagree about what plans exist.
  const planList = usePlanList({ includeArchived: false, includeLegacy: true });
  const planBoard = useMemo(
    () =>
      buildPlanBoard(planList.data?.plans ?? [], {
        nowMs,
        query: entityQuery,
      }),
    [planList.data, nowMs, entityQuery],
  );

  /* ── Work items tab ────────────────────────────────────────────────────── */

  // Work items are stored PER HARNESS, so this board is scoped to the active
  // one — the same `slug` the rest of /adv is scoped by, with the same
  // localStorage fallback the Create dock uses. Deliberately not a new picker:
  // a second harness selector on this surface would be a second source of
  // truth for "which harness am I looking at".
  const harnessSlug = useResolvedHarnessSlug();
  const workItems = useSyncQuery<HudWorkItemInput>({
    queryName: 'workItems.byHarness',
    args: { harnessSlug, limit: WORK_ITEM_FETCH_LIMIT },
    // Only fetch when the tab is actually showing: this is the heaviest read
    // on the surface and the HUD's default tab is Sessions.
    enabled: tab === 'items' && Boolean(harnessSlug),
  });
  const itemBoard = useMemo(
    () =>
      buildWorkItemBoard(workItems.data ?? [], board.unattributed, {
        nowMs,
        query: entityQuery,
      }),
    [workItems.data, board.unattributed, nowMs, entityQuery],
  );

  const entityView =
    tab === 'plans' ? (
      <HudEntityColumns
        board={planBoard}
        focusColumn={(entityColumn as HudEntityColumnId | null) ?? null}
        onFocusColumn={(id) => void setEntityColumn(id)}
        query={entityQuery}
        onQuery={(q) => void setEntityQuery(q)}
        loading={planList.loading}
        error={planList.error ? String(planList.error) : null}
        emptyLabel="No plans in this workspace yet."
        noun="plans"
      />
    ) : tab === 'items' ? (
      <HudEntityColumns
        board={itemBoard}
        focusColumn={(entityColumn as HudEntityColumnId | null) ?? null}
        onFocusColumn={(id) => void setEntityColumn(id)}
        query={entityQuery}
        onQuery={(q) => void setEntityQuery(q)}
        loading={workItems.loading}
        error={workItems.error ? String(workItems.error) : null}
        emptyLabel={
          harnessSlug
            ? `No work items in ${harnessSlug}.`
            : 'Pick a harness to see its work items.'
        }
        /* The read above is gated on a resolved harness, so with none the board
           holds ONLY the unattributed asks — which still push `total` above
           zero and therefore suppress `emptyLabel` entirely. Without this the
           tab reads as a complete work-item board while containing no work
           items at all (verified live 2026-07-26: 146 needs-you, zero of them
           work items, no explanation on screen). Say what is missing. */
        notice={
          harnessSlug
            ? null
            : 'No harness is selected, so no work items could be loaded — these are asks that belong to no single harness. Pick a harness to see its work items.'
        }
        noun="work items"
      />
    ) : null;

  return (
    <>
      <HudBoard
        board={board}
        selectedFleets={selectedFleets}
        onToggleFleet={onToggleFleet}
        selectedPlans={selectedPlans}
        onSelectPlan={onSelectPlan}
        focusColumn={(focusColumn as HudColumnId | null) ?? null}
        onFocusColumn={(id) => void setFocusColumn(id)}
        suOnly={!allAgents}
        onToggleSuOnly={() => void setAllAgents((v) => !v)}
        onOpenSession={(ownerId) => void setOpenOwner(ownerId)}
        loading={roster.loading || searching}
        error={roster.error ? String(roster.error) : searchError}
        sessionQuery={rawSessionQuery}
        onSessionQuery={(q) => void setSessionQuery(q === '' ? null : q)}
        searchActive={searchOwners !== null}
        headerAction={
          <NewSessionLauncher
            onLaunched={(ownerId) => {
              // WI-6363: `ownerId` is the pre-pinned coord owner id the new
              // session registers as, so it is exactly the key `hudsession`
              // (and SessionChatModal) already take. Null only from an operator
              // predating the pre-pin, in which case we open nothing rather
              // than guessing.
              if (ownerId) void setOpenOwner(ownerId);
            }}
          />
        }
        tab={tab as HudTabId}
        onSelectTab={(next) => void setTab(next)}
        entityView={entityView}
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
