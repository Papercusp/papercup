---
title: Deck panel — design audit round 2
slug: deck-panel-design-audit-followup-2026-05-14
status: superseded
created: 2026-05-14
updated: 2026-05-20
owner: pandawamble@gmail.com
superseded-by: deck-panel-design-audit-round5-2026-05-14
---

## Now

**State:** **Date:** 2026-05-14 (second pass, same day) **Previous audit:** `apps/operator/docs/plans/deck-panel-design-audit-2026-05-14.md` **Designer fixes shipped in:** `990c4c41` "fix deck panel audit issues" + `260bc6ec` "polish deck audit followups" **Re-audit method:** opened on `/harness?ws=default&slug=sheets`, sampled live DOM + computed styles, plus re-read the JSX/CSS diffs.

**Next:** Archived — no further work expected. Restore from archive/ only if context warrants.


# Deck panel — design audit, round 2 (designer handoff)

**Date:** 2026-05-14 (second pass, same day)
**Previous audit:** `apps/operator/docs/plans/deck-panel-design-audit-2026-05-14.md`
**Designer fixes shipped in:** `990c4c41` "fix deck panel audit issues" + `260bc6ec` "polish deck audit followups"
**Re-audit method:** opened on `/harness?ws=default&slug=sheets`, sampled live DOM + computed styles, plus re-read the JSX/CSS diffs.

The pass landed most of the high-impact items from round 1. This doc has two sections: **(1) what's fixed** (so you can confirm intent matches), and **(2) what's still off** (the new handoff list).

---

## 1. Confirmed fixed ✓

From the previous audit's lettered list:

- **A1** Left rail removed from JSX. Only `--right` aside remains; `DelegatesSection` is rendered exactly once. Class name is still `--right` (no `--left` anywhere) — fine.
- **A3** Page-dim is now a real `<div>` at `z:1180`, `position:fixed`, `bg rgba(1,4,10,.68)`, full viewport. The giant `box-shadow` spread trick is gone. Panel is a true card now: `inset: 68px 22px 22px`, `border-radius: 22px`, real `box-shadow` + cyan ring.
- **A4** `lock-flash` moved from `z:4` to `z:0` — now sits *under* content instead of over it. `pointer-events: none` confirmed on all three decoration layers.
- **B1 / B2** Pause button has its own `operator-btn--pause` + `is-paused` modifier with an amber palette. Reads as a toggle, not destructive.
- **C1** Tab accessible name is now `aria-label="Pending, 4"` and the visible label/count have a 10px gap. Screen readers and sighted users both get a clean reading.
- **C2** Tabs are 42px tall (down from 73). Right size for a label + count.
- **C3** Selected tab now has `1px solid` border and inactive tabs have *no* border. The state is visible at a glance.
- **D1** "Keep for review" uses `operator-mini-btn--auto` (teal border, transparent bg) and "Ignore" uses `--ghost` (slate). Hierarchy is clear.
- **D3** Literal `·` separators removed from the meta row. `display:flex; gap:6px` replaces them.
- **D4** Provenance flags now use `<TriangleAlert size={12}>` lucide icons instead of `⚠` emoji.
- **D6** Card heading is `<h3>` (was `<h4>`).
- **E1 / E2** Empty Decisions section now has an `Info` icon + "No recent decisions yet" body. Stream-empty has an `Activity` icon + "No stream yet · Run Scan to populate live operator events." copy.
- **E3** `DelegatesSection` mounted once.
- **E4** The orphan `border-left` line on the rail is gone — the rail is transparent and the three rail sections are each rounded 20px cards.
- **F3** Footer is now just "Esc closes".
- **I2** `role="article"` removed from `<li>`. The list reads as a real list of `n` items.
- **I4** `aria-pressed` removed from the tab buttons; only `aria-selected` remains.
- **I5 (partial)** Status chip text is now in DOM as `Scanning` / `Idle` (title-cased via `titleCaseStatus()`) with `text-transform: none`. **Tab labels still use `text-transform: uppercase`** — see B2 below.

Quick visual summary: the panel reads as a real card with proper dim, the controls have consistent semantics, and the rail's empty states tell a clear story. Big improvement.

---

## 2. New handoff list

Numbered for the new round so they don't collide with the round-1 letters.

### 2.1 ⚠️ Backdrop absorbs clicks but does nothing — and Esc/click-outside-to-close was removed

This is the highest-priority regression and the only behaviour bug, not a polish item.

