/**
 * WI-1981 — ensureHiveIdentity's Phase-1 ownership gate, made real.
 *
 * The live incident (tower↔VM, 2026-07-03): a joiner box held a `remote_hive`
 * registry VIEW for slug `papercusp` but no hives identity row; a read-path
 * call (hive:list/hive:get → resolveHivePubkey → ensureHiveIdentity lazy
 * backfill) MINTED a second conflicting hive author identity → wrong epoch
 * secrets → poison origin=local wraps → permanent mutual epoch_decrypt_fail.
 * These tests pin: view-with-pubkey HEALS (remote: row, no mint);
 * view-without-pubkey REFUSES (typed error, no mint); non-view rows mint as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const inserted: Array<Record<string, unknown>> = [];
const mintCalls: string[] = [];
const divergentCalls: Array<Record<string, unknown>> = [];
let heldPk: string | null = null; // what loadHivePubkey returns (the key this box holds)
let hiveRow: Record<string, unknown> | null = null; // the hives row getHiveBySlug returns

beforeEach(() => {
  vi.resetModules();
  inserted.length = 0;
  mintCalls.length = 0;
  divergentCalls.length = 0;
  heldPk = null;
  hiveRow = null; // no hives row — the backfill gap state
  vi.doMock('./hive-store', () => ({
    getHiveBySlug: vi.fn(async () => hiveRow),
    insertHiveIfAbsent: vi.fn(async (row: Record<string, unknown>) => {
      inserted.push(row);
      return { record: row, created: true };
    }),
  }));
  vi.doMock('./identity/keychain', () => ({
    keychainLoad: vi.fn(async () => ({ kind: 'missing' })),
  }));
  vi.doMock('./hive-owner-key-health', () => ({
    signalHiveKeyDivergent: vi.fn(async (ref: Record<string, unknown>) => {
      divergentCalls.push(ref);
      return true;
    }),
  }));
  vi.doMock('./identity/hive-keypair', () => {
    class RemoteHiveViewMintRefusedError extends Error {}
    return {
      HIVE_KEYPAIR_SERVICE: 'papercusp-hive',
      RemoteHiveViewMintRefusedError,
      loadHivePubkey: vi.fn(async () => heldPk),
      loadOrGenerateHiveKeypair: vi.fn(async (ws: string, slug: string) => {
        mintCalls.push(`${ws}/${slug}`);
        return { keychainId: `hive:${ws}:${slug}`, pubkeyBase64: 'MINTED_PK' };
      }),
    };
  });
});

afterEach(() => {
  vi.doUnmock('./hive-store');
  vi.doUnmock('./identity/keychain');
  vi.doUnmock('./identity/hive-keypair');
  vi.doUnmock('./harness-registry');
  vi.doUnmock('./hive-owner-key-health');
});

function mockRegistry(projects: Array<Record<string, unknown>>) {
  vi.doMock('./harness-registry', () => ({
    loadHarnessRegistry: vi.fn(async () => ({ projects })),
  }));
}

describe('ensureHiveIdentity — WI-1981 ownership gate', () => {
  it('HEALS a remote_hive view carrying the verified pubkey: remote: row inserted, NO mint', async () => {
    mockRegistry([{ slug: 'papercusp', harness_kind: 'hive', remote_hive: true, hive_pubkey: 'TRUE_OWNER_PK' }]);
    const { ensureHiveIdentity } = await import('./hive-identity');
    const res = await ensureHiveIdentity('papercusp-workspace', 'papercusp');
    expect(mintCalls).toEqual([]); // the poison writer never fires
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      pubkeyBase64: 'TRUE_OWNER_PK',
      keychainId: 'remote:TRUE_OWNER_PK',
    });
    expect(res.created).toBe(true);
  });

  it('REFUSES a remote_hive view WITHOUT a stamped pubkey (typed error, no mint, no insert)', async () => {
    mockRegistry([{ slug: 'papercusp', harness_kind: 'hive', remote_hive: true }]);
    const { ensureHiveIdentity } = await import('./hive-identity');
    await expect(ensureHiveIdentity('papercusp-workspace', 'papercusp')).rejects.toThrow();
    expect(mintCalls).toEqual([]);
    expect(inserted).toEqual([]);
  });

  it('resolveHivePubkey returns the view pubkey (healed) instead of undefined/poison', async () => {
    mockRegistry([{ slug: 'papercusp', harness_kind: 'hive', remote_hive: true, hive_pubkey: 'TRUE_OWNER_PK' }]);
    const { resolveHivePubkey } = await import('./hive-identity');
    expect(await resolveHivePubkey('papercusp-workspace', 'papercusp')).toBe('TRUE_OWNER_PK');
  });

  it('an OWNED (non-view) hive still mints exactly as before', async () => {
    mockRegistry([{ slug: 'my-own', harness_kind: 'hive' }]);
    const { ensureHiveIdentity } = await import('./hive-identity');
    const res = await ensureHiveIdentity('ws1', 'my-own');
    expect(mintCalls).toEqual(['ws1/my-own']);
    expect(res.created).toBe(true);
  });
});

describe('isCanonicalHiveOwner — wake-#5515 (divergent key ≠ ownership)', () => {
  it('TRUE owner: held key matches the hives row pubkey', async () => {
    heldPk = 'TRUE_OWNER_PK';
    hiveRow = { pubkeyBase64: 'TRUE_OWNER_PK', keychainId: 'hive:ws:papercusp' };
    mockRegistry([]);
    const { isCanonicalHiveOwner } = await import('./hive-identity');
    expect(await isCanonicalHiveOwner('ws', 'papercusp')).toBe(true);
    expect(divergentCalls).toEqual([]);
  });

  it('the LIVE incident: divergent held key + CORRECT hives row → NOT owner + divergent signal', async () => {
    heldPk = 'DIVERGENT_FILE_TIER_PK';
    hiveRow = { pubkeyBase64: 'dt7o6io_TRUE_PK', keychainId: 'remote:dt7o6io_TRUE_PK' };
    mockRegistry([]);
    const { isCanonicalHiveOwner } = await import('./hive-identity');
    expect(await isCanonicalHiveOwner('papercusp-workspace', 'papercusp')).toBe(false);
    await new Promise((r) => setTimeout(r, 0)); // the signal fires void'd (best-effort)
    expect(divergentCalls).toHaveLength(1);
    expect(divergentCalls[0]).toMatchObject({
      heldPubkey: 'DIVERGENT_FILE_TIER_PK',
      canonicalPubkey: 'dt7o6io_TRUE_PK',
    });
  });

  it('no held key at all → NOT owner (a plain member)', async () => {
    heldPk = null;
    hiveRow = { pubkeyBase64: 'TRUE_OWNER_PK' };
    mockRegistry([]);
    const { isCanonicalHiveOwner } = await import('./hive-identity');
    expect(await isCanonicalHiveOwner('ws', 'papercusp')).toBe(false);
  });

  it('no hives row, joined remote_hive view with stamped pubkey MISMATCH → NOT owner', async () => {
    heldPk = 'DIVERGENT_PK';
    hiveRow = null;
    mockRegistry([{ slug: 'papercusp', remote_hive: true, hive_pubkey: 'TRUE_OWNER_PK' }]);
    const { isCanonicalHiveOwner } = await import('./hive-identity');
    expect(await isCanonicalHiveOwner('ws', 'papercusp')).toBe(false);
  });

  it('no hives row, joined remote_hive view WITHOUT a stamped pubkey → NOT owner (a view is a peer)', async () => {
    heldPk = 'ANY_PK';
    hiveRow = null;
    mockRegistry([{ slug: 'papercusp', remote_hive: true }]);
    const { isCanonicalHiveOwner } = await import('./hive-identity');
    expect(await isCanonicalHiveOwner('ws', 'papercusp')).toBe(false);
  });

  it('held key + NO canonical record anywhere → legacy heuristic (owner cold-start, fail-open)', async () => {
    heldPk = 'FRESH_MINT_PK';
    hiveRow = null;
    mockRegistry([{ slug: 'papercusp', harness_kind: 'hive' }]); // own (non-view) registry entry
    const { isCanonicalHiveOwner } = await import('./hive-identity');
    expect(await isCanonicalHiveOwner('ws', 'papercusp')).toBe(true);
  });
});
