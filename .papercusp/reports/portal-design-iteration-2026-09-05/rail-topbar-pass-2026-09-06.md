# Rail + top bar design pass — 2026-09-06

Plan: `portal-design-iteration-2026-09-05#P-002` · Work-item: `WI-10000116` · Driver: `WI-2146962`.

The full Portal destination rail is now usable without misrepresenting enabled rows as dimmed or allowing overflow to hide the More affordance. The shipped source also preserves compact topbar containment at both required desktop widths.

## Findings and change

The prior overfull rail scrolled its own escape hatch out of reach and painted a sticky fade over the final visible destination. That overlay looked like a disabled-state treatment even though the covered row remained enabled. Worst-case badges could crowd their glyph, and long pinned labels had no safe wrap contract.

The existing shell was extended rather than replaced:

- `MoreSections` now sits immediately after, and outside, `.rail-apps`, so only the pinned destination list scrolls.
- `.rail-apps` owns `min-height: 0`, overflow, a stable gutter, and a theme-aware native thumb. The former `::after` fade is absent.
- Badged glyphs reserve horizontal clearance; long labels use safe wrapping and remain inside the real rail-item box.
- Existing More popover/cmdk, URL state, utility footer, side-pane strips, status surface, and theme switcher remain the same components.

Source/test files for the pass:

- Portal `packages/ui/src/shell.tsx`
- Portal `app/globals.css`
- Portal `e2e/portal-more-sections.spec.ts`
- Portal `tests/the-rail-pins-what-it-declares-pinned.test.ts`

## Current-source verification

- `npx playwright test e2e/portal-more-sections.spec.ts --reporter=line --output=/tmp/p002-final-playwright`: **4/4 passed**. Coverage includes pin persistence, every More route, search/Enter/Escape/outside dismissal in light and dark, and overfull-rail geometry at 1440×900 and 1280×800.
- `npx vitest run tests/the-rail-pins-what-it-declares-pinned.test.ts tests/shell-ui.test.tsx`: **93/93 passed** across both files.
- The two generated overfull-rail fixture screenshots were reopened at original resolution after the final run.

## Immutable release proof

The final handoff event fired once for release `7OORWOu1IP4jdyXJu_vDH-20260906173000829-792875-31f999cc`.

- `/tmp/portal-history-serving-b35ba.json` recorded HTTP 200, build id `7OORWOu1IP4jdyXJu_vDH`, and a serving child whose cwd is inside that immutable release.
- Its source and current digests both equal `f18c9ea1d4a80b7c2b9cdd5f7275b2e7f97ad7cd4769a5c1ee58cca08e020e3f`; `digestMatches` is true.
- `/tmp/portal-history-served-b35ba.json` independently recorded unmocked `:3081` HTTP 200 probes with no page errors.
- The superseded D-Q artifact was never handed off or used for acceptance.

## Real `:3081` acceptance

The live browser temporarily used the regression suite's stress preference: all 28 pinnable destinations except PRs, leaving PRs available in More. No preview stylesheet was injected.

At 1440×900 in both Dark and Light:

- `.rail-apps` measured 398px visible against 1716px content and scrolled to 1318px.
- More remained at y=518px before and after scrolling (`deltaY = 0`), outside `.rail-apps`, and fully inside the 900px rail.
- Coordination wrapped to a contained two-line label (43×23px inside its 51px-wide item).
- The More dialog measured 340×138px at x=76/y=518, stayed within the viewport, used a non-transparent theme surface, and focused its search input.
- Every visible direct topbar child fit; the rightmost edge was 1424px, leaving 16px to the viewport edge.

At 1280×800 in both Dark and Light:

- `.rail-apps` measured 380px visible against 1466px content and scrolled to 1086px.
- More remained at y=475px with `deltaY = 0`, outside the scroller and inside the rail.
- Coordination again rendered as two contained lines.
- The More dialog remained 340×138px at x=76/y=475 and contained the real PRs option with search focused.
- Every visible topbar child fit the 65px header; the theme switcher ended at x=1264, again 16px inside the viewport.

A transient DOM-only `99+` badge was inserted into the live Mail button solely to measure the deployed CSS, then removed immediately. It cleared the 20px glyph by 3.05px. The source-level browser regression independently creates the same worst-case badge and asserts at least 1px separation.

Keyboard acceptance on the live page focused More search, entered `PRs`, and pressed Enter. The route became `/?app=prs&scope=all`, the dialog closed, More gained `aria-current="page"` with label `More sections, PRs active`, and focus returned to its trigger. The browser then returned to Phone.

All four live screenshots were reopened and inspected:

- [Dark 1440×900](rail-live-dark-1440x900.png)
- [Light 1440×900](rail-live-light-1440x900.png)
- [Dark 1280×800](rail-live-dark-1280x800.png)
- [Light 1280×800](rail-live-light-1280x800.png)

## Final state

The temporary stress preference was fully reversed. A final server GET plus DOM read confirmed:

- theme `dark`, `data-theme="dark"`, and local mirror `dark`;
- dismissals `[]`, no `data-dismissed`, and no local dismissal mirror;
- the exact original 11 pinned apps in their original order;
- URL `http://127.0.0.1:3081/?app=phone`;
- both Portal side panes collapsed;
- Phone and Call current, with `call-orb phase-idle`;
- no open dialog.

`verdict` was then stopped. No call, notification, destructive action, or backend mutation occurred; only the reversible preference stress set and theme checks were written, and both were restored.
