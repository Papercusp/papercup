/**
 * Boot wiring — register the work-item claim AUTHORITY ops (the receiving side of a
 * cross-Swarm claim RPC). decentralized-dispatch-scaling-2026-06-08 P-004 / D-002.
 *
 * Imported once from the agent-tools barrel (a side-effecting import, mirroring how
 * `agent-tools/plan-items/index.ts` calls `registerPlanItemClaimAuthorityOps()`). This
 * registers the `work-item.claim.{acquire,heartbeat,release}` handlers so that when a
 * peer routes a work-item claim to THIS machine as the per-Hive authority, the op runs
 * against the local lease store. Idempotent; safe before migration 188 applies (the
 * handlers only touch PG when actually invoked by an inbound RPC).
 *
 * NOT installed here: the production multi-peer ROUTER (a Hive-scoped
 * `SwarmWorkItemClaimAuthority`, mirroring `plan-items/claim-authority-swarm.ts`) and
 * the `work_items:claim_next` → lease wiring. Those are the Track-B-cutover follow-up
 * (gated on the cross-Swarm mesh transport + P-006); until then the store's default
 * `LocalWorkItemClaimAuthority` is correct (single box → authority is always self).
 */
import { registerWorkItemClaimAuthorityOps } from '../../work-item-claim-authority-ops';

registerWorkItemClaimAuthorityOps();
