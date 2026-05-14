'use client';

import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { useReducedMotion } from 'motion/react';
import { useFancyEffectsEnabled } from '@/lib/visual-effects';
import { OperatorButton, OperatorAutoScanToggle } from './OperatorChromeControls';
import { ConsoleLauncherButton } from './ConsoleLauncherButton';
import { OpsTargetMark } from './ChromeNavMarks';
import { AriaLiveRegions } from './voice/AriaLiveRegions';
import { VoiceLeaderBootstrap } from './voice/VoiceLeaderBootstrap';
import { HostCheckBanner } from './HostCheckBanner';
import WorkspaceSwitcher from './WorkspaceSwitcher';
import UserPicker from './UserPicker';
import AutoLoginWelcomeToast from './AutoLoginWelcomeToast';
import UpdateChip from './UpdateChip';
import { NotificationCenter } from './NotificationCenter';
import { RecentActionsCenter } from './RecentActionsCenter';
import TutorialButton from './TutorialButton';
import { FLAGS } from '@papercusp/flags';
import { useFlag } from '@/lib/flag-hooks';

// Heavy dock components — they run polling, subscriptions, and large
// useEffects on mount. Not needed for first paint of any page; defer to
// idle so the page becomes interactive faster.
const OperatorPanel = lazy(() => import('./OperatorPanel').then(m => ({ default: m.OperatorPanel })));
const OperatorChatSidebar = lazy(() => import('./OperatorChatSidebar').then(m => ({ default: m.OperatorChatSidebar })));
const OracleDock = lazy(() => import('./OracleDock').then(m => ({ default: m.OracleDock })));
const OperatorBackgroundScanner = lazy(() => import('./OperatorBackgroundScanner').then(m => ({ default: m.OperatorBackgroundScanner })));
const VoiceAppBridge = lazy(() => import('./voice/VoiceAppBridge').then(m => ({ default: m.VoiceAppBridge })));
const OperatorDelegationListener = lazy(() => import('./OperatorDelegationListener'));
const RegistryShortcuts = lazy(() => import('../../lib/commands/shims/shortcut-shim').then(m => ({ default: m.RegistryShortcuts })));
const OperatorVoiceAnnouncer = lazy(() => import('./voice/OperatorVoiceAnnouncer').then(m => ({ default: m.OperatorVoiceAnnouncer })));
const ChatwootWidget = lazy(() => import('./ChatwootWidget').then(m => ({ default: m.ChatwootWidget })));

/**
 * Renders the operator's global chrome (header, Oracle dock, hidden
 * Chatwoot SDK bridge, host-check banner) ONLY for routes that aren't
 * designed to be embedded in iframes.
 *
 * Why this exists: operator routes like `/pi` and `/project-docs` are
 * mounted inside iframes by harness plugin tabs (pi-coding, fumadocs).
 * The chrome belongs in the parent harness page, not inside the iframe.
 * Previously the chrome rendered for every route and was hidden via a
 * useEffect-applied body class — that caused a flash of header/dock
 * before the JS ran, and for `/project-docs` the body class was never
 * applied so the chrome leaked permanently.
 *
 * `usePathname()` returns the pathname during SSR for client components,
 * so this skip is server-rendered: the chrome never appears in the HTML
 * for iframe routes, eliminating the flash entirely.
 *
 * Add new iframe-target routes to {@link CHROMELESS_PATH_PREFIXES}.
 */
const CHROMELESS_PATH_PREFIXES: readonly string[] = [
  '/pi',
  '/project-docs',
  '/el-min',
];

gsap.registerPlugin(useGSAP);
// Several useGSAP blocks (HarnessDashboard HUD, OperatorPanel reactor,
// OracleDock dots) target selectors that exist only when their parent
// state is in a particular branch — e.g. `.h-running-lane.live` only
// renders when `status?.alive`. When the dependency list re-runs the
// hook in the off-state, those `q('.foo')` calls return [] and GSAP
// logs "GSAP target not found." We use that as a no-op signal, not a
// bug, so silence the warning. Real selector typos would be caught by
// the visible animation simply not playing.
gsap.config({ nullTargetWarn: false });

