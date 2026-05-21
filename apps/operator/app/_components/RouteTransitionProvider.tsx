'use client';

import { useCallback, useEffect, type ReactNode } from 'react';
import { TransitionRouter, useTransitionState } from 'next-transition-router';
import { gsap } from 'gsap';
import { useEffectiveVisualEffects } from '@/lib/visual-effects';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const TRANSITION_LABEL_PLACEHOLDER = 'SYSTEM';

const JUMP_GATE_INTENT_ATTR = 'data-route-transition-intent';
const JUMP_GATE_INTENT_VALUE = 'jump-gate';
const JUMP_GATE_INTENT_TTL_MS = 2_000;

let pendingJumpGateHref: string | null = null;
let pendingJumpGateAt = 0;
let activeTransitionUsesJumpGate = false;

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function normalizeRouteLabel(value?: string) {
  if (!value) return TRANSITION_LABEL_PLACEHOLDER;

  const [path = '/'] = value.split('?');
  return path === '/' ? '/harness' : path.toUpperCase();
}

function normalizeHrefForMatch(value?: string | null) {
  if (!value || typeof window === 'undefined') return null;
  try {
    const url = new URL(value, window.location.href);
    const canonicalPath = url.pathname === '/'
      ? '/harness'
      : url.pathname.replace(/\/+$/, '') || '/';
    return canonicalPath;
  } catch {
    return value;
  }
}

function markPendingJumpGateNavigation(href: string) {
  pendingJumpGateHref = normalizeHrefForMatch(href);
  pendingJumpGateAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function consumePendingJumpGateNavigation(to?: string) {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const pendingHref = pendingJumpGateHref;
  const isFresh = pendingHref !== null && now - pendingJumpGateAt <= JUMP_GATE_INTENT_TTL_MS;
  const normalizedTo = normalizeHrefForMatch(to);

  pendingJumpGateHref = null;
  pendingJumpGateAt = 0;

  if (!isFresh) return false;
  if (!normalizedTo) return true;
  return pendingHref === normalizedTo;
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

function RouteTransitionChrome() {
  const { stage } = useTransitionState();

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

  useEffect(() => {

    function handleClickCapture(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target;
      if (!(target instanceof Element)) return;

      const anchor = target.closest<HTMLAnchorElement>(`a[${JUMP_GATE_INTENT_ATTR}="${JUMP_GATE_INTENT_VALUE}"]`);
      if (!anchor) return;
      if (anchor.hasAttribute('download') || anchor.target === '_blank') return;

      const targetUrl = new URL(anchor.href);
      const currentUrl = new URL(window.location.href);
      if (targetUrl.origin !== currentUrl.origin) return;
      if (targetUrl.href === currentUrl.href) return;

      markPendingJumpGateNavigation(anchor.href);
    }

    document.addEventListener('click', handleClickCapture, { capture: true });
    return () => document.removeEventListener('click', handleClickCapture, { capture: true });
  }, []);

  const leave = useCallback((next: () => void, from?: string, to?: string) => {
    const useJumpGate = consumePendingJumpGateNavigation(to);
    activeTransitionUsesJumpGate = useJumpGate;

    if (!useJumpGate) {
      resetRouteTransitionVisualState();
      next();
      return undefined;
    }
    if (minimalVisualEffects || prefersReducedMotion()) {
      activeTransitionUsesJumpGate = false;
      resetRouteTransitionVisualState();
      next();
      return undefined;
    }

    updateRouteLabels(from, to);

    const overlay = document.querySelector<HTMLElement>('.pc-route-transition');
    const page = document.querySelector<HTMLElement>('[data-route-transition-page="true"]');
    if (!overlay) {
      activeTransitionUsesJumpGate = false;
      resetRouteTransitionVisualState();
      next();
      return undefined;
    }

    let complete = false;
    const finish = () => {
      if (complete) return;
      complete = true;
      next();
    };
    gsap.killTweensOf([overlay, page]);
    gsap.killTweensOf('.pc-route-transition *');

    // Snappy leave: ~140ms total. `next()` fires onComplete (or via the 240ms
    // fallback) so next-transition-router's `stage` machine sees a normal
    // "leave finished" → routing → "enter" lifecycle. Calling `next()` at
    // the START of leave broke that machine (stage stuck at "leaving"); the
    // big remaining lag (HarnessDashboard mount) is solved instead by the
    // snap-enter below, which removes the 2+s GSAP enter tween that was
    // queued behind the React render and only let the page reveal *after*
    // that whole catch-up backlog finished playing.
    const timeline = gsap.timeline({
      defaults: { ease: 'power2.out' },
      onComplete: finish,
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

    // Backstop: if rAF gets starved (e.g. heavy route mount blocks the main
    // thread), `onComplete` may not fire — call next() at 240ms regardless
    // so navigation proceeds.
    const fallbackId = window.setTimeout(finish, 240);

    return () => {
      window.clearTimeout(fallbackId);
      timeline.kill();
    };
  }, [minimalVisualEffects]);

  const enter = useCallback((next: () => void, from?: string, to?: string) => {
    if (!activeTransitionUsesJumpGate) {
      resetRouteTransitionVisualState();
      next();
      return undefined;
    }
    if (minimalVisualEffects || prefersReducedMotion()) {
      activeTransitionUsesJumpGate = false;
      resetRouteTransitionVisualState();
      next();
      return undefined;
    }

    if (from || to) updateRouteLabels(from, to);

    const overlay = document.querySelector<HTMLElement>('.pc-route-transition');
    const page = document.querySelector<HTMLElement>('[data-route-transition-page="true"]');
    if (!overlay) {
      activeTransitionUsesJumpGate = false;
      resetRouteTransitionVisualState();
      next();
      return undefined;
    }

    activeTransitionUsesJumpGate = false;
    gsap.killTweensOf([overlay, page]);
    gsap.killTweensOf('.pc-route-transition *');

    // Snap enter: no animation. The leave overlay was visible while the new
    // route mounted; the moment the route commits and `enter()` fires, snap
    // everything back to base state and call next() immediately. Without
    // this, GSAP tweens (`.to(page, autoAlpha:1, duration:0.14)`) get
    // queued behind the main-thread work React just did and stretch out
    // to multiple seconds — perceived as a long, laggy fade-in even though
    // the actual page is already ready. The leave overlay does the heavy
    // lifting of "something is happening"; revealing the page should be
    // instant.
    gsap.set(page, { autoAlpha: 1, clearProps: 'scale,filter,transform' });
    gsap.set('.pc-route-transition__blade--top', { yPercent: -100 });
    gsap.set('.pc-route-transition__blade--bottom', { yPercent: 100 });
    gsap.set(overlay, { autoAlpha: 0, pointerEvents: 'none' });
    const statusNode = document.querySelector<HTMLElement>('[data-route-transition-status]');
    if (statusNode) statusNode.textContent = 'STANDING BY';

    next();
    return undefined;
  }, [minimalVisualEffects]);

  return (
    <TransitionRouter auto leave={leave} enter={enter}>
      <RouteTransitionChrome />
      {children}
    </TransitionRouter>
  );
}
