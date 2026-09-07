# Portal acceptance verification contract

Plan: `portal-design-iteration-2026-09-05`; driving work: `WI-2146962`.
Independent critique: `WI-2146962#199637`, by `su-96533dc7-ef1c-4059-8d85-2f54290c3572`.

This is the verification contract and expected population, not a passing scorecard. Implementation reports, a completed item list, or a count of images cannot establish the remaining acceptance claims.

## Three distinct questions

- **R-1, coverage:** Did the pass cover every scoped destination, side surface and adopted finding? Compare the expected matrix with actual evidence keyed by surface, theme and viewport. This criterion owns inventory and traceability. R-2 owns the visual result, and R-3 owns source/release freshness.
- **R-2, user-visible behavior:** Is each observed surface legible, contained by its actual host, truthful about state, and usable by pointer/keyboard, with prior state restored? This traces to Requirements R-2 and Decisions D-001, D-003 through D-008. A wider viewport is insufficient when expanded docks make the host smaller.
- **R-3, provenance:** Which committed source, successful checks, guarded build and supported handoff produced the inspected release? Match evidence to that identity. This criterion owns freshness and provenance, including the distinction between Portal root files and linked dependencies.

The exact population is [acceptance-matrix-2026-09-07.json](acceptance-matrix-2026-09-07.json). Its rail list comes from `DEFAULT_PORTAL_APPS`, the writer of the default app registry. Compare it with the actual account registry before grading; the current visible pinned rail is not a complete inventory. Side surfaces include the independent Papercup Chat and Chat history entries. A new destination must be reconciled explicitly. No generated count can waive an expected slot.

## Evidence and test boundaries

The four checks previously bound to rubric revision 4 are unsuitable as whole-criterion proof: `AdvShell.test.tsx` checks a limited embedded-shell seam; `mounted-surface-css.test.ts` checks stylesheet reachability; `cloud-workspaces/visual-contract.test.ts` checks semantic color literals; `gate-release-site.test.ts` concerns published-site metadata rather than Portal build identity. Their green results do not certify this matrix or the release. Do not rebind them as substitutes.

Each criterion uses an explicit manual instrument and the replication procedure below. Existing focused tests remain useful for their actual clauses. Portal `tests/source-integrity.test.ts` exercises root versus linked-dependency fingerprints. `tests/build-standalone.test.ts` exercises the guarded build wrapper with fixtures. Portal `e2e/portal-more-sections.spec.ts` exercises the rail with the mounted production cascade. The PlanPopupModal and InboxPane suites and the narrow Inbox browser cases cover the additions in `WI-10000338`. None proves the entire live matrix, actual systemd descendant, or historical screenshot provenance. Record the exact requested/matched test files and their results before interpreting a run; a partial run is unknown.

## Replication drill

1. Record the initial URL, theme, app, dock, overlay and dialog state in a separate browser context. Read the actual app registry and reconcile it with the expected matrix. Read current release metadata before any capture.
2. Visit every expected rail and side-surface slot at both target sizes and themes. Record actual viewport and host dimensions, URL, stable state, screenshot path/hash, capture time and release identity. Inspect each image for the named surface and rendered content. Different slot keys cannot share an unexplained copied image. A requested slot that is unavailable gets an explicit unknown/fail result and explanation.
3. Inspect containment at the host box and the additional/state cases in the matrix. Open controls without sending messages, launching calls/desktops, resolving decisions, or changing verdicts. Relevant fixture evidence must be labeled as fixture evidence. Restore every changed setting and compare with the starting state.
4. Reuse earlier successful build/handoff evidence only when its exact source/release identity and affected file fingerprints resolve. Read the current immutable entry, release metadata, source-root digest and HTTP readiness. Source-root digests exclude linked packages by design: compare the affected linked source files separately. A fresh build is needed only if the promised source is not represented by the inspected artifact; do not rebuild the already-completed UI additions merely to repeat their closure.
5. Bind actual observations to the current spec revisions, with source, test, rubric and environment fingerprints appropriate to the evidence. Keep failed/stale evidence as history. An independent grader reads the complete matrix and current pins; the rubric author then records a separate acceptance or rejection. Do not ship from a self-grade or a missing author response.

## Preserved history and known limits

The existing pass reports and PNG files in this directory are historical evidence and must be mapped to named matrix slots before they count. The previous “48 non-empty PNGs” threshold is retired as a verification method; it could be satisfied by the wrong slots or duplicate files.

`WI-10000338` is live and terminally complete after storage recovery, on recorded artifact `l1_ti6W2OA7E4z9vHlHf6-20260907020239497-3882061-f2cebbf3`. Its saved verification remains available on that work item and in `/tmp/portal-ui-check.5HGN3G`; no implementation or build was repeated for its close.

Keep `WI-10000302`'s resolver residue and the functional Decisions follow-up `WI-2147274` distinct from design acceptance. A correct loading/error treatment can satisfy a design clause, but it cannot be presented as proof that Decisions functionality works. Record any affected acceptance slot honestly.

Current status at contract authoring: the independent critique is persisted; the replacement matrix is defined; complete matrix observations, current revision bindings, meta-vetting, independent grading and the original author's verdict still require verification. No final acceptance or shipment is asserted here.
