---
title: Personalization — Theme selector, black theme & custom themes
slug: personalization-theme-selector-2026-05-30
status: active
created: 2026-05-30
updated: 2026-05-30
owner: avi@storewolf.com
---

# Personalization — Theme selector, black theme & custom themes

## Now

**State:** Phase 1 in progress — theme apply mechanism (`lib/theme.ts`), a first
hand-authored `[data-theme="black"]` block, and the pre-paint boot script. No
selector UI yet (Phase 3).

**Next:** Finish Phase 1 (verify the frost↔black swap on `/dev/tokens` through the
Tauri desktop shell, enumerate the leak sites), then Phase 2 (move the black theme
into the DTCG token pipeline).

## Goal

Add a **Theme** section to the Personalization settings tab:

1. A theme selector.
2. A built-in pure-**black** theme alongside the current **blue frost** theme.
3. A strict contract: a theme changes *only* the high-level (semantic) design
   tokens. If swapping those tokens doesn't fully restyle the app, that's a
   token-system robustness bug to fix — not something the theme should paper over.
4. A user-facing custom-theme creator whose themes **save to a local file** and
   show up in the selector.

## Background — surface + the robustness gap

- **Surface.** The Personalization page is `apps/operator/app/settings/personalization/page.tsx`,
  live via the operator-vite re-export at
  `apps/operator-vite/src/routes/settings/personalization.tsx`. It currently has
  one "Visual effects" section backed by `apps/operator/lib/visual-effects.ts`
  (read/write/apply/subscribe + `useSyncExternalStore`, `wsLocalKey`-scoped,
  applied pre-paint by a `<script>` in `app/layout.tsx`). The theme system mirrors
  this exact pattern.

- **The "high tokens".** The ~20 semantic CSS vars in `app/_semantic.css`
  (`--bg`, `--fg`, `--accent`, `--border`, …) — generated from
  `design-tokens/desktop.semantic.tokens.json` by Style Dictionary v4
  (`pnpm tokens`). The current values **are** the blue frost theme (bg `#07101D`,
  fg `#E7F7FF`, accent `sky-400`/`sky-300`, sky-tinted borders, white-glass
  `--frost`).

