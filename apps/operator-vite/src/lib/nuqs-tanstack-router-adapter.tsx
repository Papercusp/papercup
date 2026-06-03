'use client';

import { startTransition, useCallback, useMemo } from 'react';
import { useLocation, useRouter } from '@tanstack/react-router';
import {
  renderQueryString,
  unstable_createAdapterProvider as createAdapterProvider,
  type unstable_AdapterOptions as AdapterOptions,
} from 'nuqs/adapters/custom';

/**
 * Custom nuqs adapter for TanStack Router that PRESERVES search params nuqs
 * does not manage.
 *
 * Why this exists: the stock `nuqs/adapters/tanstack-router` adapter rebuilds
 * the entire query string from ONLY the nuqs-watched keys
 * (`to: pathname + renderQueryString(<watched-only>)`). Any param owned by
 * TanStack Router's native typed search (`validateSearch` + `useSearch`) —
 * e.g. `?dock=1` (/harness/$slug), `?switch=1` (/login) — is therefore
 * dropped on EVERY nuqs write. The WorkspaceSwitcher mount effect writes
 * `?ws=<active>` via nuqs on load, which clobbered those params (≈18 e2e
 * specs across dock + login + auth).
 *
 * The fix: `updateUrl` merges nuqs's desired watched-key state OVER the full
 * current URL search, so non-watched params survive. (This router config
 * already preserves unvalidated params passed via the `to` string — that's
 * exactly why `?ws=` itself survived while `?dock=` was dropped — so putting
 * the other params back into the `to` string keeps them.) nuqs deletions
 * still apply: a removed watched key is absent from `nuqsSearch`, and the
 * base's copy of every watched key is dropped before re-applying nuqs's state.
 *
 * Everything else mirrors the official adapter 1:1 (the `searchParams` getter,
 * the navigate options) so nuqs behaves identically for the keys it owns.
 */

/** Pure merge: nuqs's watched-key state laid over the current URL search. */
export function mergeNuqsSearchParams(
  currentSearch: string,
  watchKeys: readonly string[],
  nuqsSearch: URLSearchParams,
): URLSearchParams {
  const merged = new URLSearchParams();
  // 1. Carry over every CURRENT param nuqs does not manage (incl. arrays).
  for (const [key, value] of new URLSearchParams(currentSearch)) {
    if (!watchKeys.includes(key)) merged.append(key, value);
  }
  // 2. Apply nuqs's desired state for the watched keys (repeated keys = arrays).
  for (const [key, value] of nuqsSearch) {
    merged.append(key, value);
  }
  return merged;
}

function useNuqsTanstackRouterAdapter(watchKeys: string[]) {
  const pathname = useLocation({ select: (state) => state.pathname });
  const search = useLocation({
    select: (state) =>
      Object.fromEntries(
        Object.entries(state.search).filter(([key]) => watchKeys.includes(key)),
      ),
  });
  const { navigate } = useRouter();
  return {
    searchParams: useMemo(
      () =>
        new URLSearchParams(
          Object.entries(search).flatMap(([key, value]) => {
            if (Array.isArray(value))
              return value.map((v) => [key, String(v)] as [string, string]);
            if (typeof value === 'object' && value !== null)
              return [[key, JSON.stringify(value)] as [string, string]];
            return [[key, String(value)] as [string, string]];
          }),
        ),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [search, watchKeys.join(',')],
    ),
    updateUrl: useCallback(
      (nuqsSearch: URLSearchParams, options: AdapterOptions) => {
        const merged = mergeNuqsSearchParams(
          window.location.search,
          watchKeys,
          nuqsSearch,
        );
        // TEMP DIAG (remove):
        console.info(
          '[nuqs-merge-adapter] updateUrl from=' +
            window.location.search +
            ' watch=' +
            watchKeys.join(',') +
            ' to=' +
            renderQueryString(merged),
        );
        startTransition(() => {
          navigate({
            from: '/',
            to: pathname + renderQueryString(merged),
            replace: options.history === 'replace',
            resetScroll: options.scroll,
            hash: (prevHash) => prevHash ?? '',
            state: (state) => state,
          });
        });
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [navigate, pathname, watchKeys.join(',')],
    ),
    rateLimitFactor: 1,
  };
}

// TEMP DIAG (remove): marker + updateUrl trace to confirm the adapter is live.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__NUQS_MERGE_ADAPTER__ = '2026-06-03';
}

export const NuqsAdapter = createAdapterProvider(useNuqsTanstackRouterAdapter);
