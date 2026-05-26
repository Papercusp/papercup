'use client';

/**
 * useWorkingSet — Phase 6 P-038 (manual "set active").
 *
 * Polls GET /api/harness/:slug/working-set and returns the
 * { [feature_id]: WorkingSetMember[] } map + lookup helpers. Mirrors
 * useQueueMembership exactly. 8s poll; pauses while the document is
 * hidden.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface WorkingSetMember {
  github_user_id: number;
  github_username: string;
  display_name: string | null;
  avatar_url: string | null;
  started_at: number;
}

export interface UseWorkingSetOpts {
  slug: string;
  featureIds?: string[];
  pollMs?: number;
  fetchImpl?: typeof fetch;
}

export interface UseWorkingSetResult {
  working: Record<string, WorkingSetMember[]>;
  loaded: boolean;
  workersFor: (featureId: string) => WorkingSetMember[];
  isActive: (featureId: string, githubUserId: number) => boolean;
  /** True when ANYONE (incl. others) is actively working this feature. */
  hasAnyWorker: (featureId: string) => boolean;
  refresh: () => void;
}

function url(slug: string, featureIds?: string[]): string {
  const base = `/api/harness/${encodeURIComponent(slug)}/working-set`;
  if (!featureIds || featureIds.length === 0) return base;
  return `${base}?feature_ids=${featureIds.map(encodeURIComponent).join(',')}`;
}

export function useWorkingSet(opts: UseWorkingSetOpts): UseWorkingSetResult {
  const [working, setWorking] = useState<Record<string, WorkingSetMember[]>>({});
  const [loaded, setLoaded] = useState(false);
  const tickRef = useRef(0);
  const pollMs = opts.pollMs ?? 8000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const featureIdsKey = useMemo(
    () => (opts.featureIds ?? []).slice().sort().join(','),
    [opts.featureIds],
  );

  const doFetch = useCallback(async () => {
    if (!opts.slug) return;
    try {
      const res = await fetchImpl(url(opts.slug, opts.featureIds));
      if (!res.ok) {
        setLoaded(true);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        working?: Record<string, WorkingSetMember[]>;
      };
      setWorking(body.working ?? {});
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  }, [opts.slug, featureIdsKey, fetchImpl]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      if (typeof document === 'undefined' || !document.hidden) {
        await doFetch();
      }
      tickRef.current = window.setTimeout(tick, pollMs);
    };
    void doFetch();
    tickRef.current = window.setTimeout(tick, pollMs);
    return () => {
      cancelled = true;
      window.clearTimeout(tickRef.current);
    };
  }, [doFetch, pollMs]);

  const workersFor = useCallback(
    (featureId: string) => working[featureId] ?? [],
    [working],
  );
  const isActive = useCallback(
    (featureId: string, githubUserId: number) => {
      if (!githubUserId) return false;
      const list = working[featureId];
      if (!list) return false;
      for (const m of list) if (m.github_user_id === githubUserId) return true;
      return false;
    },
    [working],
  );
  const hasAnyWorker = useCallback(
    (featureId: string) => (working[featureId]?.length ?? 0) > 0,
    [working],
  );

  return { working, loaded, workersFor, isActive, hasAnyWorker, refresh: doFetch };
}
