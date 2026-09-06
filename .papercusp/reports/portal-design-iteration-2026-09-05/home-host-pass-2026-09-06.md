# Home / Mission Control design pass — 2026-09-06

Plan: `portal-design-iteration-2026-09-05#P-003` · Work-item: `WI-2147062` · Driver: `WI-2146962`.

Home cards now follow the space left by the portal rail and sidebars. The fix is live on :3081, with the existing promo dismissal, metric states, notification rows and keyboard actions verified.

## Finding and change

With both sidebars expanded at a 1200×800 viewport, `.surface` was 544px wide and `.mission-grid` had 496px available. Its viewport-only breakpoint still required two 260px tracks plus the gap: 536px, placing cards beyond the window. At 900px, the same 536px grid occupied a 212px content box. Baseline evidence is in `home-host-before-light-1200.png`.

The existing `portal-surface` container now selects one Home content column and two metric columns at 720px or less; below 320px it selects one metric column. A zero track minimum, text wrapping, and a bounded promo link keep the smallest host usable. The old Home viewport rules were removed. The wide layout remains two content columns with four compact metrics; the next-meeting card sizes to its content.

Source root: `/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/portal` (canonical staging checkout, also reachable through `~/papercupai-workspace/portal`). Changed files:

- `app/globals.css`
- `e2e/portal-mounted-surface.spec.ts`
- `tests/load-error-regressions.test.ts`

The registry search for cards returned no matching component. This extends the existing Home grid and follows plan decision D-001. The UI IR validator applies to generated screens, so acceptance here uses the existing browser test framework and the rendered portal.

## Verification

- Added two Chromium tests to the existing mounted-surface suite, exercising seven width/sidebar combinations in each theme. Both failed before the CSS change at the reproduced 1200px case with exactly 40px overflow; both passed afterward. Cases cover 1440 collapsed, 2300 expanded, 1200 expanded, 900 expanded, 821 expanded, 390 mobile and 320 mobile. The fixture uses production shell/container CSS and representative Home markup; the separate live checks below exercise the actual React surface.
- Six focused Vitest files passed: **121 tests**, zero failed. Files: `load-error-regressions`, `metric-empty-state`, `a-count-nobody-supplied-is-not-zero`, `promo-dismissals`, `shell-ui`, `an-unread-list-is-not-all-caught-up`.
- `git diff --check` passed. Production `npm run build` under `pc-heavy.sh` exited 0.
- Release: `PC6v2Yp2Mb50D433LOBFb-20260906042605443-1179462-6fa0f076`. Its manifest recorded source digest `aaa4e27b7ce144cf9f6d8c8eeb9b33851bf57f0b55129eddd1f01a6b2fc02af5`; the built CSS contains the Home container queries. The normal portal handoff independently matched this digest and passed its health check.
- Fresh :3081 navigation had **no temporary preview style**. Light 1200 expanded: grid 496/496px, one content column/two metrics. Dark 900 expanded: 212/212px, one content column/one metric, no clipped cards or controls. Light 390: 294/294px, one content column/two metrics. At 2300 expanded, grid 1180/1180px retains two content columns/four metrics. A separate preview of the actual React markup also fit the 133px content box at viewport 821.
- At 1440px, Tab reached the Workspaces metric with a visible 2px focus outline; Enter opened `?app=workspaces`. Enter opened the notification center from its Home control; Escape closed it. Notification rows fit, and a row-edge hit test resolved to its notification link. Individual messages and their read state were not changed.
- Zero metrics remain visually quieter than positive counts, while unavailable values keep their separate em-dash/accessible-name state. Notification titles truncate while ages remain visible; the empty next-meeting card stays compact.
- Home promo dismissal hid the card, exposed the compact download row, persisted in `/api/preferences`, and survived reload. After verification, GET confirmed **theme `system`, dismissed `[]`**; both DOM attributes were absent, the local dismissal mirror was removed, URL was `/`, and both sidebars were collapsed. The full promo was visible again. Verdict was stopped.

## Visual evidence

All images below were reopened and inspected. Paths are relative to this report.

- [Before, expanded sidebars at 1200](home-host-before-light-1200.png)
- [After, expanded sidebars at 1200](home-host-after-light-1200.png)
- [After, dark expanded layout at 900](home-host-after-dark-900.png)
- [After, light mobile at 390](home-host-after-light-390.png)
- [After, wide Home with promo dismissed](home-host-after-light-1440.png)

Initial audits are also preserved in `home-audit-before-light-1440.png`, `home-audit-before-dark-900.png`, and `home-audit-before-light-390.png`.

## Scope and continuation

P-003 is complete. Full cross-portal accessibility/topbar responsiveness remains P-010; the other rail tabs remain governed by their existing plan items. The completed Calendar, Mail and HUD-control passes were not reopened. WI-2147274 remains deferred for final backend shipment confirmation; no backend release-gate reads or monitoring occurred.

The work waited for the peer's guarded build through file-lock ticket `599a908d-c659-4228-a81e-ef02997e2986`; the refused patch wrote nothing. Source claims were released after the accepted edit. Tool friction is captured in EI-22483391444027854, EI-22483405954575649, EI-22483495007298007, EI-22465233549710829 and EI-22485219809082268. The reproduced Home defect is EI-22483700754810824, linked to this active implementation lane.
