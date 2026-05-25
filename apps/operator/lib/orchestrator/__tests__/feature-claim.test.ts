/**
 * feature-claim — P-036 sub-acceptance tests.
 *
 * Covers:
 *   P-036a — single-writer case: append + await + first-in-order → won.
 *   P-036b — two-writer race: exactly one wins.
 *   P-036c — claim record carries the schema_version per D-024.
 *   P-036d — schema-version field present.
 *   Validation — feature_id + claimer_github_user_id required.
 *   Tiebreak — earliest seq wins; bytewise-lex of pubkey on exact seq tie.
 *   Defensive — missing-own-claim treated as loss.
 */

import { describe, expect, it } from 'vitest';
import {
  claimFeature,
  pickWinningClaim,
  ClaimValidationError,
  type ClaimAutobaseHandle,
  type MergedClaim,
  type FeatureClaimRecord,
} from '../feature-claim';
import { CURRENT_SCHEMA_VERSION } from '../../sync/hyperbee/schema-version';

class FakeBase implements ClaimAutobaseHandle {
  public appended: FeatureClaimRecord[] = [];
  public ledger: MergedClaim[] = [];
  private nextSeq = 1;

  constructor(public myPubkey: string, seedLedger: MergedClaim[] = []) {
    this.ledger = [...seedLedger];
    // Advance nextSeq past any seeded entries.
    for (const c of seedLedger) {
      if (c.seq >= this.nextSeq) this.nextSeq = c.seq + 1;
    }
  }

  async appendClaim(record: FeatureClaimRecord): Promise<{ seq: number }> {
    this.appended.push(record);
    const seq = this.nextSeq++;
    this.ledger.push({ record, seq });
    return { seq };
  }

  async readClaimsForFeature(feature_id: string): Promise<MergedClaim[]> {
    return this.ledger.filter((c) => c.record.feature_id === feature_id);
  }
}

function rec(over: Partial<FeatureClaimRecord> = {}): FeatureClaimRecord {
  return {
    kind: 'feature_claim',
    feature_id: 'F-001',
    claimer_pubkey: 'aaa',
    claimer_github_user_id: 1,
    ts: 1700000000000,
    schema_version: CURRENT_SCHEMA_VERSION,
    ...over,
  };
}

describe('pickWinningClaim', () => {
  it('returns null on empty input', () => {
    expect(pickWinningClaim([])).toBeNull();
  });

  it('returns the earliest-seq claim', () => {
    const claims: MergedClaim[] = [
      { record: rec({ claimer_pubkey: 'zzz' }), seq: 3 },
      { record: rec({ claimer_pubkey: 'aaa' }), seq: 1 },
      { record: rec({ claimer_pubkey: 'bbb' }), seq: 2 },
    ];
    expect(pickWinningClaim(claims)!.record.claimer_pubkey).toBe('aaa');
  });

  it('breaks seq ties by lex of pubkey (smaller wins)', () => {
    const claims: MergedClaim[] = [
      { record: rec({ claimer_pubkey: 'zzz' }), seq: 5 },
      { record: rec({ claimer_pubkey: 'aaa' }), seq: 5 },
      { record: rec({ claimer_pubkey: 'mmm' }), seq: 5 },
    ];
    expect(pickWinningClaim(claims)!.record.claimer_pubkey).toBe('aaa');
  });
});

