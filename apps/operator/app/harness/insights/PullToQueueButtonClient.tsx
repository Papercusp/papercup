'use client';

/**
 * PullToQueueButtonClient — Phase 5b P-032a (optimistic + POST plumbing).
 *
 * Pairs with PullToQueueButton (pure UI). Owns the optimistic flip +
 * the POST to /api/harness/:slug/feature-queue/:featureId/{enqueue,dequeue}.
 *
 * On failure: reverts the optimistic flip + logs to console. No toast
 * here — the parent FeatureList already has a toast surface; we keep
 * this component minimal.
 */

import { useCallback, useState, type ReactNode } from 'react';
import { PullToQueueButton } from './PullToQueueButton';

export interface PullToQueueButtonClientProps {
  slug: string;
  featureId: string;
  githubUserId: number;
  /** Initial queued state from the server-side load. */
  initialQueued: boolean;
  hidden?: boolean;
}

export function PullToQueueButtonClient(
  props: PullToQueueButtonClientProps,
): ReactNode {
  const [queued, setQueued] = useState(props.initialQueued);
  const [pending, setPending] = useState(false);

  const toggle = useCallback(async () => {
    if (pending) return;
    if (!Number.isInteger(props.githubUserId) || props.githubUserId <= 0) return;
    const target = !queued;
    setQueued(target); // optimistic
    setPending(true);
    const action = target ? 'enqueue' : 'dequeue';
    try {
      const res = await fetch(
        `/api/harness/${encodeURIComponent(props.slug)}/feature-queue/${encodeURIComponent(props.featureId)}/${action}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ github_user_id: props.githubUserId }),
        },
      );
      if (!res.ok) {
        setQueued(!target);
        console.warn(`[pull-to-queue] ${action} failed: ${res.status}`);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
      if (body.ok === false) {
        // substrate-off — revert + leave user without a toast (intentional;
        // pre-alpha, the flag-flip will resolve this).
        setQueued(!target);
        console.warn(`[pull-to-queue] ${action} no-op: ${body.reason ?? 'unknown'}`);
      }
    } catch (e) {
      setQueued(!target);
      console.warn(`[pull-to-queue] ${action} threw:`, e);
    } finally {
      setPending(false);
    }
  }, [pending, queued, props.slug, props.featureId, props.githubUserId]);

  return (
    <PullToQueueButton
      queued={queued}
      onToggle={toggle}
      pending={pending}
      hidden={props.hidden}
    />
  );
}
