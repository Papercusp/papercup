import { useMemo } from 'react';
import {
  Link as TsrLink,
  useNavigate,
  useParams as useTsrParams,
  useRouterState,
  redirect as tsrRedirect,
  notFound as tsrNotFound,
} from '@tanstack/react-router';

/**
 * `next/navigation` compatibility shim for the operator-vite migration.
 *
 * Vite's `resolve.alias` (in `vite.config.ts`) rewrites every
 * `import … from 'next/navigation'` inside the operator-vite bundle to
 * this file. The live `apps/operator/` (still served by `next dev` during
 * the migration window) resolves the same import via `node_modules/next/`
 * and is unaffected.
 *
 * Why a shim instead of in-place edits: shared components under
 * `apps/operator/app/` (5K-line `HarnessDashboard`, etc.) are too large
 * to parallel-copy. Editing them in-place would break the live Next
 * operator (plan B-5 invariant). The shim lets the same component source
 * file work in both bundlers until Phase H deletes Next.
 *
 * **Decommission:** delete this file + the alias entries in `vite.config.ts`
 * when `apps/operator/app/` is removed in Phase H.
 *
 * Decisions:
 *   - `useRouter().refresh()` calls `router.invalidate()` — TSR's equivalent
 *     of "re-fetch the current route's data". `window.location.reload()`
 *     would force a full page reload, which the live operator doesn't.
 *   - `useRouter().prefetch()` is a no-op. TSR has its own preload model
 *     on `<Link>`; this only matters when callers call `router.prefetch()`
 *     manually (rare in operator code).
 *   - `useSearchParams()` returns a fresh `URLSearchParams` each render
 *     when the search string changes (memoized to keep identity stable
 *     between renders with the same search). Same observable behavior as
 *     Next's `ReadonlyURLSearchParams`, minus the read-only typing.
 */

export type AppRouterInstance = {
  push: (href: string) => void;
  replace: (href: string) => void;
  back: () => void;
  forward: () => void;
  refresh: () => void;
  prefetch: (href: string) => void;
};

export function useRouter(): AppRouterInstance {
  const navigate = useNavigate();
  return useMemo<AppRouterInstance>(
    () => ({
      push: (href: string) => {
        void navigate({ to: href });
      },
      replace: (href: string) => {
        void navigate({ to: href, replace: true });
      },
      back: () => {
        window.history.back();
      },
      forward: () => {
        window.history.forward();
      },
      refresh: () => {
        // TSR doesn't expose router.invalidate from a hook context here;
        // a hard navigate to the current URL forces TSR loaders to re-run.
        void navigate({ to: window.location.pathname + window.location.search, replace: true });
      },
      prefetch: () => {
        // no-op — TSR's <Link> handles prefetching; manual prefetch() is rare
      },
    }),
    [navigate],
  );
}

export function usePathname(): string {
  return useRouterState({ select: (s) => s.location.pathname });
}

export function useSearchParams(): URLSearchParams {
  const searchStr = useRouterState({ select: (s) => s.location.searchStr ?? '' });
  return useMemo(() => new URLSearchParams(searchStr), [searchStr]);
}

export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  return useTsrParams({ strict: false }) as T;
}

/**
 * `redirect(href)` — throws a TSR redirect. Behaves identically to Next's
 * `redirect()` at the call site (must be thrown / never returns).
 */
export function redirect(href: string): never {
  throw tsrRedirect({ to: href });
}

/**
 * `notFound()` — throws a TSR not-found marker. Same call shape as Next's.
 */
export function notFound(): never {
  throw tsrNotFound();
}

/**
 * Re-exported for the rare `useSelectedLayoutSegment()` caller — Next-only
 * API for nested layouts. Operator code uses it sparingly; this returns the
 * last non-empty path segment, which is what every existing call site reads.
 */
export function useSelectedLayoutSegment(): string | null {
  const pathname = usePathname();
  const segments = pathname.split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : null;
}

// `Link` lives in `next/link`, not `next/navigation`, but we re-export TSR
// `Link` here so the shim for `next/link` can re-export from us without
// duplicating a wrapper component.
export { TsrLink };
