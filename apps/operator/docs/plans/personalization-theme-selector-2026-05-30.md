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

**State:** Phases 1–3 committed (`3520c73a`, `aa79e095`, `198a2921`). Phase 1 =
apply mechanism (`lib/theme.ts`) + token contract + pre-paint boot script (Next
layout + `operator-vite/index.html`). Phase 2 = black moved into the DTCG pipeline
(`black.semantic.tokens.json` + `css-semantic-black` → generated `_semantic.black.css`
under `[data-theme="black"]`; hand-authored `_themes.css` deleted). Phase 3 = the
**Theme** card picker in `app/settings/personalization/page.tsx`
(`useActiveTheme`/`writeActiveTheme`, per-card live preview swatches scoped via
`data-theme`); frost is now an explicitly scopable `[data-theme="frost"]` block too
(`_semantic.frost.css`) so nested previews render correctly under any active theme.
Verified: `tsc` clean for changed files, `tokens.test` 9/9 (incl. THEME-CONTRACT
guard), `tokens:check` in sync, page compiles in the Vite graph. The on-screen
frost↔black swap is one window-reload away (dev is no-HMR; not hijacked the user's
window) — selector renders + persists; the mechanism is proven.

**Next:** Phase 4 — custom-theme creator (color-pick the semantic tokens, live
preview, save to a local file via an endpoint-system route at
`papercuspPath('themes', …)`, append to the picker). Phase 5 — work the leak
backlog below so black is pixel-clean.

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

**Leak inventory (static, captured 2026-05-30 — these stay blue under black):**
- `app/globals.css`: **601× `var(--sky-300)`**, **106× `var(--sky-400)`** — the bulk;
  re-point to `--accent-strong` / `--accent` (introduce `--accent-soft`/glow + tint
  tiers where a plain accent swap loses nuance).
- `app/globals.css`: ~28 literal sky/cyan hexes (`#38bdf8`×17, `#7dd3fc`×6,
  `#57d7ff`×3, `#d7f3ff`, `#0ea5e9`).
- Component `.tsx` (~80 sites; top offenders): `app/operator-mock/page.tsx` (11),
  `app/adv/harnesses/{HarnessesWorkspace,HarnessTopBar,DetailPanel,IssuesPanel,FeaturesPanel}.tsx`,
  `app/project-docs/page.tsx` (9), `app/harness/dock/AddPanelCatalog.tsx` (6).
- NOT leaks for black: direct `var(--rose-400)` (127) / `--emerald-400` (77) /
  `--amber-400`/`--gold-400` are status hues the black theme intentionally keeps;
  defer unless a future theme needs to restyle status colors.
- Also: the pre-existing `app/_lints/css-tokens.test.ts` failures (undefined
  `--accent-2`, `--fg-danger`, `--bad-bg`, `--danger`, …) belong to this cleanup —
  define them in the semantic layer or replace with existing tokens.

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
