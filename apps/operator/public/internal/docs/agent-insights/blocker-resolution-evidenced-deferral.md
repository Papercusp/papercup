# Blocker decisions: measured repair and evidenced deferral
URL: /internal/docs/agent-insights/blocker-resolution-evidenced-deferral

Current-source guidance and examples for blockerDecision, canonical custody, measured clearance, live-peer deferral and successor evidence. Draft pending clean committed proof and final release acceptance.

The blocker decision contract is implemented on the current working source for \[\[blocker-self-resolution-and-evidenced-deferral-2026-11-06]]. This guidance is preparatory until that plan's clean committed proof and final release acceptance are recorded. It does not assert that a release operator has loaded the change.

Record an encountered blocker on its canonical work-item before deferring it. Investigate the condition and try a safe remedy within your authority. Use the existing blocker, lifecycle and dependency tools; the decision is part of the work-item's existing payload and history. It creates no extra queue, monitoring mission or authority.

The guarded boundaries are work\_items:set\_blocker, work\_items:set\_state, work\_items:release, work\_items:park, work\_items:link and plans:set-status. Once a canonical unresolved obligation exists, changing its status, removing an edge, shelving it or handing it off does not erase it. A refused decision preserves custody and returns the missing evidence and next action. A blocker-free voluntary release or priority shelf keeps its ordinary lifecycle behavior. Trusted system propagation preserves its actual source provenance; agents must not invent investigation on its behalf.

A blockerDecision uses schemaVersion:1, a stable idempotencyKey, symptom, investigation, attempts and evidenceRefs. Each investigation or attempt has action, outcome and its own evidenceRefs. References have kind and ref. The server reads the referenced evidence; writing a plausible explanation is insufficient. Keep the exact normalized request for an idempotent retry. A changed decision uses a new key and the current priorRevision. Author, session and recording time come from the host.

For disposition:self\_resolve, supply verification with an outcome and evidenceRefs. Verification must measure satisfaction of this work-item or its canonical blocker condition, and every unresolved canonical obligation must be satisfied. Example: a dependency is missing; inspect the dependency error, make the authorized configuration repair, and run the relevant maintained check. Cite the actual investigation, repair and passing verification, then clear the measured obligation through the existing tool. A passing unrelated test or a bare “fixed” statement cannot prove clearance. Partial remediation preserves every independent blocker and hold; it cannot manufacture dispatch or resumed readiness.

For disposition:defer, supply deferral.reason, reasonEvidenceRefs, responsibleParty, nextAction and recheckRef. The recheck must be a reachable, still-pending work-item, event or state predicate. Choose a reason supported by the canonical evidence:

* active-peer: name the live peer who currently owns the relevant unresolved dependency. Example: another agent already holds the producer repair. Link that owned work and its exact completion event, send useful evidence once, and continue independent steps. Do not create a competing repair or second monitor.
* missing-authority or human-action: cite the measured authority denial or precise human capability, name its actual accountable actor, and state the concrete missing action. Preserve the existing human-blocker defaults and owner decisions.
* external-dependency: cite the pending dependency and its accountable source, with an actionable recheck.
* technical-limit: retain responsibility yourself, cite the pending limit, and record an attempted safe remedy or measured evidence that an attempt is unsafe. A self-authored limit or stale heartbeat is not proof.

The narrowly scoped retained-runtime technical-limit path does not turn an unmeasured runtime into available evidence. It requires the host-bound obligation, the same custodian, a measured attempted remedy and a separate reachable pending work-item recheck owned by that custodian. It does not authorize a generic release or clear.

Legacy rows remain readable as unproven; malformed decision history remains invalid. Neither state receives invented evidence. Work-item and successor summaries disclose omitted evidence and provide a readRef to the full canonical history. Follow that reference when the responsible party, next action or verification is omitted. A recorded decision is historical evidence and does not grant present custody, takeover or monitoring authority.

Plan absorption is a separate disposition guarded by the canonical drop/graph transaction and a bound plan decision. It is not an escape from unresolved obligations. Consult the current schema and the maintained boundary tests before using it.

The recurrence guards are blocker-resolution-decision.test.ts, blocker-resolution-boundaries.integration.test.ts and the SU blocker-resolution scenario. Current-tree test results prove only the source they ran against. Clean committed evidence, exact case bindings, independent behavioral verification and final runtime containment remain separate acceptance obligations.
