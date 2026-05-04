'use client';

import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { useReducedMotion } from 'motion/react';
import { OperatorButton } from './OperatorPanel';
import { VoiceButton } from './voice/VoiceButton';
import { AriaLiveRegions } from './voice/AriaLiveRegions';
import { VoiceLeaderBootstrap } from './voice/VoiceLeaderBootstrap';
import { HostCheckBanner } from './HostCheckBanner';
import WorkspaceSwitcher from './WorkspaceSwitcher';
import UpdateChip from './UpdateChip';
import TutorialButton from './TutorialButton';

// Heavy dock components — they run polling, subscriptions, and large
// useEffects on mount. Not needed for first paint of any page; defer to
// idle so the page becomes interactive faster.
const OperatorPanel = lazy(() => import('./OperatorPanel').then(m => ({ default: m.OperatorPanel })));
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
];

gsap.registerPlugin(useGSAP);

export default function ChromeShell() {
  const headerRef = useRef<HTMLElement | null>(null);
  const pathname = usePathname() ?? '';
  const reducedMotion = useReducedMotion() ?? false;
  const chromeless = CHROMELESS_PATH_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (chromeless) return null;
  // When the user is already on a harness page, Mission Control is a
  // no-op. Render a non-link span with `is-current` styling so it's
  // visibly distinct from the active CTA elsewhere in the app.
  const onHarness = pathname === '/harness' || pathname.startsWith('/harness/');
  const navLinkProps = (href: string) => {
    const active = pathname === href || pathname.startsWith(`${href}/`);
    return active
      ? { className: 'pc-header-nav-link active', 'aria-current': 'page' as const }
      : { className: 'pc-header-nav-link' };
  };

  useGSAP(
    () => {
      if (!headerRef.current || reducedMotion) return;
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

      const loops = [
        gsap.fromTo(
          q('.pc-header-hud-line--primary'),
          { xPercent: -16 },
          { xPercent: 16, duration: 3.2, ease: 'sine.inOut', repeat: -1, yoyo: true },
        ),
        gsap.fromTo(
          q('.pc-header-hud-line--secondary'),
          { xPercent: 12 },
          { xPercent: -12, duration: 4.1, ease: 'sine.inOut', repeat: -1, yoyo: true },
        ),
        gsap.to(q('.pc-header-quote'), { textShadow: '0 0 18px rgba(87, 215, 255, 0.28)', duration: 1.8, ease: 'sine.inOut', repeat: -1, yoyo: true }),
      ];

      return () => {
        intro.kill();
        loops.forEach((loop) => loop.kill());
      };
    },
    { scope: headerRef, dependencies: [pathname, reducedMotion] },
  );

  return (
    <>
      <header ref={headerRef} className="pc-header pc-header--maximal-hud">
        <span className="pc-header-hud-line pc-header-hud-line--primary" aria-hidden="true" />
        <span className="pc-header-hud-line pc-header-hud-line--secondary" aria-hidden="true" />
        {/*
          Three-region grid: left = brand + quote, centre = primary CTAs
          (Mission Control, Operator, Voice), right = nav. CSS Grid in
          `1fr auto 1fr` keeps the centre cluster geometrically centred in
          the viewport regardless of how wide the brand/quote on the left
          and the nav on the right grow.
        */}
        <div className="pc-header-left">
          <a href="/" className="brand pc-header-brand-wrap" aria-label="papercusp" style={{ display: 'flex', alignItems: 'center' }}>
            <img src="/wordmark.svg" alt="papercusp" height={22} style={{ display: 'block' }} />
          </a>
          <span className="pc-header-quote pc-header-quote--hud">Nothing is so painful to the human mind as a great and sudden change</span>
        </div>
        <div className="pc-header-center">
          {onHarness ? (
            <span
              className="pc-header-cta pc-header-cta--mission is-current"
              aria-label="Mission Control (current page)"
              aria-current="page"
            >
              <span className="pc-header-cta-orb" aria-hidden="true" />
              <span className="pc-header-cta-label">Mission Control</span>
            </span>
          ) : (
            <a href="/harness" className="pc-header-cta pc-header-cta--mission" aria-label="Mission Control">
              <span className="pc-header-cta-orb" aria-hidden="true" />
              <span className="pc-header-cta-label">Mission Control</span>
            </a>
          )}
          <OperatorButton />
          <VoiceButton />
        </div>
        <nav className="pc-header-right" aria-label="Primary navigation">
          <a href="/marketplace/" {...navLinkProps('/marketplace')}>Marketplace</a>
          <a href="/installed/harnesses" {...navLinkProps('/installed/harnesses')}>Harnesses</a>
          <a href="/installed/plugins" {...navLinkProps('/installed/plugins')}>Plugins</a>
          <a href="/installed/snapshots" {...navLinkProps('/installed/snapshots')}>Snapshots</a>
          <a href="/support" {...navLinkProps('/support')}>Support</a>
          <a href="/settings/operator" {...navLinkProps('/settings/operator')}>Settings</a>
          <a href="https://github.com/papercupai/papercusp" target="_blank" rel="noopener noreferrer" className="pc-header-nav-link">GitHub</a>
          <TutorialButton />
          <UpdateChip />
          <WorkspaceSwitcher />
        </nav>
      </header>
      <HostCheckBanner />
      <VoiceLeaderBootstrap />
      <AriaLiveRegions />
      {/* OperatorPanel mounts on every page (including /settings/*) so
          clicking the chrome-bar Operator button always opens it. The
          panel returns null when its open state is false, so mounting
          it everywhere is essentially free.

          The other heavy docks (OracleDock, ChatwootWidget, voice infra)
          ARE still skipped on /settings/* since the user isn't operating
          on a settings page — that perf win still applies. */}
      <DeferredOperatorPanel />
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
  useEffect(() => {
    const idle = (window as any).requestIdleCallback as undefined | ((cb: () => void) => number);
    let id: number | ReturnType<typeof setTimeout>;
    if (idle) {
      id = idle(() => setReady(true));
    } else {
      id = setTimeout(() => setReady(true), 200);
    }
    return () => {
      const cancel = (window as any).cancelIdleCallback as undefined | ((id: number) => void);
      if (cancel && typeof id === 'number') cancel(id);
      else clearTimeout(id as ReturnType<typeof setTimeout>);
    };
  }, []);
  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <ChatwootWidget />
      <OracleDock />
      <OperatorBackgroundScanner />
      <VoiceAppBridge />
      <OperatorDelegationListener />
      <OperatorVoiceAnnouncer />
      <RegistryShortcuts />
    </Suspense>
  );
}

// OperatorPanel is split out of DeferredDocks so it can mount on every
// page including /settings/*. Same idle-deferral pattern, just a smaller
// payload. The panel itself returns null while closed, so the only cost
// of mounting it everywhere is its useEffect/subscribe wiring, which is
// negligible compared to the bigger docks above.
function DeferredOperatorPanel() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const idle = (window as any).requestIdleCallback as undefined | ((cb: () => void) => number);
    let id: number | ReturnType<typeof setTimeout>;
    if (idle) {
      id = idle(() => setReady(true));
    } else {
      id = setTimeout(() => setReady(true), 200);
    }
    return () => {
      const cancel = (window as any).cancelIdleCallback as undefined | ((id: number) => void);
      if (cancel && typeof id === 'number') cancel(id);
      else clearTimeout(id as ReturnType<typeof setTimeout>);
    };
  }, []);
  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <OperatorPanel />
    </Suspense>
  );
}
