# Desktop GUI design drift: findings, repair and prevention plan

Prepared for Avi on 8 September 2026; portal verification completed at 09:05 UTC and the repaired meta-vetting record has passed independent audit. Avi subsequently approved the prevention program for start-to-finish implementation and designated this desktop repair as its first canary, recorded in `design-acceptance-journey-enforcement-2026-09-08#D-001`.

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

The durable browser counterexample is test-run **17690294** (`desktop-option-b-original-negative-scoped-20260908`): the original served build fails because the desktop workspace is absent. Test-run **17690287** (`desktop-option-b-live-scoped-20260908`) passes against the repaired portal. Retrieve both with `testing:runs { filePath: "portal-desktop-design.spec.ts", since: "2026-09-08T09:00:00Z", limit: 20 }` and select those exact IDs. `work_items:get { id: "WI-10000654", harness: "papercusp" }` preserves the framework verification and diagnostic record. Both ledger rows were re-resolved during final acceptance. The earlier temporary runner files had expired; citation defect **EI-22693002294959764** replaces those links with these durable records.

For later evidence handoffs, resolve each cited record at delivery and retain its test-run ID and source work-item. Temporary runner output must not be the lasting verification reference.

## Captured result and verification limits

| Capture | What it proves |
| --- | --- |
| [Original sidebar destination](desktop-design-drift-2026-09-08/original-desktops-entry.png) | The real Desktops sidebar opened cloud management before the repair. |
| [Repaired desktop, 1440 × 900](desktop-design-drift-2026-09-08/desktop-option-b-1440.png) | Large viewer area with compact roster and activity alongside, reached through the actual sidebar. |
| [Repaired narrow screen, 390 × 844](desktop-design-drift-2026-09-08/desktop-option-b-390.png) | Responsive page header and viewer, without horizontal destination overflow. |
| [Narrow roster after scrolling](desktop-design-drift-2026-09-08/desktop-option-b-390-roster.png) | The stacked roster/activity panel is reachable inside the portal's scrolling content. |

These are actual portal/current-data captures, with no fabricated desktop image or activity. Compared with option B, the selected viewer/roster hierarchy is restored; the existing portal shell remains. The illustrative mockup's connected screen cannot be reproduced honestly while the available canary has no ready connector. Real remote video, Watch/Take control/release/Escape/fullscreen operation still belongs to the separately gated connected-cloud acceptance; this repair preserves the existing transport/viewer implementation and does not claim those live actions were exercised.

The served portal build is `sAkL9leDemaAAqkCOmti2-20260908090133472-3040183-ef6fa24f`, with build ID `sAkL9leDemaAAqkCOmti2` and portal source-root digest `820d2f1184e5cd448761f272cab6621476171105a8d3589d8b9c45109f2f157c`. The normal `papercusp-cloud-portal.service` was restarted onto that immutable generation after preview acceptance. Build, full portal typecheck, and real service browser checks passed. The build reports separately changing linked dependencies; its root digest is not a whole-monorepo freeze claim.

Independent acceptance grade `EI-22693849676823148` passes every required criterion of rubric revision 3. The original BAR meanings are preserved, with the bugfix class and verification methods recorded. Author signoff is recorded in `EI-22694494830679445`. The current-build acceptance snapshot still requires the auto-generated BAR clauses to be linked to the implementing work contracts and proof records before the plan can close. The current spec-quality card is `EI-22684842903034302`; independent audit `EI-22685428343609739` passed. The earlier card `EI-22683309730362618` failed audit and is superseded. The documentation guidance clause has an explicit manual-review exemption from unit testing; the guidance remains mandatory under R-2.

Independent review rejected the original test-adequacy cards' freshness claims because copied fingerprint inputs did not independently measure the source. Replacement bindings 2098–2105 use the existing server measurement mechanism; all three replacement cards passed independent audit at 10:28 UTC. The UI repair work item **WI-10000654 is now done**, with entry and state proofs accepted.

A later edit to the shared completion handler correctly invalidated the gate-hardening proof before WI-10000685 could close. After that engineer finished, the final handler passed all 31 focused tests in run `17699293`. Card `EI-22690357630226713` passed independent audit `EI-22690592842804193` while the measured files were held stable. **WI-10000685 is now done**, and that hold is released. The earlier intermediate gate cards are retained as history.

**P-003 / WI-10000721 is also done.** Its layout-proof card `EI-22690943583588666` passed independent audit `EI-22691371624012736`. All three implementation items are now terminal. The plan's normal completion process selected an eligible independent grader, who passed the final review after fresh framework tests, an actual-portal browser run and desktop/narrow visual inspection. The separate git-sync status does not change these current-build verification results or establish deployment of the operator-core hardening.

Server measurement covers repository source, test and saved artifact bytes. Historical browser runs and the gallery above retain their original build identities. The final independent grader separately exercised the normal portal with current data and inspected fresh desktop/narrow captures; that review is recorded in `EI-22693849676823148`. Code-truth audit 6 refreshes the changed completion handler and carries forward the verified P-001/P-003 records; all three plan items have current source/evidence citations.

