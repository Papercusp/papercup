'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from '@/lib/router-compat/navigation';
import { gsap } from 'gsap';
import { useEffectiveVisualEffects } from '@/lib/visual-effects';

/**
 * Route-transition "jump-gate" warp.
 *
 * History: this used to be driven by `next-transition-router`'s
 * `<TransitionRouter leave enter>` machine. That library serialises
 * navigation through a single in-flight transition and *swallows* any
 * click that arrives while a prior transition is still settling — which,
 * combined with variable route-render latency, made ordinary navigation
 * (e.g. clicking between settings tabs) intermittently do nothing or take
 * 0.2–0.9s. Since we are on TanStack Router now, that dependency was pure
 * overhead: it was only ever wired up to animate the two `data-route-
 * transition-intent="jump-gate"` links in ChromeShell (`/` and `/adv`).
 *
 * Now: ordinary navigation is plain TanStack `<Link>` (instant, no
 * machine). The warp is driven directly here — a capture-phase click
 * listener intercepts only jump-gate anchors, plays the GSAP "leave"
 * overlay, navigates via the TSR-backed `next/navigation` shim, and snaps
 * the overlay away once the route changes (with a backstop timer).
 */

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const TRANSITION_LABEL_PLACEHOLDER = 'SYSTEM';

const JUMP_GATE_INTENT_ATTR = 'data-route-transition-intent';
const JUMP_GATE_INTENT_VALUE = 'jump-gate';
// Backstop: force the overlay away if the route never reports a change
// (e.g. the destination redirected so pathname never equals the click
// target). Keeps the warp from getting stuck "leaving".
const JUMP_GATE_ENTER_BACKSTOP_MS = 1200;

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function normalizeRouteLabel(value?: string) {
  if (!value) return TRANSITION_LABEL_PLACEHOLDER;

  const [path = '/'] = value.split('?');
  return path === '/' ? '/harness' : path.toUpperCase();
}

function resetRouteTransitionVisualState() {
  if (typeof document === 'undefined') return;
  const overlay = document.querySelector<HTMLElement>('.pc-route-transition');
  const page = document.querySelector<HTMLElement>('[data-route-transition-page="true"]');

  gsap.killTweensOf([
    overlay,
    page,
    '.pc-route-transition__blade',
    '.pc-route-transition__ring',
    '.pc-route-transition__reticle',
    '.pc-route-transition__title',
    '.pc-route-transition__subtitle',
    '.pc-route-transition__telemetry',
    '.pc-route-transition__ticks i',
    '.pc-route-transition__status',
    '.pc-route-transition__status strong',
    '.pc-route-transition__checksum',
    '.pc-route-transition__sweep',
  ]);

  if (overlay) gsap.set(overlay, { autoAlpha: 0, pointerEvents: 'none' });
  if (page) gsap.set(page, { clearProps: 'opacity,visibility,scale,filter,transform' });
}

function updateRouteLabels(from?: string, to?: string) {
  const fromNode = document.querySelector<HTMLElement>('[data-route-transition-from]');
  const toNode = document.querySelector<HTMLElement>('[data-route-transition-to]');

  if (fromNode) fromNode.textContent = normalizeRouteLabel(from);
  if (toNode) toNode.textContent = normalizeRouteLabel(to);
}

