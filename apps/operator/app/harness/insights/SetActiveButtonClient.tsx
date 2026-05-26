'use client';

/**
 * SetActiveButtonClient — Phase 6 P-038a optimistic + POST plumbing.
 *
 * Pairs with SetActiveButton. POSTs
 * /api/harness/:slug/working-set/:featureId/{set-active,clear-active},
 * optimistically flips, reverts on HTTP error / substrate-off / throw.
 * Mirrors PullToQueueButtonClient.
 */

import { useCallback, useState, type ReactNode } from 'react';
import { SetActiveButton } from './SetActiveButton';

export interface SetActiveButtonClientProps {
  slug: string;
  featureId: string;
  githubUserId: number;
  initialActive: boolean;
  takenByOther?: boolean;
  hidden?: boolean;
}

export function SetActiveButtonClient(props: SetActiveButtonClientProps): ReactNode {
  const [active, setActive] = useState(props.initialActive);
  const [pending, setPending] = useState(false);

  const toggle = useCallback(async () => {
    if (pending) return;
    if (!Number.isInteger(props.githubUserId) || props.githubUserId <= 0) return;
    const target = !active;
    setActive(target);
    setPending(true);
    const action = target ? 'set-active' : 'clear-active';
    try {
      const res = await fetch(
        `/api/harness/${encodeURIComponent(props.slug)}/working-set/${encodeURIComponent(props.featureId)}/${action}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ github_user_id: props.githubUserId }),
        },
      );
      if (!res.ok) {
        setActive(!target);
        console.warn(`[set-active] ${action} failed: ${res.status}`);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
      if (body.ok === false) {
        setActive(!target);
        console.warn(`[set-active] ${action} no-op: ${body.reason ?? 'unknown'}`);
      }
    } catch (e) {
      setActive(!target);
      console.warn(`[set-active] ${action} threw:`, e);
    } finally {
      setPending(false);
    }
  }, [pending, active, props.slug, props.featureId, props.githubUserId]);

  return (
    <SetActiveButton
      active={active}
      takenByOther={props.takenByOther}
      onToggle={toggle}
      pending={pending}
      hidden={props.hidden}
    />
  );
}
