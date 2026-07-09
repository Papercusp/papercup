# Brief AD — Workspace / tenancy isolation & routing

**Priority: S0/S1 lane.** Integration. Tenancy isolation is a security+correctness boundary.

## Objective
Prove **workspace/tenancy isolation** holds across federation: a pot in workspace A
never leaks to workspace B, writes route to the CORRECT workspace (no 'default'
mis-route), and the workspace ALS context stays correct under concurrency.

## Why it matters
Two proven incidents make this an untested-but-real risk: (1) the **EI-126 102 GB**
blowup was a **workspace MIS-ROUTE** — a write path silently defaulted `workspace_id` to
'default' while the substrate booted under the real workspace, orphaning every capture;
(2) **EI-1534** was a conversations workspace-isolation bug (fixed via a dynamic
`getWorkspaceId` thunk). Workspace is the tenancy boundary; a leak across it is an S0
privacy/correctness failure, and the mis-route class silently breaks federation +
balloons storage. Neither is systematically tested.

## Scope / scenarios
1. **Cross-workspace pot isolation:** a pot/harness in ws-A and a pot in ws-B on the
   same box → assert NO content crosses workspaces (different swarm topics derive per
   workspace — `derive-swarm-topic` cross-workspace isolation), no PG row visible across
   workspace schemas.
2. **Write routing correctness:** a federated write captures under the harness's REAL
   workspace_id, never silently 'default' (the EI-126 class) — assert capture +
   outbox + projection all carry the correct workspace_id end-to-end.
3. **ALS workspace context under concurrency:** `runWithWorkspace` (ALS) — interleaved
   operations across workspaces in one process don't bleed context (the
   pending-wakes-sweep `reg.current` drift class from the prior pass). Property/fuzz.
4. **Multi-workspace per box:** several workspaces each with pots, federating
   simultaneously → each stays isolated + correct; resource scaling.
5. **Workspace switch / move:** moving a harness between workspaces (if supported) →
   the substrate re-routes cleanly, old workspace's outbox drains/GCs, no orphan.
6. **Default-workspace trap:** explicitly assert that a missing/ambiguous workspace_id
   does NOT silently default-and-orphan — it errors or resolves correctly (guard the
   EI-126 root cause).

## Method
- Integration (real PG, multiple workspace schemas) using the workspace-registry +
  `runWithWorkspace`. Property test for the ALS-under-concurrency case. Verify via
  per-workspace PG schemas + the `origin`/`workspace_id` columns. Teeth-verify isolation
  (force a cross-workspace topic collision → assert it's REJECTED).

## Deliverables
- `findings-AD.md`: the isolation + routing matrix, any cross-workspace leak (S0) or
  mis-route/orphan (S1), the ALS-concurrency verdict, the default-workspace guard.

## Done / verdict
GREEN only when pots are provably isolated across workspaces, writes route to the
correct workspace (never silent-default), and the ALS context holds under concurrency.
