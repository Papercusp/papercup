# Worker log — EI-7783 (auto-implement)

## Assignment
Auto-implement papercusp improvement EI-7783 (kind=bug):
"[replication-liveness] connected_never_replicated: harness=papercup log=b5ab1807fbc9… (WI-183 class)"

## What EI-7783 actually is
A **runtime** replication-liveness detector observation — NOT a code bug. Identical class to
EI-7770 (already dispositioned needs-human by a prior worker; see worker-log-EI-7770.md).

- Filed by `packages/operator-core/lib/sync/hyperbee/replication-stall-ei.ts` when
  `sampleReplicationLiveness()` (replication-liveness.ts) sees a swarm-connected-but-never-replicated
  log held past the 3-min grace (the WI-183 zombie-connection class).
- `origin=remote`, `created_by=system:replication-liveness`, `found_during=replication-liveness-detector`,
  workspace `papercusp-workspace`, harness `papercup`, stalledForMs=1269993 (a stale, transient window).
- It carries NO code change to make. It auto-resolves via the detector's recovery path
  (`resolveReplicationStallEi`) on the machine running the merge loop for that log, once replication recovers.

## Why a generic auto-implement worker cannot resolve it
- Verifying the current verdict requires the p2p-release-readiness fleet's live in-process
  `getReplicationLiveness()` / dogfood-substrate diagnostics — NOT PG-queryable, and for an
  `origin:remote` log not even observable from this box (WI-2633 rationale). Cannot honestly
  resolve `fixed` (cannot verify the remote log recovered), and there is no in-scope generic
  code bug to fix. `could-not-fix` would only re-dispatch the same non-actionable runtime EI.
- The systemic mis-dispatch (these detector EIs leaking into the auto lane) is ALREADY tracked as
  **EI-8455** (kind=change, open): gate `createdBy === 'system:replication-liveness'` to `tier:human`
  in `classifyImprovement`. That fix lives in `packages/operator-core/lib/harness/improvements/**` —
  a protected TCB path AND the self-improvement loop's own code — so it is human-gated (STOP condition;
  the implement-worker contract bars auto-editing the loop's own dispatch policy). Not re-filed here.
- Standing OWNER DIRECTIVE (2026-07-06): P2P / shared-hive federation is NOT a V1 target; drain
  directive explicitly rejects P2P/shared-hive/cross-machine federation rows. This EI is exactly one.

## Outcome
- EI-7783 → resolved `needs-human` (runtime detector EI; not verifiable/fixable by a generic worker;
  systemic fix tracked as EI-8455; P2P out of V1 scope per owner directive).
- Linked EI-7783 `relates` EI-8455. No duplicate class-fix filed.

## What a validator/human should re-verify
- Confirm the p2p-release-readiness fleet (topics `federation` / `replication-liveness`) owns this class.
- Land EI-8455's classifier gate so `system:replication-liveness` EIs stop leaking into the auto lane.
