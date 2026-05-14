# Deck panel — design audit (handoff for designer)

**Date:** 2026-05-14
**Audited surface:** `OperatorPanel` (`apps/operator/app/_components/OperatorPanel.tsx`) — the floating Deck modal triggered from the header CTA, at the default viewport (1828×1507 in our session; spot-checked at 1440×900).
**How it was audited:** opened on `/harness`, inspected the live DOM + computed styles, cross-referenced the source markup and `app/globals.css` (the panel spans roughly L4961–L8930, L22235+ and L26200+ — there are many overlapping passes).

Issues are grouped by severity and tagged with the most specific selector / file:line I could find so a designer can jump straight to the artifact.

---

## A. Structural / layout glitches (highest priority)

### A1. Left rail is rendered in JSX but globally `display: none`
- The body grid declares **three** columns (`minmax(230px,290px) 1fr minmax(245px,320px)`, `globals.css:5374`), and the JSX renders **two** asides (`OperatorPanel.tsx:1600` "rail--left" and `:1906` "rail--right").
- A late override at `globals.css:26329` hard-disables the left rail (`.operator-panel__rail--left { display: none !important; }`) and rewrites the grid to two columns. The left aside still mounts, still runs `<DelegatesSection />` inside it (so the component is mounted twice — once invisible, once visible).
- Net effect: the visible right rail is labelled `--right` in source but is structurally the **only** rail. The `--left/--right` naming is misleading. Pick one (delete the hidden one, or actually surface it).

### A2. Body grid still reserves a 3rd column when the rail-right collapses
- When `decisions.length === 0` and `streamLog` is empty, the right rail renders but its children all collapse to 0 height (each `.operator-empty-rail` returns a single chip). The grid track is still 245–320px, so you get a visible empty gutter to the right of the feed.
- Repro: open Deck on a harness with no recent decisions and no stream output → there's a vertical strip of empty background ~280px wide. Should either (a) hide the column with `grid-template-columns: 1fr` while empty, or (b) replace the contents with a genuine empty-state card so the column doesn't read as broken.

### A3. Panel is a full-bleed rectangle with 0 border-radius
- `border-radius: 0`, `inset: 68px 22px 22px 376px`, dim is faked by a giant `box-shadow: 0 0 0 1828px rgba(1,4,10,.6)`.
- Two visible problems:
  - On any viewport wider than the spread (or with horizontal scroll), the right edge of the page is **not** dimmed. The spread is hard-coded to a single huge number; it's brittle at ultrawide / 4K.
  - When the document scrolls (it does — `documentElement.scrollHeight > innerHeight` was true at 1828×1507), the dim is anchored to the viewport via `box-shadow`, but content below the fold is **not** dimmed. Use a real `<div class="backdrop">` with `position: fixed; inset: 0` instead — it's cheaper and correct.
- The full-bleed rectangle with sharp corners against a similarly-dark page reads as a "page is broken / chrome failed to render" before the eye finds the inner border. Either commit to a clear card (margin + rounded corners + shadow) or to a true full-screen overlay (no inset).

### A4. Three stacked decorative layers cover the entire panel
- Direct children include `svg.operator-panel__svg-frame` (z:3, full panel size 1430×1417), `span.operator-panel__lock-flash` (z:4), and `div.operator-hud-overlay` (z:0).
- `lock-flash` at z:4 sits **above** header, body, and footer (z:1). When triggered it covers click targets. Verify it's `pointer-events: none` at all times (I couldn't easily reach a paused state to confirm), and ideally move it below the header/footer.
- `svg-frame` is a single `path` with no fill, stroked from a multi-color gradient. The path coordinates are hard-coded (`viewBox 0 0 1000 600 preserveAspectRatio="none"`) — at 1430×1417 the gradient stops are stretched out of proportion, creating a fuzzy diagonal band. Worth either redrawing with `vector-effect: non-scaling-stroke` or simply replacing with a CSS border treatment.

---

## B. Header / controls

### B1. Four header CTAs use four different ring colors
Computed border colors (from `header button` selector):
- **Scan** — green-ish (oklab green)
- **Pause autonomous actions** — pink/red (oklab red) — reads as **destructive**, which "pause" is not
- **Settings** — blue/cyan
- **Close** — red/coral

Pause being red conflicts with Pause's neutral semantic. Either use neutral for Pause and reserve red strictly for `Close` (X), or invert: make Pause amber and Close neutral. Right now the row reads as "go, danger, info, danger".

