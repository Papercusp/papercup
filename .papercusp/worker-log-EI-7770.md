# Worker log — EI-7770 (auto-implement)

## Assignment
Auto-implement papercusp improvement EI-7770 (kind=bug):
"[replication-liveness] connected_never_replicated: harness=papercup log=d24d52a910cb… (WI-183 class)"

## What EI-7770 actually is
A **runtime** replication-liveness detector observation, not a code bug:
- `engineer_issues`: `created_by=system:replication-liveness`, `found_during=replication-liveness-detector`,
  `origin=remote`, `state=open`, `severity=major`, workspace `papercusp-workspace`, harness `operator:papercusp-workspace`.
- Filed by `packages/operator-core/lib/sync/hyperbee/replication-stall-ei.ts` when
  `sampleReplicationLiveness()` (replication-liveness.ts) sees a swarm-connected-but-never-replicated log
  held past the 3-min grace (the WI-183 zombie-connection class).
- It carries NO code change to make. It auto-resolves via the detector's recovery path
  (`resolveReplicationStallEi`) on the machine running the merge loop for that log, once replication recovers.

## Why a generic auto-implement worker cannot resolve it
Verifying the current verdict requires the p2p-release-readiness fleet's live in-process
`getReplicationLiveness()` / dogfood-substrate diagnostics — NOT PG-queryable, and for an
`origin:remote` log not even observable from this box. This is exactly the WI-2633 rationale.
I cannot honestly resolve `fixed` (cannot verify the remote log recovered) and there is no in-scope
generic code bug to fix.

## Root cause of the mis-dispatch (distinct finding → EI-8455)
The `federationDetectorExclusionSql` guard (WI-2633, `work-items.ts`) gates these detector EIs out of
the **self-select** path only. The **auto-implement dispatch** is a different path:
`classifyImprovement` (`packages/operator-core/lib/harness/improvements/policy.ts`) returns `tier:auto`
for this EI — kind=bug is auto-eligible, no `watchdogKey` so `infraEnvironmentHit()` = null, no `paths`
so the protected-path gate is inert, and the title/body hit no `protectedKeyword`. So the detector EI
slips into the auto lane and is dispatched to a worker that structurally cannot action it.

Proposed durable class-fix (captured as **EI-8455**): gate `createdBy === 'system:replication-liveness'`
(RECOVERY_OWNER) to `tier:human` in `classifyImprovement`, and/or filter it at the candidate-read seam
(`read-items.ts`) mirroring `federationDetectorExclusionSql`. `ImprovementCandidate` already carries
`createdBy`, so the fix is ~5 lines + a `policy.test.ts` case.

## Why I did not implement the fix myself (STOP condition)
The fix lives in `packages/operator-core/lib/harness/improvements/**` — a protected TCB path in
`DEFAULT_RISK_TIER_POLICY.protectedPathPatterns` AND explicitly the self-improvement loop's own code.
The implement-worker contract bars auto-editing the loop's own dispatch policy (bootstrapping hazard),
so this is `needs-human`, with the diagnosis + proposed fix filed as EI-8455.

## Outcome
- EI-7770 → resolved `needs-human` (runtime detector EI gated to the p2p-release-readiness fleet;
  cannot be verified/fixed by a generic worker).
- EI-8455 filed (kind=change) for the systemic dispatch-leak fix (human-gated, protected code).

## What a validator/human should re-verify
- Confirm the p2p-release-readiness fleet owns EI-7770's triage (topic `federation` / `replication-liveness`).
- Confirm EI-8455's proposed classifier gate is the right seam vs. the read-items filter.
