import { useEffect } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { useProgress } from '@bprogress/react';

/**
 * Phase B6 — the operator-vite navigation progress bar.
 *
 * Replaces the operator's `RouteProgressProvider.tsx` (which hooked
 * `@bprogress/next` into Next's App Router events). Here the bridge is
 * TanStack Router's own `status`: `'pending'` while a route's
 * `beforeLoad`/`loader` is in flight, `'idle'` otherwise.
 *
 * Mounted once inside `<ProgressProvider>` in `__root.tsx`. The
 * `ProgressProvider` renders the bar DOM + supplies the `useProgress`
 * context; this component is the headless driver — it advances/finishes
 * the bar as the router transitions, and renders nothing itself.
 *
 * Leaf components that call `useProgress()` directly (`RouteLink`,
 * `WorkspaceSwitcher`, `MarketplaceList` — via the `@bprogress/next`
 * alias shim) share the same context, so a manual `.start()` from a
 * link click and the router-driven progress here cooperate on one bar.
 */

function cleanupStaleBusyClass() {
  if (document.querySelector('.bprogress')) return;
  document.documentElement.classList.remove('bprogress-busy');
}
export function NavigationProgress() {
  const isPending = useRouterState({ select: (s) => s.status === 'pending' });
  const { start, stop } = useProgress();

  useEffect(() => {
    if (isPending) {
      start();
      return;
    }

    const settle = () => {
      stop();
      window.setTimeout(cleanupStaleBusyClass, 200);
    };
    settle();
    const interval = window.setInterval(settle, 1_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [isPending, start, stop]);

  return null;
}
