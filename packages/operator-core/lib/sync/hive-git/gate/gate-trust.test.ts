/**
 * gate-trust.test.ts — DG-4 (P-047) pure tests: fail-closed trust resolution,
 * deterministic spot-check selection, mismatch detection.
 */
import { describe, expect, it } from 'vitest';
import {
  compareSpotCheck,
  isGateTrustedDevice,
  selectSpotChecks,
  type GateTrustDeps,
} from './gate-trust';
import type { GateVerdict } from './verdicts';

function deps(member: number | null, granted: boolean, mode: 'ok' | 'throws' = 'ok'): GateTrustDeps {
  return {
    resolveSignerMembership: async () => {
      if (mode === 'throws') throw new Error('membership down');
      return { githubUserId: member };
    },
    hasGateGrant: async (id) => granted && id === member,
  };
}

describe('isGateTrustedDevice (fail-closed)', () => {
  it('true only for admitted member + explicit gate grant', async () => {
    expect(await isGateTrustedDevice('devA', deps(77, true))).toBe(true);
    expect(await isGateTrustedDevice('devA', deps(77, false))).toBe(false); // admitted, no grant
    expect(await isGateTrustedDevice('devA', deps(null, true))).toBe(false); // unadmitted
    expect(await isGateTrustedDevice('', deps(77, true))).toBe(false); // no device
    expect(await isGateTrustedDevice('devA', deps(77, true, 'throws'))).toBe(false); // resolver error
  });
});

describe('selectSpotChecks (deterministic, seed-keyed)', () => {
  const shards = ['a::unit', 'b::unit', 'c::unit', 'd::integration', 'e::unit'];

  it('same seed ⇒ identical selection; different seed ⇒ (generally) different', () => {
    const s1 = selectSpotChecks({ shardIds: shards, fraction: 0.4, seed: 'sha-1' });
    const s2 = selectSpotChecks({ shardIds: [...shards].reverse(), fraction: 0.4, seed: 'sha-1' });
    expect(s2.selected).toEqual(s1.selected); // input order irrelevant
    expect(s1.quota).toBe(2); // ceil(0.4 × 5)
    expect(s1.selected.length).toBe(2);
    // seed-keyed: across many seeds the selection must vary at least once
    const variations = new Set(
      ['sha-2', 'sha-3', 'sha-4', 'sha-5'].map(
        (seed) => selectSpotChecks({ shardIds: shards, fraction: 0.4, seed }).selected.join(','),
      ),
    );
    variations.add(s1.selected.join(','));
    expect(variations.size).toBeGreaterThan(1);
  });

  it('fraction edges: 0 selects none; >0 selects at least one; 1 selects all; junk clamps', () => {
    expect(selectSpotChecks({ shardIds: shards, fraction: 0, seed: 's' }).selected).toEqual([]);
    expect(selectSpotChecks({ shardIds: shards, fraction: 0.01, seed: 's' }).selected.length).toBe(1);
    expect(selectSpotChecks({ shardIds: shards, fraction: 1, seed: 's' }).selected.length).toBe(5);
    expect(selectSpotChecks({ shardIds: shards, fraction: 7, seed: 's' }).selected.length).toBe(5);
    expect(selectSpotChecks({ shardIds: shards, fraction: Number.NaN, seed: 's' }).selected).toEqual([]);
    expect(selectSpotChecks({ shardIds: [], fraction: 0.5, seed: 's' }).selected).toEqual([]);
  });

  it('duplicate shard ids collapse before the quota applies', () => {
    const s = selectSpotChecks({ shardIds: ['x', 'x', 'x', 'y'], fraction: 0.5, seed: 's' });
    expect(s.quota).toBe(1); // ceil(0.5 × 2 unique)
    expect(s.selected.length).toBe(1);
  });
});

describe('compareSpotCheck', () => {
  const base: GateVerdict = {
    v: 1,
    repo_key: 'repo-42',
    staging_sha: 'a'.repeat(40),
    shard_id: '@t/a::unit',
    inputs_hash: 'b'.repeat(64),
    verdict: 'pass',
    duration_ms: 100,
    device_pubkey: 'peer-dev',
    ts: 1,
    sig: 'x',
  };

  it('same (repo, shard, inputs) same outcome ⇒ confirmed', () => {
    expect(compareSpotCheck(base, { ...base, device_pubkey: 'me', duration_ms: 999 })).toEqual({
      kind: 'confirmed',
    });
  });

  it('same work, different outcome ⇒ mismatch (the lying/flaky-peer signal)', () => {
    expect(compareSpotCheck(base, { ...base, verdict: 'fail' })).toEqual({
      kind: 'mismatch',
      peerVerdict: 'pass',
      localVerdict: 'fail',
    });
  });

  it('different inputs/shard/repo ⇒ incomparable, never a mismatch', () => {
    expect(compareSpotCheck(base, { ...base, inputs_hash: 'c'.repeat(64), verdict: 'fail' })).toEqual({
      kind: 'incomparable',
      reason: 'different-inputs',
    });
    expect(compareSpotCheck(base, { ...base, shard_id: 'other::unit' })).toEqual({
      kind: 'incomparable',
      reason: 'different-shard',
    });
    expect(compareSpotCheck(base, { ...base, repo_key: 'other' })).toEqual({
      kind: 'incomparable',
      reason: 'different-repo',
    });
  });
});
