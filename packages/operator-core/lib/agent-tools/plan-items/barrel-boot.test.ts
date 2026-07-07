/**
 * barrel-boot.test.ts — the plan_items tool barrel is what the operator boot runs
 * (agent-tools/index.ts → import './plan-items'). This proves that import is
 * side-effect-safe: it registers the 10 tools, installs the swarm-backed claim
 * authority, AND registers the authority-side plan-item.claim.* op handlers (the
 * receiving side of Phase-4 legs b/c) — all without throwing, so it cannot wedge
 * operator boot. (It imports su-584a8's @papercusp/operator-core/lib/authority.)
 * No PG, no network.
 */
import { describe, it, expect } from 'vitest';
import { getClaimAuthority, LocalClaimAuthority } from '../../plan-items/claim-authority';
import { registeredAuthorityOpKinds } from '../../authority';
import { PLAN_ITEM_CLAIM_OP_KINDS } from '../../plan-items/claims';

describe('plan_items tool barrel boots cleanly', () => {
  // 180s timeout (EI-8386, 2026-07-07: bumped again from 60s — 4 timeout failures
  // in 6h against a test that completes in ~3s isolated, confirming this is STILL
  // the same "merely slow under a heavily-loaded box" class the 20s→60s bump
  // already documented below, not a new hang: installSwarmClaimAuthority()/
  // registerPlanItemClaimAuthorityOps() at the bottom of ./index run fully
  // synchronously — no await, no network/PG I/O at import time — so the only
  // thing that can make this test slow is CPU-bound module-graph TRANSFORM time
  // under concurrent fleet load, never a stuck async op. Fleet concurrency has
  // grown since the 60s bump, so 60s is no longer enough margin; hanging-at-boot
  // — the thing this test actually guards — still fails eventually, just slower
  // to report.) The barrel import transitively transforms a large module graph;
  // under a fully-parallel affected run on a loaded box (the green-checkpoint's
  // isolated tree, peers deploying) a tight timeout flakes while the import is
  // merely SLOW, not hung (it passes in ~1.6-3s isolated).
  it('importing the barrel installs the swarm claim authority + claim op handlers without throwing', { timeout: 180_000 }, async () => {
    // Default before the barrel loads: the pure single-peer local authority.
    expect(getClaimAuthority()).toBeInstanceOf(LocalClaimAuthority);

    // Exactly what operator boot does. Must not throw.
    await expect(import('./index')).resolves.toBeDefined();

    // After boot: the swarm authority (rides Track B) is installed — no longer the
    // bare local default.
    expect(getClaimAuthority()).not.toBeInstanceOf(LocalClaimAuthority);

    // …and the authority-side claim op handlers are registered, so when THIS
    // operator is the elected authority it can execute claim ops routed from peers.
    const kinds = registeredAuthorityOpKinds();
    expect(kinds).toContain(PLAN_ITEM_CLAIM_OP_KINDS.acquire);
    expect(kinds).toContain(PLAN_ITEM_CLAIM_OP_KINDS.heartbeat);
    expect(kinds).toContain(PLAN_ITEM_CLAIM_OP_KINDS.release);
  });
});
