# Phone surface design pass — 2026-09-06

Plan: `portal-design-iteration-2026-09-05#P-006` · Work-item: `WI-2147610` · Driver: `WI-2146962`.

Phone now keeps its four views reachable and its content readable at the width the portal actually gives it. The change is live on :3081. No call, screening action, voicemail mutation, invite creation, cancellation, or message-state change was made during verification.

## Findings and changes

The composed surface used browser viewport breakpoints even though the portal rail and two sidebars can consume most of that width. Two defects were reproduced on the prior release:

- At 390×844, the `max-width:720px` viewport rule hid `.phone-rail`, leaving Call, Recents, Voicemail and Scheduled unreachable. The two-row dialer also compressed the 108px call orb to 40px and placed it above the call-face boundary.
- At 1200×800 with both sidebars expanded, the 544px Phone shell retained a 220px rail and left a 324px stage. The scheduled layout still entered its window-width two-column mode: its list track collapsed to 0px, the form extended to x=1240 outside the 1200px window, and the layout measured 276/340px.

Phone now owns an outer `phone-host` inline-size query container that works in both standalone and embedded hosts. At 960px or less, the existing view buttons become a labeled four-column grid above the stage; at 600px they become two columns. At extremely narrow widths their text remains visible while decorative icons yield space.

The dialer rows use a minimum-content floor and a scrollable stage; the orb cannot flex smaller than 108px. Scheduled layout breakpoints now query the Phone stage instead of the window. History, search inputs, call metadata and form controls have explicit zero minimums or safe wrapping, so they can shrink within the host.

Source roots:

- Phone: `/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/phone-app`
- Portal: `/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/portal` (also available as `~/papercupai-workspace/portal`)

Changed source/test files:

- Phone `packages/ui/src/index.tsx`
- Phone `packages/ui/src/styles.css`
- Portal `e2e/portal-mounted-surface.spec.ts`

`design-phase.search_registry` returned no matching tabs component. The pass therefore extends Phone's existing `nav-item` buttons, preserving their labels, counts, `aria-current`, URL state and keyboard behavior. It follows portal decision D-001: composed surfaces size against the host box.

## Automated verification

- Portal mounted-surface Playwright suite: **7/7 passed**. Three Phone checks mount the real `PhoneApp` with read-only fixture data: light/dark embedded layouts across 1440 collapsed, 1200 expanded, 900 expanded and 390 collapsed; all four views; 30 scrollable history rows; long names/titles; scheduled form/rows; and standalone 390px rendering. Fixture write ledger remained empty.
- Before the Phone fix, the new browser checks reproduced the 108×40px orb; after the fix it is 108×108px in every scenario. A history-search input boundary found by the check was fixed before the final pass.
- Phone UI tests: **23/23 passed** across `styles.test.ts`, `scheduled.test.ts` and `guest.test.ts`.
- Phone template/composition checks: **15/15 passed** via `npm test`.
- Focused Portal tests: **96/96 passed** across `shell-ui`, `four-surface.e2e` and `load-error-regressions`.
- `git diff --check` passed in both source roots. Production Portal `npm run build` under `pc-heavy.sh` exited 0 while the tested Phone source files were frozen by a manual file claim.

## Build and live verification

Release `2M17A1qsGtuCsr533c8Lm-20260906053433054-3005181-08d9b5fe` was published from Portal source digest `bbbf80eec6859dcf816f7b4184fbf194266a77f6ae6866bca21d3191e9cf443e`. Its CSS/JS contain the new `phone-host`, stage-container and minimum-content row markers. The normal deployment handoff independently matched the source digest and reported the service active and healthy.

Fresh :3081 checks, with no injected preview styles:

- 1440×900: Phone shell 1264/1264px, all four view controls visible, Call active, and orb 108×108px.
- 390×844 light: shell 294/294px; all four controls visible in two 132px columns; orb 108×108px. The stage is intentionally vertically scrollable (424px viewport, 653px content); scrolling to its maximum placed the transcript bottom exactly at the stage bottom.
- Recents at 390: all 50 rows loaded; the last row scrolled into the viewport; history measured 294/294px with zero clipped rows.
- Voicemail at 390: its truthful empty state read “No messages. Voicemail your assistant takes will appear here.” No read control was activated.
- Scheduled at 390: keyboard focus displayed a 1px outline on Scheduled; Enter selected it and updated the URL/`aria-current`. Layout and form measured 266/266px and 264/264px; all five inputs measured 230/230px.
- Scheduled at 1200 with both sidebars expanded: surface/shell/stage measured 544/544px, layout 516/516px, form 514/514px, all inputs 480/480px, and no scheduled row/control clipped. The form was fully visible within the stage.
- 900×800 dark with both sidebars expanded: surface/shell/stage widths were 260/260px, all four 115px navigation cells were visible, the orb remained 108×108px, both call controls fit, and no relevant element clipped. The stage provides the required vertical scroll instead of compressing the call face.

All four after screenshots were reopened and inspected:

- [Wide light dialer](phone-after-light-1440.png)
- [Compact light dialer](phone-after-light-390.png)
- [Expanded-sidebars light schedule form](phone-after-scheduled-light-1200.png)
- [Expanded-sidebars dark dialer](phone-after-dark-900.png)

Baseline screenshots are `phone-before-light-1440.png`, `phone-before-light-390.png`, and `phone-before-scheduled-light-1200.png`.

## Final state and scope

The live preference at the beginning of this resumed session was Dark, so Dark was restored after the explicit Light checks. A final GET/DOM read confirmed theme `dark`, dismissals `[]`, no dismissal attribute, route `/?app=phone`, both portal sidebars collapsed, Phone view Call, and `phase-idle`. Verdict was stopped. The shared portal lease, build source claim and all screenshot/report claims were released after use.

P-006 is ready to close. The completed Home, Calendar, Mail and HUD-control work was not reopened. WI-2147274 remains deferred for final backend shipment confirmation; no live release-gate read or monitoring occurred.

Design defect: EI-22487614106515213. Test-setup friction: EI-22488185952023403. Artifact scan and yielded-resource sequencing observations: EI-22524433293093245 and EI-22524905211865110.
