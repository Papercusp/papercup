/**
 * console-color-schemes — a curated catalog of terminal color schemes, one of
 * which is bound PERMANENTLY to each named fleet (agent_fleets.color_scheme).
 *
 * Why a catalog (not a free hash): a fleet should have a STABLE, recognisable
 * identity — every window it opens looks the same, forever — and distinct
 * fleets should look distinct. The fleet store allocates the next UNUSED scheme
 * at fleet:create and persists it (see agent-fleets-store.allocateNextSchemeName);
 * the binding never changes. `schemeForSlug` is the deterministic fallback for
 * legacy rows that predate the column (stable, but may collide).
 *
 * Each scheme is a coordinated triple applied via OSC escapes by
 * console-spawn.buildAppearancePrelude:
 *   - `bg`     → OSC 11 (background)   — dark + saturated so bright ANSI stays legible
 *   - `fg`     → OSC 10 (foreground)   — a light tint, high contrast on `bg`
 *   - `cursor` → OSC 12 (cursor)       — a vivid accent of the same hue family
 *
 * Pure data + pure helpers — no IO. Server + client safe.
 */

/** A coordinated terminal color scheme. All values are `#rrggbb` lowercase hex. */
export interface ColorScheme {
  /** Stable, human-readable id — what gets persisted on agent_fleets.color_scheme. */
  name: string;
  /** Background (OSC 11). Dark. */
  bg: string;
  /** Foreground / default text (OSC 10). Light, high-contrast on bg. */
  fg: string;
  /** Cursor color (OSC 12). A vivid accent. */
  cursor: string;
}

/**
 * The curated catalog — ~3 dozen hand-tuned dark schemes spanning the hue wheel
 * (blues → indigos → purples → magentas → reds → ambers → greens → teals → cyans
 * → neutrals). Order is the allocation order (first fleet gets index 0, etc.),
 * so keep the early entries the most broadly pleasant. Names are STABLE — never
 * rename one (a rename would orphan every fleet bound to it); only append.
 */
// Ordered to SPREAD across the hue wheel — consecutive entries jump colour
// family, so the first N fleets allocated get maximally-distinct looks (not five
// near-identical blues). Names/values are stable; only the order is tuned.
export const COLOR_SCHEMES: readonly ColorScheme[] = [
  { name: 'midnight-slate', bg: '#0f172a', fg: '#e2e8f0', cursor: '#38bdf8' },
  { name: 'royal-purple', bg: '#581c87', fg: '#f5e8ff', cursor: '#d8b4fe' },
  { name: 'forest', bg: '#166534', fg: '#dcfce7', cursor: '#86efac' },
  { name: 'oxblood', bg: '#7f1d1d', fg: '#fee2e2', cursor: '#f87171' },
  { name: 'deep-cyan', bg: '#164e63', fg: '#cffafe', cursor: '#22d3ee' },
  { name: 'burnt-amber', bg: '#78350f', fg: '#fef3c7', cursor: '#fbbf24' },
  { name: 'indigo-velvet', bg: '#312e81', fg: '#e0e7ff', cursor: '#a5b4fc' },
  { name: 'magenta-wine', bg: '#701a4f', fg: '#fce7f3', cursor: '#f472b6' },
  { name: 'teal-abyss', bg: '#134e4a', fg: '#ccfbf1', cursor: '#2dd4bf' },
  { name: 'deep-navy', bg: '#0b1e3b', fg: '#dbeafe', cursor: '#60a5fa' },
  { name: 'plum', bg: '#4a044e', fg: '#fae8ff', cursor: '#e879f9' },
  { name: 'moss', bg: '#14532d', fg: '#dcfce7', cursor: '#4ade80' },
  { name: 'brick', bg: '#4a1010', fg: '#ffe0e0', cursor: '#ff6b6b' },
  { name: 'antique-gold', bg: '#3a2c08', fg: '#fbf0c9', cursor: '#e3b341' },
  { name: 'sapphire', bg: '#102a52', fg: '#dceaff', cursor: '#4f9cf9' },
  { name: 'twilight-violet', bg: '#2e1065', fg: '#ede9fe', cursor: '#a78bfa' },
  { name: 'emerald-deep', bg: '#064e3b', fg: '#d1fae5', cursor: '#6ee7b7' },
  { name: 'mulberry', bg: '#3d0f2e', fg: '#ffe3f1', cursor: '#ff7fb6' },
  { name: 'rust-ember', bg: '#7c2d12', fg: '#ffedd5', cursor: '#fb923c' },
  { name: 'royal-indigo', bg: '#1e1b4b', fg: '#e0e7ff', cursor: '#818cf8' },
  { name: 'lagoon', bg: '#08343a', fg: '#d8f3f5', cursor: '#2bd4d9' },
  { name: 'cobalt', bg: '#15294d', fg: '#dbe7ff', cursor: '#6aa6ff' },
  { name: 'deep-purple', bg: '#3b0764', fg: '#f3e8ff', cursor: '#c084fc' },
  { name: 'pine', bg: '#134e2a', fg: '#d1fae5', cursor: '#34d399' },
  { name: 'crimson-rose', bg: '#831843', fg: '#ffe4e6', cursor: '#fb7185' },
  { name: 'olive-drab', bg: '#3f3f1a', fg: '#fef9c3', cursor: '#fde047' },
  { name: 'petrol', bg: '#0f2e2e', fg: '#d7f0ef', cursor: '#3fb7b0' },
  { name: 'ocean', bg: '#0c4a6e', fg: '#e0f2fe', cursor: '#38bdf8' },
  { name: 'aubergine', bg: '#2d1b2e', fg: '#f3e8f0', cursor: '#c98bbb' },
  { name: 'fern', bg: '#1e3a17', fg: '#e6f5dd', cursor: '#8bd450' },
  { name: 'cinnamon', bg: '#43200f', fg: '#ffe8d6', cursor: '#ff9e64' },
  { name: 'blackcurrant', bg: '#1a1130', fg: '#e8e0ff', cursor: '#b794f6' },
  { name: 'steel-blue', bg: '#1e293b', fg: '#e2e8f0', cursor: '#7dd3fc' },
  { name: 'graphite', bg: '#18181b', fg: '#e4e4e7', cursor: '#a1a1aa' },
  { name: 'espresso', bg: '#231a12', fg: '#f5ede4', cursor: '#d8a657' },
  { name: 'charcoal', bg: '#1c1917', fg: '#e7e5e4', cursor: '#d6d3d1' },
];

