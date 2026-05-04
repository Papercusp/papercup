'use client';

import { useEffect, useSyncExternalStore, type MouseEvent } from 'react';
import { usePathname } from 'next/navigation';
import { Link as TransitionLink } from 'next-view-transitions';
import { useProgress } from '@bprogress/next';

import {
  ROUTE_PROGRESS_FALLBACK_MS,
  beginRoutePending,
  getRoutePendingHref,
  routeHrefFromProp,
  scheduleRoutePendingClear,
  subscribeRoutePending,
} from './routePending';

export type RouteLinkProps = React.ComponentProps<typeof TransitionLink>;

// Tuning notes (2026-05-03 perf audit):
//   - FALLBACK_MS was 8000. That meant if Next.js compile / route resolve
//     hung, the progress bar showed for 8 full seconds — the user perceives
//     this as the click being "broken" (the page is in fact done).
//     Dropped to 1500ms; if the real route truly takes longer the bprogress
//     library still cleans up on `pathname` change.
//   - MIN_VISIBLE remains 0 so fast routes do not fake a long wait, but the
//     route-pending state now clears on actual completion/fallback rather than
//     immediately after click. This keeps the shell feedback truthful without
//     letting it disappear before the new route has mounted.
//   See /docs/performance #A16 for the broader pattern.
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
    scheduleRoutePendingClear();
  }, [pathname]);

  function handleClickCapture(event: MouseEvent<HTMLAnchorElement>) {
    onClickCapture?.(event);
    if (!shouldStartRouteProgress(event)) return;

    const targetUrl = new URL(event.currentTarget.href);
    beginRoutePending(`${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`);

    // Start synchronously so app-shell navigation shows feedback immediately,
    // before next-view-transitions/Next.js pushState can finish a fast route.
    progress.set(0.08);
    progress.start(0.08, 0, true);
    window.setTimeout(() => {
      progress.stop(120);
      scheduleRoutePendingClear();
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
