'use client';

/**
 * SessionsRosterContext — shares the single `/api/adv/roster` poll between the
 * roster LIST and the dossier DETAIL, which now live in two separate slots of
 * the shared `TwoPaneShell` (plan: unified-2-pane-shell). Without this they'd
 * each call `useRoster` and double-poll (and could show divergent snapshots).
 *
 * Mount `<SessionsRosterProvider>` only around the Sessions slots so it polls
 * only while the Sessions view is on screen.
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { RosterResponse } from './SessionsRosterView';

export interface RosterState {
  data: RosterResponse | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * Poll /api/adv/roster while enabled and the tab is visible. `enabled` lets the
 * provider stay mounted across view switches (so the shared shell never
 * remounts) while polling only on the Sessions view.
 */
function useRoster(
  workspaceId: string | null | undefined,
  enabled: boolean,
  intervalMs = 4000,
): RosterState {
  const url = `/api/adv/roster${workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ''}`;
  const [data, setData] = useState<RosterResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error(`status ${r.status}`);
      setData((await r.json()) as RosterResponse);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const id = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [refresh, intervalMs, enabled]);

  return { data, error, loading, refresh };
}

const RosterCtx = createContext<RosterState | null>(null);

export function SessionsRosterProvider({
  workspaceId = null,
  enabled = true,
  children,
}: {
  workspaceId?: string | null;
  /** Poll only while true. Lets the provider stay mounted across views (so the
   *  shared shell isn't remounted) yet poll only on the Sessions view. */
  enabled?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const state = useRoster(workspaceId, enabled);
  return <RosterCtx.Provider value={state}>{children}</RosterCtx.Provider>;
}

export function useRosterData(): RosterState {
  const v = useContext(RosterCtx);
  if (!v) throw new Error('useRosterData must be used within <SessionsRosterProvider>');
  return v;
}
