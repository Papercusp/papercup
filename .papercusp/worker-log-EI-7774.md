# Worker log — EI-7774 (auto-implement)

## Assignment
Auto-implement papercusp improvement EI-7774 (kind=bug):
"[replication-liveness] no_replicator: harness=papercup log=332ffc74284d… (WI-183 class)"

## What EI-7774 actually is
A **runtime** replication-liveness detector observation, NOT a code bug. Identical
class to EI-7770 (already resolved needs-human):
- Filed by `packages/operator-core/lib/sync/hyperbee/replication-stall-ei.ts`:
  `no_replicator` is a detector verdict (line 57/173), created with
  `createdBy: 'system:replication-liveness'` = RECOVERY_OWNER (line 71/185).
- `origin=remote`, workspace=default, harness=papercup, state=open, severity=major.
  The admitted remote log had 0 live replicator peers for 180s (WI-183 zombie-
  connection class — a stale-DHT-announce peer looks connected but carries no ops).
- It carries NO code change to make. It auto-resolves via the detector's own
  recovery path (`m.setIssueState(id,'resolved',RECOVERY_OWNER,note)`) on the
  machine running the merge loop for that log, once replication recovers.

## Why a generic auto-implement worker cannot resolve it
- Verifying the current verdict requires the p2p-release-readiness fleet's live
  in-process `getReplicationLiveness()` / dogfood-substrate diagnostics — NOT
  PG-queryable, and for an `origin:remote` log not observable from this box.
- P2P / shared-hive federation is explicitly NOT a V1 target (owner directive
  2026-07-06). No V1 effort should be spent verifying/prepping it.
- I cannot honestly resolve `fixed` (cannot verify the remote log recovered) and
  there is no in-scope generic code bug to fix.

## The systemic root cause (already tracked, not re-filed)
The auto-implement dispatch leaks these detector EIs into the auto lane:
`classifyImprovement` (`packages/operator-core/lib/harness/improvements/policy.ts`)
returns `tier:auto` (kind=bug is auto-eligible; no watchdogKey → infraEnvironmentHit
null; no paths → protected-path gate inert; no protectedKeyword hit). The
`federationDetectorExclusionSql` guard (WI-2633) only covers the SELF-SELECT path,
not auto-implement dispatch.

Durable class-fix is ALREADY FILED and open: **EI-8455** (kind=change) — gate
`createdBy === 'system:replication-liveness'` (RECOVERY_OWNER) to `tier:human` in
`classifyImprovement`, +/- a read-items.ts candidate-seam filter mirroring
`federationDetectorExclusionSql`, + a policy.test.ts case. Verified still open this
run — did NOT re-file a duplicate.

## Why I did not implement the fix myself (STOP condition)
EI-8455's fix lives in `packages/operator-core/lib/harness/improvements/**` — a
protected TCB path in `DEFAULT_RISK_TIER_POLICY.protectedPathPatterns` AND the
self-improvement loop's OWN dispatch policy. The implement-worker contract's STOP
conditions explicitly bar auto-editing the loop's own code (bootstrapping hazard).

## Outcome
- EI-7774 → resolved `needs-human` (runtime detector EI, gated to the
  p2p-release-readiness fleet; not verifiable/fixable by a generic worker; the
  systemic dispatch-leak fix is protected TCB / human-gated).
- No new EI filed — the class-fix EI-8455 already exists and is open.

## What a human should re-verify
- Confirm the p2p-release-readiness fleet owns EI-7774's triage (auto-resolves on
  recovery via RECOVERY_OWNER).
- Land EI-8455 so `system:replication-liveness` detector EIs stop being dispatched
  to generic auto-implement workers (this recurred: EI-7770, now EI-7774).