### B2. Pause button label flips between "Pause" / "Resume"; ring color does not
The ring stays red whether paused or running, so a paused state and an active state look the same color. The icon is the only differentiator. Add a state-driven palette (e.g., amber/yellow ring + filled background when paused).

### B3. Status chip is plain text next to the wordmark
`.operator-status` reads "scanning" / "idle" / "acting" / "thinking" / "awaiting-input" / "paused" as a single uppercase tag with no glyph and no relation to the giant orb in the header center. There's no consistent visual mapping between the chip and the panel's main visual state. Either give each state a tiny pulse/dot or remove the chip in favour of the orb.

### B4. Header right side packs four buttons + a divider into 312px
At narrower widths (≤960px) `media (max-width: 960px)` rule (`globals.css:5986`) switches `.operator-panel__actions { justify-content: flex-start; overflow-x: auto; }` — i.e., the controls become **horizontally scrollable**. A scrolling action bar is a known anti-pattern for primary actions (users can't see Close). Decide on a single-row collapse strategy (priority+more, icon-only at narrow) and ditch the scroll fallback.

---

## C. Tabs / filter row

### C1. Tab text and count run together: "Pending4", "Accepted0", "Ignored1"
- Markup is `<em>Pending</em><strong>4</strong>` (`OperatorPanel.tsx:1621`).
- There's no whitespace, no gap, and no separator. Both visually ("Pending4") and to screen readers (accessible name is `"Pending4"`).
- Fix: either insert a space, give the strong a `margin-left` and a pill background, or restructure as `<span class="label">Pending</span><span class="count">4</span>` with a `gap` on the parent flex.

### C2. Tab cards are 73px tall but contain only one short label
The pending/accepted/ignored/scans tabs are 14px-radius cards 73px tall (≈4× normal tab height). At 1430px panel width that's a lot of vertical real estate for four words. Either flatten them into a proper segmented control (~36px tall) or commit to richer content (sparkline, "last scan 12s ago", etc.).

### C3. Active vs inactive tab contrast is too low
Active background alpha 0.76, inactive 0.42, same hue. From a quick glance the four tabs look identical — the only difference is a faint glow. Up the active-state contrast or add a top-edge accent bar.

### C4. Filter row controls don't match
- Search input: `height: 26.6px`, `border-radius: 4px`, no visible border (transparent).
- Harness combobox: `height: 40px`, `border-radius: 14px`, visible cyan border.
- They sit side-by-side and form a row where one control is 13px shorter and 10px less rounded than its neighbour. Pick one.

### C5. Search input has no visible border or background
`border: 0px none`, `bg: rgba(0,0,0,0)`. The icon and "Filter title or action" placeholder float over the panel gradient with no chip. At the panel's busy gradient background, this is hard to spot. Add a subtle chip background or an `outline: 1px solid var(...)`.

---

## D. Cards (`article.operator-entry`)

### D1. Keep-for-review / Ignore buttons have no hierarchy
Both render as `.operator-mini-btn--ghost` with the exact same neutral grey background (`rgba(15,23,42,0.34)`) and the same 1px slate border. There's no way to tell at a glance which is the "default" action. If "Keep for review" is the intended primary, mark it; if it's a secondary save, drop the duplicate styling.

### D2. The Accept button collides with the auto-dispatch timer
Pending+auto cards render a 30px "Keep for review" pill and a `operator-state-text--auto` countdown ("Accepts automatically in 14s"). When the timer ticks down, the layout shifts (digit width changes from 2 → 1 chars). At the same time, on high-tier `send_directive` cards the layout flips into a `confirm-strip` (`OperatorPanel.tsx:1791`). That's three different right-edge layouts for what is nominally the same card. Worth unifying into a single "actions slot" that switches contents without reflowing.

### D3. Meta row separators are inconsistent
Inside the entry meta row we mix:
- `<span class="operator-meta-sep">·</span>` (literal dot character)
- `<span class="operator-kind operator-kind--…">…</span>` (pill)
- `<span class="operator-tier operator-tier--…">…</span>` (pill)
- `<span class="operator-life operator-life--…">…</span>` (pill)
- `<span class="operator-target">…</span>` (plain text)

Two pills + a literal `·` + plain text + another pill. Either commit to all pills (drop the `·`) or all text (drop the pill backgrounds). Right now it reads as a debug log.

### D4. Provenance flags rendered as raw "⚠ tier corrected" text
- Inside `operator-entry__flags`, two emoji-prefixed strings ("⚠ tier corrected", "⚠ capability unknown").
- Mixing emoji glyphs into a UI that otherwise uses lucide-react icons is jarring. Convert to lucide `TriangleAlert` chips with a real palette.

### D5. Markdown preview ("Preview message") and inform body live inside the same card
- `Collapsible` trigger is styled as a small chevron + "Preview message" text. The trigger has no obvious affordance that it expands; it sits flush with the rest of the body copy. Add a clear button chrome or move into a footer slot.
- For `action === 'inform'`, the full markdown body is rendered inline with `.operator-entry__markdown--compact`. Long bodies make the card grow unbounded → cards in the same list have wildly different heights. Cap to ~3 lines with a "Read more" expander.

### D6. Card heading uses `<h4>` inside a `<li role="article">`
- The list item is `role="article"`, so the `<h4>` is the article's heading — which means the heading hierarchy resets at h4 with no h1/h2/h3 above it in the panel. Should be `<h3>` (matches the empty-state's `<h3>`), or restructure so the panel's wordmark is the dialog's h1 and cards use h2.

