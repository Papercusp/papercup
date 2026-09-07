# Portal revision-5 acceptance evidence

Plan: `portal-design-iteration-2026-09-05`. Driver: `WI-2146962`. Independent grader: `su-4c6126e7-56a7-4176-b865-876b8d736b9f`, holding `WI-10000384`. This index supplies evidence for judgment; it is not an acceptance scorecard or author verdict.

The current correction release is `_h24SwYOHfExTCskF1rTh-20260907041350070-3167183-557305b9`. `provenance.json` records its immutable directory, source root, committed heads, adopted-source hashes, successful build/handoff logs and HTTP readiness. Its root digest is `baf5921be493a6963c4ec95511779e7615f5bf2cfa8c46d0de7d3f76c1f8b242`.

## Evidence population and history

The expected population remains `../acceptance-matrix-2026-09-07.json`, with the method in `../acceptance-verification-contract-2026-09-07.md`. The original `../acceptance-final-2026-09-07/observations.json` contains 164 base surface/theme/viewport slots plus 20 expanded-host and four compact-rail slots. Its `integrity.json` verifies exact inventory, actual PNG dimensions, hashes, unique keys/images, registry agreement, release stability and preference restoration. The 12 contact sheets are indexes; original PNGs are the visual evidence.

The original gallery was captured on `8yDtR949AGueJCPe7Q-EU-20260907030928688-3439458-d4ea1813`. It is preserved as historical evidence. Independent inspection found incorrect unsupported placeholders in Learning, Workflows and Settings at dark/1440. Those original rows are superseded for final target-content judgment by the matching entries in `retakes.json`, which records all three apps at 1440×900 in both themes on the correction release. `effective-matrix.json` selects exactly one capture per original slot without deleting history.

The correction changed the Portal's missing-descriptor branch and PlanDetail text colors. The Portal baseline-to-current diff touches only `packages/ui/src/shell.tsx` and its two test files; the loaded-app rendering branch remains unchanged. Among the adopted linked sources, only `apps/operator/app/admin/plans/plans.css` differs from the recorded Learning-release commit; all other compared linked files match byte-for-byte. Exact comparisons are in `provenance.json`. This bounded comparison justifies reuse of unaffected gallery observations. It does not claim that every linked file in the whole shared tree was unchanged: the guarded build logged linked-dependency drift explicitly.

## Targeted current-release observations

`results.json` records 16 passing behavioral cases: Orders/Activity/Fleet toggles, focus transfer and restoration, full-window/native-fullscreen behavior, parent preservation and Escape at both target sizes/themes; plan-popup native fullscreen and restoration at both sizes/themes; compact rail hit targets, keyboard focus and reduced motion at 1280×768 and 390×768 in both themes; narrow Inbox reading in both themes; and two no-native-fullscreen fallback cases.

The fallback cases are explicitly **browser fixtures**: the production document is mounted with `fullscreenEnabled=false` before hydration. They are not claims about an unmodified live browser. All other cases in this file are live observations. Every changed preference was restored. The initial helper's incorrect rail selector and premature Escape checks remain in `../acceptance-interactions-2026-09-07/`; their corrected rechecks passed and the current-release run uses the corrected instrument.

`retakes.json` additionally records keyboard activation of hidden Evaluation through More in both themes, a live empty calendar state, unknown desktop/workspace counts shown as em dashes with explanations, and disabled desktop actions whose visible host state explains reconciliation or absence. No call, send, launch, decision or verdict action was performed.

`additional-states.json` records two completed HTTP reads for the topbar's workspace/process statistics and the process-manager loading treatment. It does **not** establish a completed native process-list refresh. The observed Phone scheduled form was enabled and had no disabled buttons; its screenshot is not disabled-state proof. These two limits remain explicit for the independent grader rather than being turned into passing assertions. Supporting fixtures must be interpreted only for their own named clauses.

## Work and criterion mapping

