---
title: Ctrl+F find-in-page for the desktop (operator Vite SPA)
slug: find-in-page-ctrl-f-2026-06-01
status: shipped
created: 2026-06-01
updated: 2026-06-01
owner: aviynw3@gmail.com
---

# Ctrl+F find-in-page for the desktop (operator Vite SPA)

## Now

**State:** Built + **verified working end-to-end in the running Tauri shell** (P-009, commits df8c54801 + 1c82283ea). Manual verification via tauri-agent-tools caught a real bug the headless checks missed — react-css-highlight's `targetRef` is non-reactive, so the feature was initially dead (D-008); fixed by holding `<main>` in state. Confirmed live: Ctrl+F opens (`?find=1`), typing registers `CSS.highlights['papercup-find']` (8 matches) + `['papercup-find-active']` (1), count `1/8`, Enter/Shift+Enter navigate, Esc clears all highlights + `?find`. D-007's two assumptions both confirmed (exact highlight name; `onPaint` timing). Vitest green; `vite build` green; the `::highlight()` CSS rules survive lightningcss minify into the live sheets.

**Next:** Two follow-ups remain: run the committed Playwright spec under a real dev server (P-008), and update root package-lock.json once `npm install` is unbroken (P-010 / D-006).

## Background

### Why this plan exists

In a normal browser, Ctrl+F is free. In a Tauri desktop webview it is not, and the
behaviour is platform-split:

