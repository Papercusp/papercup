# Deck panel — design audit, round 4 (designer handoff)

**Date:** 2026-05-14 (fourth pass, same day)
**Previous audits:**
- `apps/operator/docs/plans/deck-panel-design-audit-2026-05-14.md` (round 1)
- `apps/operator/docs/plans/deck-panel-design-audit-followup-2026-05-14.md` (round 2)
- `apps/operator/docs/plans/deck-panel-design-audit-round3-2026-05-14.md` (round 3)

**Designer fixes shipped in:** `f422c53c` "fix deck panel round three audit issues"
**Re-audit method:** opened on `/harness?ws=default&slug=sheets`, sampled live DOM + computed styles, plus re-read the JSX/CSS/Modal diffs.

This pass closed virtually the entire round-3 list. The panel is at parity with what we'd expect to ship. The remaining items are small bugs or judgement calls.

---

## 1. Confirmed fixed ✓

- **3.1** Tier pill border is now uniform `1px` and the per-state colour is communicated via a 6×6 `::before` dot with a `color-mix` halo. Cleaner encoding than the prior 3px left stripe.
- **3.2** Footer separator before the last span now renders — the `:last-child::before { content: none }` clause was removed.
- **3.3** `:focus-visible` rule no longer carries `box-shadow !important`. Resting elevation survives focus.
- **3.4** Status `::before` has explicit `display: inline-block; inline-size: 7px; block-size: 7px; background: currentColor` (resolved white in my probe — see 4.3 below); the `operatorStatusScanPulse` animation now has something to animate.
- **3.5** `.operator-feed-search:focus-within { outline: ... }` carries the focus signal on the wrapper, and `.operator-feed-search input:focus-visible { outline: none; box-shadow: none; }` suppresses the inner ring.
- **3.6** The two parallel rail-state classes collapsed into one — `has-rail-activity` / `has-empty-rail` are mutually exclusive, applied on the same element from a single `railHasActivity` predicate. Easier to reason about.
- **3.7** SVG frame removed entirely from JSX. Panel decoration is now just the rounded card + hud-overlay + lock-flash.
- **3.8** Lifecycle and target pills are uniformly neutral. Only `tier` carries a colour-coded dot. Tier (low/medium/high) and lifecycle (accepted/auto/pending/ignored) can now be read independently.
- **3.10 (selected tab count badge — round-2 carryover)** Selected tab `.operator-tab-count` now has filled gold background + dark text + inset highlight + outer glow. Active tab visibly differs from inactive.
- **3.11** Footer text replaced from duplicated counts to `Esc closes · {scanStatus} · {autonomyState}`. Confirmed rendering "Esc closes · Scan running · Auto off".
- **3.12** Rail width is `clamp(240px, 22%, 280px)`. At 1280px panel width it resolves to 276 — proportional to the new panel size.
- **3.13** The old `inset: 68px 22px 22px` rule had `left: 22px; right: 22px;` removed. Late `left/right/inline-size` override now owns the horizontal position.
- **3.14** Radix `Dialog.Content` carries `aria-modal="true"` explicitly. `display: contents` removed from `contentStyle`. Confirmed in DOM: `<div role="dialog" aria-modal="true" aria-labelledby="…" aria-describedby="…">`.
- **3.16** New `@media (max-width: 1100px)` rule makes the action strip flex-wrap instead of horizontally scrolling.

Plus an unprompted bonus: action strip flex-wrap at 1100px (rather than 960px) is more generous than the round-3 ask. And the rail clamp scales correctly when the panel is resized.

---

## 2. Remaining / new issues

### 4.1 Dialog wrapper has 0×0 box because the panel uses `position: fixed`

The Radix `Dialog.Content` (`<div role="dialog" aria-modal="true">`) is `display: block; position: static; width: 0; height: 0` — its only child is the `motion.div.operator-panel` which floats out via `position: fixed`. The dialog's accessible tree is structurally empty; only the `aria-labelledby` / `aria-describedby` references carry information.

Screen-reader behaviour varies:
- VoiceOver: rotor "form controls" listing skips empty dialogs.
- NVDA / JAWS: dialog announcement reads aria-labelledby + aria-describedby, then enters scan-mode in the dialog subtree which is empty.

Two options:
- Drop `position: fixed` from `.operator-panel` and let the Dialog.Content's `content` style position it (or wrap it in a positioned wrapper inside the dialog).
- Or move the visible panel *inside* the dialog wrapper by changing the JSX so `OperatorPanel`'s root is the Dialog.Content (Radix `asChild`), not a floating sibling.

Either way the structural pattern of "dialog → empty wrapper → fixed-position content elsewhere" is a smell that AT will sometimes trip on.

### 4.2 Selected tab badge is loud even when its count is `0`

The selected tab's `.operator-tab-count` is rendered as a filled gold/amber chip (`background: var(--operator-metric-accent)`, dark text). When the count is `0`, the badge still screams. On a fresh workspace the Pending tab is selected by default and its badge says "0" in a big gold pill — drawing attention to *nothing*.

Fix: mute the badge when count is `0`, e.g.,

```css
.operator-feed-tabs .operator-panel__metric-card--tab[aria-selected="true"]:has(.operator-tab-count:is(:empty, [data-zero="true"])) .operator-tab-count,
.operator-feed-tabs .operator-panel__metric-card--tab[aria-selected="true"] .operator-tab-count:where(:is([data-zero]))
```

Simpler: pass `data-zero={count === 0}` from JSX and gate the filled style on `:not([data-zero="true"])`.

