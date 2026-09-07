# Portal acceptance continuation — 2026-09-07

Driver: WI-2146962. This is a continuation of `portal-design-iteration-2026-09-05`, not an acceptance verdict. The original capture matrix and earlier correction evidence remain under `acceptance-corrections-2026-09-07/`.

## Completed work

The startup-label correction EI-22573684360936822 and PlanDetail contrast correction EI-22573592788166035 are now terminal in the work-item ledger with structured root-cause and verification evidence. Their completion authority was returned as **proposed**, not committed. The concrete source, tests, immutable release and screenshots are recorded in the original evidence index/provenance. The distinction is retained here rather than relabeling the ledger's authority.

Meta-rubric card **EI-22577324999589644** grades the current acceptance rubric at revision 5: five criteria pass; preference for structured checks is weak with an explicit manual-proof disposition. It cites actual third-party critique WI-2146962#199637 and approval #199649. The original rubric author remains **su-ca863adf-6074-40a3-84c3-ed9c4606da11**. The sole critic is excluded from independent acceptance grading.

Independent grader **su-4c6126e7-56a7-4176-b865-876b8d736b9f** emitted **EI-22577547772880485** and completed WI-10000384. Its ratings are R-1 healthy, R-2 degraded, R-3 healthy for the preceding correction release. It has no author acceptance verdict. The grader initially inspected the meta-card without emitting its required formal `grading-integrity` card; a claimed formal audit was therefore overstated in driver commentary and was retracted. The correction is now complete: formal audit **EI-22579659195903370**, under **WI-10000398**, passed. A fresh target-card read verified `gradingAudit.state: passed`, that exact audit id, auditor su-4c6126e7, and audit time 2026-09-07T05:34:01.103Z.

## Additional defect fixed: stale refresh replaces a saved preference

**EI-22577829529093067.** A read-only Process manager observation requested Light but ended in Dark. The originating cause is `PortalShell.refresh()`: `/api/preferences` is read in a `Promise.all`, then applied after unrelated reads complete. A local theme save can finish between that read and its eventual application.

The distinguishing browser fixture delayed only the real `/api/apps` response, without modifying any response body. Before the correction, the stored theme began Dark; selecting Light changed both the DOM and the server to Light; releasing the delayed response changed the DOM back to Dark while the server remained Light. This rules out an external actor changing the stored theme as the cause of this reproduction.

The correction extends the existing shell model with `createPreferenceRefreshGuard`. A refresh cannot apply preference data if it crosses a local save or starts while any save is pending. Theme, pinned-app and promo-dismissal writes all use the guard. A later uncontested read remains authoritative, including after a failed save. Files in the canonical Portal checkout:

- `packages/ui/src/shell-model.ts`
- `packages/ui/src/shell.tsx`
- `tests/preference-refresh.test.ts`

Verification:

- `npx vitest run tests/preference-refresh.test.ts tests/shell-ui.test.tsx`: both requested files matched; **96/96 passed**, including five concurrency cases and the 91 existing shell cases.
- `npm run typecheck`: clean; `git diff --check`: clean.
- Guarded standalone build and supported handoff succeeded. Logs: `preference-race-build.log`, `preference-race-handoff.log`.
- `preference-race-live.json`: **both opposing theme races pass** against the production release with the delayed-response fixture; preferences restored and release stable. The initial saved probe's retired `.rail-app` selector timed out with zero cases; that attempt is preserved, and the corrected probe uses the actual loaded rail.
- `acceptance-corrections-2026-09-07/preference-fixed-results.json`: **16/16 interaction cases pass** on the new release, with preferences restored and release stable. The two fullscreen fallbacks remain explicitly browser fixtures.
- `acceptance-corrections-2026-09-07/preference-fixed-state-proofs.json`: Process manager settles in both actual themes. Each displayed Enrolled/Scanned pair matches its own successful `taskManager.inventory` response. The source reader renders `summary.total` as tasks and `live.scan.processes` as processes; these are different units. Both corresponding PNGs were reopened and inspected. No task control was activated.

The running correction release is `Jk8vf6oxYwqHmspJA7Mim-20260907051125119-3083707-5c175f77`, built with root digest `0c82479b990e3575c577a4179613d477d6caf6ba9fcce3ba4418e4e660c5cbe1`. Both :3801 and :3081 returned HTTP 200. `preference-race-provenance.json` records the immutable entry, current file hashes, source HEAD, build/handoff/evidence hashes and the result of the subsequent full-source comparison.

## Remaining acceptance limits

**Phone:** the required disabled-state witness is still unexercised. Its idle and scheduled forms have no disabled control. The source disables controls during call connection/ending, pending incoming/screening writes, or saving an invite. The current acceptance procedure prohibits call/send/launch/decision actions. No such action and no fabricated disabled state was used. The previous `phone-disabled.png` is an enabled form and remains explicitly insufficient evidence.

**Current source/provenance:** after the verified build, `package.json` and `package-lock.json` changed to add/update dependency overrides. The recomputed full root digest consequently differs from the running release. The three preference-fix files are unchanged since verification, and among the previously adopted source files only `shell.tsx` differs from the preceding correction release. This bounded source comparison does not establish that the new dependency manifests were built. The three preference-fix files also remained uncommitted at the latest checkout check. Therefore the older R-3 healthy grade and the 20 preceding evidence bindings are historical evidence; they are not a fresh R-3 pass or current binding proof for this later checkout/release pair.

**Synchronization:** the Portal routine is active on its actual ten-minute schedule, not the documented three-minute default. Its 05:15 due sweep had not fired in the 05:22 routine read. A manual Portal fire was refused by this session's hive boundary and was not bypassed. The recurrence was appended to existing **EI-22564817934661702#199812**; duplicate EI-22579011189811839 was dropped. This does not prove the routine is dead; the existing issue's prior retraction is preserved.

**Authority:** the original rubric author has not picked up the directed verdict request. A targeted read after that wake still showed the same parked session with no newer activity; a subsequent bare wake also reported pickup unconfirmed. No author has been substituted. The plan remains awaiting acceptance; no final completion audit or shipment verdict is claimed.

Next: verify the automatic source commit and reconcile the changed dependency manifests with a new verified build or explicit scope disposition; refresh the affected evidence bindings and independent grade; obtain the original author's later verdict, including a disposition for Phone's unexercised state; then record the current completion audit and final shipment decision.
