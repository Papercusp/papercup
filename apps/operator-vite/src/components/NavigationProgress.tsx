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
export function NavigationProgress() {
  const isPending = useRouterState({ select: (s) => s.status === 'pending' });
  const { start, stop } = useProgress();

  useEffect(() => {
    if (isPending) start();
    else stop();
  }, [isPending, start, stop]);

  return null;
}
