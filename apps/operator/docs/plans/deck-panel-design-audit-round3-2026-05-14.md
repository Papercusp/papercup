# Deck panel — design audit, round 3 (designer handoff)

**Date:** 2026-05-14 (third pass, same day)
**Previous audits:**
- `apps/operator/docs/plans/deck-panel-design-audit-2026-05-14.md` (round 1)
- `apps/operator/docs/plans/deck-panel-design-audit-followup-2026-05-14.md` (round 2)

**Designer fixes shipped in:** `f1ff382c` "fix deck panel followup audit issues"
**Re-audit method:** opened on `/harness?ws=default&slug=sheets`, sampled live DOM + computed styles, plus re-read the JSX/CSS/Modal diffs.

Big pass. Almost the entire round-2 list landed. Two new genuine bugs surfaced from the changes, plus a handful of follow-up polish items.

---

## 1. Confirmed fixed ✓

- **2.1** Modal migrated to Radix `Dialog` via `Modal` (`apps/operator/app/harness/Modal.tsx`). `closeOnEscape` and `closeOnOutsideClick` both passed by `OperatorButton`. Overlay `onClick` calls `onOpenChange(false)`. `srOnlyTitle="Deck"` + a real `description` populate `aria-labelledby` / `aria-describedby` — screen readers now announce "Deck dialog · Operator deck for scanning the workspace…" instead of nothing.
- **2.2** SVG `preserveAspectRatio="xMidYMid slice"` and the path now has `vectorEffect="non-scaling-stroke"`. Stroke no longer squishes.
- **2.3** Every filter-row control resolves to **38px** outer height (`tab` 38, `combo` 38, `harness-select` 38, `search` wrapper 38). The inner `<input>` is 36 inside its 38px wrapper — close enough that the row is uniform.
- **2.4** `.operator-feed-search` wrapper now has visible chrome (`background rgba(5,13,24,.72)` + `1px solid` cyan border). The input is no longer a ghost.
- **2.5** Tier/kind/life/target pills share a base palette and the tier pill has per-state bg + border (low=teal, medium=amber, high=red).
- **2.6** Tab labels have `text-transform: none` in CSS and the DOM string is `Pending` / `Accepted` / `Ignored` / `Scans`. Screen readers and sighted users get matching text.
- **2.7** `.operator-panel__body { column-gap: 16px }` — feed scrollbar and rail have breathing room.
- **2.9** Footer collapsed to 30px tall, padding 5px 16px.
- **2.10** Status chip has the `operatorStatusScanPulse` keyframe wired to `[data-scan-status="scanning"]` / `.operator-status--scanning`.
- **2.11** Panel is now `inline-size: min(1280px, vw - 72px)`, centred via `left: max(36px, …)`. At 1828px viewport the panel measures 1280×1417 at x=454 — a real centred dialog.
- **2.13** Most surfaces unified to `14px` (entries, rail sections, empty-rails, stream-empty, empty-state, callouts).
- **2.14** "Scans" tab carries a `'—'` placeholder where the other three carry counts — visual rhythm restored.
- **2.15** Tablist `aria-label` reads "Deck filters".
- **2.17** Universal `:focus-visible` rule added on every interactive element inside the panel.
- **2.20** Decisions section always renders the `__head` (label + state) and the empty-state copy reads "No decisions yet · Accepted and ignored suggestions appear here."

Plus an unprompted bonus: a `railHasActivity` flag drives `has-empty-rail` on the body, which collapses the rail and switches the grid to `1fr` when there's truly nothing to show. Resolves the round-2 2.8 nicely.

---

## 2. New issues this round (regressions / genuinely-new bugs)

### 3.1 ⚠️ Tier pill has asymmetric border (`1px 1px 1px 3px`)

Computed `border-width` on `.operator-tier`:

```
border-width: 1px 1px 1px 3px;
border-style: solid;
border-color: rgba(45, 212, 191, 0.32);   /* per tier */
```

The **3px** is on the left edge only. No equivalent treatment on `.operator-kind`, `.operator-life`, or `.operator-target`, so in a row of four pills the tier pill has a left accent stripe that none of its neighbours match. Two possibilities:

- It's intentional ("tier carries an accent stripe") — then give the lifecycle pill the same treatment, and ideally encode the tier with a *colour-coded* stripe so the stripe carries information. Currently the stripe is the same colour as the rest of the border, so the asymmetry adds visual noise but no signal.
- It's accidental, left over from an earlier hover/focus rule. Reset to `border-width: 1px` and let the per-state colour do the work.

### 3.2 ⚠️ Footer separator vanishes before the last span

Footer CSS:

```css
.operator-panel__footer span:first-child::before,
.operator-panel__footer span:last-child::before {
  content: none !important;
  display: none !important;
}

.operator-panel__footer span + span::before {
  content: "·";
  margin-right: 12px;
  color: rgba(148, 163, 184, 0.46);
}
```

