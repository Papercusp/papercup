/**
 * policy-set route — claim-gate unit tests (shared-hive-owner-enforcement EN-1, the
 * S0 authority property). Drives `runSetPolicy` with injected deps so the gate + the
 * author are tested without GitHub / PG / the keychain.
 *
 * S0: ONLY a `claimed` Hive + a viewer who is a claimant may write policy. A
 * non-claimant → 403, an unclaimed Hive → 403. TEETH (brief EN-1): the non-claimant
 * case asserts 403 AND the SAME setup with the viewer flipped to a claimant asserts
 * 200 — so removing the claimant-membership check (the gate) flips the reject test RED.
 */
import { describe, it, expect, vi } from 'vitest';
import { runSetPolicy, type SetPolicyDeps, type ClaimGateRow } from './policy-set';
import type { ResolvedHivePolicy } from '../../../hive-policy-store';

const WS = 'ws';
const HOME = 'home';
const CLAIMANT = 4242;
const OUTSIDER = 9999;

function resolved(): ResolvedHivePolicy {
  return {
    workspaceId: WS, hiveHomeSlug: HOME, policy: { membership: 'open' }, policyVersion: 1,
    ownerPubkey: 'pk', signature: 'sig', policyJson: '{"membership":"open"}', fedHlc: 'h', updatedAt: 1,
  };
}

function deps(over: Partial<SetPolicyDeps> = {}): SetPolicyDeps {
  return {
    viewerGithubId: vi.fn(async () => CLAIMANT),
    readClaimGate: vi.fn(async (): Promise<ClaimGateRow | null> => ({ claimStatus: 'claimed', claimedGithubUserIds: [CLAIMANT] })),
    author: vi.fn(async () => ({ ok: true as const, policy: resolved() })),
    ...over,
  };
}

const goodBody = { policy: { membership: 'approval', rate: { opsPerMin: 10 } } };

describe('runSetPolicy claim gate (S0 authority)', () => {
  it('claimed Hive + claimant viewer → 200, author invoked with the coerced policy', async () => {
    const d = deps();
    const res = await runSetPolicy(WS, HOME, goodBody, d);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(d.author).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS, hiveHomeSlug: HOME }));
  });

  it('TEETH: claimed Hive + NON-claimant viewer → 403; flipping viewer to a claimant → 200', async () => {
    // Same Hive/gate; only the viewer identity differs. The 403 is caused SOLELY by the
    // claimant-membership check — remove it and this reject flips to 200 (RED).
    const gate = async (): Promise<ClaimGateRow> => ({ claimStatus: 'claimed', claimedGithubUserIds: [CLAIMANT] });

    const reject = await runSetPolicy(WS, HOME, goodBody, deps({ viewerGithubId: async () => OUTSIDER, readClaimGate: gate }));
    expect(reject.status).toBe(403);
    expect(reject.body.ok).toBe(false);
    if (!reject.body.ok) expect(reject.body.error).toBe('not_a_claimant');

    const allow = await runSetPolicy(WS, HOME, goodBody, deps({ viewerGithubId: async () => CLAIMANT, readClaimGate: gate }));
    expect(allow.status).toBe(200); // proves the gate (not something else) blocked the outsider
  });

  it('unclaimed Hive → 403 (provisional owner can\'t lock down)', async () => {
    const res = await runSetPolicy(WS, HOME, goodBody, deps({
      readClaimGate: async () => ({ claimStatus: 'unclaimed', claimedGithubUserIds: [] }),
    }));
    expect(res.status).toBe(403);
    if (!res.body.ok) expect(res.body.error).toBe('hive_unclaimed');
  });

  it('no binding at all → 403', async () => {
    const res = await runSetPolicy(WS, HOME, goodBody, deps({ readClaimGate: async () => null }));
    expect(res.status).toBe(403);
  });

  it('missing gh-auth (viewer null) → 401', async () => {
    const res = await runSetPolicy(WS, HOME, goodBody, deps({ viewerGithubId: async () => null }));
    expect(res.status).toBe(401);
  });

  it('claimant but this Swarm does NOT hold the Hive key → 409 not_owner_swarm', async () => {
    const res = await runSetPolicy(WS, HOME, goodBody, deps({
      author: async () => ({ ok: false as const, code: 'not_owner_swarm', detail: 'no key' }),
    }));
    expect(res.status).toBe(409);
    if (!res.body.ok) expect(res.body.error).toBe('not_owner_swarm');
  });

  it('bad body / invalid policy → 400 (and the author is never called)', async () => {
    const d = deps();
    expect((await runSetPolicy(WS, HOME, {}, d)).status).toBe(400); // no policy key
    expect((await runSetPolicy(WS, HOME, { policy: { membership: 'tyrant' } }, d)).status).toBe(400);
    expect(d.author).not.toHaveBeenCalled();
  });
});