The rubric critique is recorded at `WI-10000712#201552`. Author vetting `EI-22691141147855764` supersedes an earlier record whose integrity audit found incomplete reproduction instructions and missing explanations of how the criticized properties could be satisfied. The revised record supplies exact read probes and concrete improvement paths. Independent audit `EI-22692975457751030` passed after replaying the rubric, critique, decisions and durable browser/gate evidence; review item `WI-10000717` is done. This audit establishes the integrity of the vetting record. Final plan acceptance still belongs to the separate eligible grader. Three rubric weaknesses remain explicit: R-2 mixes outcome and implementation language; R-1/R-3 share some browser evidence; and the browser/manual review lacks its own structured check. R-1/R-2's structured test checks run Vitest, so placing a Playwright file there would use the wrong runner; the existing typed probe mechanism provides a possible improvement path. These limitations do not waive the required browser journey, visual comparison, causal report or cloud-connectivity disclosure. The broader proposal below is the place to refine this enforcement contract.

## Approved prevention program

The approved plan is **design-acceptance-journey-enforcement-2026-09-08 — Bind approved UI designs to navigation and shipment evidence**. Its source-conversation activation audit is recorded. The first scorecard reproduced the expected verdicts but failed independent audit because its evidence omitted measuring stores and executable probes. Replacement `EI-22702225943362317` preserves the evaluator's full per-criterion evidence and passed independent integrity audit `EI-22702539061841818`. The implementation order is:

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

## Current scope

The prevention plan is admitted, and **P-001 / WI-10000753 is done**. Its adequacy card `EI-22705619308225344` passed independent integrity audit `EI-22706307135229268`. Ratified references can now declare versioned approval provenance, implementing plan items, route and required states; implementing work-items pin the exact reference revision and image hash. The completion path checks that binding, and the materializer independently verifies image bytes. Replacement revisions require a new approval reference. Historical references retain their existing rollout policy.

The final scoped proof passed 47 tests (ledger runs `17705400` and `17705401`). Four deliberately broken guard variants each failed their intended test: missing binding `17705231`, malformed binding `17705297`, replaced reference `17705303`, and rejection of a valid binding `17705393`. Each mutation was restored before the next run. These are contract and completion-path proofs with controlled comparison data; browser navigation, rendered-state coverage and the final independent desktop canary grade remain the following plan stages. The exact spec-adequacy evaluation passes with nine current, server-measured evidence bindings. No operator release or broader enforcement rollout is claimed here.

**P-002 / WI-10000754 is done.** Its adequacy card `EI-22723082678610707` passed independent audit `EI-22723558531078017`, and terminal completion was accepted. The existing browser suite now names six separate clean, canonical, legacy, persisted-selection, reload and history scenarios. Historical run `17712295` reaches a loaded shell in all six cases and then fails at the missing Desktop workspace while Cloud Workspaces is rendered. Repaired preview run `17713845` passes all nine tests, including all later selection/history actions, invalid-subject controls and the held-stats regression. The [P-002 evidence record](../evidence/desktop-design-journey-p002-2026-09-08.json) retains both build identities, saved captures, scenario observations and verification limits.

**P-003 / WI-10000755 has an accepted terminal close.** Exact adequacy card `EI-22726148974991556` passed independent integrity audit `EI-22726453965588050`. Browser run `17714647` passes 29 tests: 20 ready/empty/loading/disconnected/error captures across 1440 × 900 and 390 × 844 in light/dark themes, plus independently named state/viewport omissions, wrong-target and false-readiness controls. It renders the actual workspace and viewer components with local ticket/socket/framebuffer fixtures; Take control, Release and Escape exercise real viewer UI logic without a real remote connection. The [side-by-side review gallery](../evidence/desktop-render-matrix-p003-2026-09-08/review.html) preserves the original option-B image beside each inspected capture. Its [reviewed matrix](../evidence/desktop-render-matrix-p003-2026-09-08/reviewed-matrix.json) binds geometry, controls, provenance and review to exact image and fixture-build hashes. The close currently has proposed authority pending committed-file identity settlement; that remains a closeout obligation.

The P-003 production extension stores optional structured render observations through the existing `compare_render` and `get_design_evidence` path. It independently hashes the actual image before storing its observation; matrix checks reject missing cases, mismatched target/environment/build, overflow, unavailable controls, placeholders presented as ready, and fixture connectivity claims. Scoped framework checks passed 59 tests (`17714672`–`17714675`), including image/hash and gallery-link validation. This structural review uses fixture tokens and content; it does not claim calibrated pixel equivalence with the illustrative mockup. The separately reviewed real portal canary remains **disconnected**. The original six entry failures never reached the desktop state matrix; the repaired real capture shows the required desktop/roster composition. P-004 completion/shipment enforcement and P-005 independent canary grading remain open.

