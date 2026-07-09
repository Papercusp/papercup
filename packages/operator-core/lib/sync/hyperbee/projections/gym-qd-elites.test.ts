/**
 * gym-qd-elites projection (F1-2/F1-5, federated-scout-gym-learning-2026-07-02)
 * — hermetic tests for the wire validators + the D-005 structural properties:
 * only REMOTE ops write (into the receiver-stamped source partition of the
 * foreign-elites table, never the local archive); deletes are source-scoped;
 * the revocation purge covers both the log and device grains.
 */
import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
  buildGymQdElitesProjection,
  purgeRevokedForeignElites,
  _testing,
  type GymQdEliteWireRow,
} from './gym-qd-elites';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../../identity/ed25519';
import { signEliteOutcome } from '../../../gym/qd/elite-outcome-record';

const { composeKey, decodeValue } = _testing;

const row = (over: Partial<GymQdEliteWireRow> = {}): GymQdEliteWireRow => ({
  harness_slug: 'papercusp',
  niche_key: 'v1:loop/guard/r2/size-m',
  candidate_id: 'cand-42',
  scope: 'loop',
  domain: 'guard',
  risk: 'r2',
  fitness: 0.87,
  descriptor: { v: 1, surface: 'loop', shape: 'guard' },
  rationale: 'won its gym cycle',
  federatable: true,
  updated_at: 1_700_000_000_000,
  ...over,
});

/** Tagged-template sql fake capturing interpolated values per call. */
function fakeSql(rowsToReturn: unknown[] = []): { sql: postgres.Sql; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const fn = (_s: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push(vals);
    return Promise.resolve(rowsToReturn);
  };
  return { sql: fn as unknown as postgres.Sql, calls };
}

describe('composeKey — matches mig 464 capture key (niche_key)', () => {
  it('is the niche key verbatim', () => {
    expect(composeKey(row())).toBe('v1:loop/guard/r2/size-m');
  });
});

describe('decodeValue — defensive on every field', () => {
  it('accepts a well-formed wire row (extra to_jsonb fields tolerated)', () => {
    expect(decodeValue({ ...row(), source: 'gym', created_at: 1, workspace_id: 'x' })).not.toBeNull();
  });
  it('rejects malformed rows', () => {
    expect(decodeValue(null)).toBeNull();
    expect(decodeValue(row({ harness_slug: '' }))).toBeNull();
    expect(decodeValue(row({ niche_key: '' }))).toBeNull();
    expect(decodeValue(row({ fitness: Number.NaN }))).toBeNull();
    expect(decodeValue(row({ descriptor: null as never }))).toBeNull();
    expect(decodeValue(row({ rationale: 'x'.repeat(2001) }))).toBeNull();
  });
  it('rejects a row WITHOUT the D-002 eligibility stamp — receiver re-check', () => {
    expect(decodeValue(row({ federatable: false }))).toBeNull();
    expect(decodeValue({ ...row(), federatable: undefined as never })).toBeNull();
  });
});

describe('writeToPg — foreign rows only, receiver-stamped partition', () => {
  const opts = (sql: postgres.Sql) => ({ workspaceId: 'ws', harnessSlug: 'papercusp', sql });

  it('drops ops for a different hive home (demux guard) — no SQL issued', async () => {
    const { sql, calls } = fakeSql();
    await buildGymQdElitesProjection(opts(sql)).writeToPg(row({ harness_slug: 'other-hive' }), {
      authorPubkey: 'k1',
      origin: 'remote',
    } as never);
    expect(calls.length).toBe(0);
  });

  it('drops LOCAL echoes entirely — the local archive is the canonical row', async () => {
    const { sql, calls } = fakeSql();
    await buildGymQdElitesProjection(opts(sql)).writeToPg(row(), {
      authorPubkey: 'own-device',
      origin: 'local',
    } as never);
    expect(calls.length).toBe(0);
  });

  it('drops ops with NO provenance (defensive)', async () => {
    const { sql, calls } = fakeSql();
    await buildGymQdElitesProjection(opts(sql)).writeToPg(row(), undefined);
    expect(calls.length).toBe(0);
  });

  it('a REMOTE op lands in its receiver-stamped source partition', async () => {
    const { sql, calls } = fakeSql();
    await buildGymQdElitesProjection(opts(sql)).writeToPg(row(), {
      authorPubkey: 'stamped-source-log-key',
      origin: 'remote',
      ts: 1_700_000_000_500,
    } as never);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('stamped-source-log-key');
    expect(calls[0]).toContain('v1:loop/guard/r2/size-m');
  });

  it('an unattributable remote op falls to the unknown-remote partition, never NULL', async () => {
    const { sql, calls } = fakeSql();
    await buildGymQdElitesProjection(opts(sql)).writeToPg(row(), {
      authorPubkey: '',
      origin: 'remote',
    } as never);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('unknown-remote');
  });
});

