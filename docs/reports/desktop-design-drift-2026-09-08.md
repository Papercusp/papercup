# Desktop GUI design drift: findings, repair and prevention plan

Prepared for Avi on 8 September 2026; portal verification completed at 09:05 UTC and evidence review updated at 11:10 UTC. The overnight AUTO grant is limited to the specific desktop GUI repair. The wider prevention program is a proposal for morning review.

## Current conclusion

The mismatch is real. You selected a desktop workspace with a large viewer and a compact roster/activity column. The portal instead opened cloud-infrastructure management and required expanding a host before its desktop viewer became visible. The existing viewer implementation was present, but its placement and navigation did not deliver the selected experience.

The layout/navigation repair is now running at **http://127.0.0.1:3801/?app=desktops**. Clicking **Desktops** in the real sidebar opens the selected option B composition directly. Four browser acceptance cases passed against that normal service: sidebar entry and responsive layout, canonical unavailable link, legacy unavailable link, and workspace selection with reload/back/forward. The same sidebar test failed against the prior served build because the desktop workspace was absent.

There is also a separate connectivity limitation: the available canary panel reports that its desktop connection is not ready. Repairing layout and navigation does not prove that a remote desktop is connected. No cloud initialization, credential mint, provisioning, takeover or teardown has been performed for this repair.

## The approved design

Your 7 September choice is recorded in `unified-web-portal-2026-08-29#D-062`: “For the desktop mockups lets go with option B”.

- [Selected option B](../../scratchpad/visual-desktop-mockups-2026-09-07/b-workspace.png).
- [Interactive original mockups](../../scratchpad/visual-desktop-mockups-2026-09-07/index.html).
- Alternatives: [A — Gallery](../../scratchpad/visual-desktop-mockups-2026-09-07/a-gallery.png), [C — Dock](../../scratchpad/visual-desktop-mockups-2026-09-07/c-dock.png).

Option B places the selected desktop in the main area, with desktop previews and recent activity alongside it. Watch, Take control, release/Escape and fullscreen are explicit actions. The decision calls for reusing the portal shell, existing desktop viewer/session components and real scoped desktop data. The mockup's example applications, screens and activity are illustrative; reproducing them as fake production data would not satisfy the design.

## How the drift happened

The source contains three connected implementation choices:

1. `packages/operator-ui/src/surfaces/index.tsx` mounted the same Cloud Workspaces page for both the `desktops` and `cloud` portal destinations.
2. In the separate portal checkout, `packages/ui/src/shell.tsx`'s `operatorDeepLinkTargets()` sets `host` to null for Desktops when `desktopHost` is absent. The sidebar does not supply a host on a fresh entry.
3. `apps/operator/app/cloud-workspaces/OperateStage.tsx` only renders a host's tabs and desktop workspace when that host row is expanded by its selected id.

Consequently, the sidebar could say “Desktops” while the user saw only a cloud-host list. Manually selecting the canary row exposed the viewer and confirmed that the viewer existed. The defect is a composition and navigation failure; it would remain a defect even with a healthy host.

The exact source and live reproduction are recorded on **WI-10000654**. This attribution is based on code and work-item evidence, not a git author or commit subject: this workspace's background git sweeps cannot reliably identify the implementer that way.

## Why the checks did not catch it

### Component checks covered a narrower promise

The existing Cloud Workspaces tests explicitly expand a host. The desktop workspace tests mount the component directly and substitute a test viewer. Those are useful tests of local behavior, but neither establishes that the real portal navigation reaches that component or gives it the approved position on screen.

Before the repair, the relevant existing suites passed: 40 Cloud Workspaces tests, 8 desktop workspace tests, and 22 design-gate tests. A new regression using the **actual portal surface registry** then failed on the broken implementation: the expected desktop workspace was absent and cloud management was rendered instead. All four new entry/state cases failed before the fix and passed after it.

### Written approval was not connected to visual enforcement

I checked the design artifact store for the original plan and desktop work-item scopes: `unified-web-portal-2026-08-29`, `WI-2001281`, `WI-1044532`, and `WI-1044541`. No artifact rows were returned for those scopes. A positive control against the same harness/table returned an existing design artifact, so this was a tested scoped absence, not a failed query presented as zero.

The existing design gate discovers obligations from registered ratified references. With none attached to those scopes, it reports the check as not applicable. D-062's prose selection was durable and readable, but did not itself create the reference/evidence binding the gate consumes.

### There is an additional aggregation weakness

The existing completion adapter returned the **first applicable** candidate design result. A passing plan-level reference could therefore hide a failing item-level reference; an advisory failure could also hide a later enforceable failure. This is a separate defect discovered during the investigation. There is no evidence that it caused this particular screen drift, because the checked original scopes had no registered references in the first place.