| Platform | Webview | Native Ctrl/Cmd+F |
|---|---|---|
| Windows | WebView2 | works (built-in find bar) |
| macOS | WKWebView | does nothing (tauri#9385, open) |
| Linux | WebKitGTK 4.1 | no built-in find UI |

Research findings (2026-06-01):
- **No Tauri/wry API.** `wry::WebView` (docs.rs v0.55.1) exposes 24 methods, none
  find/search. wry#585 ("find string in web content") is open, "nice to have",
  unimplemented for years. tauri#9385 / tauri#7891 are open with no API planned.
- **No turnkey library.** crates.io / npm / awesome-tauri have no
  `tauri-plugin-find-in-page`. The npm packages that call themselves find-in-page
  widgets (`react-ctrl-f`, `react-highlight-words`) require wrapping content in
  their own components / `<mark>` tags — they cannot find arbitrary rendered DOM,
  and are not Custom-Highlight-API based.
- **The web platform has the right primitive.** The CSS Custom Highlight API
  (`CSS.highlights` + `Range` + `::highlight()`) is Baseline since 2025-06 and
  supported on all three Tauri webview engines. It is literally how browsers
  implement their own Find — no DOM mutation, no layout thrash, no fighting React's
  reconciler. Firefox styling caveats are irrelevant (Tauri webviews are never
  Firefox).
- **Engine libraries exist; full widgets do not.** `react-css-highlight` (yairEO,
  MIT, v3.1.0 2026-05, TS-first) and `highlight-search-term` (marmelab, MIT) both
  wrap the Custom Highlight API but stop at "highlight all matches + a count" —
  neither does active-match navigation, scroll-to-match, or a find-bar UI.

### Decision

Use `react-css-highlight` for the highlighting engine (it owns the genuinely fiddly
TreeWalker → `Range` → `CSS.highlights.set` matching, with case/whole-word/debounce)
and build the find bar + active-match navigation ourselves. See D-001..D-005.

### Live surfaces (verified 2026-06-01)

- **Mount point:** `apps/operator-vite/src/routes/__root.tsx` — global overlays
  (`<GlobalCommandPalette/>` L102, `<GlobalShortcutDispatcher/>` L78) and the main
  content container `<main data-route-transition-page>` L113. `<NuqsAdapter>`
  (tanstack-router) at L95.
- **Shortcuts:** shared `apps/operator/lib/shortcut-registry.ts` +
  `hotkeys.ts` (`useShortcutAction`); dispatcher
  `apps/operator/app/_components/GlobalShortcutDispatcher.tsx` is mounted in the
  live SPA (the `@/app/_components/*` shared overlays are imported by operator-vite —
  that dir is *not* fully dead).
- **`feature.search-global`** (registry L221, default `mod+f`) is **defined but has
  no `useShortcutAction` handler anywhere** → pressing Ctrl+F today is a no-op.
- **Palette pattern to mirror:** `GlobalCommandPalette.tsx` uses
  `useQueryState('palette', parseAsBoolean.withDefault(false))` for open-state and a
  `useShortcutAction` for the toggle.
- **xterm find (UX to mirror):** `apps/operator/app/harness/PiPanel.tsx` (find input
  ~L887): Enter→next, Shift+Enter→prev, Esc→close+clear, `×` button.
- `react-css-highlight` is **not** yet a dependency; no existing `CSS.highlights` /
  `::highlight()` usage in the repo.

## Design

### Components (as built)

1. **`apps/operator/app/_components/GlobalFindInPage.tsx`** — the find bar overlay +
   controller. Open-state via nuqs `?find` (boolean); query + `activeIndex` +
   `matchCount` in `useState`. Drives `useHighlight` (engine) via `onPaint`; renders
   the bar; owns keyboard inside the input. Scrolls only on a user action
   (type / next / prev), never on a background repaint.
2. **`apps/operator/lib/find-in-page/engine.ts`** — framework-free helpers. Pure
   (unit-tested): `nextIndex`/`prevIndex`/`formatMatchLabel`/`orderRanges`. DOM:
   `collectOrderedRanges` (reads `CSS.highlights.get('papercup-find')`),
   `setActiveHighlight` (the `papercup-find-active` highlight),
   `clearActiveHighlight`/`clearHighlight`, `scrollRangeIntoView`,
   `isHighlightApiSupported`. (Plan originally said `find-in-page-engine.ts` beside
   the component; as built it's a `lib/` module — logic in `lib/`, UI in `app/`.)
3. **`apps/operator/app/find-in-page.css`** — `::highlight(papercup-find)` +
   stronger `::highlight(papercup-find-active)` (theme tokens), plus the `.pc-find*`
   bar chrome. Imported in `__root.tsx` beside `command-palette.css` (a `::highlight()`
   pseudo cannot be CSS-module-scoped).

Edits: `__root.tsx` (mount `<GlobalFindInPage/>` + css import); `shortcut-registry.ts`
+ `shortcut-bus.ts` (repurpose `feature.search-global` → `find.open`).

### Data flow

`Ctrl+F` → dispatcher → `find.open` handler → `setOpen(true)`, focus input →
type (debounced) → `react-css-highlight` re-registers `CSS.highlights['papercup-find']`
within `<main>` → `onPaint` → engine `collectOrderedRanges` → `activeIndex=0` →
`setActiveHighlight` + scroll → `matchCount` shown → Enter/Shift+Enter step
`activeIndex` → Esc/close → clear highlights + reset + restore focus. Content change
(navigation/lazy load) re-runs the search via a debounced MutationObserver on `<main>`.

### Decisions baked in

- **Engine target** = the `<main>` ref; sidebar/header/Toaster/find-bar chrome
  excluded by targeting `<main>` only.
- **Keybinding** = `Mod+F` via repurposing the dead `feature.search-global`
  (D-003). `/` still focuses the feature-panel filter.
- **State split** = open in nuqs, query/index in useState (D-004).
- **No feature flag** (D-005).

## Phase 1 — Build

- **P-000** `done` Spike via library source-inspection (headless, not a running
  route): `react-css-highlight` registers via `CSS.highlights.set(highlightName, …)`
  with OUR controllable name, and exposes `onPaint`/`onHighlightChange` — so we read
  ranges back from `CSS.highlights.get('papercup-find')`. Zero runtime deps. Scroll
  approach chosen: `range.startContainer.parentElement.scrollIntoView({block:'center'})`
  (walks every scroll ancestor). The two assumptions this could not confirm headlessly
  are tracked in D-007.
- **P-001** `done` Declared `react-css-highlight@^3.1.0` in
  `apps/operator-vite/package.json`. **Placed in `node_modules` via `npm pack` +
  extract** because `npm install` is broken repo-wide (D-006). `vite build` green.
- **P-002** `done` `apps/operator/app/find-in-page.css` with the two `::highlight()`
  rules (theme tokens) + `.pc-find*` chrome; imported in `__root.tsx`.
- **P-003** `done` `apps/operator/lib/find-in-page/engine.ts` (pure + DOM helpers).
- **P-004** `done` `apps/operator/app/_components/GlobalFindInPage.tsx` (nuqs `?find`,
  `find.open` shortcut, debounced `useHighlight`, bar UI, Enter/Shift+Enter/Esc,
  aria-live count, focus-restore, scroll-only-on-user-action, MutationObserver re-run).
- **P-005** `done` Renamed `feature.search-global` → `find.open` in
  `shortcut-registry.ts` (category navigation, desc "Find in page") + the id-claim in
  `shortcut-bus.ts` (+ its test). Grep confirmed no other references.
- **P-006** `done` Mounted `<GlobalFindInPage/>` in `__root.tsx` beside the palette.
  Content-change re-run via a debounced MutationObserver on `<main>` (chosen over a
  hard location-change reset so find keeps working across navigation).
- **P-007** `done` `apps/operator/lib/find-in-page/engine.test.ts` — 11 Vitest tests
  green (index wrap-around, label, real-jsdom document-order range sort). Plus the bus
  claim test in `shortcut-bus.test.ts` (13 green).
- **P-008** `done (written, NOT executed)` `apps/operator/e2e/find-in-page.spec.ts` —
  derives a guaranteed-present term from `<main>`, asserts the count, the
  `papercup-find` / `papercup-find-active` highlight sizes, Enter nav, and Esc
  teardown. Needs the running dev stack; not run headlessly this session. OWED: run it.
- **P-009** `done` **Manual verify in the Tauri shell** (`cd papercusp-desktop && (verified in the Tauri shell via tauri-agent-tools commit 1c82283ea: Ctrl+F→8 highlights, 1/8 count, Enter/Shift+Enter nav, Esc clears all + ?find. Found+fixed a real bug D-008.)
  npm run dev`) on docs viewer + chat transcript + a long list — NOT a browser at
  :3055. Confirm D-007's two assumptions. OWED.
- **P-010** `todo` Install/lockfile follow-up (D-006): once `npm install` works again,
  run a proper install so root `package-lock.json` records `react-css-highlight`,
  otherwise a clean `npm ci` will miss it.

## Risks & open questions

- **Range access for navigation** — RESOLVED: the lib's JS API returns only
  `matchCount`, but we read ranges from `CSS.highlights.get('papercup-find')`. (The
  name-suffix risk is the open half — D-007.)
- **Scroll-into-view from a `Range`** — chosen approach is parent-element
  `scrollIntoView({block:'center'})`; confirm it centres correctly in nested scroll
  containers during P-009.
- **Canvas content** (xterm terminal) is unsearchable by DOM find — acceptable; the
  terminal keeps its own `Ctrl+Shift+F`.
- **Hidden / virtualized content** — `display:none`, closed `<details>`, and
  virtualized rows aren't in the live DOM, so matches there won't highlight/scroll.
  Known limitation.
- **Browser support** — all three target webviews support the API; the bar shows
  "Find isn’t supported in this webview" via the lib's `isSupported` otherwise.

## Testing

Per the four-framework rule (`testing/index.mdx` §1.0a): **Vitest** unit for the
pure engine math + the bus claim (green); **Playwright** spec in `apps/operator/e2e/`
for the real find flow (written; run pending a dev stack); plus **manual**
Tauri-shell verification (P-009, owed). No Cargo / LLM-scenario coverage applies.

## Decisions

### D-001 — Engine = react-css-highlight; the find bar + navigation are ours
Date: 2026-06-01
No library provides a complete Ctrl+F widget on the Custom Highlight API; the ones
that advertise it wrap content in their own components and can't search arbitrary
DOM. `react-css-highlight` (MIT, actively maintained, by the Tagify author) owns the
hard engine part — TreeWalker traversal, `Range` building, `CSS.highlights`
registration, case/whole-word/debounce. What no library does — active-match
navigation, scroll-to-match, the bar — is small and stays in-house. The only
counter-argument is depending on a niche (17-star) package for an engine we could
hand-roll in ~120 lines; we accept the dep for now and keep a clean fallback (run our
own TreeWalker) flagged at P-000, since the author is credible and the package is
current.

### D-002 — Mechanism = CSS Custom Highlight API (not mark.js, not native Rust)
Date: 2026-06-01
The API is purpose-built for find-in-page, mutates no DOM (so no layout thrash and no
conflict with React's reconciler — unlike `mark.js`/`<mark>` wrapping), is Baseline
on all three Tauri webviews, and needs zero per-platform Rust (unlike bridging
`WebKitFindController` / WKWebView find, which WebView2 can't even match). It is also
strictly better than leaning on native find, which exists only on Windows and can't
be styled to match the app.

### D-003 — Claim Mod+F by repurposing the dead `feature.search-global`
Date: 2026-06-01
`feature.search-global` (Mod+F) is registered in the shared registry but has no
`useShortcutAction` handler, so Ctrl+F is currently a no-op — there is no working
feature to displace. We rename it to `find.open` (keeping `mod+f`). Ctrl+F is the
universally-expected find-in-page binding; the feature-panel filter remains reachable
via `/` (`feature.search`) and its filter buttons, which serve a different purpose
(filter the list) than find (highlight + scroll). Bold, clean, breaks nothing.

### D-004 — Open-state in nuqs (`?find`); query + active index in useState
Date: 2026-06-01
Per CLAUDE.md, a panel's open/closed flag is user-meaningful and agent-drivable →
nuqs (mirrors the palette's `?palette=1`, lets an agent open find via `ui:dispatch`).
The live search term is "typing-in-progress that would lose on reload" — explicitly a
`useState` case in CLAUDE.md's own list — and keeping it out of the URL avoids
per-keystroke history churn. `activeIndex`/`matchCount` are render-only → useState. A
later enhancement could lift the term into nuqs for full agent-driven find; not now.

### D-005 — No feature flag
Date: 2026-06-01
Find-in-page is core, always-on UX, not one of the cut-for-V1 surfaces the flag
system gates. Gating it would add a kill-switch for something we will never cut.

### D-006 — Dependency placed via tarball; root lockfile NOT updated
Date: 2026-06-01
Every form of `npm install` fails repo-wide with `EUNSUPPORTEDPROTOCOL` on the
`workspace:*` dep in `packages/agent-mcp/package.json` (npm 11 doesn't support that
protocol; `--workspaces=false` doesn't help — npm still reads the tree). To unblock,
`react-css-highlight@3.1.0` (zero runtime deps; React 19 peer already present) was
fetched with `npm pack` OUTSIDE the workspace and extracted into
`node_modules/react-css-highlight`, and declared in `apps/operator-vite/package.json`.
The dev build + tests work, but **root `package-lock.json` was not updated**, so a
clean `npm ci` would miss it (P-010). This doesn't regress an otherwise-green install:
`npm ci` is already broken by the same `workspace:*` issue.

### D-007 — Two runtime assumptions to confirm in the manual pass (P-009)
Date: 2026-06-01
P-000 was source-inspection (headless), not a running webview. Two things must be
eyeballed in the Tauri shell: (1) **Highlight name** — we assume the lib registers
under exactly `highlightName`, so `::highlight(papercup-find)` styling +
`CSS.highlights.get('papercup-find')` both match; if the lib suffixes the name,
matches won't render → adjust the CSS name / read-back. (2) **Paint timing** — we
read ranges in `onPaint`, assuming the registry is written by then (the lib defers
painting via `requestIdleCallback`); if navigation lags a keystroke, switch to
`onHighlightChange` or re-read on a microtask.

### D-008 — Manual Tauri verification found a real bug — react-css-highlight's targetRef is non-reactive
Date: 2026-06-01
Date: 2026-06-01
P-009 (driving the running Tauri shell via tauri-agent-tools) caught a bug that all the headless checks — Vitest, vite build, the source-inspection spike — missed: the feature was completely dead (no highlight ever registered). Root cause: `react-css-highlight`'s create-effect reads `targetRef.current` only when its deps `[targetRef, isSupported]` change — i.e. ONCE at mount — then `createHighlight(targetRef.current, …)` or, if null, hits an early-return guard. Refs aren't reactive, so a `targetRef` whose `.current` is populated AFTER mount (our case: `<main>` resolved via querySelector in an effect) is captured as null and never re-read. No dev warning fired because the desktop serves a production build (the lib's `console.warn` is `NODE_ENV==='development'`-gated). Fix (commit 1c82283ea): hold `<main>` in `useState` and pass the lib a fresh ref object per element (`useMemo(() => ({current: mainEl}), [mainEl])`), so the create-effect's `[targetRef]` dep identity changes when `<main>` resolves and the effect re-runs with a non-null target. This also resolves D-007: verified live that the lib registers under exactly `papercup-find` (CSS + read-back names match) and that reading ranges in `onPaint` is correctly timed. Lesson: when a hook takes a `RefObject` target, assume it reads `.current` at its own effect time — give it a target that exists by then (attach the ref to rendered JSX, or key a fresh ref object off state), don't populate the ref asynchronously.
Related: P-009

### D-009 — Find bar is solid + top-centered (design refinement)
Date: 2026-06-01
Date: 2026-06-01
User feedback after P-009: the bar used the translucent `--bg-2` glass token, so page text bled through and the bar's own text was hard to read; the top-right corner also crowded the window controls + top-right toaster. Refined (commit 834853e67): background → solid `--bg-popover` (the popover surface tier; `--bg-2/3/4` are deliberately white-glass per the theme scale); position → top-centered (`top:60px` below the header, `left:50%`), which clears the left chat sidebar and the right-side toasts; plus a leading search icon, a count/nav divider, and `--accent-ink` text on the active-match highlight. Verified live in the Tauri shell via tauri-agent-tools: `getComputedStyle(.pc-find).backgroundColor === rgb(13,24,41)` at `opacity:1` (solid), centered (center-offset 0px), icon + divider present, and the search still functions (1/1).
