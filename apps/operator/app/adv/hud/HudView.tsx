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
import PlanPopupModal from '@/app/_components/plans/PlanPopupModal';
import WorkItemPopupModal from '@/app/_components/work-items/WorkItemPopupModal';
import { scopeInboxItems, useInboxAttention } from '@/app/_components/inbox/use-inbox-pending';
import { Modal } from '@/app/harness/Modal';
import { OtherDetail } from '@/app/admin/plans/PlanOtherList';
import NewSessionLauncher from '@/app/adv/sessions/NewSessionLauncher';
import { usePlanList } from '@/app/admin/plans/plans-api';
import { useResolvedHarnessSlug } from '@/app/adv/create/use-create-data';
import HudBoard from './HudBoard';
import HudEntityColumns from './HudEntityColumns';
import { workItemIdForCard, type HudEntityCard } from './hud-entity-board';
import { advRosterArgs } from '@/lib/adv-roster-args';
import {
  ALL_FLEETS,
  ALL_PLANS,
  NO_PLAN_TOKEN,
  buildHudBoard,
  matchesSessionText,
  reconcileBoardIdentity,
  searchHitAnchor,
  HUD_COLUMNS,
  type HudAsk,
  /* Aliased: `HudBoard` is already the default-imported COMPONENT above, and
     the collision is invisible to vitest (which does not typecheck). */
  type HudBoard as HudBoardData,
  type HudColumnId,
  type HudRosterEntry,
  type HudSearchHit,
} from './hud-board-model';
import {
  buildPlanBoard,
  buildWorkItemBoard,
  HUD_ENTITY_COLUMNS,
  HUD_TABS,
  HUD_WORK_ITEM_FETCH_STATES,
  rollUpStateCounts,
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
  /** WI-6376: terminal-spawned psu launches inside their boot window, already
   *  deduped server-side against `active`. A separate tier from `pending`
   *  because the pui panes that one and these sessions own a terminal already. */
  starting?: HudRosterEntry[];
}

/** The board re-derives ages from a clock; without a tick, a card would say
 *  "blocked 2m" an hour later. 15s is fine — every age is rendered at
 *  minute-or-coarser granularity, so a faster tick would only cost renders. */
const CLOCK_TICK_MS = 15_000;

/** Work-item CARDS pulled per status (P-004). 12 statuses × 40 ≈ 480 rows —
 *  about what the old single 500-row window cost, but spread so every column is
 *  actually represented instead of whichever statuses happened to be touched
 *  most recently. The board renders at most
 *  HUD_ENTITY_DEFAULT_MAX_PER_COLUMN (60) per column regardless; counts come
 *  from the store-wide aggregate, so under-fetching a column understates no
 *  number, it only means more of it sits behind "+N more". */
