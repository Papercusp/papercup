'use client';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { ProgressProvider } from '@bprogress/next/app';
import { usePathname } from 'next/navigation';
import { useProgress } from '@bprogress/next';

import ControlPlaneLoading from './ControlPlaneLoading';
import {
  ROUTE_PROGRESS_FALLBACK_MS,
  beginRoutePending,
  finishRoutePending,
  getRoutePendingTarget,
  scheduleRoutePendingClear,
  subscribeRoutePending,
} from './routePending';
import { shouldStartDocumentRouteProgressForAnchor } from './route-progress-document';

function shouldStartDocumentRouteProgress(event: MouseEvent | PointerEvent): HTMLAnchorElement | null {
  const target = event.target;
  const anchor = target instanceof Element ? target.closest('a[href]') : null;
  const allowed = shouldStartDocumentRouteProgressForAnchor({
    defaultPrevented: event.defaultPrevented,
    button: 'button' in event ? event.button : 0,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    isElementTarget: target instanceof Element,
    anchorPresent: anchor instanceof HTMLAnchorElement,
    download: anchor instanceof HTMLAnchorElement ? anchor.hasAttribute('download') : false,
    targetBlank: anchor instanceof HTMLAnchorElement ? anchor.target === '_blank' : false,
    disableProgress: anchor instanceof HTMLAnchorElement ? anchor.getAttribute('data-disable-progress') === 'true' : false,
    targetBlocksProgress:
      target instanceof Element
      && Boolean(target.closest('[data-prevent-progress="true"], [data-disable-progress="true"]')),
    currentHref: window.location.href,
    targetHref: anchor instanceof HTMLAnchorElement ? anchor.href : window.location.href,
  });
  return allowed && anchor instanceof HTMLAnchorElement ? anchor : null;
}

function BProgressBusyClassCleanup() {
  useEffect(() => {
    const cleanup = () => {
      if (document.querySelector('.bprogress')) return;
      document.documentElement.classList.remove('bprogress-busy');
    };

    const scheduleCleanup = () => {
      window.requestAnimationFrame(cleanup);
    };

    const observer = new MutationObserver(scheduleCleanup);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    observer.observe(document.body, { childList: true, subtree: true });
    cleanup();

    return () => observer.disconnect();
  }, []);

  return null;
}

function RouteProgressCompletion() {
  const pathname = usePathname();
  const progress = useProgress();
  const didMount = useRef(false);

  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    progress.stop(120);
    scheduleRoutePendingClear();
  }, [pathname, progress]);

  return null;
}

function RoutePendingOverlay() {
  const pendingTarget = useSyncExternalStore(
    subscribeRoutePending,
    getRoutePendingTarget,
    getRoutePendingTarget,
  );
  const harnessPending = pendingTarget === 'harness';

  return (
    <>
      <div
        className={`pc-route-pending-overlay${harnessPending ? ' is-route-pending-suppressed' : ''}`}
        aria-atomic={harnessPending ? undefined : 'true'}
        aria-hidden={harnessPending || undefined}
        aria-live={harnessPending ? undefined : 'polite'}
        data-route-pending-target={pendingTarget ?? undefined}
      >
        Loading…
      </div>
      {harnessPending ? <ControlPlaneLoading label="Mission Control" mode="overlay" /> : null}
    </>
  );
}

function DocumentRouteProgressCapture() {
  const progress = useProgress();

  useEffect(() => {
    let fallbackTimer: number | null = null;

    const startPending = (event: MouseEvent | PointerEvent) => {
      const anchor = shouldStartDocumentRouteProgress(event);
      if (!anchor) return;

      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
      beginRoutePending(anchor.href);
      progress.set(0.08);
      progress.start(0.08, 0, true);
      fallbackTimer = window.setTimeout(() => {
        progress.stop(120);
        scheduleRoutePendingClear();
      }, ROUTE_PROGRESS_FALLBACK_MS);
    };

    document.addEventListener('pointerdown', startPending, true);
    return () => {
      document.removeEventListener('pointerdown', startPending, true);
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
      finishRoutePending();
    };
  }, [progress]);

  return null;
}

export default function RouteProgressProvider({ children }: { children: React.ReactNode }) {
  return (
    <ProgressProvider
      height="3px"
      color="#57d7ff"
      delay={80}
      stopDelay={120}
      startPosition={0.08}
      disableSameURL
      options={{ showSpinner: false, trickle: true }}
    >
      {children}
      <BProgressBusyClassCleanup />
      <RouteProgressCompletion />
      <RoutePendingOverlay />
      <DocumentRouteProgressCapture />
    </ProgressProvider>
  );
}
