# Deck panel — design audit, round 5 (designer handoff)

**Date:** 2026-05-14 (fifth pass, same day)
**Previous audits:** rounds 1–4 in this folder.
**Designer fixes shipped in:** `1ca25718` "fix deck panel round four audit issues"
**Re-audit method:** opened on `/harness?ws=default&slug=sheets`, sampled live DOM + computed styles, plus diff-read of the commit.

This is a short report. The round-4 list closed cleanly. A few tiny things and one open verification remain.

---

## 1. Confirmed fixed ✓

- **4.1** New `operator-panel-dialog` class is the Radix `Dialog.Content`'s `className`. The dialog wrapper now carries `position: fixed`, the inline-size, and the centring math — and `.operator-panel` is `position: relative` filling the wrapper at 100%. Confirmed in DOM: the dialog box is `1280×1417 @ (454, 68)` — i.e. it physically contains the visible panel. Screen readers walking the dialog subtree will find content this time.
- **4.2** `<strong class="operator-tab-count" data-zero="true">` is emitted when count is 0, and a separate CSS rule mutes the selected-tab badge in that case (`background: color-mix(...metric-fill, transparent 28%)`, neutral border). Selected-non-zero retains the gold fill.
- **4.3** Status chip colour now flows from `.operator-panel[data-scan-status="scanning"] .operator-status { color: rgb(94, 234, 212) }` and the `::before { background: currentColor !important }`. The pulse dot is teal in scanning state. ✓ Verified: computed status color = teal, ::before bg resolves to the same teal hue.
- **4.4** `.operator-panel .operator-tier { overflow: visible !important }` — halo won't be clipped. (Still couldn't render a tier pill during audit; see 5.5 below.)
- **4.5** `display: inline !important` removed from the footer separator rule. Cascade is clean.
- **4.6** New `humanizeAutoAcceptMode` maps `'low' | 'medium' | 'high' | 'off'` to readable copy. Footer reads "Autopilot paused" / "Autopilot off" / "Autopilot: low risk" / "Autopilot: low + medium" / "Autopilot: all risks". ✓
- **4.8** `.operator-feed-harness-filter { flex: 0 0 160px; min-width: 160px }` drops the combobox from 188 → 160. Filter row now has ~32px more horizontal breathing room when rendered. (Filter row not visible in current state — see 5.5.)
- **4.9** `.operator-panel` is now `position: relative; top/bottom/left/right: auto`. All positioning lives in `.operator-panel-dialog`. Single source of truth.

Plus: Modal received a new `contentClassName` prop, threaded straight through to `Dialog.Content`, which is the right shape for further customisation.

---

## 2. Remaining / minor

### 5.1 `.operator-feed-tabs` container is 76px tall for 38px tabs

The tablist row has computed `margin: -9px 0 8px; padding: 0; display: flex; align-items: center` — and a rendered height of **76px** despite the tabs themselves being 38px. That's 38px of implicit vertical chrome above/below the tab buttons (almost certainly a `min-height` inherited from `.operator-panel__metrics` — the metrics class was originally a stat-card grid before it was repurposed as a tablist).

Either:
- Reset `.operator-feed-tabs` min-height: `.operator-feed-tabs { min-height: 0 !important }`.
- Or remove the `.operator-panel__metrics` class from the tablist if its rules are no longer wanted.

Saves ~38px of vertical space above the cards list.

### 5.2 Status dot's `::before` background uses `currentColor` everywhere now — confirm other states match

Round-4's 4.3 only targeted `data-scan-status="scanning"`. Other states (`idle`, `acting`, `thinking`, `awaiting-input`, `paused`) still inherit whatever colour the status chip's base CSS provides. Quick visual check: open the panel in each state and confirm the dot's colour matches the chip's accent. If any state's chip uses an explicit `color` that doesn't read against the surrounding panel, paint the dot explicitly too.

The pulse animation only runs for `scanning`, which is correct — the other states should render a static dot. Verify that the `::before` is still visible (it has explicit `inline-size: 7px; block-size: 7px`), or hide it via `display: none` for non-scanning if you'd rather only show the dot during a scan.

### 5.3 Animation stagger — still six layered entrances

Carried from rounds 2/3/4. Six `pc-animate-in --delay-{0,1,2,fast}` cascades on open. ~600ms before the panel settles. Not blocking, but if a designer wants one final motion polish: drop the stagger inside the panel and use just the panel-level container fade.

### 5.4 Two `<aside>` queries on `body.has-op-chat` use slightly different selectors

The new CSS has:

```css
body.has-op-chat .operator-panel-dialog { ... }
body.has-op-chat:has(.operator-panel) .operator-panel-dialog > .operator-panel { ... }
```

The first uses a class-only selector; the second uses `:has()`. If `op-chat-sidebar` is rendered but the deck is closed, the first rule fires (harmlessly, the dialog doesn't exist). The second is gated by `:has(.operator-panel)`. The asymmetry probably doesn't bite, but for consistency drop the `:has()` from the second rule — it can't fire without the panel anyway.

### 5.5 Couldn't verify tier dot in context

As in round 4 — the workspace has no Pending cards at audit time, so no tier pill is rendered. CSS is correct in source. Designer should screenshot the panel with at least one low/medium/high pending suggestion and confirm:

- Dot fills with the per-tier colour (teal / amber / red).
- Halo `box-shadow: 0 0 0 2px color-mix(currentColor, transparent 86%)` glows correctly and isn't clipped (now that `overflow: visible` is set).
- The 6×6 dot doesn't collide with the 8px horizontal padding of the pill.

### 5.6 Filter row breathing room — same as 5.5

Filter `tools` row is hidden when there are no card entries. Couldn't measure the 4.8-after gap. CSS says the combobox is now 160 (was 188), so the row should fit comfortably at 1280px panel width — but worth a sanity screenshot once a pending card exists.

---

## 3. Net assessment — the Deck is shipped

Across five passes the panel went from "many cross-cutting visual bugs and accessibility gaps" to a clean, accessible, dialog-correct surface with consistent control geometry, a state-coloured status pulse, sensible empty states, real Esc/click-outside close, and proper focus styling. The remaining items in this round are:

- **5.1** A 38px metrics-container ghost height — one-line CSS fix.
- **5.5 / 5.6** Two visual verifications that need a live card or screenshot.
- **5.2 / 5.3 / 5.4** Polish-only.

No new bugs. No structural debt. Designer can ship a tiny follow-up patch for 5.1 + the verification screenshots and call this surface done.

Thank you to the designer for the iteration cadence — five rounds in one day is unusual, and the panel ended up much better for it.