- **The gap (why req #3 is the real work).** Components do **not** consistently
  route through the semantic layer. In `globals.css` alone: **601** direct
  `var(--sky-300)` + **106** `var(--sky-400)` (reaching past the semantic layer to
  the brand primitive), **315** hardcoded hexes, **3,035** raw `rgba()` literals,
  plus **194** `.tsx` files with inline colors. So overriding only the ~20 semantic
  tokens will leave blue bleeding through wherever those leaks live. **That is the
  predicted "token system not robust enough" symptom.** The plan treats the black
  theme as the acceptance test that *surfaces* the leaks, then re-routes them
  through semantic tokens in staged batches (Phase 5).

## Decisions

- **D-1 Storage → local JSON file via the operator API** (honors the explicit
  "save to a file"). Custom-theme *definitions* (name + token map) persist to a
  per-workspace file under `papercuspPath('themes', ...)`
  (`~/.papercusp-workspaces/<id>/.papercusp/themes/custom.json`), written through
  an endpoint-system route. The *active-theme selection* stays browser-local in
  `localStorage` (per-device, like visual-effects). Noted deviation: the repo's
  PG-by-default storage policy is intentionally overridden here per the explicit
  "to a file" instruction.
- **D-2 Token scope → ship now, stage the cleanup.** Strict semantic-only contract
  from day one; black ships as the leak-detector; the 600+ primitive refs + hex
  leaks get re-pointed at semantic tokens in follow-up batches (Phase 5). Safe
  sequencing of the full refactor — small reviewable diffs, no big-bang regression
  risk to the existing frost theme.
- **D-3 Built-ins → DTCG token pipeline; custom → runtime injection.** Frost =
  current `:root`. Black = a token file → SD emits a `[data-theme="black"]{…}`
  block (keeps black in the DTCG source, token tests, mobile mirror). Custom themes
  inject a `<style>` block at runtime. **Unified apply mechanism: everything is
  driven by `document.documentElement.dataset.theme`.**

## The theme contract (load-bearing)

A theme may set **only** the semantic-token allow-list (`THEME_TOKENS` in
`lib/theme.ts`): the color/overlay tokens from `_semantic.css` — `bg`, `bg-1..4`,
`bg-popover`, `fg`, `fg-dim`, `fg-mute`, `border`, `border-strong`, `accent`,
`accent-strong`, `accent-cool`, `accent-ink`, `good`, `warn`, `bad`, `warn-bg`,
`warn-border`, `frost`, `card-shadow`. Never brand primitives (`--sky-*`), never
literals. This is exactly what makes "not robust enough" a *findable bug* rather
than something a theme can hide.

## Phases

### Phase 1 — Apply mechanism + first black theme (no selector UI)  *(in progress)*
- `apps/operator/lib/theme.ts` — `THEME_TOKENS` allow-list, built-in registry,
  `readActiveTheme`/`writeActiveTheme`/`applyTheme`/`subscribeTheme`/`useActiveTheme`,
  `wsLocalKey`-scoped, applies via `documentElement.dataset.theme`.
- `apps/operator/app/_themes.css` — hand-authored `[data-theme="black"]`
  semantic-only override; imported by `globals.css`.
- Boot `<script>` in `app/layout.tsx` (sets `data-theme` pre-paint, replicating
  `getBrowserWorkspaceId()` so boot + lib agree on the scoped key).
- **Verify:** flip `data-theme` on `/dev/tokens` via the Tauri desktop shell →
  the semantic swatches swap; enumerate the leak sites for Phase 5.

### Phase 2 — Move black into the DTCG pipeline
- `design-tokens/black.semantic.tokens.json` (the ~20 semantic tokens at
  black/grey; `--frost` neutral, status hues kept for usability).
- Extend `design-tokens/style-dictionary.config.mjs` with a `css-semantic-black`
  platform → `_semantic.black.css`, `selector: '[data-theme="black"]'`; import in
  `globals.css`; `pnpm tokens`. Replace the Phase-1 hand-authored block.
- `design-tokens/tokens.test.ts` covers the new token file.

### Phase 3 — Selector UI in Personalization
- Add a **Theme** section to `app/settings/personalization/page.tsx` (reuse
  `../../harness/Select`, matching the Visual-effects section). Lists built-ins +
  custom themes; selecting one calls `writeActiveTheme`.

### Phase 4 — Custom theme creator + file persistence (D-1)
- Endpoint-system route reading/writing `papercuspPath('themes', 'custom.json')`
  (GET list, PUT save, DELETE).
- Editor: start from an existing theme, color-pick each semantic token,
  live-preview (apply to root), name + save. Saved theme writes the file, caches
  resolved CSS to `localStorage` (so the boot script avoids an async-fetch flash),
  and appears in the selector. Include delete.

### Phase 5 — Token-robustness cleanup (staged, ongoing)
- Using the black-theme leak list: re-point `var(--sky-300)`/`var(--sky-400)` →
  `--accent-strong`/`--accent`, introduce any missing semantic roles the leaks
  demand (e.g. an accent-glow token + accent-tint tiers for blue `rgba()` tints,
  analogous to `--bg-2/3/4`), convert hardcoded hexes. Small per-area diffs (nav,
  harness, cards, …), each verified against **both** frost and black.

## Acceptance criteria

- Personalization tab shows a Theme section; switching is instant, persists across
  reloads (no FOUC), per workspace.
- Black is selectable and overrides **only** semantic tokens.
- A user can create/name/save/re-select/delete a custom theme; it persists to a
  local file and survives restart.
- Frost remains pixel-identical to today.
- Remaining blue bleed-through under black is enumerated as the Phase 5 backlog
  (the explicit robustness signal), not hidden.

## Testing

- Run via the Tauri desktop shell only:
  `cd /home/marsh-office/papercupai-workspace/papercusp-desktop && npm run dev`
  (never browse `:3055`/`:3070`). `/dev/tokens` is the swatch-level acceptance
  surface; `verdict` for UI checks.
- `pnpm tokens` after token-JSON edits; `npm run test:affected` after lib/API
  edits; `design-tokens/tokens.test.ts` covers the black token file.

## Risks / notes

- File storage vs PG policy — intentional per D-1; flagged for reviewers.
- Phase 5 is open-ended (600+ leak sites); deliberately incremental and does not
  block shippable Phases 1–4.
- Custom-theme FOUC mitigated by caching resolved CSS in `localStorage` for the
  boot script.