describe('claimFeature — P-036', () => {
  it('P-036a — single-writer wins on uncontested feature', async () => {
    const base = new FakeBase('mypubkey');
    const r = await claimFeature(base, { feature_id: 'F-1', claimer_github_user_id: 42 });
    expect(r.won).toBe(true);
    expect(r.claim_seq).toBe(1);
    expect(r.winner_pubkey).toBeUndefined();
    expect(base.appended).toHaveLength(1);
    expect(base.appended[0]).toMatchObject({
      kind: 'feature_claim',
      feature_id: 'F-1',
      claimer_pubkey: 'mypubkey',
      claimer_github_user_id: 42,
      schema_version: CURRENT_SCHEMA_VERSION,
    });
  });

  it('P-036b — two-writer race: only one wins, the other reports the winner', async () => {
    // Simulate writer A getting in first; writer B appends second.
    const seededWithA: MergedClaim[] = [
      { record: rec({ feature_id: 'F-1', claimer_pubkey: 'AAA' }), seq: 1 },
    ];
    const baseB = new FakeBase('BBB', seededWithA);
    const r = await claimFeature(baseB, { feature_id: 'F-1', claimer_github_user_id: 99 });
    expect(r.won).toBe(false);
    expect(r.winner_pubkey).toBe('AAA');
    // Our append still happened (so audit can see we tried).
    expect(baseB.appended).toHaveLength(1);
  });

  it('P-036c/d — appended record carries schema_version', async () => {
    const base = new FakeBase('mypubkey');
    await claimFeature(base, { feature_id: 'F-1', claimer_github_user_id: 1 });
    expect(base.appended[0].schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('uses now_ms override for deterministic ts', async () => {
    const base = new FakeBase('mypubkey');
    await claimFeature(base, { feature_id: 'F-1', claimer_github_user_id: 1, now_ms: 1234567 });
    expect(base.appended[0].ts).toBe(1234567);
  });

  it('rejects empty feature_id', async () => {
    const base = new FakeBase('mypubkey');
    await expect(
      claimFeature(base, { feature_id: '', claimer_github_user_id: 1 }),
    ).rejects.toBeInstanceOf(ClaimValidationError);
  });

  it('rejects non-positive claimer_github_user_id', async () => {
    const base = new FakeBase('mypubkey');
    await expect(
      claimFeature(base, { feature_id: 'F-1', claimer_github_user_id: 0 }),
    ).rejects.toBeInstanceOf(ClaimValidationError);
    await expect(
      claimFeature(base, { feature_id: 'F-1', claimer_github_user_id: -5 }),
    ).rejects.toBeInstanceOf(ClaimValidationError);
    await expect(
      claimFeature(base, { feature_id: 'F-1', claimer_github_user_id: 1.5 }),
    ).rejects.toBeInstanceOf(ClaimValidationError);
  });

  it('filters out ops for other feature_ids', async () => {
    const seeded: MergedClaim[] = [
      { record: rec({ feature_id: 'F-OTHER', claimer_pubkey: 'AAA' }), seq: 1 },
      // Our future append goes in at seq 2 in this lane:
    ];
    const base = new FakeBase('mypubkey', seeded);
    const r = await claimFeature(base, { feature_id: 'F-1', claimer_github_user_id: 7 });
    expect(r.won).toBe(true);              // F-OTHER doesn't compete
  });

  it('three-writer contest — earliest seq across pubkeys still wins', async () => {
    const seeded: MergedClaim[] = [
      { record: rec({ feature_id: 'F-1', claimer_pubkey: 'BBB' }), seq: 1 },
      { record: rec({ feature_id: 'F-1', claimer_pubkey: 'AAA' }), seq: 2 },
    ];
    const baseC = new FakeBase('CCC', seeded);
    const r = await claimFeature(baseC, { feature_id: 'F-1', claimer_github_user_id: 3 });
    expect(r.won).toBe(false);
    expect(r.winner_pubkey).toBe('BBB');     // seq 1 < seq 2 < seq 3
  });

  it('defensive: if own claim never lands in the view, return won:false', async () => {
    // Build a handle where appendClaim returns a seq but readClaimsForFeature
    // returns nothing (simulating a divergence). Treated as loss.
    const broken: ClaimAutobaseHandle = {
      myPubkey: 'mypubkey',
      async appendClaim() { return { seq: 99 }; },
      async readClaimsForFeature() { return []; },
    };
    const r = await claimFeature(broken, { feature_id: 'F-1', claimer_github_user_id: 1 });
    expect(r.won).toBe(false);
    expect(r.claim_seq).toBe(99);
    expect(r.winner_pubkey).toBeUndefined();
  });
});