- The backdrop div at `z:1180` has `pointer-events: auto` and no click handler. Clicking the dim area is a **dead zone**: it neither closes the panel nor falls through to the page beneath. Users will reach for "click outside to close" reflexively.
- In the same commit, the previous `useEffect` that listened for clicks outside the panel and Escape keys was **deleted** (`OperatorPanel.tsx`, removed lines 509–528 in `990c4c41`). The footer still advertises "Esc closes" — it lies now.
- `role="dialog"` and `aria-modal="true"` were also removed from the panel `<motion.div>` (also in `990c4c41`).
- Pick one of two consistent designs:
  - **Modal:** restore `role="dialog"` + `aria-modal="true"`, re-add focus trap, re-add the Esc handler, and add an `onClick` on the backdrop that calls `broadcastState({ open: false })`.
  - **Non-modal/dockable:** drop the backdrop entirely (it's misleading), make the panel narrower (it currently covers ~95% of the viewport — `1784×1417` of `1828×1507`), and give it `role="region"` with `aria-labelledby` pointing at the wordmark.

Either way the current intermediate state (looks modal, isn't a modal, footer hint claims Esc works but nothing closes it) is the worst of both.

### 2.2 SVG frame is still stretched, not just at the wrong scale

`globals.css`-level finding from the first audit didn't get touched.

- `OperatorPanel.tsx:1498` still emits `<svg viewBox="0 0 1000 600" preserveAspectRatio="none">`.
- At the current rendered size 1784×1417 the rendered aspect ratio is 1.26; the viewBox is 1.67. The path is squashed vertically and the gradient is squished with it.
- The path has `stroke="url(#operatorPanelFrameRail)"` but no `vector-effect="non-scaling-stroke"`, so the stroke also stretches non-uniformly.
- Two clean options:
  - Keep the decorative path, but set `preserveAspectRatio="xMidYMid slice"` (or `meet`) and add `vector-effect="non-scaling-stroke"` to the `<path>`.
  - Replace the whole `<svg>` with a CSS `::before`/`::after` border treatment — the path is just a notched frame; CSS `clip-path: polygon(...)` plus a 1px gradient border would render correctly at every ratio with no JSX.

### 2.3 Filter-row controls still don't match each other

The three controls in the same horizontal slot have three different heights and four different radii:

| Element | Height | Radius |
| --- | --- | --- |
| Search input (`input[type="search"]`) | 36 | 4px |
| Harness combobox (`[role="combobox"]`) | 38 | 14px |
| Metric tabs (`[role="tab"]`) | 42 | 12px |
| Rail section cards | — | 20px |
| Header buttons | 34/40 | 999px |

The 4px search-input radius is the loud outlier in a panel that otherwise uses 12–22px rounded shapes. Pick one row-height for filter controls (38 is fine) and one radius for input/combo (14 is fine).

### 2.4 Search input has no visible chrome at all

(Carried over from round-1 C5; was not addressed.)

- Computed: `border: 0px none …; background: rgba(0,0,0,0); border-radius: 4px`.
- The placeholder "Filter title or action" floats over the panel's gradient with no chip. At the panel's current background, the input is **invisible until focused**.
- Either add the same background+border treatment as the combobox (`rgba(5,13,24,.72)` + `1px solid rgba(125,211,252,.18)`), or wrap both controls in a shared "filter bar" pill with a single border.

### 2.5 Meta-row pill styling is inconsistent

In the card meta row, the two pills sit side-by-side with `gap: 6px` (good), but their visual treatment differs:

| Pill | Background | Border | Padding | Radius |
| --- | --- | --- | --- | --- |
| `.operator-kind` ("Note") | `rgba(9,20,34,.62)` | `1px solid rgba(186,230,253,.22)` | `0 8px` | 999px |
| `.operator-tier` ("Low risk") | `rgba(0,0,0,0)` | *none* | `0 8px` | 999px |

The tier pill has padding and radius like a pill, but no chrome, so it reads as plain text inside an invisible chip. From the user's POV it doesn't match its neighbour. Two paths:
- Give the tier pill its own colour-coded border/bg per tier (`low` = neutral, `medium` = amber, `high` = red).
- Or drop the kind pill to plain text too and let the meta row be type-only, separated by 6px.

The `operator-life` lifecycle chip and the `operator-target` harness label have similar uneven styling — please standardise the whole meta row in one pass.

### 2.6 Tabs still use `text-transform: uppercase`

(Round-1 I5 only got fixed for the status chip.)

- `.operator-tab-label` is `text-transform: uppercase`, DOM text is `Pending`.
- "PENDING" doesn't read as poorly as "I D L E" did, but for consistency with the status chip's new title-case approach, prefer rendering the desired case in the DOM (`Pending`) and dropping `text-transform`. If the all-caps look is intentional, set `font-feature-settings: "smcp"` (true small caps) or change the DOM string to `PENDING` — but don't rely on CSS to do case conversion for screen readers.

### 2.7 Feed and rail butt up against each other (gap: 0)

The grid has no `column-gap` between the main feed and the right rail:

- `bodyShape.grid = "1438px 320px"`, `column-gap` is browser default (`normal` → 0 in `display: grid`).
- The feed's vertical scrollbar (15px wide) sits flush against the rail's left edge. The two distinct content zones don't have any visual breathing room.
- Add `column-gap: 16px` (or 20px) on `.operator-panel__body` and let the rail's left edge sit `16px` away from the scrollbar.

### 2.8 The rail still reserves 320px even when its content is "empty-state cards"

(Carried over from round-1 A2 — still relevant in a softer form.)

When `decisions.length === 0` and `streamLog.length === 0`, the rail renders three empty-state cards (delegates / decisions / stream). The cards now look intentional ✓, but visually they take **the same 320px column** as a fully-populated rail. On a workspace that hasn't been used yet, the entire right-third of the panel is "no recent decisions / no stream yet / no delegates". That's a lot of "nothing to show" for a primary surface.

Designer call:
- Hide the rail entirely until at least one of its sections has data, and switch the body grid to `1fr`.
- Or collapse to a single 88-92px-wide rail with just three vertical state dots, expandable on click.

### 2.9 Footer is 43px tall for the text "Esc closes"

`footer { height: 43.05px; padding: 8px 18px; justify-content: flex-start; }` for a one-line ten-character hint. The footer reserves a full row of chrome for what's now a single keystroke note. Either:
- Drop the footer entirely and surface the Esc affordance as a quiet tooltip on the Close button.
- Or expand it to actually be useful (last scan time, "Scan in 28s", workspace name).

### 2.10 Status chip uses different greens for "Scanning" vs "Idle" but no movement

The chip says `Scanning` with `color rgb(237,248,255)` and `bg rgba(125,211,252,.12)` + `border rgba(45,212,191,.48)`. Idle is the same cyan family with no scanning indicator. Two issues:

- No animation indicates that scanning is *in progress*. A static text label with a cyan border could be either "scan complete" or "still scanning". Add a pulse, a tiny progress dot, or a left-anchored shimmer when `scanStatus === 'scanning'`.
- The status palette doesn't map to the panel's "operator state" palette (`acting` / `thinking` / `awaiting-input` / `paused`). Right now `scanning` is teal, `paused` is amber, the rest are cyan — there isn't a documented mapping. If there's an intended palette per state, document it; if not, design one and apply it consistently.

### 2.11 Panel covers ~95% of viewport — that's fighting the "card" treatment

The new rounded-card border-radius and dim backdrop set the expectation that the Deck is a focused dialog, but the inset is only `22px` on three sides and `68px` from the top (header height). On a 1828×1507 display the card is 1784×1417 — visually it's basically a full-screen takeover with rounded corners.

Two options for resolving the mismatch with the new card aesthetic:
- Narrow it: cap the inline-size to `min(1280px, 100vw - 96px)` and centre it, so it actually looks like a dialog.
- Or commit to the takeover: remove `border-radius`, drop the dim, and treat it as a route-like surface (no backdrop, no card chrome).

### 2.12 Card title row can collide with the action group on narrow widths

In the card, the `h3` title row and the `operator-entry__title-actions` (state text + Accept/Ignore buttons) sit on the same line via `flex`. With a long title like "7 plan reviews · accept-with-notes (F-FIX-009 iteration)" + a wide auto-dispatch state text + the Keep-for-review button, the title wraps awkwardly into the action region.

- Add `min-inline-size: 0` and `flex: 1 1 auto` on the heading container so it can truncate or wrap cleanly, and `flex-shrink: 0` on the actions container so the buttons stay one-line. Currently the heading has no `min-inline-size` constraint and pushes the actions off-row at narrower panel widths.

### 2.13 Three subtly-different rounded-card languages on screen

Visible in one render:

- Panel itself: `border-radius: 22px`.
- Right-rail sections (delegates / decisions / stream): `border-radius: 20px`.
- Card entries in the feed: (didn't measure directly — let me sample) `border-radius: ~14px` based on `.operator-entry` rules.
- Tabs: `border-radius: 12px`.

22 / 20 / 14 / 12 / 4 / 999 — six radii in one surface. Round-1 G1 mentioned three; the followup added two more (rail sections at 20, panel at 22). Pick a scale (e.g., `8 / 14 / 22 / 999`) and apply across all surfaces.

### 2.14 Tab "Scans" doesn't have a count where the others do

Three tabs have a count badge (`Pending 4`, `Accepted 0`, `Ignored 0`); the fourth ("Scans") doesn't. The visual asymmetry is jarring — it looks like the badge failed to load. Either give Scans a count (number of recent scans? open scans?) or give the count badge a "—" placeholder so all four tabs have the same shape.

### 2.15 Tab's `tablist` aria-label is "Deck action views" but the tabs aren't "action views"

The `role="tablist"` advertises "Deck action views" — but the content under each tab is a list of *suggestions*, not a per-tab view of "actions". This is minor copy; "Deck filters" or "Deck status" would describe what the user is toggling more accurately.

### 2.16 The page below the panel is still visible through the dim

The new backdrop is `rgba(1,4,10,.68)` — fine for a flat content page, but the harness route underneath has its own glowing HUD, animated rows, and high-saturation gradients. At 68% alpha those bleed through and compete with the panel's HUD. Two options:
- Increase the dim to `rgba(0,2,6,.85)` so the underlying motion is fully suppressed.
- Or add `backdrop-filter: blur(6px) saturate(0.6)` to the backdrop so the page behind goes quiet without darkening further.

### 2.17 No focus-visible treatment on tabs, header buttons, or cards

Tabbed via keyboard, the focused tab gets a 2px browser-default outline (per UA). With `box-shadow: inset` styling on the tab, the outline collides with the inner shadow. Two improvements:
- Add `:focus-visible { outline: 2px solid rgba(125,211,252,.6); outline-offset: 2px; }` on all interactive panel elements.
- Make sure tab focus doesn't visually overlap the tab's border-radius.

(I couldn't reliably trigger focus in this audit because the panel intercepted my keyboard events for state; flagging based on CSS read, please verify.)

### 2.18 The two visible "operator-section" empty-state cards in the rail use different layouts

- `operator-empty-rail--decisions` — icon on the left, `<div>` with `<strong>` + `<span>` on the right.
- `operator-stream-empty` — icon on the left, `<div>` with `<strong>` + `<span>` on the right.

Same shape ✓ — but the parent containers differ:
- Decisions card has the empty-state at its full extent (`h: 100px`).
- Stream card has a `.operator-section__head` with "Stream / scanning" *plus* the empty-state below it. So Decisions has one section title, Stream has two visible labels ("Stream" + "No stream yet"). Pick one pattern and apply to both — either always show the section title above, or always replace it with the empty-state's strong text.

### 2.19 Footer announces "Esc closes" but Esc no longer closes the panel

(Already called out in 2.1, repeated here because a designer scanning the list may not read the lengthy 2.1.) If Esc handling is reinstated, the copy is fine; if it isn't, change the footer or remove it.

### 2.20 Right rail wordmarks "Delegates / Decisions / Stream" lack consistent eyebrow treatment

- Delegates uses the `<section class="operator-section__head"><span>Delegates</span><em>0 open</em></section>` pattern (when populated).
- Decisions empty uses `<strong>Decisions</strong><span>copy</span>` — no eyebrow.
- Stream uses both — `<section__head>Stream / scanning</section__head>` plus an empty body card.

The three sections look like they belong to three different surfaces. Pick a heading pattern (label + status-pill on the right) and use it for all three.

---

## Quick-wins for the next pass

If we're prioritising, in roughly this order:

1. **2.1** — Close-on-Esc / close-on-backdrop-click is genuinely broken UX.
2. **2.4** — Search input has no chrome.
3. **2.3** — Filter-row heights & radii.
4. **2.7** — `column-gap` between feed and rail.
5. **2.2** — SVG frame `preserveAspectRatio` + `vector-effect`.
6. **2.5** — Meta-row pill consistency (tier needs chrome).
7. **2.13** — Pick a radius scale.
8. **2.14** — Scans tab badge symmetry.
9. **2.11** — Panel size / takeover-vs-card commitment.

Everything from 2.8 onward is judgement / direction — flag for the designer to make a creative call rather than a fix-list item.

---

## Out of scope, would still be nice

- An empty-state pass for a brand-new workspace (no harnesses, no scans, no decisions). The current empty-state copy assumes some history exists.
- The `pc-animate-in --delay-1/2/…` stagger on every direct child is still aggressive (~600ms cascade on open). Round 1 raised this; consider one or two motion layers instead of six.
- Mobile (≤760px) still hides the rail and lets the action bar overflow horizontally. Either ship a mobile layout or gate the Deck CTA off on mobile breakpoints.