### Implementation status was not final acceptance

The original desktop acceptance work, WI-2001281/P-031, still carries a separate connected-cloud acceptance obligation. Its checkpoint claims the B integration was built and rendered, while reserving actual connected DesktopSession/control acceptance for the canary readiness gate. Those statements do not establish that the portal sidebar journey matched B. A component build, a screenshot, an item completion, a plan shipment verdict and actual remote control are different claims and need different evidence.

## Verified repair

The specific repair is tracked under **desktop-design-fidelity-repair-2026-09-08**, with WI-10000654 for the screen and WI-10000685 for focused design-gate hardening.

- The portal registry now mounts a dedicated `DesktopWorkspacePage` for Desktops. Cloud management retains its own destination.
- The desktop page chooses an available workspace when there is no explicit selection, prioritizing one advertising the supported connector. It exposes a workspace selector and preserves explicit deep-link subjects; an invalid subject is shown as unavailable rather than silently opening another machine.
- The real browser test exposed a remaining legacy-link defect: the portal shell erased `host` when `desktopHost` was absent. The bridge now leaves that page-owned selector intact. Canonical `desktopHost` still takes precedence, and workspace selection survives reload and browser back/forward.
- `HostedDesktopConnection` extracts and reuses the existing session/discovery/viewer wiring for both destinations. Host or connector changes reset the scoped connection identity; switching management tabs retains the connection component.
- The desktop page uses the existing option B viewer/roster/activity layout and portal tokens, with a truthful disconnected/empty state and responsive container layout.
- Four new registry-level entry/state tests pass, alongside the 48 existing UI tests. The final focused gate suite passes 31 tests; the portal URL bridge/isolation suites pass 29. Final named operator/core checks and the portal's full TypeScript check passed.
- Focused gate hardening evaluates every candidate and honors explicit `payload.designReferences: [{ featureId, referenceId }]` obligations. Missing declared ratification and malformed requirements can no longer silently become not-applicable. Existing report-only and host-calibration enforcement limits remain intact. Real completion-handler positive and negative controls passed; this is verified source behavior, not a claim that the operator's separate green release pipeline has deployed it.

The initial repaired UI test result is saved in `/tmp/pcv/papercusp-test-files-report-Chnyp2/group-0.json`; the original failing regression result is `/tmp/pcv/papercusp-test-files-report-9iLNC7/group-0.json`. These are local run artifacts. Durable conclusions and later evidence are recorded on the work items.

## Captured result and verification limits

| Capture | What it proves |
| --- | --- |
| [Original sidebar destination](desktop-design-drift-2026-09-08/original-desktops-entry.png) | The real Desktops sidebar opened cloud management before the repair. |
| [Repaired desktop, 1440 × 900](desktop-design-drift-2026-09-08/desktop-option-b-1440.png) | Large viewer area with compact roster and activity alongside, reached through the actual sidebar. |
| [Repaired narrow screen, 390 × 844](desktop-design-drift-2026-09-08/desktop-option-b-390.png) | Responsive page header and viewer, without horizontal destination overflow. |
| [Narrow roster after scrolling](desktop-design-drift-2026-09-08/desktop-option-b-390-roster.png) | The stacked roster/activity panel is reachable inside the portal's scrolling content. |

These are actual portal/current-data captures, with no fabricated desktop image or activity. Compared with option B, the selected viewer/roster hierarchy is restored; the existing portal shell remains. The illustrative mockup's connected screen cannot be reproduced honestly while the available canary has no ready connector. Real remote video, Watch/Take control/release/Escape/fullscreen operation still belongs to the separately gated connected-cloud acceptance; this repair preserves the existing transport/viewer implementation and does not claim those live actions were exercised.

The served portal build is `sAkL9leDemaAAqkCOmti2-20260908090133472-3040183-ef6fa24f`, with build ID `sAkL9leDemaAAqkCOmti2` and portal source-root digest `820d2f1184e5cd448761f272cab6621476171105a8d3589d8b9c45109f2f157c`. The normal `papercusp-cloud-portal.service` was restarted onto that immutable generation after preview acceptance. Build, full portal typecheck, and real service browser checks passed. The build reports separately changing linked dependencies; its root digest is not a whole-monorepo freeze claim.

Formal acceptance remains open. The current acceptance rubric is revision 3, with the original BAR meanings preserved and the bugfix class and verification methods recorded. The current spec-quality card is `EI-22684842903034302`; independent audit `EI-22685428343609739` passed. The earlier card `EI-22683309730362618` failed audit and is superseded. The documentation guidance clause has an explicit manual-review exemption from unit testing; the guidance remains mandatory under R-2.