---

## E. Right rail ("rail--right")

### E1. Empty Decisions section renders only "Decisions / no recent decisions / 0"
The `operator-empty-rail` markup is a `<strong>label</strong><span>copy</span><em>count</em>` triple. There's no icon, no CTA, no link to a Decisions log. It looks like a stat that failed to load. Either remove the whole section when empty, or add a single CTA ("View decision history →").

### E2. "Stream" section says "(no stream yet)" in lower-case parens
- Plain text "(no stream yet)" — no styling, no icon, no contextual hint about what would appear there. Designer call on whether this empty state lives in the right rail at all.

### E3. Both rails contain a `DelegatesSection`
As noted in A1, `DelegatesSection` is rendered twice. When the left rail is forced hidden by CSS, the right rail's instance is what users see. But scroll restoration, focus management, and any internal state of the hidden DelegatesSection are now invisible-but-live. Delete the dead one.

### E4. Right rail border style doesn't match the panel
`.operator-panel__rail--right { border-left: 1px solid rgba(var(--operator-arc), 0.14); }` — but the panel body itself has gradient layers with a different border treatment on the outside. The rail's left edge is a 1px line that doesn't continue past the rail's height, so it looks like the gradient is "cracked" at the top and bottom. Either extend the line or remove it.

---

## F. Typography / iconography

### F1. Three different "scan" icons in one panel
- Header: `RefreshCcw size={14}` for the Scan button
- Empty state: `RefreshCcw size={18}` AND `Search size={18}` (depending on state)
- Right-rail Stream section uses different prose

A user seeing both Search and Refresh icons next to "Scan" might think they do different things. Unify on one icon for the scan action.

### F2. Mixed icon stroke widths
- Panel header buttons use `strokeWidth={2.2}` and `2.3` and `2.4` (Close).
- Card entries use mixed widths too (chevron at `2`, scan icons at `2.2`).
- This is visible at the size we render — buttons feel inconsistent in weight. Pick 2.0 or 2.2 globally for icons in this surface.

### F3. Footer is three hints in one line
`<span>Cmd/Ctrl+K then D • Esc closes • Click outside closes</span>`. Three redundant statements separated by middle dots. Pick the most useful (`Esc to close`) and drop the rest, or move all into a `?` popover.

---

## G. Tokens / colors

### G1. Two different "card" radii: 14px and 999px
- Metric tabs / harness combobox: `border-radius: 14px`
- All header buttons + mini-buttons inside cards: `border-radius: 999px`
- Search input: `border-radius: 4px`

Three distinct radii in one panel with no apparent rule. Reduce to two (pill for actions, soft-radius for containers) and apply consistently.

### G2. Color variables are sometimes referenced as `oklab(…)` and sometimes as `rgba(var(--operator-arc), …)`
The mix of computed `oklab(0.71919 …)` borders (header buttons) and `rgba(var(--operator-arc), 0.18)` borders (combobox) means future theming has two source-of-truth lookups. Pick one channel system and migrate.

### G3. Inactive metric-tab background is the same hue as the panel body
Inactive tab `rgba(5, 13, 24, 0.42)` over body background `rgba(2, 14, 25, 0.86)` is basically invisible. The "card" is implied only by the rounded corner shadow. Either give inactive tabs a visible chip border or remove the chip and make them text-only.

---

## H. Motion / responsiveness

### H1. Animation classes on every direct child
Header, body, footer, both rails, and the metrics row each have `pc-animate-in pc-animate-in--down pc-animate-in--delay-1/2/…`. That's six layered entrance animations on a single panel open. Tested at 1828px it cascades for ~600ms before the panel settles. Consider one or two motion layers (panel container fade + content fade) rather than per-child stagger.