function RouteTransitionChrome({ stage }: { stage: 'idle' | 'leaving' | 'entering' }) {
  return (
    <div className="pc-route-transition" data-route-transition-stage={stage} aria-hidden="true">
      <div className="pc-route-transition__backdrop" />
      <div className="pc-route-transition__grid" />
      <div className="pc-route-transition__starfield" />
      <div className="pc-route-transition__blade pc-route-transition__blade--top" />
      <div className="pc-route-transition__blade pc-route-transition__blade--bottom" />
      <div className="pc-route-transition__sweep pc-route-transition__sweep--a" />
      <div className="pc-route-transition__sweep pc-route-transition__sweep--b" />
      <div className="pc-route-transition__scan pc-route-transition__scan--vertical" />
      <div className="pc-route-transition__scan pc-route-transition__scan--horizontal" />
      <div className="pc-route-transition__core">
        <div className="pc-route-transition__ring pc-route-transition__ring--outer" />
        <div className="pc-route-transition__ring pc-route-transition__ring--middle" />
        <div className="pc-route-transition__ring pc-route-transition__ring--inner" />
        <div className="pc-route-transition__reticle" />
        <div className="pc-route-transition__title">JUMP GATE</div>
        <div className="pc-route-transition__subtitle">SYNCHRONIZING ORACLE MEMORY</div>
      </div>
      <div className="pc-route-transition__telemetry pc-route-transition__telemetry--left">
        <span>FROM</span>
        <strong data-route-transition-from>{TRANSITION_LABEL_PLACEHOLDER}</strong>
      </div>
      <div className="pc-route-transition__telemetry pc-route-transition__telemetry--right">
        <span>TO</span>
        <strong data-route-transition-to>{TRANSITION_LABEL_PLACEHOLDER}</strong>
      </div>
      <div className="pc-route-transition__status">
        <span>WARP STATUS</span>
        <strong data-route-transition-status>STANDING BY</strong>
      </div>
      <div className="pc-route-transition__ticks">
        {Array.from({ length: 18 }, (_, index) => (
          <i key={index} />
        ))}
      </div>
      <div className="pc-route-transition__checksum">
        <span>ORACLE // VECTOR LOCK // SIGNAL CLEAN</span>
      </div>
    </div>
  );
}

