'use client';

import { useCallback, useEffect, type ReactNode } from 'react';
import { TransitionRouter, useTransitionState } from 'next-transition-router';
import { gsap } from 'gsap';
import { ScrambleTextPlugin } from 'gsap/ScrambleTextPlugin';
import { useEffectiveVisualEffects } from '@/lib/visual-effects';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const TRANSITION_LABEL_PLACEHOLDER = 'SYSTEM';
const SCRAMBLE_CHARS = '01█▓▒░<>/{}[]-_=+*';

gsap.registerPlugin(ScrambleTextPlugin);

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
function completeOnce(next: () => void) {
  let complete = false;

  return () => {
    if (complete) return;
    complete = true;
    next();
  };
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

    const done = completeOnce(next);
    let fallbackId: number | undefined;
    const finish = () => {
      if (fallbackId !== undefined) window.clearTimeout(fallbackId);
      done();
    };
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

    const timeline = gsap.timeline({
      defaults: { ease: 'power4.inOut' },
      onComplete: finish,
    });

    timeline
      .set(overlay, { autoAlpha: 1, pointerEvents: 'auto' })
      .set('.pc-route-transition__sweep', { xPercent: -140, autoAlpha: 0 })
      .fromTo(
        '.pc-route-transition__blade--top',
        { yPercent: -112, skewY: -4 },
        { yPercent: 0, skewY: 0, duration: 0.44 },
        0,
      )
      .fromTo(
        '.pc-route-transition__blade--bottom',
        { yPercent: 112, skewY: -4 },
        { yPercent: 0, skewY: 0, duration: 0.44 },
        0,
      )
      .fromTo(
        '.pc-route-transition__ring',
        { autoAlpha: 0, scale: 0.46, rotate: -34 },
        { autoAlpha: 1, scale: 1, rotate: 0, duration: 0.52, stagger: 0.045, ease: 'back.out(1.9)' },
        0.08,
      )
      .fromTo(
        '.pc-route-transition__reticle',
        { autoAlpha: 0, scaleX: 0.18, scaleY: 1.7 },
        { autoAlpha: 1, scaleX: 1, scaleY: 1, duration: 0.34, ease: 'expo.out' },
        0.12,
      )
      .fromTo(
        '.pc-route-transition__title, .pc-route-transition__subtitle',
        { autoAlpha: 0, y: 18, filter: 'blur(14px)' },
        { autoAlpha: 1, y: 0, filter: 'blur(0px)', duration: 0.32, stagger: 0.045 },
        0.18,
      )
      .fromTo(
        '[data-route-transition-status]',
        { textContent: 'STANDING BY' },
        { scrambleText: { text: 'VECTOR LOCKED', chars: SCRAMBLE_CHARS, speed: 0.65 }, duration: 0.54, ease: 'none' },
        0.14,
      )
      .fromTo(
        '.pc-route-transition__telemetry',
        { autoAlpha: 0, x: (_index: number, target: Element) => (target.classList.contains('pc-route-transition__telemetry--left') ? -46 : 46) },
        { autoAlpha: 1, x: 0, duration: 0.36, stagger: 0.04 },
        0.2,
      )
      .fromTo(
        '.pc-route-transition__status, .pc-route-transition__checksum',
        { autoAlpha: 0, y: 16, filter: 'blur(10px)' },
        { autoAlpha: 1, y: 0, filter: 'blur(0px)', duration: 0.34, stagger: 0.045 },
        0.16,
      )
      .fromTo(
        '.pc-route-transition__ticks i',
        { autoAlpha: 0, scaleY: 0.2 },
        { autoAlpha: 1, scaleY: 1, duration: 0.24, stagger: { each: 0.012, from: 'center' } },
        0.12,
      )
      .to(
        '.pc-route-transition__sweep--a',
        { autoAlpha: 1, xPercent: 140, duration: 0.48, ease: 'expo.inOut' },
        0.16,
      )
      .to(
        '.pc-route-transition__sweep--b',
        { autoAlpha: 0.9, xPercent: 140, duration: 0.58, ease: 'expo.inOut' },
        0.24,
      )
      .to(
        page,
        { autoAlpha: 0.22, scale: 0.985, filter: 'blur(10px) saturate(1.55)', duration: 0.34 },
        0,
      );

    fallbackId = window.setTimeout(finish, 900);

    return () => {
      if (fallbackId !== undefined) window.clearTimeout(fallbackId);
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

    const done = completeOnce(next);
    let fallbackId: number | undefined;
    const finish = () => {
      activeTransitionUsesJumpGate = false;
      if (fallbackId !== undefined) window.clearTimeout(fallbackId);
      done();
    };
    gsap.killTweensOf([
      overlay,
      page,
      '.pc-route-transition__blade',
      '.pc-route-transition__ring',
      '.pc-route-transition__telemetry',
      '.pc-route-transition__status',
      '.pc-route-transition__status strong',
      '.pc-route-transition__checksum',
    ]);

    const timeline = gsap.timeline({
      defaults: { ease: 'power4.inOut' },
      onComplete: finish,
    });

    timeline
      .set(page, { autoAlpha: 0, scale: 1.018, filter: 'blur(16px) saturate(1.8)' })
      .to(page, { autoAlpha: 1, scale: 1, filter: 'blur(0px) saturate(1)', duration: 0.46, ease: 'expo.out' }, 0)
      .to('.pc-route-transition__ring', { scale: 1.45, rotate: 38, autoAlpha: 0, duration: 0.42, stagger: 0.025 }, 0.04)
      .to('.pc-route-transition__reticle', { scaleX: 2.4, scaleY: 0.36, autoAlpha: 0, duration: 0.34 }, 0.08)
      .to('.pc-route-transition__title, .pc-route-transition__subtitle', { autoAlpha: 0, y: -20, filter: 'blur(12px)', duration: 0.24 }, 0)
      .to('.pc-route-transition__telemetry', { autoAlpha: 0, y: 18, duration: 0.22, stagger: 0.02 }, 0)
      .to('[data-route-transition-status]', { scrambleText: { text: 'HANDOFF COMPLETE', chars: SCRAMBLE_CHARS, speed: 0.7 }, duration: 0.26, ease: 'none' }, 0)
      .to('.pc-route-transition__status, .pc-route-transition__checksum', { autoAlpha: 0, y: 18, duration: 0.22, stagger: 0.02 }, 0.05)
      .to('.pc-route-transition__blade--top', { yPercent: -112, skewY: 4, duration: 0.5 }, 0.12)
      .to('.pc-route-transition__blade--bottom', { yPercent: 112, skewY: 4, duration: 0.5 }, 0.12)
      .to(overlay, { autoAlpha: 0, pointerEvents: 'none', duration: 0.12 }, 0.55);

    fallbackId = window.setTimeout(finish, 780);

    return () => {
      if (fallbackId !== undefined) window.clearTimeout(fallbackId);
      activeTransitionUsesJumpGate = false;
      timeline.kill();
    };
  }, [minimalVisualEffects]);

  return (
    <TransitionRouter auto leave={leave} enter={enter}>
      <RouteTransitionChrome />
      {children}
    </TransitionRouter>
  );
}
