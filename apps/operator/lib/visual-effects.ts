'use client';

import { useSyncExternalStore } from 'react';

export type VisualEffectsMode = 'system' | 'full' | 'minimal';
export type EffectiveVisualEffects = 'full' | 'minimal';

export const VISUAL_EFFECTS_STORAGE_KEY = 'papercusp.visualEffectsMode';
export const VISUAL_EFFECTS_CHANGE_EVENT = 'papercusp:visual-effects-changed';
export const VISUAL_EFFECTS_REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const VISUAL_EFFECTS_MODES = new Set<VisualEffectsMode>(['system', 'full', 'minimal']);

export function isVisualEffectsMode(value: unknown): value is VisualEffectsMode {
  return typeof value === 'string' && VISUAL_EFFECTS_MODES.has(value as VisualEffectsMode);
}

function getReducedMotionPreference(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(VISUAL_EFFECTS_REDUCED_MOTION_QUERY).matches;
}

export function readVisualEffectsMode(): VisualEffectsMode {
  if (typeof window === 'undefined') return 'system';
  try {
    const stored = window.localStorage.getItem(VISUAL_EFFECTS_STORAGE_KEY);
    return isVisualEffectsMode(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function getEffectiveVisualEffects(mode: VisualEffectsMode): EffectiveVisualEffects {
  if (mode === 'minimal') return 'minimal';
  if (mode === 'system' && getReducedMotionPreference()) return 'minimal';
  return 'full';
}

export function applyVisualEffectsMode(mode: VisualEffectsMode = readVisualEffectsMode()): void {
  if (typeof document === 'undefined') return;
  const safeMode = isVisualEffectsMode(mode) ? mode : 'system';
  const effective = getEffectiveVisualEffects(safeMode);
  document.documentElement.dataset.visualEffects = effective;
  document.documentElement.dataset.visualEffectsMode = safeMode;
}

export function writeVisualEffectsMode(mode: VisualEffectsMode): void {
  const safeMode = isVisualEffectsMode(mode) ? mode : 'system';
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(VISUAL_EFFECTS_STORAGE_KEY, safeMode);
    } catch {
      // localStorage can be unavailable in private/embedded contexts; still apply in-memory.
    }
  }
  applyVisualEffectsMode(safeMode);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(VISUAL_EFFECTS_CHANGE_EVENT, {
        detail: { mode: safeMode, effective: getEffectiveVisualEffects(safeMode) },
      }),
    );
  }
}

export function subscribeVisualEffects(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const sync = () => {
    applyVisualEffectsMode();
    listener();
  };

  const handleStorage = (event: StorageEvent) => {
    if (event.key === VISUAL_EFFECTS_STORAGE_KEY) sync();
  };

  window.addEventListener(VISUAL_EFFECTS_CHANGE_EVENT, sync);
  window.addEventListener('storage', handleStorage);

  const media = typeof window.matchMedia === 'function'
    ? window.matchMedia(VISUAL_EFFECTS_REDUCED_MOTION_QUERY)
    : null;
  media?.addEventListener?.('change', sync);
  media?.addListener?.(sync);

  return () => {
    window.removeEventListener(VISUAL_EFFECTS_CHANGE_EVENT, sync);
    window.removeEventListener('storage', handleStorage);
    media?.removeEventListener?.('change', sync);
    media?.removeListener?.(sync);
  };
}

function getVisualEffectsSnapshot(): EffectiveVisualEffects {
  const mode = readVisualEffectsMode();
  applyVisualEffectsMode(mode);
  return getEffectiveVisualEffects(mode);
}

function getServerVisualEffectsSnapshot(): EffectiveVisualEffects {
  return 'full';
}

export function useEffectiveVisualEffects(): EffectiveVisualEffects {
  return useSyncExternalStore(
    subscribeVisualEffects,
    getVisualEffectsSnapshot,
    getServerVisualEffectsSnapshot,
  );
}

export function useFancyEffectsEnabled(): boolean {
  return useEffectiveVisualEffects() === 'full';
}