Independent review rejected the original test-adequacy cards' freshness claims because copied fingerprint inputs did not independently measure the source. Replacement bindings 2098–2105 use the existing server measurement mechanism; all three replacement cards passed independent audit at 10:28 UTC. The UI repair work item **WI-10000654 is now done**, with entry and state proofs accepted.

A later edit to the shared completion handler correctly invalidated the gate-hardening proof before WI-10000685 could close. After that engineer finished, the final handler passed all 31 focused tests in run `17699293`. Card `EI-22690357630226713` passed independent audit `EI-22690592842804193` while the measured files were held stable. **WI-10000685 is now done**, and that hold is released. The earlier intermediate gate cards are retained as history.

P-003 is now held as WI-10000721. Its layout-proof card `EI-22690943583588666` binds the actual browser run and original-build counterexample to measured source, tests and captures; its independent audit is in progress. Final plan acceptance is still pending. The separate git-sync status does not change these current-build verification results or establish deployment of the operator-core hardening.

Server measurement covers repository source, test and saved artifact bytes. It does not claim a fresh live deployment measurement; the historical browser runs retain their original build identities, and final acceptance still requires an independent actual-portal run and visual inspection. Code-truth audit 5 now resolves the source/evidence citations for all three plan items.

The rubric critique is recorded at `WI-10000712#201552`. Author vetting `EI-22691141147855764` supersedes an earlier record whose integrity audit found incomplete reproduction instructions and missing explanations of how the criticized properties could be satisfied. The revised record supplies exact read probes and concrete improvement paths; its audit is pending. Three rubric weaknesses remain explicit: R-2 mixes outcome and implementation language; R-1/R-3 share some browser evidence; and the browser/manual review lacks its own structured check. R-1/R-2's structured test checks run Vitest, so placing a Playwright file there would use the wrong runner; the existing typed probe mechanism provides a possible improvement path. These limitations do not waive the required browser journey, visual comparison, causal report or cloud-connectivity disclosure. The broader proposal below is the place to refine this enforcement contract.

## Recommended prevention program

The proposed plan is **design-acceptance-journey-enforcement-2026-09-08 — Bind approved UI designs to navigation and shipment evidence**. It is intentionally draft. I recommend the following order:

| Stage | Change | Acceptance check |
| --- | --- | --- |
| 1. Bind approval | Record the approved artifact, hash/revision, approval source, implementing items, route and required states in the existing design/spec stores. | An approved design with missing or malformed binding cannot silently pass as not applicable. |
| 2. Test entry | Require a test through the real shell/navigation with clean URL, persisted selection, direct link and back/forward cases. | A correct component behind the wrong destination fails. |
| 3. Check the state matrix | Capture ready, empty, loading, disconnected and error states at agreed viewports/themes; verify layout bounds and control availability. | A placeholder cannot stand in for ready-state evidence; a missing narrow state remains unproven. |
| 4. Bind completion and shipment | Require current evidence for every applicable reference/case, tied to source and served build identity. | Wrong target, stale build/reference, missing proof and a later failed obligation each block independently. |
| 5. Pilot and calibrate | Independently review the desktop repair, exercise deliberate negative controls, and define historical migration and explicit exceptions before wider rollout. | The controls demonstrably fail on the original defect and analogous missing-reference/stale-evidence cases. |

This should extend existing mechanisms, not introduce another design database or screenshot service. The essential proof families are complementary:

- **Structural/journey checks** prove where the screen appears, what the user can reach and whether layout bounds hold.
- **Calibrated image comparison** proves appearance only when reference and implementation use commensurable data, fonts, viewport and theme.
- **Real runtime journeys** prove the backend connection and actual application controls.
- **Independent visual review** checks the agreed intent and any explicit adaptation that a deterministic image comparison cannot fairly judge.

A pixel threshold alone will not solve this incident. Comparing an illustrative mockup's example browser windows against changing live content can produce misleading failures; loosening the threshold until it passes can hide structural drift. Conversely, a pixel-perfect component screenshot can still be mounted behind the wrong navigation. The contract must name both the target and the journey.

The practical rule I recommend is: **no UI approval lives only in prose, and no UI completion relies only on a component test or a hand-picked screenshot.** The approved reference, actual entry route, required state matrix and current build evidence should be visible together in the plan's acceptance record. Reference changes and exceptions should be deliberate, versioned and reviewed, never silently regenerated from the drifting implementation.

## Overnight scope

I am continuing directly in this session with AUTO mode registered. The recurring loop was stopped after the live repair; the exact independent-review completion event carries the remaining handoff. The stop condition is formal closure of the verified specific desktop layout/navigation repair and an updated report. The broader prevention plan remains for your morning review. Cloud credentials, initialization and provider lifecycle operations retain their existing separate approval boundaries.