### 4.3 Scanning pulse dot is white instead of state-coloured

Computed `::before` `background-color` resolves to `oklab(0.96 -0.015 -0.015)` (almost white) rather than `currentColor`. The CSS rule says `background: currentColor;` but a more specific later rule (or the base `.operator-status::before` block) is setting an explicit white. Result: every state's pulse dot is the same white — the colour-state signal is lost.

Likely fix: find the older `.operator-status::before { background: ... }` rule and either remove its colour or move the scanning-state rule below it.

The halo (box-shadow) is correctly `currentColor`-tinted, so the *aura* around the dot matches the state — just not the dot itself. Probably worth one-shot CSS specificity bump to get them both on-state.

### 4.4 Tier dot's halo may clip if the pill has `overflow: hidden`

`.operator-tier::before` carries `box-shadow: 0 0 0 2px color-mix(in oklab, currentColor, transparent 86%)`. If the parent `.operator-tier` has `overflow: hidden` or `overflow: clip` (couldn't verify in this audit — no pending tier pill rendered when I probed), the halo gets cropped at the chip's rounded edge and the dot looks plain.

Quick verify: render any pending card with a tier and inspect `.operator-tier`'s computed `overflow`. If `hidden`, change to `visible` (the chip already has explicit `padding` so contents won't escape).

### 4.5 Footer `::before` `display` cascade is muddled

The CSS rule `.operator-panel__footer span + span::before { display: inline !important }` is overridden somewhere — computed `display: block` on the rendered `::before`. Visually the separator renders correctly (the spans are flex items and the block ::before fits on the single line because of the short "·" content), so this is a code-tidiness item, not a visual bug. Remove the now-redundant `display: inline !important` and let the cascade pick whatever the base says.

### 4.6 `footerAutonomyLabel` produces awkward strings for non-`off` states

```ts
const footerAutonomyLabel = state.paused
  ? 'Auto paused'
  : state.autoAccept === 'off'
    ? 'Auto off'
    : `Auto ${state.autoAccept}`;
```

When `state.autoAccept` is `'manual'`, `'low-only'`, or `'all-low'` (whatever the actual enum is), the footer reads "Auto manual", "Auto low-only", "Auto all-low" — clunky. Preferred:

```ts
const footerAutonomyLabel = state.paused
  ? 'Autopilot paused'
  : state.autoAccept === 'off'
    ? 'Autopilot off'
    : `Autopilot: ${humanizeAutoAcceptMode(state.autoAccept)}`;
```

Map the enum values through a human-readable function rather than concatenating. (`humanizeAutoAcceptMode` could live in the same file.)

### 4.7 Animation stagger is still 6 layered entrances

Carried over from rounds 2 and 3. Six `pc-animate-in --delay-{1,2,...}` cascades on every open. ~600ms before the panel settles. Designer judgement, but if the team's eyes are tired of audit feedback this is the one cheap motion change to make: drop the per-row stagger and use just the container fade.

### 4.8 Tab + filter row spacing now feels tight in the 962px feed column

At the new panel width (1280), feed column = 962. Pending+Accepted+Ignored+Scans tabs sum to ~480px on the left half; filter search+combo sum to ~478px on the right half. Together that's ~958px, leaving 4px of horizontal breathing room before they butt against each other. Two cheap fixes:
- Reduce the harness-select width from 188 → 160.
- Or push the filter row to its own line below the tabs at panel widths < 1400px.

### 4.9 Panel `top: 68px; bottom: 22px;` from one rule, `left/right/inline-size` from another

Cleanup: the `.operator-panel` selector at L4961-ish keeps `top: 68px; bottom: 22px;` (no inset shorthand any more), and a later override block sets `left: max(36px, …); right: auto; inline-size: min(1280px, …);`. The two-rule positioning is functional but the positioning model lives in two places. Consider consolidating into one block.

### 4.10 No tier pill visible in current state — couldn't verify dot rendering in context

The panel's `Pending` count was 0 at the time of audit, so no card was rendered, so no tier pill was in the DOM. CSS is in place, and the rules are correct in source, but the actual visual of the dot + glow + neighbour pills is unverified.

Action: designer should screenshot the panel with at least one card in Pending and one in Accepted to confirm:
- Dot is the right colour per tier.
- Halo doesn't clip.
- Neighbouring pills (kind / target / life) don't have leftover style competing with the dot.

---

## 3. Quick wins for the next pass

In rough priority:

1. **4.3** Scanning pulse dot uses `currentColor` for both background and halo (it's mostly there, one specificity bump).
2. **4.2** Mute selected tab badge when count is `0`.
3. **4.6** Map `autoAccept` enum through a humanizer before concatenating into the footer.
4. **4.4** Verify tier dot halo isn't clipped; `overflow: visible` on `.operator-tier` if needed.
5. **4.1** Resolve the empty dialog wrapper (or accept it after verifying with a real screen reader).
6. **4.8** Slim down the harness-select or wrap the filter row.
7. **4.5** Drop redundant `display: inline !important` on footer separator.
8. **4.9** Consolidate panel position rules.

Everything else is either out of scope (motion stagger) or pending a screenshot from the live UI (4.10).

---

## 4. Net assessment

The panel is essentially done. Four rounds of audit consumed the structural and semantic debt; the remaining list is small bugs (4.2, 4.3, 4.6) and clean-up (4.5, 4.9). After this next pass we should call the panel shipped and move on to the next surface unless real users surface regressions.

Big thank-you to the designer for the iteration cadence — each round closed nearly the full prior list.
