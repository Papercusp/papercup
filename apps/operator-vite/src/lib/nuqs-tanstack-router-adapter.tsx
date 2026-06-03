'use client';

import { startTransition, useCallback, useMemo } from 'react';
import { useLocation, useRouter } from '@tanstack/react-router';
import {
  unstable_createAdapterProvider as createAdapterProvider,
  type unstable_AdapterOptions as AdapterOptions,
} from 'nuqs/adapters/custom';

/**
 * Custom nuqs adapter for TanStack Router that preserves search params nuqs
 * does not manage — and, crucially, lets TanStack Router own URL
 * serialization.
 *
 * Why this exists: the stock `nuqs/adapters/tanstack-router` adapter writes
 * the whole URL as a STRING (`to: pathname + renderQueryString(<watched>)`).
 * That fights TanStack's typed search in two ways:
 *   1. It rebuilds from only the nuqs-watched keys, so params owned by
 *      TanStack's native typed search (`validateSearch` + `useSearch`) — e.g.
 *      `?dock=1` on /harness/$slug — are dropped on every nuqs write.
 *   2. TanStack re-stringifies that string-`to` with its own JSON encoder, so
 *      a value it has already encoded (e.g. the string `"1"`) gets re-encoded
 *      and duplicated on each pass — an encoding feedback loop.
 *
 * The fix: write via TanStack's FUNCTIONAL search updater
 * (`navigate({ search: (prev) => … })`). `prev` is the current *validated*
 * search object, so non-nuqs params survive; nuqs's watched keys are laid on
 * top; and TanStack stringifies exactly once. nuqs deletions apply because a
 * removed watched key is absent from `nuqsSearch` (and every watched key is
 * stripped from `prev` before re-applying nuqs's state).
 */

/** Pure merge: nuqs's watched-key state laid over the current search object. */
export function applyNuqsToSearch(
  prev: Record<string, unknown>,
  watchKeys: readonly string[],
  nuqsSearch: URLSearchParams,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...prev };
  // Drop nuqs's keys from the base — nuqs re-adds exactly the ones it wants.
  for (const key of watchKeys) delete next[key];
  // Group nuqs's desired state (repeated keys = arrays), then overlay.
  const grouped: Record<string, string | string[]> = {};
  for (const [key, value] of nuqsSearch.entries()) {
    const cur = grouped[key];
    grouped[key] =
      cur === undefined ? value : Array.isArray(cur) ? [...cur, value] : [cur, value];
  }
  return { ...next, ...grouped };
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
        startTransition(() => {
          navigate({
            from: '/',
            to: pathname,
            search: (prev) =>
              applyNuqsToSearch(prev as Record<string, unknown>, watchKeys, nuqsSearch),
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

export const NuqsAdapter = createAdapterProvider(useNuqsTanstackRouterAdapter);