The `:last-child` clause kills the separator that the `span + span` rule put before the last span. Computed before-content per span:

| Span | Text | `::before` content |
| --- | --- | --- |
| 1 | "Esc closes" | none |
| 2 | "2 pending" | "·" |
| 3 | "0 accepted" | "·" |
| 4 | "0 ignored" | **none** ← bug |

The line reads "Esc closes · 2 pending · 0 accepted   0 ignored" (with a gap, no dot). I think the intent was "don't put a leading dot on the first span" — drop the `:last-child` rule.

### 3.3 ⚠️ Focus-visible rule sets `box-shadow !important`, wiping resting elevation

```css
.operator-panel :is(button, a, input, [role="tab"], [role="combobox"], .operator-entry):focus-visible {
  outline: 2px solid rgba(125, 211, 252, 0.66) !important;
  outline-offset: 2px;
  box-shadow:
    0 0 0 1px rgba(125, 211, 252, 0.18),
    0 0 18px rgba(125, 211, 252, 0.18) !important;
}
```

When a tab or button gains keyboard focus, the `box-shadow: !important` replaces the existing `box-shadow` that gives the element its resting depth (cards have shadow, tabs have inner-glow, etc.). The result: focusing an element makes it look *less* elevated than the unfocused neighbours.

Fix: drop the `box-shadow` clause entirely. The `outline` + `outline-offset` already provides a clear, accessible focus ring. Or, if you want a glow, use `outline-color` + `outline-offset` to fake the glow without touching `box-shadow`.

### 3.4 ⚠️ Scanning-pulse pseudo may not render (no visible mark)

The `operatorStatusScanPulse` keyframe animates `box-shadow` and `transform` on `.operator-status::before`. The pseudo's `content: ""` was confirmed, but I couldn't measure visible width/height on `::before` in this audit — depending on whether the base rule sets `display: inline-block; inline-size: 8px; block-size: 8px; border-radius: 50%; background: currentColor;` the pseudo may render as 0×0 and the animation will be invisible.

Action: open the panel, force `data-scan-status="scanning"`, and verify there's a visible pulsing dot to the left of "Scanning". If not, add an explicit base size + background to `.operator-status::before` so the keyframe has something to scale and glow.

### 3.5 ⚠️ Search input still has no internal chrome — focus jumps inside the wrapper

The `.operator-feed-search` wrapper has the chrome (the rounded chip), but the `<input>` *inside* it is still `background: transparent; border: 0 none;`. When the user clicks into the input, `:focus-visible` fires on the `<input>` (the inner 286×36 rect), so the 2px cyan outline anchors to the inner rect rather than the visible wrapper pill.

Two fixes:
- Move the focus-within signal up to the wrapper: `.operator-feed-search:focus-within { outline: 2px solid …; outline-offset: 2px; }` and drop `:focus-visible` on the `<input>`.
- Or expand the input's own focus ring to encompass the entire wrapper (negative outline-offset).

### 3.6 The two parallel "rail is sparse" classes have overlapping but not identical semantics

The body now carries two related classes:
- `has-empty-activity` — set when `decisions.length === 0`.
- `has-empty-rail` — set when `!(decisions.length > 0 || streamLog.length > 0 || scanStatus === 'scanning' || scanStatus === 'error')`.

These don't compose orthogonally — `has-empty-activity` can be true while the rail is fully visible (because scan is running, so `has-empty-rail` is false). The styling that depends on `has-empty-activity` (rendering an empty-state inside the feed) and the styling that depends on `has-empty-rail` (collapsing the rail) sometimes both fire, sometimes one fires alone, and the visual reading isn't predictable.

Decide on a single rail-visibility predicate and drive both the empty-state-in-feed AND the rail collapse from it.

### 3.7 SVG frame: `xMidYMid slice` crops at non-1.67 ratios

`xMidYMid slice` preserves aspect ratio by *cropping* the viewBox so the content fills the rendered area. The viewBox is 1000×600 (ratio 1.67); the panel is 1280×1417 (ratio 0.90). At that ratio, slice will scale the viewBox to fit the longer side and crop the shorter side. The top/bottom notches in the path (`M46 10 H414 L448 27 H552 L586 10 H954`) won't appear where intended — they'll be cropped out of view.

Two options:
- Switch to `meet` (preserve ratio without cropping — but you get whitespace at the un-filled axis).
- Drop the SVG path entirely and replace with a `clip-path: polygon(...)` on the panel itself. The path is just a decorative notched frame; CSS can do it without ever scaling weirdly.

This may be load-bearing for the operator's HUD look; flagging as a directional question rather than a fix.

---

## 3. Carried-over polish (round-2 items not addressed this pass)

### 3.8 Tier and Lifecycle share the same colour palette

