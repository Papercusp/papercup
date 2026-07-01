'use client';

/**
 * React hooks that wrap @papercusp/flags/client with subscription so
 * components re-render when flag values change.
 *
 * Lives in apps/operator (not libs/flags) so libs/flags can stay
 * react-free and bundle into any client surface (Tauri webview,
 * non-React mobile, etc.).
 */
import { useEffect, useState } from 'react';

import type { FlagKey, FlagValues } from '@papercusp/flags';
import { FLAG_DEFAULTS } from '@papercusp/flags';
import {
  getFlagSnapshot,
  loadFlags,
  subscribe,
  subscribeToFlagStream,
} from '@papercusp/flags/client';
import { reportSyncReachable, reportSyncUnreachable } from '@papercusp/sync';

let bootstrapStarted = false;
let streamSub: { close(): void } | null = null;

// The flags stream is always-on, app-wide infrastructure (mounted once for
// the whole session via `useFlag`'s bootstrap) — a sustained failure to
// reach it is a real "operator unreachable" signal, not a per-component
// concern. Feed the SAME shared connectivity store `@papercusp/sync`'s own
// SSE transport reports to (SSEAdapter.tsx), so a down operator surfaces as
// ONE consolidated "operator connection lost" toast (OfflineIndicator)
// instead of each independent stream silently reconnect-looping on its own
// with no user-visible signal beyond raw console network-error spam.
function ensureBootstrap(): void {
  if (bootstrapStarted) return;
  bootstrapStarted = true;
  if (typeof window === 'undefined') return;
  void loadFlags().catch(() => {
    // network failures fall back to FLAG_DEFAULTS via getFlagSnapshot
  });
  streamSub = subscribeToFlagStream(undefined, {
    onOpen: () => reportSyncReachable(),
    onStatusChange: (status) => {
      if (status === 'failing') reportSyncUnreachable();
    },
  });
}

export function useFlag(key: FlagKey): boolean {
  ensureBootstrap();
  const [value, setValue] = useState<boolean>(() => {
    const snap = getFlagSnapshot();
    return snap.flags[key] ?? FLAG_DEFAULTS[key];
  });
  useEffect(() => {
    const unsub = subscribe((next: FlagValues) => {
      setValue(next[key] ?? FLAG_DEFAULTS[key]);
    });
    return unsub;
  }, [key]);
  return value;
}