Each R-1 binding uses the exact inventory and corresponding surface group below. Each R-2 binding uses that group's original visual observations, current targeted observations where listed, source comparison, and historical pass report. R-3 uses `provenance.json` and the retained verification logs.

| Plan item | Implementing work | Evidence group |
| --- | --- | --- |
| <a id="r-1-p-001"></a>P-001 | WI-2146962 | Full effective matrix, registry and integrity census |
| <a id="r-1-p-002"></a><a id="r-2-p-002"></a>P-002 | WI-10000116 | Rail/topbar gallery; current compact rail and More navigation; `../rail-topbar-pass-2026-09-06.md` |
| <a id="r-1-p-003"></a><a id="r-2-p-003"></a>P-003 | WI-2147062 | Home normal/expanded-host slots; current empty/unknown states; `../home-host-pass-2026-09-06.md` |
| <a id="r-1-p-004"></a><a id="r-2-p-004"></a>P-004 | WI-2147154 | Mail normal/expanded-host slots and unchanged Mail source; historical item note and thread-row guard |
| <a id="r-1-p-005"></a><a id="r-2-p-005"></a>P-005 | WI-2147155 | Calendar normal/expanded-host slots; `../calendar-event-time-pass-2026-09-06.md` |
| <a id="r-1-p-006"></a><a id="r-2-p-006"></a>P-006 | WI-2147610 | Phone normal/expanded-host slots; current scheduled form; `../phone-pass-2026-09-06.md`; disabled-state limitation above |
| <a id="r-1-p-007"></a><a id="r-2-p-007"></a>P-007 | WI-10000284 | Workspaces normal/expanded-host slots and current disabled-state observations; `../workspaces-pass-2026-09-06.md` |
| <a id="r-1-p-008"></a><a id="r-2-p-008"></a>P-008 | WI-10000302 | Seven side surfaces, including distinct Papercup Chat and Chat history; `../side-panes-pass-2026-09-06.md`; native process-refresh limitation above |
| <a id="r-1-p-009"></a><a id="r-2-p-009"></a>P-009 | WI-2147225 | Embedded gallery, exact corrected app retakes and current HUD/popup/Inbox cases; `../hud-popup-pass-2026-09-06.md` |
| <a id="r-1-p-010"></a><a id="r-2-p-010"></a>P-010 | WI-10000317 | Compact rail and keyboard/motion cases; `../responsive-accessibility-pass-2026-09-06.md` |
| <a id="r-3-p-011"></a>P-011 | WI-10000327 | Committed-source comparison, test/typecheck logs, guarded build, supported handoff, immutable release and readiness in `provenance.json` |

Additional adopted fixes are `WI-10000338` (already-completed popup/Inbox work), `EI-22569766397606182` (Learning snapshot crash, prior report), `EI-22573592788166035` (plan text contrast), and `EI-22573684360936822` (truthful registry loading/error/absence). The last two have new regression evidence in this directory. The five startup cases failed before the change; the complete shell suite now passes 91 tests. The two real-browser contrast cases failed before the color correction and now pass. Portal typecheck is clean. Requested/matched files are the named shell suite and mounted-surface browser suite; the contrast run deliberately selected two cases and is not a claim that every browser test ran.

## Remaining acceptance authority

The live rubric remains revision 5, criteria hash `160782a1bcfdae607185847c411dd1e5394891bfa9de8a9c780dceb4cf8f8355`. Its author remains `su-ca863adf-6074-40a3-84c3-ed9c4606da11`. Critique `WI-2146962#199637` and amendment approval `#199649` were read directly. The sole critic is excluded from final grading. No author identity has been transferred or impersonated.

`WI-10000302`'s completion resolver residue and `WI-2147274`'s functional Decisions follow-up remain distinct. `WI-2147154` also still has an open work-item ledger row despite its terminal plan item; this index does not manufacture a terminal completion record. The plan requires independent grading, the original author's later acceptance/rejection, and a current completion audit before shipment.