### H2. At <960px, the right rail vanishes and the body becomes single-column
Rule at `globals.css:5995` hides `--right` below 960px viewport. There's no equivalent compact representation of decisions/stream — they just disappear. If the rail is load-bearing, surface a "show details" toggle on narrow viewports.

### H3. At <760px, the left rail also vanishes (`globals.css:6014`) and grid becomes 1fr
At 760px wide the panel `inset: 58px 10px 10px` and only the main feed is visible. The header still tries to fit four CTAs + Close in `flex-start; overflow-x: auto` — it ends up scrolling horizontally on phones. Likely a no-go for mobile; pick whether Deck is desktop-only and gate it, or design a real mobile layout.

---

## I. Accessibility & semantics

### I1. Tabs lack accessible name with separator (see C1)
Already covered. The fix is also the a11y fix.

### I2. `role="article"` on `<li>` inside `<ul role="list">`
`<li role="article">` overrides the implicit list-item role, which means assistive tech sees a list with `0` items and free-floating articles. Either drop `role="article"` (the `<article>` semantic isn't needed here) or restructure as `<ul><li><article>…</article></li></ul>`.

### I3. `aria-modal="true"` but the underlying chrome is reachable
The panel asserts modal but the op-chat-sidebar (after today's fix), the harness page beneath, and the header are all in the focus order. Either trap focus inside the panel (real modal) or drop `aria-modal` and treat it as a non-modal dialog. Both are defensible; pick one.

### I4. `aria-pressed` AND `aria-selected` on the same button
`OperatorPanel.tsx:1615`: `aria-selected={…} aria-pressed={…}` on a `role="tab"`. `aria-pressed` is for toggle buttons; on a tab it conflicts with `aria-selected`. Remove `aria-pressed`.

### I5. Status text uses uppercase via CSS (`text-transform`), not in the DOM
Means a screen reader reads "I D L E" letter-by-letter in some browsers. Provide the text capitalized in the DOM and only style-case it (or use `text-transform: capitalize`).

---

## J. Minor / polish

- **J1.** "Operator scan degraded — MCP read tools erroring" card title is **truncated/wrapped** awkwardly in cards because the title row has no `max-inline-size`; long titles push the action buttons off-screen on narrow viewports.
- **J2.** Footer `<span>` uses bullet `•` but the entry meta uses `·` (middle dot). Two different separators in one panel.
- **J3.** The "scanning" status chip and the action button "Scan" both exist in the header — one is a state indicator, one is a trigger; they're side-by-side and look like the same control rendered twice.
- **J4.** First-run intro lives in the right rail as `<section class="operator-callout">` — it's the most important onboarding text in the surface but it's in the most peripheral location. Promote to a top-of-feed banner for first-run.
- **J5.** "Set up Papercup →" button on scan-error appears in both the empty state and the rail's Stream-error block. The two are functionally identical buttons in different positions; users see the same control twice on the same render.
- **J6.** The panel close button uses a 16px X icon in a 32×34px circle — the click target is small and offset because of the rounded ring inset. Bump to 40×40 minimum.
- **J7.** Voice slot (`<span class="operator-voice-slot" aria-hidden="true" />`) is rendered in every card meta row but is always empty in steady state. Either show what it controls or drop the placeholder DOM.

---

## Quick wins (worth one designer pass)

If we only have time for a few high-impact, low-risk fixes:

1. **Fix tab text "Pending4"** (C1) — 1-line markup change.
2. **Remove the dead left rail** (A1, E3) — delete the JSX + the CSS override.
3. **Pause button ring color** (B1, B2) — semantic correctness.
4. **Header CTAs to one consistent palette** (B1).
5. **Footer: pick one hint** (F3).
6. **Card buttons: differentiate Keep vs Ignore** (D1).
7. **Search input: visible chip** (C5).
8. **Empty Decisions section: hide or CTA-ify** (E1, E2, A2).

The rest of the list is design judgment + larger refactor (rails, motion, responsive strategy).

---

## Things deliberately **not** flagged

- The dim-the-page `box-shadow` trick — listed in A3 but the spread issue is the only bug; the dim itself is intentional.
- The orb / SVG frame as the panel's identity — covered in A4 but the visual direction itself is a creative decision.
- The HUD overlay (`operator-hud-overlay`) — too tied to the running "energy" idea to call out without a creative review.
