'use client';

import { useEffect, useState } from 'react';
import { DEFAULT_WORKSPACE_ID } from './workspace-id-constant';

/**
 * Read the active workspace id from the URL ?ws= param. Defaults to
 * DEFAULT_WORKSPACE_ID. Returns null during SSR (window is undefined)
 * and resolves to the real value on first effect tick.
 *
 * Stays in sync with workspace switches: the workspace switcher navigates
 * to /harness?ws=<id>, which triggers a route change; this hook listens
 * to popstate + a synthetic 'workspacechange' event for in-app switches
 * without a full navigation.
 */
export function useWorkspaceId(): string {
  const [ws, setWs] = useState<string>(() => {
    if (typeof window === 'undefined') return DEFAULT_WORKSPACE_ID;
    return new URL(window.location.href).searchParams.get('ws') ?? DEFAULT_WORKSPACE_ID;
  });

  useEffect(() => {
    const update = () => {
      setWs(new URL(window.location.href).searchParams.get('ws') ?? DEFAULT_WORKSPACE_ID);
    };
    window.addEventListener('popstate', update);
    window.addEventListener('workspacechange', update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener('workspacechange', update);
    };
  }, []);

  return ws;
}
