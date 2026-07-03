# worker-log EI-6910 — coord invariant: escalations unacked past 6h

## Outcome: fixed (loop closed by this run; code authored by a prior dispatch)

## Root cause
`coord-invariant-monitor.evaluateInvariants` counted ALL open escalations older than
`staleEscalationHours` (6h) for its `major` "escalations unacked past 6h" invariant.
That set includes the human decision backlog (blocker/question/advisory from real
agents/operator) which is NEVER a substrate leak — a human clears it. So the invariant
fired perpetually on the ~554 normal-backlog rows and minted an un-closeable `major` bug
that re-filed every hour. Same category error as EI-6789/EI-6782 (escalation-aging health
metric).

## Fix (commit 11e0427292 — committed via git-sync, rides the release gate)
- Removed `staleEscalationHours` from `InvariantThresholds`/`DEFAULT_THRESHOLDS`.
- Snapshot now carries `openEscalations: OpenEscalationLite[]` ({ts, from, hasOptions}).
- The invariant now fires ONLY on genuine substrate DRAIN FAILURE: operational escalations
  (`isOperationalEscalation` — same classifier the reader + reconcile sweep use) still open
  past `OPERATIONAL_ESCALATION_TTL_MS` (48h, the reconcile sweep's own deadline). Severity
  major -> minor. Genuine human decisions excluded. Mirrors the sibling handoff
  (auto-accept-before-measure) + wake-queue (sweep-before-measure) invariants.
- Regression test `EI-6910: ... measures substrate DRAIN failure, not the human backlog`.

## What this run did
Reproduced (read the item snapshot: 554 openEscalationTs; DB: ~290 open, only ~14
operational-eligible), found the fix already in the tree (prior dispatch committed it but
never called improvements:resolve — implementAttempts:1, still open), reviewed it for
correctness, and VERIFIED it green.

## Validator should re-verify
- `cd packages/operator-core && npx vitest run lib/harness/routines/coord-invariant-actions.test.ts` => 25/25 (incl. new EI-6910 test).
- No dangling `staleEscalationHours`/`openEscalationTs` code refs; `InvariantSnapshot`/`OpenEscalationLite` have no external consumers; module typechecks clean.
