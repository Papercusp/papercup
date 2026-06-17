/**
 * Cross-machine lock E2E with authority failover mid-hold (P-007 of
 * coord-system-e2e-testing-2026-06-10) — the two-instances-one-box rung.
 *
 * Rig: `_two-instance-authority-rig.ts` — two simulated machines with
 * per-instance stores behind the REAL file-lock op handlers, real loopback
 * HTTP through the REAL `handleAuthorityRpc`, HARDENED authority verification
 * (epoch fencing + anti-flap), the D-005 `LockSetReconstructor` handover, and
 * the requester routing over the production transport seams
 * (`routeFileLockOp` → boot-wired `HttpPeerRpcTransport`). Clock + roster are
 * injected and mutable — deterministic, no sleeps.
 *
 * Proves, across a real wire:
 *   1. grant at the initial authority (epoch 1),
 *   2. failover mid-hold → the NEW authority refuses a contender once the
 *      holder re-asserts (mutual exclusion survives the handover),
 *   3. fencing: epoch bumps on takeover; a deposed authority's stale-epoch
 *      grant is fenced out downstream (`fenceValid`), and the deposed instance
 *      itself refuses mis-routed ops (`not_authority` → requester fails open),
 *   4. the documented optimistic-grant gap during rebuild (D-004 fail-open),
 *   5. cross-wire release at the new authority frees the contender,
 *   6. anti-flap: the returning lower peer cannot preempt within the cooldown
 *      (requests routed to it by a bare-argmin requester fail open, no double
 *      grant), and preempts cleanly after the cooldown with a fresh epoch.
 *
 * Hermetic: no PG, no LLM. (The real-PG store leg is covered by
 * file-lock-authority-e2e.integration.test.ts; the flood variant is the
 * sibling authority-failover-flood test (P-003); the two-physical-box variant
 * is P-010, owner-gated.)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { routeFileLockOp } from '../file-lock-routing';
import { routeToAuthority } from '../lock-authority';
import { FILE_LOCK_OP_KINDS, type FileLockAcquireParams } from '../file-lock-authority-ops';
import { fenceValid } from '../hardened-authority';
import { TwoInstanceAuthorityRig, type GrantResult } from './_two-instance-authority-rig';

const DOMAIN = '/repo/xmachine-failover';
const PATH_P = 'libs/contended.ts';
const PATH_Q = 'libs/uncontended.ts';
const OWNER_A = 'holder-A';
const OWNER_B = 'contender-B';
const ASSERT_TTL_MS = 60_000;

const rig = new TwoInstanceAuthorityRig({ harness: 'xmachine-failover-harness' });
const T0 = rig.clock;

function routedAcquire(owner: string, paths: string[]) {
  const local = vi.fn(async (): Promise<GrantResult> => ({ ok: true, lockId: 'LOCAL-ADVISORY' }));
  return {
    local,
    run: routeFileLockOp<GrantResult>(
      DOMAIN,
      {
        local,
        remote: {
          kind: FILE_LOCK_OP_KINDS.acquire,
          payload: {
            owner,
            paths,
            intent: 'cross-machine failover E2E',
            ttlSec: 600,
            coordinationDomain: DOMAIN,
          } satisfies FileLockAcquireParams,
          decode: (raw) => raw as GrantResult,
        },
      },
      rig.requesterDeps(DOMAIN),
    ),
  };
}

// The downstream fence ledger (Kleppmann): the highest epoch a grant consumer
// has seen; older-epoch grants are rejected as stale split-brain artifacts.
let highestSeenEpoch = 0;
function consumeGrant(g: GrantResult): boolean {
  const epoch = g.epoch ?? 0;
  if (!fenceValid(epoch, highestSeenEpoch)) return false;
  highestSeenEpoch = epoch;
  return true;
}

describe('cross-machine lock E2E: failover mid-hold + fencing (two instances, one box)', () => {
  beforeAll(async () => {
    await rig.start();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it('grants at the initial authority X under epoch 1 (across the wire)', async () => {
    const { run, local } = routedAcquire(OWNER_A, [PATH_P]);
    const res = await run;
    expect(res.via).toBe('remote-authority');
    expect(local).not.toHaveBeenCalled();
    expect(res.value.ok).toBe(true);
    expect(res.value.epoch).toBe(1);
    expect(consumeGrant(res.value)).toBe(true); // fence ledger now at 1
    expect(rig.X.held.get(PATH_P)?.owner).toBe(OWNER_A);
    expect(rig.Y.held.size).toBe(0);
  });

  it('fails over mid-hold: holder re-asserts to Y and the contender is refused across the wire', async () => {
    // X dies mid-hold: its presence goes stale; Y + requester stay fresh.
    rig.clock = T0 + 5_000;
    rig.beatAllButX();

    // Holder A's TTL heartbeat re-asserts its lock to the CURRENT authority
    // (resolved fresh = Y), carried over the same transport seam.
    const assertRes = await routeToAuthority<{ ok: boolean; rebuilt: boolean }>(
      rig.harness,
      {
        local: async () => ({ ok: false, rebuilt: false }),
        remote: {
          kind: 'lock.assert',
          payload: { path: PATH_P, owner: OWNER_A, ttlMs: ASSERT_TTL_MS },
          decode: (raw) => raw as { ok: boolean; rebuilt: boolean },
        },
      },
      rig.requesterAuthorityDeps(),
    );
    expect(assertRes.via).toBe('remote-authority');
    expect(assertRes.value.ok).toBe(true);
    expect(assertRes.value.rebuilt).toBe(false); // still inside the rebuild window
    expect(rig.Y.epoch).toBe(2); // takeover bumped the fencing epoch

    // Contender B races during the handover: Y's store is empty, but the
    // re-asserted hold makes the contended check refuse B — mutual exclusion
    // SURVIVES the failover.
    const { run } = routedAcquire(OWNER_B, [PATH_P]);
    const res = await run;
    expect(res.via).toBe('remote-authority');
    expect(res.value.ok).toBe(false);
    expect(res.value.busy?.[0]?.path).toBe(PATH_P);
  });

  it('fences out the deposed authority: stale-epoch grants are rejected downstream', () => {
    // A late grant minted by X under epoch 1 (X still believes it leads during
    // the split-brain gap) is rejected by any consumer that has seen epoch 2.
    expect(highestSeenEpoch).toBe(1);
    const lateXGrant: GrantResult = { ok: true, lockId: 'lk-x-late', epoch: 1 };
    const freshYGrant: GrantResult = { ok: true, lockId: 'lk-y', epoch: 2 };
    expect(consumeGrant(freshYGrant)).toBe(true); // ledger advances to 2
    expect(consumeGrant(lateXGrant)).toBe(false); // split-brain artifact fenced out
  });

  it('the deposed authority itself refuses mis-routed ops (not_authority → requester fails open)', async () => {
    // A requester with a STALE roster still believes X leads and routes there.
    const staleRows = [
      { device_pubkey: rig.X.pubkey, github_user_id: 1, machine_label: rig.X.pubkey, last_seen_ms: rig.clock - 100 },
      { device_pubkey: rig.requesterPubkey, github_user_id: 3, machine_label: rig.requesterPubkey, last_seen_ms: rig.clock - 100 },
    ];
    const local = vi.fn(async (): Promise<GrantResult> => ({ ok: true, lockId: 'LOCAL-ADVISORY' }));
    const res = await routeFileLockOp<GrantResult>(
      DOMAIN,
      {
        local,
        remote: {
          kind: FILE_LOCK_OP_KINDS.acquire,
          payload: {
            owner: OWNER_B,
            paths: [PATH_P],
            intent: 'stale-roster route to deposed X',
            ttlSec: 600,
            coordinationDomain: DOMAIN,
          } satisfies FileLockAcquireParams,
          decode: (raw) => raw as GrantResult,
        },
      },
      { ...rig.requesterDeps(DOMAIN), fetchPresenceRows: async () => staleRows },
    );
    // X verifies against the TRUE roster + shared record → not the authority →
    // refuses; the transport maps that to unreachable → loud fail-open.
    expect(res.via).toBe('fail-open');
    expect(res.warning).toContain('unreachable');
    expect(local).toHaveBeenCalledTimes(1);
    expect(rig.X.held.get(PATH_P)?.owner).toBe(OWNER_A); // X granted nothing new
  });

  it('grants an UNCONTENDED path optimistically during the rebuild window (D-004, the documented gap)', async () => {
    const { run } = routedAcquire(OWNER_B, [PATH_Q]);
    const res = await run;
    expect(res.via).toBe('remote-authority');
    expect(res.value.ok).toBe(true); // no re-assert for Q → optimistic grant
    expect(res.value.epoch).toBe(2);
  });

  it('fences out a deposed authority\'s stale-epoch re-assert at the new authority (B1, D-006)', async () => {
    // Y (epoch 2) optimistically granted Q to OWNER_B during the rebuild window
    // (the previous test). Now a LATE heartbeat for OWNER_A on Q — whose hold
    // would have been minted under the deposed X's epoch 1 — races to Y.
    // Unfenced, the reconstructor would clobber Y's epoch-2 truth (B holds Q);
    // with the fence the stale-epoch assert is DROPPED.
    const staleAssert = await routeToAuthority<{ ok: boolean; applied: boolean; rebuilt: boolean }>(
      rig.harness,
      {
        local: async () => ({ ok: false, applied: false, rebuilt: false }),
        remote: {
          kind: 'lock.assert',
          payload: { path: PATH_Q, owner: OWNER_A, ttlMs: ASSERT_TTL_MS, epoch: 1 },
          decode: (raw) => raw as { ok: boolean; applied: boolean; rebuilt: boolean },
        },
      },
      rig.requesterAuthorityDeps(),
    );
    expect(staleAssert.via).toBe('remote-authority');
    expect(staleAssert.value.ok).toBe(true);
    expect(staleAssert.value.applied).toBe(false); // fenced out — not folded in
    // The reconstructor did NOT learn a held lock for Q under OWNER_A: a current
    // contender for Q is therefore NOT refused on the strength of the stale assert.
    expect(rig.Y.reconstructor?.isHeldByOther(PATH_Q, 'someone-else', rig.clock)).toBe(false);

    // A CURRENT-epoch (epoch 2) re-assert from the live holder IS folded in.
    const freshAssert = await routeToAuthority<{ ok: boolean; applied: boolean }>(
      rig.harness,
      {
        local: async () => ({ ok: false, applied: false }),
        remote: {
          kind: 'lock.assert',
          payload: { path: PATH_Q, owner: OWNER_B, ttlMs: ASSERT_TTL_MS, epoch: 2 },
          decode: (raw) => raw as { ok: boolean; applied: boolean },
        },
      },
      rig.requesterAuthorityDeps(),
    );
    expect(freshAssert.value.applied).toBe(true);
    expect(rig.Y.reconstructor?.isHeldByOther(PATH_Q, 'someone-else', rig.clock)).toBe(true);
    // Clean up so the next test's release/acquire on PATH_P is unaffected.
    rig.Y.reconstructor?.assert(PATH_Q, OWNER_B, 0, rig.clock, 2);
    rig.Y.reconstructor?.prune(rig.clock + 1);
  });

  it('release at the new authority frees the contender after the rebuild window', async () => {
    rig.clock += 1_500; // past the 1s heartbeat interval → reconstruction complete
    rig.beatAllButX();
    expect(rig.Y.reconstructor?.isRebuilt(rig.clock)).toBe(true);

    // Still held: B refused on P even after rebuild (the re-assert persists).
    const denied = await routedAcquire(OWNER_B, [PATH_P]).run;
    expect(denied.value.ok).toBe(false);

    // A releases across the wire at Y… (the reconstructor entry ages out with
    // its TTL; the store is the live truth post-rebuild)
    rig.Y.reconstructor?.assert(PATH_P, OWNER_A, 0, rig.clock); // holder stops re-asserting
    rig.Y.reconstructor?.prune(rig.clock + 1);
    const rel = await routeToAuthority<{ ok: boolean; released?: string[] }>(
      rig.harness,
      {
        local: async () => ({ ok: false }),
        remote: {
          kind: FILE_LOCK_OP_KINDS.release,
          payload: { owner: OWNER_A, allMine: true, coordinationDomain: DOMAIN },
          decode: (raw) => raw as { ok: boolean; released?: string[] },
        },
      },
      rig.requesterAuthorityDeps(),
    );
    expect(rel.via).toBe('remote-authority');

    // …and B now wins P.
    const granted = await routedAcquire(OWNER_B, [PATH_P]).run;
    expect(granted.value.ok).toBe(true);
    expect(granted.value.epoch).toBe(2);
    expect(rig.Y.held.get(PATH_P)?.owner).toBe(OWNER_B);
  });

  it('anti-flap: returning X cannot preempt within the cooldown; preempts cleanly after it (epoch 3)', async () => {
    // X comes back fresh 100ms later — inside Y's 2s re-grant cooldown.
    rig.clock += 100;
    rig.beat(rig.X.pubkey, rig.Y.pubkey, rig.requesterPubkey);

    // The hardened decision keeps Y (no thrash)…
    const during = await rig.Y.resolve();
    expect(during.isSelf).toBe(true);
    expect(during.epoch).toBe(2);

    // …so a bare-argmin requester that routes to X gets refused → fail-open,
    // and crucially X mints NO grant (no double-authority window).
    const flap = await routedAcquire('flapper-C', [PATH_P]);
    const res = await flap.run;
    expect(res.via).toBe('fail-open');
    // X minted NO new grant: its store still carries only the original epoch-1
    // hold from before the failover (harmless — fenced out by the epoch check).
    expect(rig.X.held.get(PATH_P)?.owner).toBe(OWNER_A);
    expect(rig.Y.held.get(PATH_P)?.owner).toBe(OWNER_B);

    // After the cooldown elapses, X preempts with a fresh fencing epoch.
    rig.clock += 2_500;
    rig.beat(rig.X.pubkey, rig.Y.pubkey, rig.requesterPubkey);
    const after = await rig.X.resolve();
    expect(after.isSelf).toBe(true);
    expect(after.epoch).toBe(3);
    const yAfter = await rig.Y.resolve();
    expect(yAfter.isSelf).toBe(false);
  });
});