The separate loading defect **`EI-22708091798400094` is done**: shell refresh now invokes the existing workspace-statistics refresh independently of app-list rendering. Its browser regression holds the stats request open, fails on the earlier served build in `17711801`, and passes on the repaired preview in `17713845`. The preview build, TypeScript and 96 shell/preference checks also passed. The verified preview is `YwYDgKxI3kL-64RCJTWa4-20260908160620228-2244334-229c9378`, with portal root-source digest `049ab089027614df8f0553dcc1e6a2a26e74706d82c93884fe0a89d31d07877e`. It was staged without promotion; these results do not claim deployment or a frozen linked-dependency graph.

**P-004 / WI-10000756 is done, with committed completion authority.** Exact adequacy card `EI-22728973201597463` passed independent audit `EI-22729270661168973`. After the pause was lifted, the recorded source/test hashes still matched and the exact adequacy reevaluation passed. The existing immutable approval now pins the reviewed journey/state contract and names its evidence artifact. The shared gate independently hashes the declared source, test, fixture, rubric, environment and build artifacts, checks the builder's recorded revision, validates each browser entry scenario and each render case, and re-hashes capture bytes. The existing browser file ledger corroborates the scenario artifact; its aggregate pass is not presented as a separate measurement of every scenario. Shipment re-evaluates every implementing work-item, including ones already closed, and cannot inherit a stale completion. Tests exercise the saved original negative and repaired positive desktop evidence with controlled current-file and ledger inputs. These are enforcement-path tests, not a new live desktop session.

Newly adopted approval contracts require explicit acceptance registration and proof. Historical references without an approval contract retain their existing policy; the original design-gate switch remains its registered kill switch. Illustrative raster references are judged by the pinned structural/journey contract and explicit visual review, without claiming calibrated pixel equivalence. P-005 canary grading/migration guidance and final settlement remain open.

Work resumed after the verified system-wide lift at 22:01 UTC. P-004 is complete following **181 passing tests** (`17717417`–`17717421`), a passing independent audit and a current-proof recheck. The [P-004 evidence record](../evidence/desktop-design-gate-p004-2026-09-08.json) preserves the test identities, counterexamples and verification limits. The work loop is restored on the same direct implementation route. P-005 is now in progress; its independent canary census, versioned migration/exception policy and bounded rollout remain, followed by original repair AUTO-BAR/report settlement.

At 22:39 UTC, P-005's exact spec evaluation passed with eleven current evidence bindings, and adequacy card `EI-22734787899631831` was submitted for independent audit. The [implementation verification](../evidence/desktop-design-rollout-p005-verification-2026-09-08.json) records 100 passing tests across six files and the ledger's partial persistence of that run. All seven named changed TypeScript files passed their focused typecheck. The [seven-control census](../evidence/desktop-design-rollout-p005-census-2026-09-08.json), [versioned policy](../evidence/desktop-design-rollout-policy-2026-09-08.json) and [author guidance](design-acceptance-author-guidance-2026-09-08.md) are saved. Wider adoption now requires a byte-pinned policy and an independent complete review through the existing ratification path; the current recommendation grants no wider cohort or exception. Historical obligations are preserved, and temporary exceptions can only defer explicitly named new adoptions.

P-005 is not closed. Its adequacy card passed independent integrity audit `EI-22735392982903881` at 22:49 UTC. A subsequent current-proof check found a source mismatch caused solely by another change to `packages/operator-core/lib/scorecards.ts`: substituting that file's previously measured bytes exactly reproduces the stored nineteen-file source fingerprint. That change is now committed. The six-file P-005 refresh passed 100 tests at `517d7038b0`, with rollout ledger run `17727361`; evidence renewal remains necessary before closure.

The separate re-audit defect `EI-22734527752004628` is fixed. Both draft and active neutral-edit cases reproduced the original refusal; the fixed real-Postgres suite and amendment suite pass all 25 tests, and the three named changed TypeScript files are clean. Re-audit uses the last successful audit's exact source snapshot to preserve locked BAR text and METHOD while advancing only the derived subject-version pin. Repeated re-audits preserve rubric and spec revisions; actual Requirements or work-mapping changes remain subject to the amendment guard. After the 9 September owner-directed resume, the staging service successfully recorded activation audit 3 without changing the rubric or BAR set.

Final acceptance preparation found undeclared proof layers in both plans. The proposed amendments preserve the existing outcomes and evidence planes while declaring the required component, integration and browser proof. Independent review requests are recorded on `WI-10000757` (`thread-post:202133`) and `WI-10000723` (`thread-post:202135`); neither amendment has been applied. A broader current-source test run also found 15 completion-gate cases failing during synthetic-reference setup, before their intended assertions, because the new rollout prerequisite was absent. This regression is tracked as `EI-22752246212019237`; the fixture now supplies the admitted synthetic cohort through the existing host-owned test seam, with verification in progress. Original repair/report settlement and P-003 committed-authority settlement remain outstanding. No connected-cloud desktop or wider deployment is claimed.