describe('deleteFromPg — source-scoped, remote-only', () => {
  const opts = (sql: postgres.Sql) => ({ workspaceId: 'ws', harnessSlug: 'papercusp', sql });

  it('a remote delete scopes to ITS OWN source partition', async () => {
    const { sql, calls } = fakeSql();
    await buildGymQdElitesProjection(opts(sql)).deleteFromPg!('v1:loop/guard/r2/size-m', 123, undefined, {
      authorPubkey: 'source-a',
      origin: 'remote',
    } as never);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('source-a');
    expect(calls[0]).toContain('v1:loop/guard/r2/size-m');
  });

  it('a LOCAL delete never touches foreign rows; blank keys no-op', async () => {
    const { sql, calls } = fakeSql();
    const proj = buildGymQdElitesProjection(opts(sql));
    await proj.deleteFromPg!('v1:loop/guard/r2/size-m', 123, undefined, {
      authorPubkey: 'own',
      origin: 'local',
    } as never);
    await proj.deleteFromPg!('', 123, undefined, { authorPubkey: 'x', origin: 'remote' } as never);
    expect(calls.length).toBe(0);
  });

  it('registers with the echo-breaker + the right tag', () => {
    const proj = buildGymQdElitesProjection({ workspaceId: 'ws', harnessSlug: 'papercusp' });
    expect(proj.tableTag).toBe('gym-qd-elites-by-niche');
    expect((proj as { skipOwnOps?: boolean }).skipOwnOps).toBe(true);
  });
});

describe('purgeRevokedForeignElites — D-005 revocation cleanup', () => {
  it('no revocations ⇒ no SQL', async () => {
    const { sql, calls } = fakeSql();
    const n = await purgeRevokedForeignElites({
      workspaceId: 'ws',
      potHomeSlug: 'papercusp',
      revokedPubkeys: [],
      sql,
    });
    expect(n).toBe(0);
    expect(calls.length).toBe(0);
  });

  it('purges the LOG grain directly (source_hive / author_pubkey in the blocklist)', async () => {
    const { sql, calls } = fakeSql([{ niche_key: 'n1' }, { niche_key: 'n2' }]);
    const n = await purgeRevokedForeignElites({
      workspaceId: 'ws',
      potHomeSlug: 'papercusp',
      revokedPubkeys: ['revoked-log-key'],
      sql,
    });
    expect(n).toBeGreaterThanOrEqual(2); // direct delete returned 2 rows
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].flat()).toContain('revoked-log-key');
  });

  it('resolves the DEVICE grain via the admission map and purges those sources', async () => {
    // The fake returns the same rows for every call: the SELECT DISTINCT yields
    // {source_hive:'log-x'} which resolves to a revoked device ⇒ a second DELETE.
    const { sql, calls } = fakeSql([{ source_hive: 'log-x', niche_key: 'n' }]);
    await purgeRevokedForeignElites({
      workspaceId: 'ws',
      potHomeSlug: 'papercusp',
      revokedPubkeys: ['revoked-device'],
      resolveAuthorDevice: (src) => (src === 'log-x' ? 'revoked-device' : null),
      sql,
    });
    // direct DELETE + SELECT DISTINCT + device-grain DELETE
    expect(calls.length).toBe(3);
    expect(calls[2].flat()).toContain('log-x');
  });
});

