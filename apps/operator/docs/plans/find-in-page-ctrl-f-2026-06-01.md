---
title: Ctrl+F find-in-page for the desktop (operator Vite SPA)
slug: find-in-page-ctrl-f-2026-06-01
status: draft
created: 2026-06-01
updated: 2026-06-01
owner: aviynw3@gmail.com
---

# Ctrl+F find-in-page for the desktop (operator Vite SPA)

## Now

**State:** Draft — design settled, awaiting greenlight. Approach: a browser-style
find bar built on the **CSS Custom Highlight API**, using **`react-css-highlight`**
as the highlighting *engine* plus a small in-house find-bar + match-navigation
*wrapper*. Research confirmed there is **no** Tauri/wry/plugin native find API and
**no** drop-in find-in-page widget library on the Custom Highlight API — native
webview find is inconsistent (WebView2 yes; WKWebView + WebKitGTK no). Live surfaces
mapped: mount in `apps/operator-vite/src/routes/__root.tsx` beside
`<GlobalCommandPalette/>`; reuse the shared shortcut registry
(`apps/operator/lib/shortcut-registry.ts` + `hotkeys.ts`). **Key unlock:**
`feature.search-global` (Mod+F) is a registered-but-unimplemented no-op, so Ctrl+F
can be claimed with zero conflict.

**Next:** Human greenlights → **P-000** spike (confirm `react-css-highlight` honours
a stable `highlightName` and that `CSS.highlights.get(name)` yields iterable ranges
for navigation), then P-001..P-009 in order.

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

### Components (3 new units + 2 edits)

1. **`GlobalFindInPage.tsx`** (new, `apps/operator/app/_components/`, beside
   `GlobalCommandPalette.tsx`) — the find bar overlay + controller. Open-state via
   nuqs `?find` (boolean); query + `activeIndex` + `matchCount` in `useState`.
   Drives the engine; renders the bar; owns keyboard inside the input.
2. **`find-in-page-engine.ts`** (new, beside the component) — framework-free
   navigation logic layered on the highlight the engine registers:
   - `collectOrderedRanges(name)` → read `CSS.highlights.get(name)`, spread to an
     array, sort by document order via `a.compareBoundaryPoints(Range.START_TO_START, b)`.
   - `setActiveRange(ranges, i)` → register a second highlight `find-active`
     containing only `ranges[i]`, then `scrollRangeIntoView(ranges[i])`.
   - `scrollRangeIntoView(range)` → from `range.getBoundingClientRect()`; if out of
     view, scroll (anchor-element approach finalised in P-000).
   - `nextIndex/prevIndex(i, len)` → wrap-around.
   - `clearHighlights()` → `CSS.highlights.delete('find-all'|'find-active')`.
3. **Global `::highlight()` CSS** — `::highlight(find-all)` and a stronger
   `::highlight(find-active)`, using theme surface/accent **tokens** (not literals).
   Must live in a document-level stylesheet (pseudo can't be CSS-module-scoped).

Edits: `__root.tsx` (mount `<GlobalFindInPage/>`); `shortcut-registry.ts` (repurpose
`feature.search-global` → `find.open`).

### Data flow

`Ctrl+F` → dispatcher → `find.open` handler → `setOpen(true)`, focus input →
type (debounced) → `react-css-highlight` re-registers `CSS.highlights['find-all']`
within `<main>` → engine `collectOrderedRanges` → `activeIndex=0` → `setActiveRange`
+ scroll → `matchCount` shown → Enter/Shift+Enter step `activeIndex` → Esc/close →
`clearHighlights()` + reset + restore focus. Route change resets find.

### Decisions baked in

- **Engine target** = the `<main>` ref; sidebar/header/Toaster/find-bar chrome
  excluded by targeting `<main>` only.
- **Keybinding** = `Mod+F` via repurposing the dead `feature.search-global`
  (D-003). `/` still focuses the feature-panel filter.
- **State split** = open in nuqs, query/index in useState (D-004).
- **No feature flag** (D-005).

## Phase 1 — Build

- **P-000** `todo` Spike (½ day): add `react-css-highlight` in a throwaway route;
  confirm (a) it honours a stable `highlightName`, (b) `CSS.highlights.get(name)`
  returns iterable ranges we can order, (c) the robust `scrollRangeIntoView` variant
  (anchor element vs nearest-scrollable). Output: a 1-paragraph note appended here +
  the chosen scroll approach. Gates the rest.
- **P-001** `todo` Add `react-css-highlight` to `apps/operator-vite/package.json`;
  pin a version; `npm i`. Confirm it bundles under Vite (ESM) and `isSupported` is
  true in the Tauri webview. blocked-by: P-000.
- **P-002** `todo` Add the global `::highlight(find-all)` / `::highlight(find-active)`
  rules to the SPA's global stylesheet (confirm whether that is a `main.tsx` CSS
  import or inline in `index.html`); use theme tokens. blocked-by: P-000.
