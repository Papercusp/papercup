/**
 * gate-verdicts.test.ts — the DG-1 projection's decode guard + receive-side
 * verification gates (P-044), pure with injected seams: a fake sql recorder +
 * an injected membership resolver. The end-to-end capture→federate→apply path
 * rides the standard federation harness (stamp-trigger-coverage +
 * capture-coverage guards pin the DDL/producer surfaces).
 */
import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
  generateEd25519KeypairDer,
  signWithPrivateKeyDer,
} from '../../../identity/ed25519';
import { gateVerdictId, signGateVerdict } from '../../hive-git/gate/verdicts';
import {
  _testing,
  gateVerdictFromWireRow,
  type GateVerdictProjectionOpts,
  type GateVerdictWireRow,
} from './gate-verdicts';

const { decodeValue, composeKey, writeToPg } = _testing;

const dev = generateEd25519KeypairDer();
const sign = async (bytes: Buffer) => signWithPrivateKeyDer(dev.privateKeyDer, bytes);

async function wireRow(overrides: Partial<GateVerdictWireRow> = {}): Promise<GateVerdictWireRow> {
  const v = await signGateVerdict(
    {
      repoKey: 'repo-42',
      stagingSha: 'a'.repeat(40),
      shardId: '@t/a::unit',
      inputsHash: 'b'.repeat(64),
      verdict: 'pass',
      durationMs: 5_000,
      devicePubkeyBase64: dev.pubkeyBase64,
      nowMs: 1_700_000_000_000,
    },
    sign,
  );
  return {
    harness_slug: 'my-hive',
    verdict_id: gateVerdictId(v),
    schema_v: v.v,
    repo_key: v.repo_key,
    staging_sha: v.staging_sha,
    shard_id: v.shard_id,
    inputs_hash: v.inputs_hash,
    verdict: v.verdict,
    duration_ms: v.duration_ms,
    device_pubkey: v.device_pubkey,
    verdict_ts: v.ts,
    sig: v.sig,
    ...overrides,
  };
}

/** A fake postgres.Sql tagged-template that records invocations. */
function fakeSql(): { sql: postgres.Sql; calls: string[] } {
  const calls: string[] = [];
  const fn = (strings: TemplateStringsArray, ..._vals: unknown[]) => {
    calls.push(strings.join('?'));
    return Promise.resolve([]);
  };
  return { sql: fn as unknown as postgres.Sql, calls };
}

function opts(
  sql: postgres.Sql,
  membership: { githubUserId: number | null } | 'throws',
): GateVerdictProjectionOpts {
  return {
    workspaceId: 'ws-1',
    harnessSlug: 'my-hive',
    potHomeSlug: 'my-hive',
    sql,
    resolveSignerMembership: async () => {
      if (membership === 'throws') throw new Error('membership store down');
      return { tier: 'message', githubUserId: membership.githubUserId } as never;
    },
  };
}

describe('gate-verdicts projection decode/guard', () => {
  it('accepts a well-formed row; composeKey is the content address', async () => {
    const row = await wireRow();
    expect(decodeValue(row)).toEqual(row);
    expect(composeKey(row)).toBe(row.verdict_id);
    expect(gateVerdictFromWireRow(row).sig).toBe(row.sig);
  });

  it('rejects malformed rows', async () => {
    const row = await wireRow();
    expect(decodeValue({ ...row, harness_slug: '' })).toBeNull();
    expect(decodeValue({ ...row, verdict_id: 'not-hex' })).toBeNull();
    expect(decodeValue({ ...row, verdict: 'maybe' })).toBeNull();
    expect(decodeValue({ ...row, duration_ms: 'slow' })).toBeNull();
    expect(decodeValue({ ...row, sig: '' })).toBeNull();
    expect(decodeValue(null)).toBeNull();
    expect(decodeValue({ garbage: true })).toBeNull();
  });
});

describe('gate-verdicts receive-side verification (remote, hive-bound)', () => {
  const remote = { origin: 'remote' as const, authorPubkey: 'relay-log-key', ts: 1, fedHlc: null };

  it('applies a valid verdict from an ADMITTED signer', async () => {
    const { sql, calls } = fakeSql();
    await writeToPg(opts(sql, { githubUserId: 77 }), await wireRow(), remote as never);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('INSERT INTO harness_shared.gate_verdicts');
    expect(calls[0]).toContain('ON CONFLICT (workspace_id, verdict_id) DO NOTHING');
  });

  it('drops a verdict whose signature does not verify (flipped outcome)', async () => {
    const { sql, calls } = fakeSql();
    const row = await wireRow();
    // Forge: flip pass→fail but keep the honest sig + recompute the id so ONLY
    // the signature check can catch it.
    const forged = { ...row, verdict: 'fail' };
    const reAddressed = {
      ...forged,
      verdict_id: gateVerdictId(gateVerdictFromWireRow(forged as GateVerdictWireRow)),
    };
    await writeToPg(opts(sql, { githubUserId: 77 }), reAddressed as GateVerdictWireRow, remote as never);
    expect(calls.length).toBe(0);
  });

  it('drops a verdict whose claimed id does not match its content (tampered replica)', async () => {
    const { sql, calls } = fakeSql();
    const honest = await wireRow();
    // Valid sig, valid content — but delivered under a DIFFERENT id (attempting
    // to shadow another fact's identity).
    await writeToPg(
      opts(sql, { githubUserId: 77 }),
      { ...honest, verdict_id: 'f'.repeat(64) },
      remote as never,
    );
    expect(calls.length).toBe(0);
  });

  it('drops a valid verdict from an UNADMITTED signer (fail-closed membership)', async () => {
    const { sql, calls } = fakeSql();
    await writeToPg(opts(sql, { githubUserId: null }), await wireRow(), remote as never);
    expect(calls.length).toBe(0);
  });

  it('drops when the membership resolve throws (fail-closed, never throws out)', async () => {
    const { sql, calls } = fakeSql();
    await writeToPg(opts(sql, 'throws'), await wireRow(), remote as never);
    expect(calls.length).toBe(0);
  });

  it('slug mismatch never writes (projection demux)', async () => {
    const { sql, calls } = fakeSql();
    await writeToPg(opts(sql, { githubUserId: 77 }), await wireRow({ harness_slug: 'other-hive' }), remote as never);
    expect(calls.length).toBe(0);
  });

  it('a LOCAL write applies without the membership gate (CDC-captured own write)', async () => {
    const { sql, calls } = fakeSql();
    const o = opts(sql, { githubUserId: null }); // resolver would DENY — must not be consulted
    await writeToPg(o, await wireRow(), undefined);
    expect(calls.length).toBe(1);
  });
});
