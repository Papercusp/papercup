'use client';

/**
 * useQueueMembership — Phase 5b P-032.
 *
 * Plan: papercusp-dogfood-phase5b-hyperbee-ui-integration-2026-05-24.
 *
 * Polls GET /api/harness/:slug/feature-queue-membership and returns the
 * { [feature_id]: QueueAvatarMember[] } map plus a helper for membership
 * lookups in render.
 *
 * Polling cadence: 8s. The right answer long-term is a sync subscription
 * (Phase 5a substrate hook), but per-row queue state changes infrequently
 * and an 8s poll is cheap. Polling pauses while the document is hidden
 * (no point burning a tab in the background).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { QueueAvatarMember } from './QueueAvatarCluster';

export interface UseQueueMembershipOpts {
  slug: string;
  /** Optional: filter to a subset of features at the endpoint. */
  featureIds?: string[];
  /** Override poll interval (ms). Default 8000. */
  pollMs?: number;
  /** Override fetch (testing). */
  fetchImpl?: typeof fetch;
}

export interface UseQueueMembershipResult {
  membership: Record<string, QueueAvatarMember[]>;
  /** True once a fetch has returned (success or error). */
  loaded: boolean;
  /** Returns the members queued on a feature; empty array if none / not yet loaded. */
  membersFor: (featureId: string) => QueueAvatarMember[];
  /** Returns true if `githubUserId` has `featureId` queued. */
  isQueued: (featureId: string, githubUserId: number) => boolean;
  /** Force a refresh. */
  refresh: () => void;
}

function membershipUrl(slug: string, featureIds?: string[]): string {
  const base = `/api/harness/${encodeURIComponent(slug)}/feature-queue-membership`;
  if (!featureIds || featureIds.length === 0) return base;
  return `${base}?feature_ids=${featureIds.map(encodeURIComponent).join(',')}`;
}

export function useQueueMembership(opts: UseQueueMembershipOpts): UseQueueMembershipResult {
  const [membership, setMembership] = useState<Record<string, QueueAvatarMember[]>>({});
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
      const res = await fetchImpl(membershipUrl(opts.slug, opts.featureIds));
      if (!res.ok) {
        setLoaded(true);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        membership?: Record<string, QueueAvatarMember[]>;
      };
      setMembership(body.membership ?? {});
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  }, [opts.slug, featureIdsKey, fetchImpl]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.hidden) {
        // Skip ticks in the background.
      } else {
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

  const membersFor = useCallback(
    (featureId: string) => membership[featureId] ?? [],
    [membership],
  );

  const isQueued = useCallback(
    (featureId: string, githubUserId: number) => {
      if (!githubUserId) return false;
      const list = membership[featureId];
      if (!list) return false;
      for (const m of list) if (m.github_user_id === githubUserId) return true;
      return false;
    },
    [membership],
  );

  return { membership, loaded, membersFor, isQueued, refresh: doFetch };
}