- **P-003** `todo` Write `find-in-page-engine.ts` (`collectOrderedRanges`,
  `setActiveRange`, `scrollRangeIntoView`, `nextIndex/prevIndex`, `clearHighlights`)
  per the P-000 findings. blocked-by: P-000.
- **P-004** `todo` Write `GlobalFindInPage.tsx`: nuqs `?find` open-state,
  `useShortcutAction('find.open', …)`, debounced query→engine, bar UI (input, count
  "N / M", up/down/×), input keydown (Enter/Shift+Enter/Esc), aria-live count,
  focus-restore on close. Mirror xterm find UX. blocked-by: P-001, P-002, P-003.
- **P-005** `todo` Repurpose `feature.search-global` → `find.open` in
  `shortcut-registry.ts` (keep `mod+f`; description "Find in page"; category
  navigation; keep `enableOnFormTags`). Grep + update any references. blocked-by: P-004.
- **P-006** `todo` Mount `<GlobalFindInPage/>` in `__root.tsx` beside
  `<GlobalCommandPalette/>`. Reset find state on TanStack-Router location change.
  blocked-by: P-004.
- **P-007** `todo` Vitest unit tests `find-in-page-engine.test.ts`: `nextIndex/prevIndex`
  wrap-around, query normalization, range ordering against mock ranges. blocked-by: P-003.
- **P-008** `todo` Playwright e2e `apps/operator/e2e/find-in-page.spec.ts`: Ctrl+F →
  type known term on a content route → assert count text + `CSS.highlights.get('find-all').size`
  via `page.evaluate` → Enter cycles + scrolls → Shift+Enter reverses + wraps → Esc
  closes + highlights cleared. blocked-by: P-006.
- **P-009** `todo` Manual verify in the **Tauri shell**
  (`cd papercusp-desktop && npm run dev`) on docs viewer + chat transcript + a long
  list — NOT a browser at :3055. Run `npm run test:affected`. blocked-by: P-006.

## Risks & open questions

- **Range access for navigation** — the lib's JS API returns only `matchCount`.
  Mitigation: read ranges from the global `CSS.highlights.get(highlightName)`
  registry directly. P-000 confirms this is viable; if the lib mangles or rotates
  the name, fall back to running our own `TreeWalker` (the lib then only saves the
  bar UI — still net-positive, re-decide at P-000).
- **Scroll-into-view from a `Range`** is fiddly across nested scroll containers —
  P-000 picks the robust approach.
- **Canvas content** (xterm terminal) is unsearchable by DOM find — acceptable; the
  terminal keeps its own `Ctrl+Shift+F`. Document.
- **Hidden / virtualized content** — `display:none`, closed `<details>`, and
  virtualized rows aren't in the live DOM, so matches there won't highlight/scroll.
  Known limitation; note in UI copy if cheap.
- **Browser support** — all three target webviews support the API; guard with the
  lib's `isSupported` and degrade gracefully.

## Testing

Per the four-framework rule (`testing/index.mdx` §1.0a): **Vitest** unit for the
pure engine math (P-007); **Playwright** spec in `apps/operator/e2e/` for the real
find flow (P-008, the Custom Highlight API needs a real browser); plus **manual**
Tauri-shell verification (P-009). No Cargo / LLM-scenario coverage applies.

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