export default function ChromeShell() {
  const headerRef = useRef<HTMLElement | null>(null);
  const pathname = usePathname() ?? '';
  const reducedMotion = useReducedMotion() ?? false;
  const visualEffectsEnabled = useFancyEffectsEnabled();
  const fancyEffectsEnabled = visualEffectsEnabled && !reducedMotion;
  const chromeless = CHROMELESS_PATH_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (chromeless) return null;
  // When the user is already on a harness page, Ops is a no-op. Render a
  // non-link span with `is-current` styling so it's visibly distinct from
  // the active CTA elsewhere in the app.
  const onHarness = pathname === '/harness' || pathname.startsWith('/harness/');
  const snapshotsFlag = useFlag(FLAGS.SNAPSHOTS);
  const marketplaceFlag = useFlag(FLAGS.MARKETPLACE);
  const oracleFlag = useFlag(FLAGS.ORACLE);
  const mainNavJumpGateProps = { 'data-route-transition-intent': 'jump-gate' as const };
  const navLinkProps = (href: string) => {
    const active = pathname === href || pathname.startsWith(`${href}/`);
    return active
      ? { ...mainNavJumpGateProps, className: 'pc-header-nav-link active', 'aria-current': 'page' as const }
      : { ...mainNavJumpGateProps, className: 'pc-header-nav-link' };
  };

  useGSAP(
    () => {
      if (!headerRef.current || !fancyEffectsEnabled) return;
      const q = gsap.utils.selector(headerRef.current);
      const intro = gsap.timeline({ defaults: { ease: 'power3.out' } });

      intro
        .fromTo(
          q('.pc-header-left > *, .pc-header-center > *, .pc-header-right > *'),
          { autoAlpha: 0, y: -14 },
          { autoAlpha: 1, y: 0, duration: 0.42, stagger: 0.035 },
          0,
        )
        .fromTo(
          q('.pc-header-hud-line'),
          { autoAlpha: 0.18, scaleX: 0 },
          { autoAlpha: 1, scaleX: 1, duration: 0.64, stagger: 0.08 },
          0.06,
        );

      // Idle/ambient header HUD line sweeps are now driven by CSS @keyframes
      // (pc-header-hud-line-primary-sweep / pc-header-hud-line-secondary-sweep
      // in ChromeShell.css). Removing the GSAP rAF loops takes ~282
      // DOM-attribute mutations per 5s off the main thread on every page
      // ChromeShell renders.

      return () => {
        intro.kill();
      };
    },
    { scope: headerRef, dependencies: [pathname, fancyEffectsEnabled] },
  );

  return (
    <>
      <header ref={headerRef} className="pc-header pc-header--maximal-hud">
        <span className="pc-header-hud-line pc-header-hud-line--primary" aria-hidden="true" />
        <span className="pc-header-hud-line pc-header-hud-line--secondary" aria-hidden="true" />
        {/*
          Three-region grid: left = brand + quote, centre = primary CTAs
          (Ops, Deck, auto-scan, console), right = nav. CSS Grid
          in `1fr auto 1fr` keeps the centre cluster geometrically centred
          in the viewport regardless of how wide the brand/quote on the left
          and the nav on the right grow.
        */}
        <div className="pc-header-left">
          <a href="/" className="brand pc-header-brand-wrap" aria-label="papercusp" style={{ display: 'flex', alignItems: 'center' }} {...mainNavJumpGateProps}>
            <img src="/wordmark.svg" alt="papercusp" height={22} style={{ display: 'block' }} />
          </a>
          <span className="pc-header-quote pc-header-quote--hud" data-quote="Nothing Is So Painful To The Human Mind As A Great And Sudden Change">Nothing Is So Painful To The Human Mind As A Great And Sudden Change</span>
        </div>
        <div className="pc-header-center">
          {onHarness ? (
            <span
              className="pc-header-cta pc-header-cta--mission is-current"
              aria-label="Ops (current page)"
              aria-current="page"
            >
              <span className="pc-header-cta-orb" aria-hidden="true">
                <OpsTargetMark className="pc-header-cta-logo pc-header-cta-logo--ops" />
              </span>
              <span className="pc-header-cta-label">OPS</span>
            </span>
          ) : (
            <a href="/harness" className="pc-header-cta pc-header-cta--mission" aria-label="Ops" {...mainNavJumpGateProps}>
              <span className="pc-header-cta-orb" aria-hidden="true">
                <OpsTargetMark className="pc-header-cta-logo pc-header-cta-logo--ops" />
              </span>
              <span className="pc-header-cta-label">OPS</span>
            </a>
          )}
          <OperatorButton />
          <OperatorAutoScanToggle />
          <ConsoleLauncherButton />
        </div>
        <nav className="pc-header-right" aria-label="Primary navigation">
          {marketplaceFlag ? (
            <a href="/marketplace/" {...navLinkProps('/marketplace')}>Marketplace</a>
          ) : null}
          <a href="/installed/harnesses" {...navLinkProps('/installed/harnesses')}>Harnesses</a>
          <a href="/installed/plugins" {...navLinkProps('/installed/plugins')}>Plugins</a>
          {snapshotsFlag ? (
            <a href="/installed/snapshots" {...navLinkProps('/installed/snapshots')}>Snapshots</a>
          ) : null}
          <a href="/support" {...navLinkProps('/support')}>Support</a>
          <a href="/settings/operator" {...navLinkProps('/settings/operator')}>Settings</a>
          {/* Admin link intentionally NOT rendered — reachable only by URL /admin */}
          {(() => {
            const p = navLinkProps('/dev');
            return <a href="/dev" {...p} className={`${p.className} is-dev`}>DEV</a>;
          })()}
          <a href="https://github.com/papercupai" target="_blank" rel="noopener noreferrer" className="pc-header-nav-link">GitHub</a>
          {oracleFlag ? <TutorialButton /> : null}
          <UpdateChip />
          <NotificationCenter />
          <RecentActionsCenter />
          <WorkspaceSwitcher />
          <UserPicker />
        </nav>
      </header>
      <HostCheckBanner />
      <VoiceLeaderBootstrap />
      <AriaLiveRegions />
      <AutoLoginWelcomeToast />
      {/* OperatorPanel mounts on every page (including /settings/*) so
          clicking the chrome-bar Deck button always opens it. The
          panel returns null when its open state is false, so mounting
          it everywhere is essentially free.

          The other heavy docks (OracleDock, ChatwootWidget, voice infra)
          ARE still skipped on /settings/* since the user isn't operating
          on a settings page — that perf win still applies. */}
      <DeferredOperatorPanel />
      {/* Operator chat sidebar — fixed left, full-height, on every
          non-chromeless page. The sidebar shifts the rest of the app
          right via body.has-op-chat padding-left (set inside the
          component). Mounted under <Suspense> with no fallback so the
          page paints before the lazy chunk lands; the layout-shift on
          mount is acceptable for now. Iframe-target routes (CHROMELESS
          prefixes) skip ChromeShell entirely so the sidebar is absent
          there too — desired, those routes are embedded inside other
          pages that already host the sidebar. */}
      <Suspense fallback={null}>
        <OperatorChatSidebar />
      </Suspense>
      {!pathname.startsWith('/settings') && <DeferredDocks />}
    </>
  );
}

