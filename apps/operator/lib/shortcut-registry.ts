'use client';

/**
 * Canonical list of every keyboard shortcut the operator binds.
 *
 * Why a registry: shortcuts are user-customizable through
 * `/settings/shortcuts`. The page UI, the cheat-sheet modal, and the
 * runtime bindings all read from this same source of truth so a remap
 * in settings flows through to every surface.
 *
 * To add a new shortcut: add an entry here, then call
 * `useShortcutAction('my.shortcut.id', handler)` from the component
 * that owns the action. The settings page picks it up automatically.
 *
 * Combo grammar:
 *   - `mod+k`              → Cmd on macOS, Ctrl elsewhere
 *   - `mod+shift+p`        → adds Shift modifier
 *   - `mod+k, mod+shift+p` → comma separates alternates (either fires)
 *   - `j, ArrowDown`       → either single key fires the binding
 *   - `g>d`                → sequence: g, then d (within 1 s)
 *   - `slash`, `bracketright`, `Enter`, `Space`, `Escape` → named keys
 *   - Spaces are insignificant; `mod + k` and `mod+k` are equivalent.
 */
import type { ActionOptions } from './shortcut-bus';

export type ShortcutCategory = 'global' | 'navigation' | 'feature-list' | 'editor' | 'palette';

export interface ShortcutDef {
  /** Stable id used for storage + the settings UI. Dotted convention. */
  id: string;
  /** Human-readable label shown in the cheat-sheet + settings page. */
  description: string;
  /** Default combo (or comma-separated alternates). */
  defaultCombo: string;
  category: ShortcutCategory;
  /**
   * Whether this shortcut shows up on the settings page as user-editable.
   * Default true. Set to false for plumbing/glue shortcuts (e.g. an
   * Escape handler that's part of an internal flow, not a real binding
   * a user would want to remap). Mirrors Notion's `customizable` flag.
   */
  customizable?: boolean;
  /**
   * Per-shortcut option defaults (merged before per-call options on
   * `useShortcutAction`). Most relevant for `enableOnFormTags`.
   */
  options?: Partial<ActionOptions>;
}

