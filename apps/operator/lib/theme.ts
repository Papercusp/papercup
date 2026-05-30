'use client';

/**
 * Color-theme selection for the operator UI.
 *
 * Mirrors the `lib/visual-effects.ts` pattern (read/write/apply/subscribe +
 * `useSyncExternalStore`, `wsLocalKey`-scoped, applied pre-paint by a boot
 * `<script>` in `app/layout.tsx`). The *active theme selection* is a per-device
 * browser-local preference; *custom theme definitions* persist to a local file
 * (Phase 4).
 *
 * Apply mechanism — one path for every theme: `document.documentElement
 * .dataset.theme = '<id>'`. Built-in themes resolve via generated CSS selector
 * blocks (`:root` = frost default, `[data-theme="black"]`); custom themes
 * (Phase 4) inject a `<style>` block keyed on `[data-theme="custom:<id>"]`.
 *
 * The theme contract (load-bearing): a theme may set ONLY the semantic tokens in
 * {@link THEME_TOKENS} — never brand primitives (`--sky-*`) or raw literals. If
 * swapping those tokens doesn't fully restyle the app, that's a token-system
 * robustness bug to fix (re-route the leak through a semantic token), not
 * something a theme should work around. See
 * `docs/plans/personalization-theme-selector-2026-05-30.md`.
 */
import { useSyncExternalStore } from 'react';
import { wsLocalKey } from '@/lib/browser-workspace';

export const THEME_STORAGE_KEY = 'papercusp.theme';
export const THEME_CHANGE_EVENT = 'papercusp:theme-changed';

/**
 * The semantic-token allow-list — the only CSS variables a theme may set.
 * Source of truth: the color/overlay tokens in `app/_semantic.css` (generated
 * from `design-tokens/desktop.semantic.tokens.json`). Kept in sync by hand; the
 * Phase-2 DTCG black file and the Phase-4 custom-theme editor both operate on
 * exactly this set.
 */
export const THEME_TOKENS = [
  'bg', 'bg-1', 'bg-2', 'bg-3', 'bg-4', 'bg-popover',
  'fg', 'fg-dim', 'fg-mute',
  'border', 'border-strong',
  'accent', 'accent-strong', 'accent-cool', 'accent-ink',
  'good', 'warn', 'bad', 'warn-bg', 'warn-border',
  'frost', 'card-shadow',
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

export const BUILTIN_THEME_IDS = ['frost', 'black'] as const;
export type BuiltinThemeId = (typeof BUILTIN_THEME_IDS)[number];

/** Frost is the `:root` default — the base semantic layer in `_semantic.css`. */
export const DEFAULT_THEME_ID: BuiltinThemeId = 'frost';

export interface ThemeMeta {
  id: string;
  label: string;
  builtin: boolean;
}

export const BUILTIN_THEMES: ThemeMeta[] = [
  { id: 'frost', label: 'Blue frost', builtin: true },
  { id: 'black', label: 'Black', builtin: true },
];

const CUSTOM_PREFIX = 'custom:';

/**
 * A theme id is valid if it's a known built-in or a `custom:<id>` id. Custom
 * themes have no CSS until Phase 4, but the id shape is accepted now so a
 * previously-saved selection round-trips instead of silently resetting.
 */
export function isValidThemeId(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  if ((BUILTIN_THEME_IDS as readonly string[]).includes(value)) return true;
  return value.startsWith(CUSTOM_PREFIX) && value.length > CUSTOM_PREFIX.length;
}

export function readActiveTheme(): string {
  if (typeof window === 'undefined') return DEFAULT_THEME_ID;
  try {
    const stored = window.localStorage.getItem(wsLocalKey(THEME_STORAGE_KEY));
    return isValidThemeId(stored) ? stored : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function applyTheme(id: string = readActiveTheme()): void {
  if (typeof document === 'undefined') return;
  const safe = isValidThemeId(id) ? id : DEFAULT_THEME_ID;
  document.documentElement.dataset.theme = safe;
}

export function writeActiveTheme(id: string): void {
  const safe = isValidThemeId(id) ? id : DEFAULT_THEME_ID;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(wsLocalKey(THEME_STORAGE_KEY), safe);
    } catch {
      // localStorage can be unavailable in private/embedded contexts; still apply in-memory.
    }
  }
  applyTheme(safe);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { id: safe } }));
  }
}

export function subscribeTheme(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const sync = () => {
    applyTheme();
    listener();
  };

  const handleStorage = (event: StorageEvent) => {
    if (event.key === wsLocalKey(THEME_STORAGE_KEY)) sync();
  };

  window.addEventListener(THEME_CHANGE_EVENT, sync);
  window.addEventListener('storage', handleStorage);

  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, sync);
    window.removeEventListener('storage', handleStorage);
  };
}

function getThemeSnapshot(): string {
  const id = readActiveTheme();
  applyTheme(id);
  return id;
}

function getServerThemeSnapshot(): string {
  return DEFAULT_THEME_ID;
}

export function useActiveTheme(): string {
  return useSyncExternalStore(subscribeTheme, getThemeSnapshot, getServerThemeSnapshot);
}
