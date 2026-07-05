/**
 * Left sidebar (left-sidebar-tauri-2026-06-07) — the desktop twin of the pui
 * dock's retired main pane: **Swarm / Voice / Hives** as tabs in a docked,
 * collapsible, drag-resizable LEFT rail. The zellij dock is now consoles-only
 * (operator chat ⇄ brain ⇄ live bees); the tab-style surfaces live HERE.
 *
 * Architecture mirrors the proven DevAdminRail (dev-admin-sidebar-2026-06-05):
 *   - DOCKED, not floating — reserves layout space (body.has-left-sidebar
 *     padding-left + --left-sidebar-w) so the app shifts right; sits AFTER the
 *     op-chat sidebar (offset by --op-chat-w).
 *   - Collapses to a thin icon rail (the three tab icons — clicking one
 *     expands straight into that tab), never disappears.
 *   - Drag-resizable from its RIGHT edge, width persisted per-workspace.
 *   - State in the URL via nuqs (`?lsb=…&lst=swarm`) so it is deep-linkable
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
import { useQueryStates, parseAsBoolean, parseAsStringLiteral } from 'nuqs';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { usePathname } from '@/lib/router-compat/navigation';
import { useLexicon } from '@/lib/useLexicon';
import type { BoundLexicon } from '@papercusp/lexicon';
import { Users, AudioLines, Network, Coffee, Thermometer, CupSoda, KeyRound, PanelLeftOpen } from 'lucide-react';
import { useFlag } from '@papercusp/flags/client';
import { FLAGS } from '@papercusp/flags';
import { LEFT_SIDEBAR_CSS } from './left-sidebar.styles';
// Always-on operator-voice controls, pinned to the TOP of the rail (above the
// tabs) so they show on every tab, not just Sentinel (owner request 2026-06-22).
import SentinelVoiceBar from '../voice-bar/SentinelVoiceBar';

const SwarmTab = lazy(() => import('./SwarmTab'));
const VoiceTab = lazy(() => import('./VoiceTab'));
const HivesTab = lazy(() => import('./HivesTab'));
// 🔑 Accounts — the owner's session-now account override (which Max accounts the fleet
// may use right now), beside Queen as a sibling owner-steering lever (accounts-pool-tab
// P-005; promoted to the LEFTMOST sidebar tab by owner request 2026-06-17).
const AccountsTab = lazy(() => import('./AccountsTab'));
// 👑 Queen steering — the owner's focus/pause controls for the autonomous Queen.
// Moved here from the /adv top tab strip as an owner-steering tab (owner
// review 2026-06-15; queen-steering-panel-2026-06-15 B-04).
const QueenTab = lazy(() => import('./QueenTab'));
// 👁 Overwatch — the autonomous supervisor's actionable panel (control + the
// anomaly→action list). Moved here from the /adv strip next to Queen (owner ask
// 2026-06-15; system-health-tab P-008) — its duplicated health grid dropped (the
// Health tab owns the panels). Flag-gated (OVERWATCH); hidden when the role is dark.
const OverwatchTab = lazy(() => import('./OverwatchTab'));
// 📣 Sentinel — the always-on, voice-first human-facing companion's
// quick live-override settings (audience mode, voice, proactive nudges, DND). The
// sidebar is the quick live-override surface; full workspace settings hold the
// defaults. Flag-gated (SENTINEL); hidden until the role is live.
const SentinelTab = lazy(() => import('./SentinelTab'));

// `tip` is the hover tooltip (owner ask 2026-06-23) — a one-line "what is this
// tab for", surfaced via the button's native `title` on hover.
//
// label/tip are BUILDERS of the active lexicon `t` (restore-pot-lexicon P-005):
// brand nouns resolve through the flag-gated pack — classic/public shows Pot,
// Brain, Operator, Fleet; the-hive skin shows Hive, Queen, Sentinel, Colony.
// Overwatch has no TermKey (D-002) so it stays literal in both packs.
const TABS = [
  { id: 'accounts', label: (_t: BoundLexicon) => 'Accounts', icon: KeyRound, tip: (_t: BoundLexicon) => 'Provider accounts & API keys your agents sign in with', render: (a: boolean) => <AccountsTab active={a} /> },
  // Cup-cast nav icons (restore-pot-lexicon D-006): Mug→Coffee ☕ · Kettle→Thermometer
  // (no lucide kettle exists; the thermometer ties the kettle's heat to overwatch's
  // system-health monitoring) · Papercup→CupSoda 🥤. classic labels flow from the lexicon.
  { id: 'queen', label: (t: BoundLexicon) => t('brain'), icon: Coffee, tip: (t: BoundLexicon) => `The ${t('brain')} — plans work and places it across the ${t('fleet', { lower: true })}`, render: (a: boolean) => <QueenTab active={a} /> },
  { id: 'overwatch', label: (t: BoundLexicon) => t('overwatch'), icon: Thermometer, tip: (t: BoundLexicon) => `${t('overwatch')} — supervises ${t('fleet', { lower: true })} & system health, nudges when things drift`, render: (a: boolean) => <OverwatchTab active={a} /> },
  { id: 'sentinel', label: (t: BoundLexicon) => t('operator'), icon: CupSoda, tip: (t: BoundLexicon) => `${t('operator')} — your voice/text front-door agent; talks, suggests, and hands work to the ${t('brain')}`, render: (a: boolean) => <SentinelTab active={a} /> },
  { id: 'swarm', label: (t: BoundLexicon) => t('fleet'), icon: Users, tip: (t: BoundLexicon) => `The ${t('fleet', { lower: true })} — live roster of SU agents & ${t('contributor', { plural: true, lower: true })} and what each is doing`, render: (a: boolean) => <SwarmTab active={a} /> },
  { id: 'voice', label: (_t: BoundLexicon) => 'Peers', icon: AudioLines, tip: (_t: BoundLexicon) => 'Peers — live voice/video channels with other people', render: (a: boolean) => <VoiceTab active={a} /> },
  { id: 'hives', label: (t: BoundLexicon) => t('pot', { plural: true }), icon: Network, tip: (t: BoundLexicon) => `${t('pot', { plural: true })} — the cross-device P2P network of connected ${t('node', { plural: true, lower: true })}`, render: (a: boolean) => <HivesTab active={a} /> },
] as const;

type TabId = (typeof TABS)[number]['id'];
const TAB_IDS = TABS.map((t) => t.id) as unknown as TabId[];

// Width model — mirrors DevAdminRail's.
const COLLAPSED_WIDTH = 48;
const MIN_WIDTH = 300;
const DEFAULT_WIDTH = 384;
const WIDTH_STORAGE_KEY = 'papercusp.leftSidebar.width';

// Chromeless (iframe-target) routes render no global chrome — absent there.
const CHROMELESS_PREFIXES = ['/pi', '/project-docs', '/el-min'];

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
    // Queen is the DEFAULT-OPEN tab (owner's call 2026-06-15) — the steering
    // panel is the first thing the owner reaches in the Colony sidebar.
    lst: parseAsStringLiteral(TAB_IDS).withDefault('queen'),
  });
  const setOpen = (v: boolean) => void setRail({ lsb: v });
  const setTab = (v: TabId) => void setRail({ lst: v });

  // Overwatch is flag-gated (OVERWATCH, default OFF until proven live, D-009):
  // hide its sidebar tab while the role is dark. The nuqs enum still accepts
  // 'overwatch' (deep-link / ui:dispatch), so snap a stale ?lst=overwatch back
  // to Queen when the flag is off (mirrors AdvShell's health/overwatch guard).
  const overwatchOn = useFlag(FLAGS.OVERWATCH);
  // Sentinel is flag-gated too (SENTINEL, default OFF until the role
  // is live) — same hide-tab + stale-?lst snap-back treatment as overwatch.
  const sentinelOn = useFlag(FLAGS.SENTINEL);
  const visibleTabs = TABS.filter(
    (x) => (x.id !== 'overwatch' || overwatchOn) && (x.id !== 'sentinel' || sentinelOn),
  );
  useEffect(() => {
    if (!overwatchOn && tab === 'overwatch') void setRail({ lst: 'queen' });
    if (!sentinelOn && tab === 'sentinel') void setRail({ lst: 'queen' });
  }, [overwatchOn, sentinelOn, tab, setRail]);

  const pathname = usePathname() ?? '';
  const chromeless = CHROMELESS_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

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
          aria-label={`${t('fleet')} sidebar`}
        >
        {/* Collapsed: the three tab icons — click one to expand into it. */}
        <div className="pclsb__expand-rail" aria-hidden={open}>
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
          <button
            type="button"
            className="pclsb__rail-btn pclsb__rail-btn--expand"
            onClick={() => setOpen(true)}
            aria-label="Expand sidebar"
          >
            <PanelLeftOpen size={17} aria-hidden="true" />
          </button>
        </div>

        <div className="pclsb__expanded-shell" aria-hidden={!open}>
          {open && (
            <>
              {/* Voice controls pinned to the top of the rail — always shown, on
                  every tab (not just Sentinel). The collapse control lives in this
                  bar's header now; the old empty header row was removed (owner
                  2026-06-22) and the active-tab title heading before it (the
                  highlighted tab already shows which view you're on). */}
              <SentinelVoiceBar onCollapse={() => setOpen(false)} />

              <div className="pclsb__tabs" role="tablist">
                {visibleTabs.map((x) => {
                  const Icon = x.icon;
                  const isActive = x.id === tab;
                  return (
                    <button
                      key={x.id}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      className={`pclsb__tab pclsb__tab--${x.id}${isActive ? ' is-active' : ''}`}
                      data-testid={`left-sidebar-tab-${x.id}`}
                      title={x.tip(t)}
                      onClick={() => setTab(x.id)}
                    >
                      <span className="pclsb__tab-icon">
                        <Icon size={14} aria-hidden="true" />
                      </span>
                      <span className="pclsb__tab-label">{x.label(t)}</span>
                    </button>
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
