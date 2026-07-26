/**
 * Left sidebar (left-sidebar-tauri-2026-06-07) — the desktop twin of the pui
 * dock's retired main pane: tabs in a docked, collapsible, drag-resizable
 * MIDDLE rail (it docks after the op-chat sidebar, which is the leftmost
 * surface). The zellij dock is now consoles-only (operator chat ⇄ brain ⇄ live
 * bees); the tab-style surfaces live HERE.
 *
 * SCOPE (owner placement corrections, 2026-07-16 → 2026-07-17): this rail is
 * the SETTINGS / steering surface — Accounts, Mug, Kettle, Papercup, Pots. The
 * LIVE surfaces moved out to the leftmost op-chat sidebar one by one: Inbox
 * (EI-13037), then Fleet + Peers (WI-5162). Their panes still live in this
 * directory; only their host changed — see components/chat-faces/ChatFacesHost.
 *
 * Architecture mirrors the proven DevAdminRail (dev-admin-sidebar-2026-06-05):
 *   - DOCKED, not floating — reserves layout space (body.has-left-sidebar
 *     padding-left + --left-sidebar-w) so the app shifts right; sits AFTER the
 *     op-chat sidebar (offset by --op-chat-w).
 *   - Collapses to a thin icon rail (the three tab icons — clicking one
 *     expands straight into that tab), never disappears.
 *   - Drag-resizable from its RIGHT edge, width persisted per-workspace.
 *   - State in the URL via nuqs (`?lsb=…&lst=queen`) so it is deep-linkable
 *     and agent-driveable (ui:get_state / ui:dispatch).
 *   - Only the ACTIVE tab's panel is mounted (lazy chunks; queries gate on
 *     mount), and the whole body unmounts while collapsed.
 *
 * Unlike DevAdminRail this is NOT dev-gated — it's a first-class app surface.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
// Retry-wrapped lazy: a transient first-boot chunk fetch failure on the packaged
// WebKitGTK desktop must retry, not escalate to the fatal boundary (WI-2902).
import { lazyWithRetry as lazy } from '@papercusp/operator-core/lib/lazy-with-retry';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Tooltip } from '@/app/harness/Tooltip';
import { useQueryStates, parseAsBoolean, parseAsStringLiteral } from 'nuqs';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { usePathname } from '@/lib/router-compat/navigation';
import { isChromelessPath } from '@papercusp/operator-core/lib/chromeless-routes';
import { useLexicon } from '@/lib/useLexicon';
import type { BoundLexicon } from '@papercusp/lexicon';
import { Network, Coffee, Thermometer, CupSoda, KeyRound, Cog, Bot, Coins, MessagesSquare, PanelLeftOpen, PanelLeftClose } from 'lucide-react';
import { useFlag } from '@papercusp/flags/client';
import { FLAGS } from '@papercusp/flags';
import { LEFT_SIDEBAR_CSS } from './left-sidebar.styles';
// The always-on operator-voice controls that used to sit here (PapercupVoiceBar)
// are RETIRED (WI-4740, owner ask 2026-07-13): they duplicated the chat
// sidebar's op-chat-controls row button-for-button, so the chat bar is now the
// ONLY voice-controls surface (the TTS mute moved there too). Only the rail
// collapse control — the one genuinely rail-specific button — stays, in the
// slim row above the tabs.

// SwarmTab / VoiceTab are no longer mounted here — they render as op-chat
// sidebar faces now (WI-5162); components/chat-faces/ChatFacesHost lazy-loads
// them. The files stay where they are: only their HOST moved.
const PotsTab = lazy(() => import('./PotsTab'));
// 🔑 Accounts — the owner's session-now account override (which Max accounts the fleet
// may use right now), beside Mug as a sibling owner-steering lever (accounts-pool-tab
// P-005; promoted to the LEFTMOST sidebar tab by owner request 2026-06-17).
const AccountsTab = lazy(() => import('./AccountsTab'));
// 👑 Mug steering — the owner's focus/pause controls for the autonomous Mug.
// Moved here from the /adv top tab strip as an owner-steering tab (owner
// review 2026-06-15; queen-steering-panel-2026-06-15 B-04).
const MugTab = lazy(() => import('./MugTab'));
// 👁 Overwatch — the autonomous supervisor's actionable panel (control + the
// anomaly→action list). Moved here from the /adv strip next to Mug (owner ask
// 2026-06-15; system-health-tab P-008) — its duplicated health grid dropped (the
// Health tab owns the panels). Flag-gated (OVERWATCH); hidden when the role is dark.
const OverwatchTab = lazy(() => import('./OverwatchTab'));
// 📣 Sentinel — the always-on, voice-first human-facing companion's
// quick live-override settings (audience mode, voice, proactive nudges, DND). The
// sidebar is the quick live-override surface; full workspace settings hold the
// defaults. Flag-gated (PAPERCUP); hidden until the role is live.
const PapercupTab = lazy(() => import('./PapercupTab'));
// 🤖 Agents + ⚙ System — the scheduled-work rail, split by whether a fire RUNS A
// MODEL (owner ask 2026-07-26: "its an 'agents' tab, only the actual llm runs
// should show there, other things that run in a schedule lets make a new tab for
// all the routines that are deterministic").
//
// These two REPLACE the former Blender (🌀 learning) and Docs (📄 documentation)
// tabs, whose rows redistributed into the split — the learning pipeline and doc
// repair are model runs and live in Agents; knowledge-pack maintenance and the doc
// freshness sweep are deterministic and live in System. Subject was never the axis
// the owner needed; "does this spend money" was. The Blender's Arming (spend-gate)
// section moved into Agents, beside the things it gates.
//
// The lenses partition the catalog by construction (`spend !== 'none'` vs
// `=== 'none'`), so a routine cannot fall between them — which is how the old
// category wiring lost 40 rows to an `infra` category no pane claimed.
const AgentsTab = lazy(() => import('./AgentsTab'));
const SystemTab = lazy(() => import('./SystemTab'));
// 💬 Conversations — the curated conversation stream (Q&A, group decisions,
// agent chats, work-item mail) at rail width (WI-5754, owner ask 2026-07-25).
// It is the SAME four SSE-cached reads /adv's Conversations tab consumes — see
// components/conversations/unified-conversations for the shared composition —
// re-laid-out as a single drill-in column. Reading only: composing a question
// lives in the Agents tab (AskAgentPane), so the rail has exactly one place to
// ask and one place to read.
const ConversationsTab = lazy(() => import('./ConversationsTab'));
// 💰 Spend — the ONE workspace-wide cost surface (owner correction 2026-07-25).
// Blender/Docs/Agents each had their own "Spend" lane, but spend is recorded per
// agent ROLE with no link back to the spawning routine, so each pane hand-picked
// overlapping roles and reported the SAME dollars as its own. Cost is a peer tab
// now, sitting right of Agents, with the attribution limit stated on it.
const SpendTab = lazy(() => import('./SpendTab'));
// (The 📥 Inbox tab (EI-13037) MOVED to the op-chat sidebar — owner placement
// correction 2026-07-16: this middle rail is the SETTINGS surface; the far-left
// papercup-chat sidebar is the live surface. See _components/inbox/InboxPane.)

// `tip` is the hover tooltip (owner ask 2026-06-23) — a one-line "what is this
// tab for", surfaced via the button's native `title` on hover.
//
// label/tip are BUILDERS of the active lexicon `t` (restore-pot-lexicon P-005):
// brand nouns resolve through the flag-gated pack — classic/public shows Pot,
// Brain, Operator, Fleet; the-hive skin shows Hive, Queen, Sentinel, Colony.
// Overwatch has no TermKey (D-002) so it stays literal in both packs.
// ORDER IS OWNER-SET (2026-07-25, split 2026-07-26): Accounts · Pots · Papercup ·
// Mug · Kettle · Agents · System · Spend. The owner reads the rail left-to-right
// as "who am I / what am I running / who talks to me" (Accounts → Pots → Papercup)
// before the autonomous machinery (Mug → Kettle → the two scheduled-work panes).
// Tab IDS ARE FROZEN — `?lst=<id>` deep links, ui:dispatch, and the collapsed rail
// buttons key on them — so reordering only moves array entries; never rename an id
// to match a new position. (`blender` and `docs` are RETIRED ids: their panes were
// dissolved into the Agents/System split. A stale `?lst=blender` deep link now
// falls through to the default tab rather than resolving.)
const TABS = [
  { id: 'accounts', label: (_t: BoundLexicon) => 'Accounts', icon: KeyRound, tip: (_t: BoundLexicon) => 'Provider accounts & API keys your agents sign in with', render: (a: boolean) => <AccountsTab active={a} /> },
  // (The Fleet + Peers tabs MOVED to the op-chat sidebar — owner ask 2026-07-17
  // (WI-5162): they now sit right of the 🫖 Pot Health "kettle" button as faces
  // of the far-left live surface, alongside the Inbox that moved there the day
  // before (EI-13037). Same panes (SwarmTab / VoiceTab), composed for the
  // sidebar in components/chat-faces/ChatFacesHost. This middle rail keeps the
  // SETTINGS/steering surfaces.)
  { id: 'hives', label: (t: BoundLexicon) => t('pot', { plural: true }), icon: Network, tip: (t: BoundLexicon) => `${t('pot', { plural: true })} — the cross-device P2P network of connected ${t('node', { plural: true, lower: true })}`, render: (a: boolean) => <PotsTab active={a} /> },
  // Cup-cast nav icons (restore-pot-lexicon D-006): Mug→Coffee ☕ · Kettle→Thermometer
  // (no lucide kettle exists; the thermometer ties the kettle's heat to overwatch's
  // system-health monitoring) · Papercup→CupSoda 🥤. classic labels flow from the lexicon.
  { id: 'sentinel', label: (t: BoundLexicon) => t('operator'), icon: CupSoda, tip: (t: BoundLexicon) => `${t('operator')} — your voice/text front-door agent; talks, suggests, and hands work to the ${t('brain')}`, render: (a: boolean) => <PapercupTab active={a} /> },
  { id: 'queen', label: (t: BoundLexicon) => t('brain'), icon: Coffee, tip: (t: BoundLexicon) => `The ${t('brain')} — plans work and places it across the ${t('fleet', { lower: true })}`, render: (a: boolean) => <MugTab active={a} /> },
  { id: 'overwatch', label: (t: BoundLexicon) => t('overwatch'), icon: Thermometer, tip: (t: BoundLexicon) => `${t('overwatch')} — supervises ${t('fleet', { lower: true })} & system health, nudges when things drift`, render: (a: boolean) => <OverwatchTab active={a} /> },
  // 🤖 Agents + ⚙ System sit immediately after the Kettle (overwatch) tab, in the
  // slots Blender + Docs held — owner placement 2026-07-25, split 2026-07-26.
  // Agents leads: it is the one that costs money. Literal labels in both lexicon
  // packs — they name concrete automation surfaces, not cup-cast brand nouns, so
  // there is no TermKey to resolve.
  { id: 'agents', label: (_t: BoundLexicon) => 'Agents', icon: Bot, tip: (_t: BoundLexicon) => 'Scheduled work that RUNS A MODEL — loops, wakes, learning, doc repair. Everything here can spend money', render: (a: boolean) => <AgentsTab active={a} /> },
  { id: 'system', label: (_t: BoundLexicon) => 'System', icon: Cog, tip: (_t: BoundLexicon) => 'Deterministic scheduled work — git sync, release gate, GC, health probes. None of it spends money', render: (a: boolean) => <SystemTab active={a} /> },
  { id: 'spend', label: (_t: BoundLexicon) => 'Spend', icon: Coins, tip: (_t: BoundLexicon) => 'What every agent in this workspace cost over the last 7 days', render: (a: boolean) => <SpendTab active={a} /> },
  // 💬 Conversations sits LAST (owner ask 2026-07-25). Appending rather than
  // inserting keeps the owner-set order of every tab before it untouched — the
  // order is pinned by a test precisely so a later addition can't quietly
  // reshuffle it. Label is "Convos": a 3-column tab cell fits ~8 characters
  // beside its icon at the rail's 300px minimum, and "Conversations" would
  // ellipsise; the pane header carries the full word.
  { id: 'conversations', label: (_t: BoundLexicon) => 'Convos', icon: MessagesSquare, tip: (_t: BoundLexicon) => 'Conversations — questions, group decisions, agent chats and work-item mail', render: (a: boolean) => <ConversationsTab active={a} /> },
] as const;

type TabId = (typeof TABS)[number]['id'];
const TAB_IDS = TABS.map((t) => t.id) as unknown as TabId[];

// Width model — mirrors DevAdminRail's.
const COLLAPSED_WIDTH = 48;
const MIN_WIDTH = 300;
const DEFAULT_WIDTH = 384;
const WIDTH_STORAGE_KEY = 'papercusp.leftSidebar.width';

// Chromeless-route detection lives in lib/chromeless-routes (shared with __root
// + DevAdminRail) so the list can't drift per-component.

function widthCeiling(viewportWidth: number): number {
  return Math.max(MIN_WIDTH, Math.floor(viewportWidth * 0.5));
}

function clampWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width)) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(widthCeiling(viewportWidth), width));
}

function readStoredWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(wsLocalKey(WIDTH_STORAGE_KEY));
    if (!raw) return DEFAULT_WIDTH;
    return clampWidth(Number(raw), window.innerWidth);
  } catch {
    return DEFAULT_WIDTH;
  }
}

export default function LeftSidebar() {
  const t = useLexicon();
  // ONE useQueryStates group (not two useQueryState hooks): the collapsed
  // rail's icon buttons set open+tab together, and two same-tick writes race
  // through the custom nuqs adapter (each merges over the pre-tick search, so
  // the last writer clobbers the first's key — observed live: lst landed,
  // lsb=false survived). A single setRail() write is atomic.
  const [{ lsb: open, lst: tab }, setRail] = useQueryStates({
    lsb: parseAsBoolean.withDefault(true),
    // Mug is the DEFAULT-OPEN tab (owner's call 2026-06-15) — the steering
    // panel is the first thing the owner reaches in the Colony sidebar.
    lst: parseAsStringLiteral(TAB_IDS).withDefault('queen'),
  });
  const setOpen = (v: boolean) => void setRail({ lsb: v });
  const setTab = (v: TabId) => void setRail({ lst: v });

  // Overwatch is flag-gated (OVERWATCH, default OFF until proven live, D-009):
  // hide its sidebar tab while the role is dark. The nuqs enum still accepts
  // 'overwatch' (deep-link / ui:dispatch), so snap a stale ?lst=overwatch back
  // to Mug when the flag is off (mirrors AdvShell's health/overwatch guard).
  const overwatchOn = useFlag(FLAGS.OVERWATCH);
  // Papercup is flag-gated too (PAPERCUP, default ON since
  // voice-unified-sentinel-pipeline made Papercup the one voice brain) — same
  // hide-tab + stale-?lst snap-back treatment as overwatch for when it IS off.
  const sentinelOn = useFlag(FLAGS.PAPERCUP);
  const visibleTabs = TABS.filter(
    (x) => (x.id !== 'overwatch' || overwatchOn) && (x.id !== 'sentinel' || sentinelOn),
  );
  useEffect(() => {
    if (!overwatchOn && tab === 'overwatch') void setRail({ lst: 'queen' });
    if (!sentinelOn && tab === 'sentinel') void setRail({ lst: 'queen' });
  }, [overwatchOn, sentinelOn, tab, setRail]);

  const pathname = usePathname() ?? '';
  const chromeless = isChromelessPath(pathname);

  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setWidth(readStoredWidth());
    setHydrated(true);
  }, []);

  // Reserve left-side layout space (released on chromeless routes) so the app
  // docks beside the rail rather than under it.
  useEffect(() => {
    if (!hydrated) return;
    if (chromeless) {
      document.body.classList.remove('has-left-sidebar');
      document.documentElement.style.removeProperty('--left-sidebar-w');
      return;
    }
    const offsetWidth = open ? width : COLLAPSED_WIDTH;
    document.documentElement.style.setProperty('--left-sidebar-w', `${offsetWidth}px`);
    document.body.classList.add('has-left-sidebar');
    try {
      window.localStorage.setItem(wsLocalKey(WIDTH_STORAGE_KEY), String(width));
    } catch {
      /* sandbox / quota */
    }
  }, [open, width, hydrated, chromeless]);

  useEffect(() => {
    if (!hydrated) return;
    const onResize = () => setWidth((current) => clampWidth(current, window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [hydrated]);

  // Strip the reservation on unmount (HMR / route teardown safety).
  useEffect(() => {
    return () => {
      try {
        document.body.classList.remove('has-left-sidebar');
        document.documentElement.style.removeProperty('--left-sidebar-w');
      } catch {
        /* DOM may be torn down already */
      }
    };
  }, []);

  // Drag-to-resize from the RIGHT edge: the rail starts at --op-chat-w, so its
  // width is clientX minus that left offset.
  const draggingRef = useRef(false);
  const leftOffset = () => {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--op-chat-w');
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };
  const onHandleDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }, []);
  const onHandleMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    setWidth(clampWidth(e.clientX - leftOffset(), window.innerWidth));
  }, []);
  const onHandleUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  }, []);

  if (chromeless) return null;

  const renderedWidth = open ? (hydrated ? width : DEFAULT_WIDTH) : COLLAPSED_WIDTH;
  const active = visibleTabs.find((x) => x.id === tab) ?? visibleTabs[0];

  return (
    <>
      <style>{LEFT_SIDEBAR_CSS}</style>
      <TooltipPrimitive.Provider delayDuration={250}>
        <aside
          className="pclsb"
          data-testid="left-sidebar"
          data-collapsed={open ? 'false' : 'true'}
          data-tab={active.id}
          style={{ width: renderedWidth }}
          // Was "<Fleet> sidebar" — stale once the Fleet tab moved out
          // (WI-5162); this rail holds the steering/settings tabs now.
          aria-label={`${t('pot')} steering sidebar`}
        >
        {/* Collapsed: the expand control on TOP — the mirror of the collapse
            chevron (re-expands to the LAST pane, no tab switch; owner ask
            2026-07-14) — then the tab icons, each of which expands straight
            INTO its own tab. */}
        <div className="pclsb__expand-rail" aria-hidden={open}>
          <Tooltip label="Expand sidebar" side="right">
            <button
              type="button"
              className="pclsb__rail-btn pclsb__rail-btn--expand"
              data-testid="left-sidebar-rail-expand"
              onClick={() => setOpen(true)}
              aria-label="Expand sidebar"
            >
              <PanelLeftOpen size={17} aria-hidden="true" />
            </button>
          </Tooltip>
          {visibleTabs.map((x) => {
            const Icon = x.icon;
            return (
              <button
                key={x.id}
                type="button"
                className={`pclsb__rail-btn pclsb__rail-btn--${x.id}`}
                data-testid={`left-sidebar-rail-${x.id}`}
                aria-label={`Open ${x.label(t)}`}
                onClick={() => void setRail({ lsb: true, lst: x.id })}
              >
                <Icon size={17} aria-hidden="true" />
              </button>
            );
          })}
        </div>

        <div className="pclsb__expanded-shell" aria-hidden={!open}>
          {open && (
            <>
              {/* WI-4740: the voice-controls bar that lived here is retired —
                  its buttons duplicated the chat sidebar's header controls.
                  Only the rail-specific collapse control remains. */}
              <div className="pclsb__collapse-row">
                <Tooltip label="Collapse sidebar" side="right">
                  <button
                    type="button"
                    className="pclsb__collapse-btn"
                    onClick={() => setOpen(false)}
                    aria-label="Collapse sidebar"
                  >
                    <PanelLeftClose size={15} aria-hidden="true" />
                  </button>
                </Tooltip>
              </div>

              <div className="pclsb__tabs" role="tablist">
                {visibleTabs.map((x) => {
                  const Icon = x.icon;
                  const isActive = x.id === tab;
                  return (
                    // The per-tab tip is an owner ask (2026-06-23) and is PRESERVED
                    // verbatim — only its delivery moved from a native `title=` to the
                    // shared Tooltip primitive (design-simplification P-009), which the
                    // design lint requires. Radix's Provider/Root render no DOM and the
                    // trigger renders the button itself, so `role="tablist" > role="tab"`
                    // is unchanged.
                    <Tooltip key={x.id} label={x.tip(t)} side="right">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        className={`pclsb__tab pclsb__tab--${x.id}${isActive ? ' is-active' : ''}`}
                        data-testid={`left-sidebar-tab-${x.id}`}
                        onClick={() => setTab(x.id)}
                      >
                        <span className="pclsb__tab-icon">
                          <Icon size={14} aria-hidden="true" />
                        </span>
                        <span className="pclsb__tab-label">{x.label(t)}</span>
                      </button>
                    </Tooltip>
                  );
                })}
              </div>

              <div className="pclsb__body">
                <Suspense fallback={<div className="pclsb-panel__empty">Loading…</div>}>
                  {active.render(true)}
                </Suspense>
              </div>
            </>
          )}
        </div>

          <div
            className="pclsb__resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={onHandleUp}
          />
        </aside>
      </TooltipPrimitive.Provider>
    </>
  );
}