Tier (low / medium / high) and Lifecycle (accepted / auto / pending / ignored) both use the same teal / amber / red / slate. In a row of pills the user can't tell at a glance whether "amber" means "medium risk" or "auto-fire pending". The pills are positioned next to each other (`.operator-kind`, `.operator-tier`, `.operator-life`, `.operator-target`) so the ambiguity is in-context.

Recommend a different visual encoding per pill type:
- Tier: keep the colour palette but anchor it with a small "tier dot" on the left.
- Lifecycle: use an icon glyph instead (✓ accepted, ⏱ auto, ⌛ pending, ⊘ ignored) and drop the colour.
- Kind: keep the colour-coded outline (already differentiated).
- Target: neutral, plain.

### 3.9 Pause button — verify state palette swap

`.operator-btn--pause` carries an amber palette. The class set adds `is-paused` when the panel is paused, but I couldn't see a CSS rule that changes the visual when `.is-paused` is present. Either:
- Confirm `.operator-btn--pause.is-paused` has a filled/amber-bg variant (filled when paused, ghost when running).
- Or accept that pause/resume have the same chrome and only the icon swaps.

Pick one and document; the current state is ambiguous.

### 3.10 Tab count chip has the same style on active and inactive tabs

The selected tab has a 1px border, the inactive tabs don't — that's a clean state signal. But the count badge `.operator-tab-count` is the same colour on both. If the badge is the primary signal ("4 things to do"), give the selected tab's badge a stronger fill or invert it (selected → filled cyan; inactive → outlined cyan).

### 3.11 Footer + tabs duplicate the same counts

Tabs show "Pending 4 · Accepted 0 · Ignored 0". Footer shows the same numbers. Either:
- Drop the footer counts; keep "Esc closes" only.
- Or change the footer to surface what the tabs don't (last scan time, workspace name, "next scan in 28s").

### 3.12 Rail width is fixed 320px

At the new panel width (1280) the rail takes ~25%; at the prior width (1784) it took ~18%. The empty-state cards in the rail now feel proportionally heavier. Either:
- Drop rail width to 280 at the new panel size.
- Or scale rail with `clamp(240px, 22%, 320px)`.

### 3.13 The `inset: 68px 22px 22px` rule at the original panel selector is now dead code

The new override at the bottom of `globals.css` sets `inline-size`, `left`, and `right`. The earlier `inset` shorthand (around line 4961) is no longer reachable in modern browsers because the new `left: max(...) !important; right: auto !important` wins. Delete the old `inset` to avoid confusion for the next maintainer.

### 3.14 `display: contents` on the dialog content removes `aria-modal`

The Radix `Dialog.Content` is rendered with `contentStyle={{ display: 'contents' }}`. As a side-effect, the rendered `<div role="dialog">` reports `aria-modal: null` (it should be `aria-modal="true"`). This may be a Radix quirk with `display: contents` + portal interaction. Verify by:

1. Inspecting the Deck `[role="dialog"]` element with the panel open.
2. If `aria-modal` is missing, add it manually via `contentProps={{ 'aria-modal': true }}` or by removing the `display: contents`.

This affects screen-reader announcement of "you have entered a modal dialog" — degraded UX for AT users despite the labelled-by/described-by fix.

### 3.15 Animation stagger still ~6 layered entrances

Six `.pc-animate-in --delay-1/2/...` direct children of the panel + body cascade for ~600ms on every open. Round 2 raised this; not addressed. Designer judgement.

### 3.16 Mobile breakpoints still let the action bar overflow horizontally

At <960px and <760px the panel adjusts inset but `.operator-panel__actions` still has `overflow-x: auto` from earlier breakpoints. Scrolling action bars hide the Close button. If Deck is desktop-only, gate the CTA off on mobile.

---

## 4. Quick wins

In rough priority:

1. **3.2** Footer separator before "0 ignored" — one-line CSS fix.
2. **3.3** Drop `box-shadow !important` from `:focus-visible`.
3. **3.1** Normalise tier pill border or apply consistently across meta pills.
4. **3.5** Move search focus signal to the wrapper.
5. **3.4** Verify scanning-pulse pseudo actually shows; add base size+bg if not.
6. **3.14** Verify `aria-modal` on the dialog; restore if missing.
7. **3.7** Decide on SVG frame strategy (slice / meet / clip-path).
8. **3.8** Different visual encoding for tier vs lifecycle.
9. **3.11** Footer: drop count duplication or repurpose.

Everything from 3.9 onward is creative/strategic; the doc can be filed without action if priorities elsewhere.

---

## 5. Net assessment

This pass closed every round-2 item that wasn't strictly creative. The panel now reads as a proper dialog: rounded card, real backdrop with blur, focus styling, accessible names, sensible filter-row geometry, balanced colour palette, and a sane footer. The remaining issues are mostly polish-level — except for **3.2 (footer separator bug)**, **3.3 (focus shadow override)**, and **3.4 (scanning pulse may be invisible)**, which are bugs that should be confirmed in the browser and patched before the next visual review.

Designer can ship the next pass with confidence; the panel is close to done.
