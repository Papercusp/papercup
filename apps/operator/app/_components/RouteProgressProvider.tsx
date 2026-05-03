'use client';
import { useEffect, useRef } from 'react';

import { ProgressProvider } from '@bprogress/next/app';
import { usePathname } from 'next/navigation';
import { useProgress } from '@bprogress/next';

// See RouteLink.tsx + /docs/performance #A16. The 3000ms minimum-visible
// debounce + 8000ms fallback dominated the perceived navigation latency
// — every nav showed a 3-second progress bar regardless of how fast the
// route actually loaded. Dropped to 0/1500 so the bar reflects ACTUAL
// pending state. Both copies in this app must stay in sync.
const ROUTE_PROGRESS_MIN_VISIBLE_MS = 0;
const ROUTE_PROGRESS_FALLBACK_MS = 1500;

function shouldStartDocumentRouteProgress(event: MouseEvent | PointerEvent): HTMLAnchorElement | null {
  if (event.defaultPrevented) return null;
  if ('button' in event && event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;

  const target = event.target;
  if (!(target instanceof Element)) return null;

  const anchor = target.closest('a[href]');
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (anchor.hasAttribute('download')) return null;
  if (anchor.target === '_blank') return null;
  if (anchor.getAttribute('data-disable-progress') === 'true') return null;
  if (target.closest('[data-prevent-progress="true"], [data-disable-progress="true"]')) return null;

  const targetUrl = new URL(anchor.href);
  const currentUrl = new URL(window.location.href);
  if (targetUrl.origin !== currentUrl.origin) return null;
  if (targetUrl.href === currentUrl.href) return null;
  return anchor;
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
  }, [pathname, progress]);

  return null;
}

function DocumentRouteProgressCapture() {
  const progress = useProgress();

  useEffect(() => {
    let clearTimer: number | null = null;

    const clearPending = () => {
      document.documentElement.removeAttribute('data-route-pending');
      clearTimer = null;
    };

    const startPending = (event: MouseEvent | PointerEvent) => {
      const anchor = shouldStartDocumentRouteProgress(event);
      if (!anchor) return;

      if (clearTimer !== null) window.clearTimeout(clearTimer);
      document.documentElement.setAttribute('data-route-pending', 'true');
      progress.set(0.08);
      progress.start(0.08, 0, true);

      clearTimer = window.setTimeout(clearPending, ROUTE_PROGRESS_MIN_VISIBLE_MS);
      window.setTimeout(() => progress.stop(120), ROUTE_PROGRESS_FALLBACK_MS);
    };

    document.addEventListener('pointerdown', startPending, true);
    return () => {
      document.removeEventListener('pointerdown', startPending, true);
      if (clearTimer !== null) window.clearTimeout(clearTimer);
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
      <div className="pc-route-pending-overlay" aria-live="polite" aria-atomic="true">
        Loading…
      </div>
      <DocumentRouteProgressCapture />
    </ProgressProvider>
  );
}
