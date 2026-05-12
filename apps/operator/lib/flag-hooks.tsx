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

let bootstrapStarted = false;
let streamSub: { close(): void } | null = null;

function ensureBootstrap(): void {
  if (bootstrapStarted) return;
  bootstrapStarted = true;
  if (typeof window === 'undefined') return;
  void loadFlags().catch(() => {
    // network failures fall back to FLAG_DEFAULTS via getFlagSnapshot
  });
  streamSub = subscribeToFlagStream();
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
