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

**State:** Phases 1–4 committed (`3520c73a`, `aa79e095`, `198a2921`, `611655b0`,
`65d82040`) — **all four original requirements delivered.** Selector + per-theme
live previews (P3), built-in black via the DTCG pipeline (P2), the
semantic-only token contract enforced in code + tests (P1/P2), and the
custom-theme creator that saves to a per-workspace local file (P4:
`lib/theme-tokens.ts` shared contract, `lib/custom-themes.ts` file persistence,
`routes/themes` GET/PUT/DELETE, `ThemeEditor.tsx`, boot-cache FOUC avoidance).
Verified: `tsc` clean for all new files, `tokens.test` 9/9, `theme-tokens` unit
9/9, route-stack/shadowing 20/20. Two known runtime caveats: (a) the `/api/themes`
endpoint goes live on the next operator sidecar restart (tsx, not hot-reloaded);
(b) open desktop windows show stale CSS until reloaded (dev no-HMR). Neither
hijacked the user's live window.

**Next:** Phase 5's **mechanical, frost-safe-by-construction** cleanup is DONE
(batches 1–5, ~1740 conversions). Every batch maps a sky-300/400/cool reference
to its semantic token (`--accent-strong`/`--accent`/`--accent-cool`); all are
frost-identical because `_semantic.css` aliases the token to that exact primitive
and the tokens aren't redefined where edited:
- **B1** (`a6c7ddc5`) `globals.css` `var(--sky-300)`→`--accent-strong` (601) +
  `var(--sky-400)`→`--accent` (106).
- **B2** (`ffa67a92`) `globals.css` literal hexes `#38bdf8`/`#7dd3fc`/`#d7f3ff` →
  accent/accent-strong/accent-cool (24).
- **B3** (`937e072d`) real-UI exact-match component leaks (OperatorChatSidebar ×2,
  AgentThinkingPopover). The "~80 component leaks" were mostly already-correct
  `var(--token,#hex)` fallbacks.
- **B4** (`9579b210`) **997** `rgba()` sky tints across 29 files →
  `color-mix(in srgb, var(--accent-strong|accent), transparent N%)`. ENGINE-VERIFIED
  byte-identical (color-mix-with-transparent in srgb = the exact rgba). Held a lock.
- **B5** (`f6ded881`) cleanly-isolable stragglers: `adv-dock.css` (sky-300 +
  sky-cool → fully theme-following), `admin-tables.css`, `h-proposals.css`.

**B6** (`f4bf08d3`) — accent-tint token scale (`accent-soft`=sky-200,
`accent-deep`=sky-500, `accent-deeper`=sky-700; frost aliases the primitives,
black = monochrome greys) + sweep of **184** rgba sky tints (cool/200/500/700)
across 12 files → `color-mix(in srgb, var(--accent-*))`. Closes the last sky-tint
leaks (incl. the cinematic HUD's sky shades).

### Tauri-verified (drove the live desktop via the dev bridge + screenshots)
Bridge `eval` + `import -window` screenshots confirmed, in the running webview:
- New tints live after reload: `--accent-soft` = `#bae6fd` (frost) / `#d8d8d8` (black).
- **Content panels sample neutral grey** (`#363738`) under black — accents/tints work.
- **BUT chrome surfaces (sidebar, header) still read navy** (`#111A24`, blue > red).

### The real remaining gap: SURFACE navy is a re-skin, not a token-swap
The frost theme's dark base isn't a few `--bg` tokens — it's **~270 distinct
bespoke dark-navy literals** (`rgb(3,10,20)` ×82, `rgb(7,16,29)`=`#07101d` ×44,
`rgb(9,19,34)` ×23, the sidebar's `rgb(6,14,24)→rgb(3,8,15)` gradient, the header's
`rgb(6,13,24)` at ~10 alphas, …) hand-tuned throughout. Because they bypass the
`--bg` tokens, black keeps a faint navy cast on chrome. Making it pure-black means
EITHER:
- (a) **a dark-surface re-skin**: introduce a `--surface-*` scale, route the navy
  family, frost-exact per shade (≈many tokens) — substantial; OR
- (b) **normalize** the navy family → the `--bg` family (one token), accepting a
  *sub-perceptible* frost change (verified: sidebar `#111A25`→`#0F1924`) that
  flattens some bespoke navy depth — fast, and improves token robustness (req #3).

Also note: live SURFACE verification needs a clean desktop rebuild — the running
dev shell served stale component CSS on reload (only regenerated token files
propagated), so surface edits can't be eyeballed without a restart.

**Leave regardless:** decorative multi-hue rotations (`harness.css` tab/log/git
accents `nth-child(1)=sky,(2)=amber,(3)=cyan…`; `plans.css` status palette) —
intentional rainbow, like status colors; `operator-mock` (demo); Chatwoot
`widgetColor` (3rd-party JS); `dev.css` (internal); `#0ea5e9`/`#57d7ff` (no token).

Net: **accents + tints + content are monochrome in black (done, committed);
chrome surfaces retain the frost theme's bespoke navy** — pure-black there is a
deliberate surface re-skin (option a or b above), pending a product call + a clean
desktop rebuild to verify.

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
- ~~`app/globals.css`: 601× `var(--sky-300)`, 106× `var(--sky-400)`~~ — **DONE
  (batch 1, `a6c7ddc5`):** re-pointed to `--accent-strong` / `--accent`. Frost-safe by
  construction. A future refinement could split out `--accent-soft`/glow + tint
  tiers where a plain accent swap loses nuance, but the leak itself is closed.
- ~~`app/globals.css`: ~28 literal sky/cyan hexes~~ — **DONE (batch 2,
  `ffa67a92`):** `#38bdf8→var(--accent)`, `#7dd3fc→var(--accent-strong)`,
  `#d7f3ff→var(--accent-cool)`. Left `#57d7ff`×3 (progress bar) + `#0ea5e9` (sky-500)
  — no semantic token.
- ~~Component `.tsx` "~80 sites"~~ — **mostly NOT leaks:** the survey was largely
  already-correct `var(--accent, #hex)` fallback patterns. Genuine exact-match
  hardcoded leaks **DONE (batch 3, `937e072d`):** `OperatorChatSidebar` ×2,
  `AgentThinkingPopover`. Left: `operator-mock` demo page (low value) + Chatwoot
  `widgetColor` (3rd-party JS, not CSS).
- **REMAINING (needs design + visual check):** ~202 component `rgba()` sky tints
  (`rgba(125,211,252,α)` ×154, `rgba(56,189,248,α)` ×48) at arbitrary alphas →
  introduce `--accent-tint-*` tokens or use `color-mix(in oklab, var(--accent-strong),
  transparent N%)`, per occurrence. `globals.css` itself has **0** of these (it
  flows through `var(--border)`/`var(--accent)` already).
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