/** The fallback scheme for a non-fleet / unresolved context. */
export const DEFAULT_SCHEME: ColorScheme = COLOR_SCHEMES[0]!;

/** Look up a scheme by its stable name. Returns undefined for an unknown name. */
export function schemeByName(name: string | null | undefined): ColorScheme | undefined {
  if (!name) return undefined;
  return COLOR_SCHEMES.find((s) => s.name === name);
}

/**
 * Deterministic slug → scheme — the FALLBACK for legacy fleet rows created
 * before the color_scheme column existed (their persisted value is null). Stable
 * forever for a given slug, but unlike allocation it can collide across slugs.
 * Same hash shape as console-spawn.hashSlugToColor for consistency.
 */
export function schemeForSlug(slug: string): ColorScheme {
  let h = 0;
  for (let i = 0; i < slug.length; i++) {
    h = ((h << 5) - h + slug.charCodeAt(i)) | 0;
  }
  return COLOR_SCHEMES[Math.abs(h) % COLOR_SCHEMES.length]!;
}

/**
 * Allocate the next scheme for a NEW fleet given the schemes already in use in
 * the workspace: the first catalog entry not yet taken (preserving catalog order
 * so early fleets get the broadly-pleasant ones). Once every scheme is in use
 * the catalog wraps deterministically by the in-use count — distinctness is
 * best-effort beyond {@link COLOR_SCHEMES}.length fleets. Returns a scheme NAME.
 */
export function allocateNextSchemeName(usedNames: readonly string[]): string {
  const used = new Set(usedNames);
  const free = COLOR_SCHEMES.find((s) => !used.has(s.name));
  if (free) return free.name;
  return COLOR_SCHEMES[usedNames.length % COLOR_SCHEMES.length]!.name;
}

/**
 * The RAW OSC escape bytes that recolor a live terminal to `scheme`: OSC 10
 * (foreground), OSC 11 (background), OSC 12 (cursor), each BEL-terminated (`\x07`).
 *
 * This is the RUNTIME-recolor sibling of console-spawn's `buildAppearancePrelude`:
 * that one emits a `printf '\033]11;…'` SHELL one-liner the freshly-spawned shell
 * runs at startup; this returns the bytes to write STRAIGHT to a TTY (the psu-pty
 * host's stdout, or the agent's controlling terminal) so an already-open window
 * recolors with no relaunch. Keep the OSC numbers here and there in lockstep.
 *
 * Pure — no IO. The single canonical definition of the recolor sequence; the psu
 * launch path (psu-pty-host.mjs) builds the same bytes inline from the resolved
 * `#rrggbb` env values, so a change here must mirror there.
 */
export function oscRecolorSequence(scheme: ColorScheme): string {
  return `\x1b]10;${scheme.fg}\x07\x1b]11;${scheme.bg}\x07\x1b]12;${scheme.cursor}\x07`;
}