const WORK_ITEM_PER_STATE = 40;

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
  /* Which turn the modal should open ON — the text of the search match that
     put this card on screen (owner ask 2026-08-02, part b).

     nuqs, not useState, and deliberately so: it is user-meaningful (it changes
     what the modal shows), it must survive the reload/share the `hudsession`
     param already survives, and — the repo rule that settles it — anything in
     useState is invisible to the agent UI control surface (`ui:get_state` /
     `ui:dispatch` read the URL). TEXT rather than a turn index because the
     search index and the modal's transcript are different stores; see
     `searchHitAnchor`. */
  const [openFocus, setOpenFocus] = useQueryState('hudfocus', parseAsString);
  // WI-6367: which session THIS view just launched, and when. Deliberately
  // useState, not nuqs: it is mid-flight lifecycle state, not user-meaningful
  // (a shared/reloaded URL must not claim a session is "starting up" — by then
  // it either registered or failed, and both read correctly without this).
  const [pendingLaunch, setPendingLaunch] = useState<{ ownerId: string; startedAtMs: number } | null>(
    null,
  );

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
    args: advRosterArgs(workspaceId),
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
        // WI-6742: the STRUCTURED destination. Carried through the slimming
        // (ui-read-projection drops only `actions` and clips `body`), so
        // routing needs no extra fetch.
        ref: (i as { ref?: { kind: string; slug?: string | null } | null }).ref ?? null,
      }));
  }, [attention.items]);

  const entries: HudRosterEntry[] = useMemo(() => {
    const payload = roster.data?.[0];
    if (!payload) return [];
    // Pending launches are recorded-but-not-started sessions; they belong on the
    // board (they are real, the human asked for them) and classify as `needs-you`
    // — owner ask 2026-07-27, "all fresh sessions start as needs you". They used
    // to land in `parked`; see deriveColumn step 1c for why that was backwards.
    //
    // `starting` is the same argument for the OTHER launch path (WI-6376): a
    // terminal-spawned psu session is equally real and equally the human's, and
    // before this tier existed it appeared in no column for its whole boot
    // window. Already deduped against `active` server-side.
    return [...(payload.active ?? []), ...(payload.pending ?? []), ...(payload.starting ?? [])];
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
  /** The top transcript match per session — the card excerpt AND the turn the
   *  modal opens on (owner ask 2026-08-02). */
  const [searchHits, setSearchHits] = useState<Map<string, HudSearchHit> | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchSeq = useRef(0);

  /* The INSTANT half (owner ask 2026-08-02 — see `matchesSessionText`). Keyed on
     the RAW query, not the debounced one: this is the pass that has to land on
     the same frame as the keystroke, exactly like the Work-items pane. The
     transcript pass below stays debounced, because it is the one that costs a
     round-trip. */
  const localOwners = useMemo(() => {
    const q = rawSessionQuery.trim();
    if (!q) return null;
    const out = new Set<string>();
    for (const e of entries) if (matchesSessionText(e, q)) out.add(e.ownerId);
    return out;
  }, [entries, rawSessionQuery]);

  useEffect(() => {
    const q = sessionQuery.trim();
    // <2 chars is "not searching yet", NOT "no matches" — it must clear the
    // filter rather than empty the board.
    if (q.length < 2) {
      setSearchOwners(null);
      setSearchHits(null);
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
            sessionId?: string | null;
            sourceKind?: string | null;
            /* Owner ask 2026-08-02. These came back on every response all along
               — the old handler destructured out the ownerId and dropped them,
               which is why a search result rendered as an ordinary card with
               nothing saying why it matched. Ordered best-first by the engine. */
            hits?: {
              turnIdx?: number | null;
              excerpt?: string | null;
              highlight?: string | null;
              speaker?: string | null;
              ts?: string | null;
            }[];
          }[];
          error?: string;
        };
        if (seq !== searchSeq.current) return; // superseded by a newer keystroke
        if (!r.ok || body.ok === false) {
          setSearchError(body.error ?? `search failed (${r.status})`);
          setSearchOwners(new Set());
          setSearchHits(null);
          return;
        }
        const owners = new Set<string>();
        const hits = new Map<string, HudSearchHit>();
        for (const s of body.sessions ?? []) {
          const id = s.active?.ownerId ?? s.session?.coordOwnerId ?? null;
          if (!id) continue;
          owners.add(id);
          /* The engine ranks hits, so [0] is the best one — that is the excerpt
             the card shows and the turn the modal opens on. `more` keeps the
             rest honest: one excerpt with no hint that 40 others exist reads as
             the whole answer. A hit with no usable text is skipped rather than
             rendered as an empty strip. */
          const top = s.hits?.[0];
          const text = top?.highlight ?? top?.excerpt ?? '';
          if (!top || !text.trim()) continue;
          hits.set(id, {
            turnIdx: typeof top.turnIdx === 'number' ? top.turnIdx : -1,
            highlight: top.highlight ?? null,
            excerpt: top.excerpt ?? '',
            speaker: top.speaker ?? null,
            ts: top.ts ?? null,
            sessionId: s.sessionId ?? '',
            sourceKind: s.sourceKind ?? '',
            more: Math.max(0, (s.hits?.length ?? 0) - 1),
          });
        }
        setSearchOwners(owners);
        setSearchHits(hits);
      } catch (e) {
        if (ctl.signal.aborted || seq !== searchSeq.current) return;
        setSearchError(e instanceof Error ? e.message : 'search failed');
        setSearchOwners(new Set());
        setSearchHits(null);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    })();
    return () => ctl.abort();
  }, [sessionQuery]);

  /* UNION, not intersection: the two passes answer different questions about the
     same session ("does its card say this" vs "did it ever say this"), so a hit
     from either is a hit. Intersecting would make the board NARROW when the
     slow pass returned, i.e. cards would vanish a second after appearing.

     `null` from a pass means "not applicable / nothing yet", never "matched
     nothing" — an empty Set is the real no-match. That distinction is what keeps
     a 1-character query (below the transcript floor) filtering locally instead
     of blanking the board. */
  const searchedEntries = useMemo(() => {
    if (!localOwners && !searchOwners) return entries;
    return entries.filter(
      (e) => Boolean(localOwners?.has(e.ownerId)) || Boolean(searchOwners?.has(e.ownerId)),
    );
  }, [entries, localOwners, searchOwners]);

  /* How many sessions the SLOW pass added that the instant one had not already
     found — the honest measure of what waiting bought you, and what the input's
     status chip reports. A transcript hit that the card text also matched is not
     "+1 transcript": it was already on screen. */
  const transcriptExtra = useMemo(() => {
    if (!searchOwners) return null;
    let n = 0;
    for (const id of searchOwners) if (!localOwners?.has(id)) n += 1;
    return n;
  }, [searchOwners, localOwners]);

  /* WI-6560 — `buildHudBoard` is pure and allocates fresh session objects every
     call, and this memo re-runs on every 15s clock tick. `reconcileBoardIdentity`
     hands back the PREVIOUS object for any session/column/board that is
     structurally unchanged, which is what lets `MemoSessionCard`'s shallow
     compare hold across a tick that did not change what any card renders (see
     the long rationale on the function). Writing the ref during the memo is a
     pure cache: if React discards this render, the next comparison is still
     structural, so the output can never be stale — at most one extra render. */
  const prevBoardRef = useRef<HudBoardData | null>(null);
  const board = useMemo(() => {
    const built = buildHudBoard(searchedEntries, asks, {
      nowMs,
      suOnly: !allAgents,
      fleets: selectedFleets,
      plans: selectedPlans,
      searchHits: searchHits ?? undefined,
    });
    const reconciled = reconcileBoardIdentity(prevBoardRef.current, built);
    prevBoardRef.current = reconciled;
    return reconciled;
  }, [searchedEntries, asks, nowMs, allAgents, selectedFleets, selectedPlans, searchHits]);

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
    // P-004: a FAIR slice per status, not one `updated_ts DESC` window across
    // all of them. The old window (limit 500 of 27,514) held zero of the 45
    // needs-human rows — recently-touched `done` work crowded them out — so the
    // needs-you column rendered no work items while reporting a count. This
    // asks for every status the board maps, bounded, and costs LESS data.
    args: {
      harnessSlug,
      states: HUD_WORK_ITEM_FETCH_STATES,
      perState: WORK_ITEM_PER_STATE,
    },
    // Only fetch when the tab is actually showing: this is the heaviest read
    // on the surface and the HUD's default tab is Sessions.
    enabled: tab === 'items' && Boolean(harnessSlug),
  });
  /* The counts the board REPORTS come from a store-wide aggregate, never from
     the sampled cards — reusing the existing `workItems.stats` feed rather than
     adding a second counting path. */
  const workItemStats = useSyncQuery<{ state?: string | null; n?: number | null }>({
    queryName: 'workItems.stats',
    args: { harnessSlug },
    enabled: tab === 'items' && Boolean(harnessSlug),
  });
  const itemTotals = useMemo(
    () => (workItemStats.data ? rollUpStateCounts(workItemStats.data) : null),
    [workItemStats.data],
  );
  const itemBoard = useMemo(
    () =>
      buildWorkItemBoard(workItems.data ?? [], board.unattributed, {
        nowMs,
        query: entityQuery,
        totals: itemTotals,
      }),
    [workItems.data, board.unattributed, nowMs, entityQuery, itemTotals],
  );

  /* ── Card → popup (P-002) ───────────────────────────────────────────────
     Owner ask 2026-07-27: clicking a Plans/Work-items row should open it in a
     popup, "like it works in the plans tab in the left hand side bar". So this
     opens the SAME two components that sidebar (PlansPane) and the chat's ref
     pills already open — PlanPopupModal / WorkItemPopupModal — rather than a
     third detail renderer.

     Own nuqs keys (`hudplanpop`/`hudwi`), deliberately distinct from PlansPane's
     `pplan` and OperatorChat's `wpop`/`wppop`: the same convention those two
     already follow, so a popup opened from the HUD and one opened from the
     sidebar can coexist instead of fighting over one URL key.

     ⚠ `hudplanpop`, NOT `hudplan` — `hudplan` is ALREADY TAKEN, 330 lines up, by
     the plan FILTER axis (`parseAsArrayOf`). This originally shipped as `hudplan`
     and the two hooks silently fought over one key: clicking a plan card wrote the
     slug, the ARRAY hook read it back as a filter, and the board emptied to zero
     cards while no popup ever opened — strictly worse than the unwired card the
     owner reported. The collision check that produced the comment above looked at
     OTHER files (`pplan`, `wpop`) and missed the one in this same component, which
     is exactly why `app/_lints/nuqs-key-collisions.test.ts` now asserts key
     uniqueness here mechanically instead of by eye. */
  const [openPlanSlug, setOpenPlanSlug] = useQueryState('hudplanpop', parseAsString);
  const [openItemId, setOpenItemId] = useQueryState('hudwi', parseAsString);
  /* WI-6742: the third destination — the ask itself, for the asks that are not
     ABOUT a work item or plan (improvement triage, standing approval, dark-flag
     ratification). nuqs, not useState, like every other popup here; the key is
     asserted unique by app/_lints/nuqs-key-collisions.test.ts. */
  const [openAskId, setOpenAskId] = useQueryState('hudask', parseAsString);

  /* PlanDetail is harness-scoped — scoping plans:get to the wrong harness is
     the "Server: not_found" trap PlanPopupModal's own docblock names. The plan
     row already carries its harness, so read it from the loaded list rather
     than assuming the board's active harness. */
  const openPlanRow = useMemo(
    () => (planList.data?.plans ?? []).find((p) => p.slug === openPlanSlug) ?? null,
    [planList.data, openPlanSlug],
  );

  /* WorkItemPopupModal is harness-scoped for the SAME reason, and the board's
     active harness is not a safe stand-in: the Work items tab renders the
     unattributed ASK cards even under `scope=all` with no harness resolved, so
     `harnessSlug` is null exactly when those cards are on screen and the popup
     renders "No harness context for <id>" instead of the item (measured live
     2026-07-28). The ask carries its own harness — read it from there and fall
     back to the board's, mirroring `openPlanRow` above. */
  const openItemHarness = useMemo(() => {
    if (!openItemId) return null;
    const hit = asks.find(
      (a) => workItemIdForCard({ id: `ask:${a.id}`, ref: a.itemRef ?? '' }) === openItemId,
    );
    return hit?.harnessSlug ?? null;
  }, [asks, openItemId]);

  /* The ask behind `hudask`. Read from the SAME scoped feed the cards are built
     from, so a card that is on screen always resolves — and an id that no
     longer matches (the ask was resolved elsewhere, or the URL was pasted into
     a differently-scoped board) yields null and the modal simply stays shut
     rather than opening empty. */
  const openAsk = useMemo(
    () => (openAskId ? (attention.items ?? []).find((i) => i.id === openAskId) ?? null : null),
    [attention.items, openAskId],
  );

  const onOpenPlanCard = useCallback(
    (card: HudEntityCard) => void setOpenPlanSlug(card.id),
    [setOpenPlanSlug],
  );
  /* WI-6742 [owner-reported]: clicking a "Needs you" card did nothing, while
     every other column opened a popup.

     This handler used to RE-DERIVE a destination by pattern-matching the card's
     `id`/`ref`. That fails for the ask cards folded into needs-you — and only
     for them, which is why exactly one column was dead: an ask's `ref` is a
     KIND LABEL ("Improvement triage"), so it matched no work-item id and the
     handler returned early. `HudEntityColumns` still rendered the card as a
     `<button>` (board-wide, keyed off `onOpenCard` being supplied, not
     per-card), producing the dead button its own docblock warns about.

     The board now DECLARES the destination on every card it builds, so there is
     nothing to re-derive and no early return to fall through. `card.open` is a
     total function (see HudAskTarget) — an unmapped ref opens the ask itself
     rather than nothing, so a future adapter cannot reintroduce this. */
  const onOpenItemCard = useCallback(
    (card: HudEntityCard) => {
      const target = card.open;
      if (!target) return;
      if (target.kind === 'work-item') void setOpenItemId(target.id);
      else if (target.kind === 'plan') void setOpenPlanSlug(target.slug);
      else void setOpenAskId(target.askId);
    },
    [setOpenItemId, setOpenPlanSlug, setOpenAskId],
  );

  /* WI-6560 — this MUST stay a stable reference, and it is load-bearing in a way
     that is invisible locally. It is the `onOpen` prop of `MemoSessionCard`
     (HudBoard.tsx), so a fresh arrow here changes one prop of EVERY session card
     on EVERY HudView render, and `memo`'s shallow compare then misses on all of
     them. Both row components carry docblocks explaining that their error
     boundary sits INSIDE the memo "so an unchanged row re-renders neither" —
     that saving was inert on the session board for exactly this reason, while
     the entity board got it right (onOpenItemCard / onOpenPlanCard above are
     already useCallback'd, which is why MemoEntityCard's memo does hold).

     On its own this fixes the large class of renders where session data did NOT
     change — work-item/plan data arriving, entity-search typing, opening/closing
     the chat modal, switching tabs — which used to re-render every session card
     for nothing.

     It did NOT, on its own, fix the two paths WI-6560 actually measured: `board`
     is also rebuilt whenever roster data arrives or the 15s clock ticks, and
     `buildHudBoard` allocates new session objects, so the `session` prop churned
     on those renders regardless. `reconcileBoardIdentity` (at the `board` memo
     above) closes that second half by handing back the previous object whenever
     the rebuilt one is structurally identical. Both halves are required: a
     stable `onOpen` with churning `session` objects, or stable sessions with a
     fresh `onOpen` arrow, each leaves the memo missing on every card.

     Pinned by hud-render-stability.test.tsx: the memo BEHAVIOUR is proven by
     rendering HudBoard (including the failure direction — a changing onOpen
     identity re-renders every card), and this call site is held by a structural
     guard in the same file, because HudView itself has no render harness. Do
     not inline it back. */
  /* The hits are read through a ref rather than taken as a dep ON PURPOSE.
     `onOpenSession`'s identity is load-bearing — hud-render-stability.test.tsx
     pins that a changing identity re-renders every card — and `searchHits`
     changes on every keystroke's search response, which is exactly when the
     board is busiest. The handler only needs the hits AT CLICK TIME, never a
     re-render when they change, which is precisely the case a latest-ref is
     for. */
  const searchHitsRef = useRef(searchHits);
  searchHitsRef.current = searchHits;
  const onOpenSession = useCallback(
    (ownerId: string) => {
      void setOpenOwner(ownerId);
      // Null clears the param: opening a NON-search card must not inherit the
      // previous search's anchor and scroll to a turn nobody asked about.
      void setOpenFocus(searchHitAnchor(searchHitsRef.current?.get(ownerId) ?? null));
    },
    [setOpenOwner, setOpenFocus],
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
        onOpenCard={onOpenPlanCard}
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
        onOpenCard={onOpenItemCard}
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
        onOpenSession={onOpenSession}
        /* NOT `|| searching` any more. Folding the transcript pass into the
           board's loading flag made every keystroke put the whole board into
           "Reading the session roster…" for the length of a 0.4–4.9s request —
           the instant local results were computed and then hidden behind a
           spinner, which is the very inertness this change exists to remove.
           The slow pass now reports itself on the input instead. */
        loading={roster.loading}
        error={roster.error ? String(roster.error) : searchError}
        sessionQuery={rawSessionQuery}
        onSessionQuery={(q) => void setSessionQuery(q === '' ? null : q)}
        /* A QUERY is active, which is not the same as "the transcript pass has
           answered" (the old test, `searchOwners !== null`). With the instant
           pass a 1-char query filters the board while the transcript pass has
           not run at all, and the empty-board copy has to say "nothing matched"
           for that case rather than "no sessions are running". */
        searchActive={rawSessionQuery.trim().length > 0}
        sessionSearching={searching}
        transcriptExtra={transcriptExtra}
        headerAction={
          <NewSessionLauncher
            onLaunched={(ownerId) => {
              // WI-6363: `ownerId` is the pre-pinned coord owner id the new
              // session registers as, so it is exactly the key `hudsession`
              // (and SessionChatModal) already take. Null only from an operator
              // predating the pre-pin, in which case we open nothing rather
              // than guessing.
              if (!ownerId) return;
              // WI-6367: remember WHEN, so the chat can render the boot window
              // as "starting up" rather than as the gone-away empty state a
              // session with no roster row otherwise gets.
              setPendingLaunch({ ownerId, startedAtMs: Date.now() });
              void setOpenOwner(ownerId);
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
        pendingLaunch={pendingLaunch}
        focusAnchor={openFocus}
        onClose={() => {
          // WI-6367: the launch context is only meaningful for the modal it
          // opened — drop it on close so reopening the same session later
          // (by then a normal, possibly ended, session) gets the normal
          // empty states rather than a stale "starting up".
          setPendingLaunch(null);
          void setOpenOwner(null);
          void setOpenFocus(null);
        }}
      />
      {/* P-002: the Plans / Work items tabs' destination. Mounted here (not in
          HudEntityColumns) for the same reason PlansPane mounts its own — the
          popup is a pure function of props, the CALLER owns the open-id param. */}
      <PlanPopupModal
        planSlug={openPlanSlug}
        harnessSlug={openPlanRow?.harness ?? harnessSlug}
        planTitle={openPlanRow?.title ?? null}
        onClose={() => void setOpenPlanSlug(null)}
      />
      <WorkItemPopupModal
        id={openItemId}
        harnessSlug={openItemHarness ?? harnessSlug}
        onSelect={(id) => void setOpenItemId(id)}
        onClose={() => void setOpenItemId(null)}
      />
      {/* WI-6742: the ask's own popup, for asks that are not ABOUT a work item
          or plan. `OtherDetail` is the SAME component the Plans queue and
          SessionChatModal already render — never a second renderer — so these
          cards get the real approve/resolve/discuss actions rather than a
          read-only echo. It re-fetches the full item itself (the list feed is
          slimmed), which is why passing the slimmed row is correct here. */}
      <Modal
        open={openAsk != null}
        onOpenChange={(o) => {
          if (!o) void setOpenAskId(null);
        }}
        title={openAsk?.title ?? 'Ask'}
        srOnlyTitle
      >
        {openAsk ? (
          <OtherDetail
            key={openAsk.id}
            item={openAsk}
            onResolved={() => {
              attention.refresh();
              void setOpenAskId(null);
            }}
          />
        ) : null}
      </Modal>
    </>
  );
}