describe('onRefusedOp — per-source refused-op counter (F1-4 / P-012)', () => {
  const mkOpts = (sql: postgres.Sql) => ({ workspaceId: 'ws', harnessSlug: 'papercusp', sql });

  it('bumps the counter for a REMOTE declined op with the source + not-federatable reason', async () => {
    const { sql, calls } = fakeSql();
    await buildGymQdElitesProjection(mkOpts(sql)).onRefusedOp!(
      { niche_key: 'v1:loop/guard/r2/size-m', federatable: false },
      { authorPubkey: 'peer-log-key', origin: 'remote' },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['ws', 'papercusp', 'peer-log-key', 'gym-qd-elites-by-niche', 'not-federatable']);
  });

  it('classifies a non-elite-shaped op as malformed', async () => {
    const { sql, calls } = fakeSql();
    await buildGymQdElitesProjection(mkOpts(sql)).onRefusedOp!(
      { garbage: true },
      { authorPubkey: 'peer', origin: 'remote' },
    );
    expect(calls[0]?.[4]).toBe('malformed');
  });

  it('does NOT count a LOCAL decode failure (not an anti-poisoning signal)', async () => {
    const { sql, calls } = fakeSql();
    await buildGymQdElitesProjection(mkOpts(sql)).onRefusedOp!(
      { niche_key: 'v1:x', federatable: false },
      { authorPubkey: 'self', origin: 'local' },
    );
    expect(calls).toHaveLength(0);
  });

  it('classifyEliteRefusal: not-federatable vs malformed', () => {
    const { classifyEliteRefusal } = _testing;
    expect(classifyEliteRefusal({ niche_key: 'n', federatable: false })).toBe('not-federatable');
    expect(classifyEliteRefusal({ niche_key: 'n' })).toBe('not-federatable');
    expect(classifyEliteRefusal({ federatable: false })).toBe('malformed');
    expect(classifyEliteRefusal(null)).toBe('malformed');
    expect(classifyEliteRefusal({ niche_key: 'n', federatable: true })).toBe('malformed');
  });
});

describe('writeToPg — P-014 device-signed outcome verification', () => {
  const kp = generateEd25519KeypairDer();
  const SRC_LOG = 'source-log-key-xyz';
  const remote = { authorPubkey: SRC_LOG, origin: 'remote' as const, ts: 1_700_000_000_500 };

  // The default row's niche_key/candidate_id — the record must bind to these.
  async function signedRec(over: Record<string, unknown> = {}) {
    return signEliteOutcome(
      {
        nicheKey: 'v1:loop/guard/r2/size-m',
        candidateId: 'cand-42',
        sourceHive: 'papercusp',
        outcome: 'won',
        grade: 0,
        fitness: 0.87,
        devicePubkeyBase64: kp.pubkeyBase64,
        nowMs: 1_700_000_000_000,
        ...over,
      },
      async (b) => signWithPrivateKeyDer(kp.privateKeyDer, b),
    );
  }
  // Seams: the relaying source log resolves to kp's device, which is an admitted member.
  const vopts = (sql: postgres.Sql) => ({
    workspaceId: 'ws',
    harnessSlug: 'papercusp',
    sql,
    resolveSignerDevice: (src: string) => (src === SRC_LOG ? kp.pubkeyBase64 : null),
    isDeviceAdmitted: (d: string) => d === kp.pubkeyBase64,
  });
  // outcome_verified is the ONLY boolean interpolated into the INSERT (novelty_gift
  // is a SQL NOT EXISTS subquery, not a param), so toContain(true/false) is exact.

  it('a valid signed record from the relaying device, admitted ⇒ outcome_verified TRUE', async () => {
    const { sql, calls } = fakeSql();
    const rec = await signedRec();
    await buildGymQdElitesProjection(vopts(sql)).writeToPg(row({ outcome_record: rec }), remote);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(true);
  });

  it('no outcome_record ⇒ FALSE (still admitted — "where verifiable")', async () => {
    const { sql, calls } = fakeSql();
    await buildGymQdElitesProjection(vopts(sql)).writeToPg(row(), remote);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(false);
  });

  it('ANTI-LIFT: signer device != the relaying-log device ⇒ FALSE', async () => {
    const { sql, calls } = fakeSql();
    const rec = await signedRec();
    const opts = {
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      sql,
      resolveSignerDevice: () => 'someone-elses-device',
      isDeviceAdmitted: () => true,
    };
    await buildGymQdElitesProjection(opts).writeToPg(row({ outcome_record: rec }), remote);
    expect(calls[0]).toContain(false);
  });

  it('MEMBERSHIP: signer not an admitted member ⇒ FALSE', async () => {
    const { sql, calls } = fakeSql();
    const rec = await signedRec();
    const opts = {
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      sql,
      resolveSignerDevice: () => kp.pubkeyBase64,
      isDeviceAdmitted: () => false,
    };
    await buildGymQdElitesProjection(opts).writeToPg(row({ outcome_record: rec }), remote);
    expect(calls[0]).toContain(false);
  });

  it('REPLAY: a record bound to a different niche ⇒ FALSE', async () => {
    const { sql, calls } = fakeSql();
    const rec = await signedRec({ nicheKey: 'v1:other/niche/r1/size-s' });
    await buildGymQdElitesProjection(vopts(sql)).writeToPg(row({ outcome_record: rec }), remote);
    expect(calls[0]).toContain(false);
  });
});
