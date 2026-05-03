'use client';

import { useEffect, useSyncExternalStore, type MouseEvent } from 'react';
import { usePathname } from 'next/navigation';
import { Link as TransitionLink } from 'next-view-transitions';
import { useProgress } from '@bprogress/next';

export type RouteLinkProps = React.ComponentProps<typeof TransitionLink>;

// Tuning notes (2026-05-03 perf audit):
//   - FALLBACK_MS was 8000. That meant if Next.js compile / route resolve
//     hung, the progress bar showed for 8 full seconds — the user perceives
//     this as the click being "broken" (the page is in fact done).
//     Dropped to 1500ms; if the real route truly takes longer the bprogress
//     library still cleans up on `pathname` change.
//   - MIN_VISIBLE was 3000. Every navigation forced the progress bar
//     visible for 3 seconds *minimum*, regardless of how fast the route
//     actually loaded — a 50ms route showed as a 3-second "still loading"
//     state. The whole point of the bar is to reflect ACTUAL pending; a
//     minimum-visible debounce is the wrong tool. Dropped to 0; the
//     useProgress() library already debounces sub-frame flashes itself.
//   See /docs/performance #A16 for the broader pattern.
const ROUTE_PROGRESS_FALLBACK_MS = 1500;
const ROUTE_PROGRESS_MIN_VISIBLE_MS = 0;

let routePendingHref: string | null = null;
let routePendingStartedAt = 0;
let routePendingTimer: number | null = null;
const routePendingListeners = new Set<() => void>();

function emitRoutePending() {
  routePendingListeners.forEach((listener) => listener());
}

function subscribeRoutePending(listener: () => void) {
  routePendingListeners.add(listener);
  return () => routePendingListeners.delete(listener);
}

function getRoutePendingHref() {
  return routePendingHref;
}

function normalizeRouteHref(href: string): string {
  try {
    const url = new URL(href, 'http://papercusp.local');
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    return `${pathname}${url.search}${url.hash}`;
  } catch {
    return href;
  }
}

function routeHrefFromProp(href: unknown): string | null {
  if (typeof href === 'string') return normalizeRouteHref(href);
  if (
    href
    && typeof href === 'object'
    && 'pathname' in href
    && typeof href.pathname === 'string'
  ) {
    return normalizeRouteHref(href.pathname);
  }
  return null;
}

function finishRoutePendingHref() {
  routePendingHref = null;
  routePendingTimer = null;
  document.documentElement.removeAttribute('data-route-pending');
  emitRoutePending();
}

function clearRoutePendingHrefWithMinimum() {
  if (!routePendingHref || routePendingTimer !== null) return;

  const remaining = Math.max(
    0,
    ROUTE_PROGRESS_MIN_VISIBLE_MS - (performance.now() - routePendingStartedAt),
  );

  routePendingTimer = window.setTimeout(finishRoutePendingHref, remaining);
}

function setRoutePendingHref(href: string) {
  if (routePendingTimer !== null) {
    window.clearTimeout(routePendingTimer);
    routePendingTimer = null;
  }

  routePendingHref = normalizeRouteHref(href);
  routePendingStartedAt = performance.now();
  document.documentElement.setAttribute('data-route-pending', 'true');
  emitRoutePending();
  routePendingTimer = window.setTimeout(finishRoutePendingHref, ROUTE_PROGRESS_MIN_VISIBLE_MS);
}

function shouldStartRouteProgress(event: MouseEvent<HTMLAnchorElement>): boolean {
  if (event.defaultPrevented) return false;
  if (event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;

  const anchor = event.currentTarget;
  if (anchor.hasAttribute('download')) return false;
  if (anchor.target === '_blank') return false;
  if (anchor.getAttribute('data-disable-progress') === 'true') return false;

  const target = event.target;
  if (
    target instanceof Element
    && (target.closest('[data-prevent-progress="true"]') || target.closest('[data-disable-progress="true"]'))
  ) {
    return false;
  }

  const targetUrl = new URL(anchor.href);
  const currentUrl = new URL(window.location.href);
  if (targetUrl.origin !== currentUrl.origin) return false;
  return targetUrl.href !== currentUrl.href;
}

export default function RouteLink({ className, onClickCapture, ...props }: RouteLinkProps) {
  const progress = useProgress();
  const pathname = usePathname();
  const pendingHref = useSyncExternalStore(
    subscribeRoutePending,
    getRoutePendingHref,
    getRoutePendingHref,
  );
  const ownHref = routeHrefFromProp(props.href);
  const pending = ownHref !== null && pendingHref === ownHref;

  useEffect(() => {
    clearRoutePendingHrefWithMinimum();
  }, [pathname]);

  function handleClickCapture(event: MouseEvent<HTMLAnchorElement>) {
    onClickCapture?.(event);
    if (!shouldStartRouteProgress(event)) return;

    const targetUrl = new URL(event.currentTarget.href);
    setRoutePendingHref(`${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`);

    // Start synchronously so app-shell navigation shows feedback immediately,
    // before next-view-transitions/Next.js pushState can finish a fast route.
    progress.set(0.08);
    progress.start(0.08, 0, true);
    window.setTimeout(() => {
      progress.stop(120);
      clearRoutePendingHrefWithMinimum();
    }, ROUTE_PROGRESS_FALLBACK_MS);
  }

  const mergedClassName = [className, pending ? 'is-route-pending' : null].filter(Boolean).join(' ');

  return (
    <TransitionLink
      {...props}
      aria-busy={pending || undefined}
      className={mergedClassName || undefined}
      data-route-pending={pending ? 'true' : undefined}
      onClickCapture={handleClickCapture}
    />
  );
}
