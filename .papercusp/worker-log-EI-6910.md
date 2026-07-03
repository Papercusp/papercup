# Worker log — EI-6910 (coord invariant: escalations unacked past 6h)

## Root cause
`coord-invariant-monitor`'s stale-escalation check (`evaluateInvariants` in
`packages/operator-core/lib/harness/routines/coord-invariant-actions.ts`) counted
ALL open escalations older than a 6h threshold. That count included the normal
human-decision backlog (owner approval-requests, agent-raised blockers/questions,
plus leaked test-fixture debris), which is NEVER a coordination-substrate leak — a
human clears those. So the invariant fired perpetually (snapshot: 554 open) and
minted an un-closeable bug that re-filed every hour.

The rest of the system already excludes this: `computeEscalationsHealth`
(system-health), the attention reader (tiering), and the reconcile sweep all use
the shared `isOperationalEscalation` classifier — only OPERATIONAL escalations
(system / infra-emitter, option-less) are substrate-owned; they're auto-drained by
the hourly attention-reconcile sweep on the `OPERATIONAL_ESCALATION_TTL_MS` (48h)
deadline. The invariant monitor was never brought in line with that model.

## Fix (already present in tree — source + test both landed; my run verified it)
The escalation invariant is re-scoped to measure substrate DRAIN failure, not the
human backlog:
- `InvariantSnapshot.openEscalationTs: string[]` → `openEscalations: OpenEscalationLite[]`
  (`{ ts, from, hasOptions }`), populated in `gatherSnapshot` from
  `listEscalations({status:'open'})`.
- `evaluateInvariants` now fires ONLY on operational escalations still open past
  `OPERATIONAL_ESCALATION_TTL_MS` (48h) — i.e. the reconcile sweep is not keeping
  up. Genuine (non-operational) escalations never violate, however old.
- New STABLE dedup title: `coord invariant: operational escalations undrained past
  reconcile TTL` (severity minor). The old `staleEscalationHours` threshold was
  removed. Reuses the shared `isOperationalEscalation` classifier (reuse-first).
- Mirrors the sibling handoff invariant (auto-accept stale before measure,
  F-FIX-037) and wake-queue invariant (sweep dead-owner wakes before measure,
  EI-314): measure genuine stalls, not expected/human-owned state.

## Verification
- `npx vitest run lib/harness/routines/coord-invariant-actions.test.ts` — 25/25
  passed, including the `EI-6910` regression test (genuine escalations never
  violate; operational-within-TTL never violate; operational-past-TTL → exactly one
  violation with the new title/severity).
- No stale references to `openEscalationTs` / `staleEscalationHours` anywhere in the
  tree except the explanatory NOTE comment (build-safe).
- Live data (`harness_shared.coord_open_escalations`): the old 6h-all check would
  fire on ~282 rows; the re-scoped check fires only on 14 operational rows past the
  48h TTL. The perpetual human-backlog false positive is eliminated.

## Distinct discovery (NOT EI-6910 — captured separately)
14 operational escalations remain open past the 48h reconcile TTL: 13 from
`steering-lease` (opened 2026-07-01, just crossed 48h) and 1 from
`system:infra-liveness-alarm` (opened 2026-06-28, ~5 days old — genuinely
undrained). `steering-lease`/`compaction-watchdog` were only added to
`AUTOMATED_INFRA_EMITTERS` on 2026-07-02 (EI-6789), so the reconcile may not have
caught up; the 5-day-old infra-liveness row should already have drained → possible
reconcile-sweep gap (or heavy-tick shedding). The re-scoped invariant will surface
this on its next hourly run; captured as an observation for follow-up.

## Validator should re-verify
- The unit test is green in the affected suite.
- The re-scoped invariant is the intended semantics (substrate drain-health, not
  human backlog).