export default function RouteTransitionProvider({ children }: { children: ReactNode }) {
  const visualEffects = useEffectiveVisualEffects();
  const minimalVisualEffects = visualEffects === 'minimal';
  const router = useRouter();
  const pathname = usePathname();
  const [stage, setStage] = useState<'idle' | 'leaving' | 'entering'>('idle');

  // Set while a jump-gate navigation is in flight; holds the origin path so
  // we can detect "the route changed" robustly (even through redirects).
  const pendingRef = useRef<{ fromPath: string } | null>(null);
  const backstopRef = useRef<number | null>(null);

  const playEnter = useCallback(() => {
    if (backstopRef.current !== null) {
      window.clearTimeout(backstopRef.current);
      backstopRef.current = null;
    }
    pendingRef.current = null;

    // Snap enter: no animation. The leave overlay was visible while the new
    // route mounted; the moment the route commits, snap everything back to
    // base state instantly. Animating the reveal here queues GSAP tweens
    // behind the main-thread render work and stretches into a multi-second
    // laggy fade — the leave overlay already did the "something is happening"
    // job, so revealing the page should be instant.
    const overlay = document.querySelector<HTMLElement>('.pc-route-transition');
    const page = document.querySelector<HTMLElement>('[data-route-transition-page="true"]');
    gsap.killTweensOf([overlay, page]);
    gsap.killTweensOf('.pc-route-transition *');
    if (page) gsap.set(page, { autoAlpha: 1, clearProps: 'scale,filter,transform' });
    gsap.set('.pc-route-transition__blade--top', { yPercent: -100 });
    gsap.set('.pc-route-transition__blade--bottom', { yPercent: 100 });
    if (overlay) gsap.set(overlay, { autoAlpha: 0, pointerEvents: 'none' });
    const statusNode = document.querySelector<HTMLElement>('[data-route-transition-status]');
    if (statusNode) statusNode.textContent = 'STANDING BY';
    setStage('idle');
  }, []);

  // When the pending jump-gate navigation actually changes the route, snap
  // the overlay away on the next frame.
  useEffect(() => {
    if (pendingRef.current && pathname !== pendingRef.current.fromPath) {
      requestAnimationFrame(() => playEnter());
    }
  }, [pathname, playEnter]);

  const runJumpGate = useCallback(
    (to: string, fromPath: string, toPath: string) => {
      const go = () => {
        router.push(to);
      };

      if (minimalVisualEffects || prefersReducedMotion()) {
        resetRouteTransitionVisualState();
        go();
        return;
      }

      const overlay = document.querySelector<HTMLElement>('.pc-route-transition');
      const page = document.querySelector<HTMLElement>('[data-route-transition-page="true"]');
      if (!overlay) {
        resetRouteTransitionVisualState();
        go();
        return;
      }

      updateRouteLabels(fromPath, toPath);
      setStage('leaving');
      gsap.killTweensOf([overlay, page]);
      gsap.killTweensOf('.pc-route-transition *');

      // Idempotent commit: navigation fires exactly once, from whichever
      // comes first — the leave timeline's onComplete (~140ms) or the 240ms
      // rAF-starvation fallback. The overlay is fully up before the route
      // swaps; the snap-enter (above) reveals the new page instantly.
      let committed = false;
      const commit = () => {
        if (committed) return;
        committed = true;
        pendingRef.current = { fromPath };
        go();
        backstopRef.current = window.setTimeout(playEnter, JUMP_GATE_ENTER_BACKSTOP_MS);
      };

      const timeline = gsap.timeline({
        defaults: { ease: 'power2.out' },
        onComplete: commit,
      });

      timeline
        .set(overlay, { autoAlpha: 1, pointerEvents: 'auto' })
        .set(
          [
            '.pc-route-transition__ring',
            '.pc-route-transition__reticle',
            '.pc-route-transition__title',
            '.pc-route-transition__subtitle',
            '.pc-route-transition__telemetry',
            '.pc-route-transition__ticks i',
            '.pc-route-transition__status',
            '.pc-route-transition__checksum',
          ],
          { autoAlpha: 1, scale: 1, x: 0, y: 0, rotate: 0, scaleX: 1, scaleY: 1, clearProps: 'filter' },
        )
        .set('[data-route-transition-status]', { textContent: 'VECTOR LOCKED' })
        .fromTo('.pc-route-transition__blade--top', { yPercent: -100 }, { yPercent: 0, duration: 0.14 }, 0)
        .fromTo('.pc-route-transition__blade--bottom', { yPercent: 100 }, { yPercent: 0, duration: 0.14 }, 0)
        .to(page, { autoAlpha: 0.55, duration: 0.12 }, 0);

      // Backstop in case rAF is starved and the timeline's onComplete never
      // fires; `commit` is idempotent so this never double-navigates.
      window.setTimeout(commit, 240);
    },
    [minimalVisualEffects, router, playEnter],
  );

  useEffect(() => {
    function handleClickCapture(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target;
      if (!(target instanceof Element)) return;

      const anchor = target.closest<HTMLAnchorElement>(
        `a[${JUMP_GATE_INTENT_ATTR}="${JUMP_GATE_INTENT_VALUE}"]`,
      );
      if (!anchor) return;
      if (anchor.hasAttribute('download') || anchor.target === '_blank') return;

      const targetUrl = new URL(anchor.href);
      const currentUrl = new URL(window.location.href);
      if (targetUrl.origin !== currentUrl.origin) return;
      if (targetUrl.href === currentUrl.href) return;

      // Take over navigation so the warp plays; TanStack's <Link> sees
      // defaultPrevented and skips its own navigation.
      event.preventDefault();
      const to = `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;
      runJumpGate(to, currentUrl.pathname, targetUrl.pathname);
    }

    document.addEventListener('click', handleClickCapture, { capture: true });
    return () => document.removeEventListener('click', handleClickCapture, { capture: true });
  }, [runJumpGate]);

  useEffect(
    () => () => {
      if (backstopRef.current !== null) window.clearTimeout(backstopRef.current);
    },
    [],
  );

  return (
    <>
      <RouteTransitionChrome stage={stage} />
      {children}
    </>
  );
}