// Order in this array drives the order in the cheat-sheet + settings UI
// (within each category). Keep related shortcuts adjacent.
export const SHORTCUTS: readonly ShortcutDef[] = [
  // ── Global / palette ────────────────────────────────────────────
  {
    id: 'palette.toggle',
    description: 'Open or close the command palette',
    // Three alternates — any of them fires the toggle:
    //   * Mod+P    — overrides the browser print dialog (Notion-style).
    //                Browsers let preventDefault win on Ctrl/Cmd+P, so
    //                the user gets our palette, not OS print. Requires
    //                `enableOnFormTags` so it works while focus is in a
    //                textarea/input — otherwise Mod+P inside vditor
    //                would still trigger the browser print path.
    //   * Mod+/    — universal-safe (Slack uses this); free in FF/Safari.
    //   * Mod+K    — Linear muscle memory (works on Chrome/Edge; FF +
    //                Safari swallow it for their address-bar search).
    defaultCombo: 'mod+p, mod+/, mod+k',
    category: 'palette',
    options: { enableOnFormTags: ['INPUT', 'TEXTAREA'] },
  },
  {
    id: 'shortcuts.show',
    description: 'Show keyboard-shortcut cheat-sheet',
    defaultCombo: 'shift+slash',
    category: 'palette',
  },
  {
    id: 'operator.toggle',
    description: 'Open or close the Operator panel',
    // mod+; (semicolon) is universally free across Firefox/Chrome/Safari.
    // mod+shift+o is kept as an alternate for muscle memory.
    defaultCombo: 'mod+;, mod+shift+o',
    category: 'global',
  },
  {
    id: 'editor.save',
    description: 'Save the current editor (prompts, memory, etc.)',
    defaultCombo: 'mod+s',
    category: 'editor',
    options: { enableOnFormTags: ['INPUT', 'TEXTAREA'] },
  },

  // ── Tab navigation (Linear-style 2-stroke `g d` / `g s` / …) ────
  {
    id: 'goto.dashboard',
    description: 'Go to Dashboard tab',
    defaultCombo: 'g>d',
    category: 'navigation',
  },
  {
    id: 'goto.summary',
    description: 'Go to Summary tab',
    defaultCombo: 'g>s',
    category: 'navigation',
  },
  {
    id: 'goto.config',
    description: 'Go to Config tab',
    defaultCombo: 'g>c',
    category: 'navigation',
  },
  {
    id: 'goto.brainstorm',
    description: 'Go to Brainstorm tab',
    defaultCombo: 'g>b',
    category: 'navigation',
  },
  {
    id: 'goto.proposals',
    description: 'Go to Proposals tab',
    defaultCombo: 'g>p',
    category: 'navigation',
  },
  {
    id: 'goto.experts',
    description: 'Go to Experts tab',
    defaultCombo: 'g>e',
    category: 'navigation',
  },
  {
    id: 'goto.insights',
    description: 'Go to Insights tab',
    defaultCombo: 'g>i',
    category: 'navigation',
  },

  // ── Feature list ────────────────────────────────────────────────
  {
    id: 'feature.move-down',
    description: 'Move selection down',
    defaultCombo: 'j, ArrowDown',
    category: 'feature-list',
    options: { preventDefault: true },
  },
  {
    id: 'feature.move-up',
    description: 'Move selection up',
    defaultCombo: 'k, ArrowUp',
    category: 'feature-list',
    options: { preventDefault: true },
  },
  {
    id: 'feature.next',
    description: 'Next feature (without focusing the list)',
    defaultCombo: 'bracketright',
    category: 'feature-list',
  },
  {
    id: 'feature.prev',
    description: 'Previous feature (without focusing the list)',
    defaultCombo: 'bracketleft',
    category: 'feature-list',
  },
  {
    id: 'feature.open',
    description: 'Open the selected feature',
    defaultCombo: 'Enter, Space',
    category: 'feature-list',
    options: { preventDefault: true },
  },
  {
    id: 'feature.search',
    description: 'Focus the feature search input',
    defaultCombo: 'slash',
    category: 'feature-list',
    options: { preventDefault: true },
  },
  {
    id: 'feature.search-global',
    description: 'Find a feature (global, overrides browser Find)',
    // Mod+F overrides the browser's in-page find dialog. The global
    // dispatcher (`GlobalShortcutDispatcher`) preventDefaults whenever
    // a registered action runs, so the browser's find bar is skipped.
    // `enableOnFormTags` is required so the binding wins inside vditor /
    // search inputs / etc.
    defaultCombo: 'mod+f',
    category: 'feature-list',
    options: { enableOnFormTags: ['INPUT', 'TEXTAREA'] },
  },
  {
    id: 'feature.reset',
    description: 'Reset the selected feature',
    defaultCombo: 'r',
    category: 'feature-list',
  },
  {
    id: 'feature.toggle-select',
    description: 'Toggle selection of the focused feature',
    defaultCombo: 'x',
    category: 'feature-list',
  },
  {
    id: 'feature.cycle-status',
    description: 'Cycle status of the focused feature (todo → in-progress → passed)',
    defaultCombo: 'mod+Enter',
    category: 'feature-list',
  },
  {
    id: 'feature.search-blur',
    description: 'Blur the search input when typing',
    defaultCombo: 'Escape',
    category: 'feature-list',
    customizable: false, // glue, not a real binding
    options: { enableOnFormTags: ['INPUT'] },
  },
] as const;

const SHORTCUT_BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s] as const));

export function getShortcutDef(id: string): ShortcutDef | undefined {
  return SHORTCUT_BY_ID.get(id);
}

// ── Storage ─────────────────────────────────────────────────────────

const STORAGE_KEY = 'papercusp.shortcuts.v1';

export type OverrideMap = Record<string, string>;

export function loadOverrides(): OverrideMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as OverrideMap) : {};
  } catch {
    return {};
  }
}

export function saveOverride(id: string, combo: string): void {
  if (typeof window === 'undefined') return;
  const all = loadOverrides();
  const trimmed = combo.trim();
  if (!trimmed) {
    delete all[id];
  } else {
    all[id] = trimmed;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  // Notify in-page listeners. localStorage events normally fire only in
  // OTHER tabs; emit a synthetic event so our own components re-bind.
  window.dispatchEvent(new CustomEvent('papercusp:shortcuts-changed'));
}

export function resetOverride(id: string): void {
  saveOverride(id, '');
}

export function resetAllOverrides(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new CustomEvent('papercusp:shortcuts-changed'));
}

export function effectiveCombo(id: string, overrides?: OverrideMap): string {
  const def = SHORTCUT_BY_ID.get(id);
  if (!def) return '';
  const o = overrides ?? loadOverrides();
  return (o[id] ?? def.defaultCombo).trim();
}
