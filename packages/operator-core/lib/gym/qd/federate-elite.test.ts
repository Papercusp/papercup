/**
 * markEliteFederatable (F1-4 / P-012, federated-scout-gym) — hermetic tests for
 * the WI-1564-guarded elite SEND seam: a non-eligible elite is not stamped; an
 * eligible elite REFUSES LOUDLY under the non-federating coordination/'*'
 * partition (the strand combo — the twin of assertFact's shareable-fact guard);
 * an eligible elite in a real workspace stamps the LOCAL row.
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { markEliteFederatable } from './federate-elite';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import {
  isEliteOutcomeRecord,
  verifyEliteOutcome,
  verifyEliteOutcomeForElite,
} from './elite-outcome-record';

/** Tagged-template sql fake capturing interpolated values per call. */
function fakeSql(rowsToReturn: unknown[] = []): { sql: Sql; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const fn = (_s: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push(vals);
    return Promise.resolve(rowsToReturn);
  };
  return { sql: fn as unknown as Sql, calls };
}

const base = { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', nicheKey: 'v1:loop/guard/r2/size-m' };

describe('markEliteFederatable — eligibility (D-002)', () => {
  it('does NOT stamp a non-eligible elite (no SQL, no error)', async () => {
    const { sql, calls } = fakeSql([{ niche_key: base.nicheKey }]);
    const res = await markEliteFederatable({ ...base, eligibility: { outcome: 'lost', grade: 2 } }, sql);
    expect(res).toEqual({ federatable: false, reason: 'not-eligible' });
    expect(calls).toHaveLength(0);
  });

  it('accepts outcome=won OR grade>=4', async () => {
    const { sql: s1 } = fakeSql([{ niche_key: base.nicheKey }]);
    expect((await markEliteFederatable({ ...base, eligibility: { outcome: 'won' } }, s1)).federatable).toBe(true);
    const { sql: s2 } = fakeSql([{ niche_key: base.nicheKey }]);
    expect((await markEliteFederatable({ ...base, eligibility: { grade: 4 } }, s2)).federatable).toBe(true);
  });
});

describe('markEliteFederatable — WI-1564 strand guard', () => {
  it('REFUSES LOUDLY when an eligible elite would federate from a non-federating partition', async () => {
    for (const ws of ['default', '*', '']) {
      const { sql, calls } = fakeSql([{ niche_key: base.nicheKey }]);
      await expect(
        markEliteFederatable({ ...base, workspaceId: ws, eligibility: { outcome: 'won' } }, sql),
      ).rejects.toThrow(/WI-1564/);
      expect(calls).toHaveLength(0); // never even reaches the UPDATE
    }
  });
});

describe('markEliteFederatable — stamp the local row', () => {
  it('UPDATEs the local (source_hive NULL) row for the (ws, harness, niche)', async () => {
    const { sql, calls } = fakeSql([{ niche_key: base.nicheKey }]);
    const res = await markEliteFederatable({ ...base, eligibility: { outcome: 'won' } }, sql);
    expect(res).toEqual({ federatable: true, reason: 'stamped' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['papercusp-workspace', 'papercusp', base.nicheKey]);
  });

  it('reports no-row when the niche has no local elite', async () => {
    const { sql } = fakeSql([]);
    const res = await markEliteFederatable({ ...base, eligibility: { grade: 5 } }, sql);
    expect(res).toEqual({ federatable: false, reason: 'no-row' });
  });
});

describe('markEliteFederatable — P-014 device-signed outcome record', () => {
  const dev = generateEd25519KeypairDer();
  const signer = {
    devicePubkeyBase64: dev.pubkeyBase64,
    sign: async (b: Buffer) => signWithPrivateKeyDer(dev.privateKeyDer, b),
  };
  // The stamp UPDATE returns the row fields the signed record binds.
  const eliteRow = { candidate_id: 'cand-abc', fitness: 0.87, updated_at: 1720000000000 };

  it('signs + persists a valid record bound to the stamped elite (won)', async () => {
    const { sql, calls } = fakeSql([eliteRow]);
    const res = await markEliteFederatable(
      { ...base, eligibility: { outcome: 'won' }, outcomeSigner: signer },
      sql,
    );
    expect(res.federatable).toBe(true);
    expect(res.reason).toBe('stamped');
    expect(res.outcomeRecordId).toMatch(/^[0-9a-f]{64}$/);
    // Two UPDATEs: [0] stamp federatable + RETURNING fields; [1] persist the record.
    expect(calls).toHaveLength(2);
    const record = JSON.parse(calls[1][0] as string);
    expect(isEliteOutcomeRecord(record)).toBe(true);
    expect(record.niche_key).toBe(base.nicheKey);
    expect(record.candidate_id).toBe('cand-abc');
    expect(record.fitness).toBe(0.87);
    expect(record.outcome).toBe('won');
    expect(record.device_pubkey).toBe(dev.pubkeyBase64);
    expect(record.ts).toBe(1720000000000);
    expect(verifyEliteOutcome(record)).toBe(true);
    // The receive-side gate accepts it for the matching elite + signer device.
    expect(
      verifyEliteOutcomeForElite(record, {
        nicheKey: base.nicheKey,
        candidateId: 'cand-abc',
        expectedSignerDevice: dev.pubkeyBase64,
      }),
    ).toBe(true);
  });

  it('signs a grade>=4 elite with basis=graded', async () => {
    const { sql, calls } = fakeSql([eliteRow]);
    const res = await markEliteFederatable(
      { ...base, eligibility: { grade: 5 }, outcomeSigner: signer },
      sql,
    );
    expect(res.federatable).toBe(true);
    const record = JSON.parse(calls[1][0] as string);
    expect(record.outcome).toBe('graded');
    expect(record.grade).toBe(5);
    expect(verifyEliteOutcome(record)).toBe(true);
  });

  it('returns no-row without signing when the niche has no local elite', async () => {
    const { sql, calls } = fakeSql([]);
    const res = await markEliteFederatable(
      { ...base, eligibility: { outcome: 'won' }, outcomeSigner: signer },
      sql,
    );
    expect(res).toEqual({ federatable: false, reason: 'no-row' });
    expect(calls).toHaveLength(1); // only the stamp UPDATE; nothing signed/persisted
  });

  it('the signed record cannot be LIFTED onto a different elite (receive-side bind)', async () => {
    const { sql, calls } = fakeSql([eliteRow]);
    await markEliteFederatable(
      { ...base, eligibility: { outcome: 'won' }, outcomeSigner: signer },
      sql,
    );
    const record = JSON.parse(calls[1][0] as string);
    // Same valid signature, replayed onto a different candidate → rejected.
    expect(
      verifyEliteOutcomeForElite(record, {
        nicheKey: base.nicheKey,
        candidateId: 'DIFFERENT-cand',
        expectedSignerDevice: dev.pubkeyBase64,
      }),
    ).toBe(false);
  });
});