// Mounts the heavy dock components AFTER the page has had a chance to
// paint and become interactive. Uses requestIdleCallback (or a 200ms
// fallback) so first-meaningful-paint isn't blocked by their useEffect
// chains, polling, and event-listener registration.
function DeferredDocks() {
  const [ready, setReady] = useState(false);
  const oracleEnabled = useFlag(FLAGS.ORACLE);
  useEffect(() => {
    const idle = (window as any).requestIdleCallback as undefined | ((cb: () => void, opts?: { timeout: number }) => number);
    let idleId: number | undefined;
    // Race requestIdleCallback against a 1500ms backstop. Without the
    // backstop, a busy page (HMR storms in dev, large-app cold paint)
    // can starve idle entirely — the dock never mounts. The backstop
    // also covers Safari/older browsers where requestIdleCallback is
    // missing. The first to fire wins; the loser is canceled.
    const backstop = setTimeout(() => {
      setReady(true);
      if (idleId !== undefined) {
        const cancel = (window as any).cancelIdleCallback as undefined | ((id: number) => void);
        cancel?.(idleId);
      }
    }, 1500);
    if (idle) {
      idleId = idle(() => {
        setReady(true);
        clearTimeout(backstop);
      }, { timeout: 1500 });
    }
    return () => {
      clearTimeout(backstop);
      if (idleId !== undefined) {
        const cancel = (window as any).cancelIdleCallback as undefined | ((id: number) => void);
        cancel?.(idleId);
      }
    };
  }, []);
  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <ChatwootWidget />
      {oracleEnabled ? <OracleDock /> : null}
      <OperatorBackgroundScanner />
      <VoiceAppBridge />
      <OperatorDelegationListener />
      <OperatorVoiceAnnouncer />
      <RegistryShortcuts />
    </Suspense>
  );
}

// OperatorPanel is split out of DeferredDocks so it can mount on every
// page including /settings/*. It renders null while closed, but keeping
// the lazy component mounted lets it subscribe to the shared Deck state
// before the chrome button is pressed.
function DeferredOperatorPanel() {
  return (
    <Suspense fallback={null}>
      <OperatorPanel />
    </Suspense>
  );
}
