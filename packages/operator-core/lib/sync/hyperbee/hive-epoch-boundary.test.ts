/**
 * Tests for the BOUNDARY-TRIGGER CORE (Brief RE-KEY / Move 2, K's P2). End-to-end
 * across my P1 (epoch model) + P2 (advanceEpochAndWrap) + P4 (serving) + ed300's REAL
 * crypto: a boundary advances the epoch, mints + wraps the new key to remaining members,
 * a REMAINING member unwraps it and decrypts content — and the REMOVED member, absent
 * from the wrap set, is cut off. Keychain + hive-settings-store mocked in-memory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';

// in-memory keychain (device keys + epoch keys share the id-keyed map; serviceName ignored)
const { mem } = vi.hoisted(() => ({ mem: new Map<string, Buffer>() }));
vi.mock('../../identity/keychain', () => ({
  keychainStore: async (id: string, der: Buffer) => { mem.set(id, der); return { kind: 'ok', value: undefined }; },
  keychainLoad: async (id: string) =>
    mem.has(id) ? { kind: 'ok', value: mem.get(id)! } : { kind: 'error', error: { kind: 'not_found' } },
  keychainDelete: async (id: string) => { mem.delete(id); return { kind: 'ok', value: undefined }; },
}));

// in-memory hive_settings (backs the P1 epoch model)
const { settings } = vi.hoisted(() => ({ settings: new Map<string, unknown>() }));
const sk = (ws: string, slug: string, key: string) => `${ws}::${slug}::${key}`;
vi.mock('../../hive-settings-store', () => ({
  getHiveSetting: async (ws: string, slug: string, key: string) =>
    settings.has(sk(ws, slug, key))
      ? { workspaceId: ws, potHomeSlug: slug, settingKey: key, value: settings.get(sk(ws, slug, key)), createdAt: 0, updatedAt: 0 }
      : null,
  setHiveSetting: async (i: { workspaceId: string; potHomeSlug: string; settingKey: string; value: unknown }) => {
    settings.set(sk(i.workspaceId, i.potHomeSlug, i.settingKey), i.value);
    return { ...i, createdAt: 0, updatedAt: 0 };
  },
}));

const { createHiveEpochCrypto } = await import('./hive-epoch-crypto-impl');
const { keychainStore } = await import('../../identity/keychain');
const { advanceEpochAndWrap } = await import('./hive-epoch-boundary');
const { encryptOpPayload, decryptOpPayload } = await import('./hive-epoch-serving');

/** Register a device: fresh Ed25519 keypair, PKCS8 priv key in the (mock) keychain. */
async function makeDevice(keychainId: string): Promise<{ keychainId: string; pubkeyBase64: string }> {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const pubkeyBase64 = Buffer.from(spki.subarray(spki.length - 32)).toString('base64');
  await keychainStore(keychainId, der);
  return { keychainId, pubkeyBase64 };
}

const CTX = { workspaceId: 'default', potHomeSlug: 'hello-world-hive', potId: 'hive-1' };
const enc = (s: string) => new TextEncoder().encode(s);

beforeEach(() => { mem.clear(); settings.clear(); });

describe('advanceEpochAndWrap — structure', () => {
  it('advances the epoch + wraps one row per UNIQUE remaining member; excludes the removed one', async () => {
    const c = createHiveEpochCrypto();
    const b = await makeDevice('dev-b');
    const cc = await makeDevice('dev-c');
    await makeDevice('dev-removed');
    const res = await advanceEpochAndWrap(c, CTX, [b.pubkeyBase64, b.pubkeyBase64, cc.pubkeyBase64]); // dup b
    expect(res.newEpoch).toBe(1);
    const pks = res.wrapped.map((w) => w.memberDevicePubkey).sort();
    expect(pks).toEqual([b.pubkeyBase64, cc.pubkeyBase64].sort()); // deduped, removed absent
  });
  it('is monotonic across boundaries', async () => {
    const c = createHiveEpochCrypto();
    const b = await makeDevice('dev-b2');
    expect((await advanceEpochAndWrap(c, CTX, [b.pubkeyBase64])).newEpoch).toBe(1);
    expect((await advanceEpochAndWrap(c, CTX, [b.pubkeyBase64])).newEpoch).toBe(2);
  });
});

describe('advanceEpochAndWrap — WI-6044 malformed-device guard (WI-3927 parity)', () => {
  // 'pk-creator' is the real leaked test-fixture value from WI-3927: ~10 chars instead of the
  // 43/44-char base64 of a 32-byte key, so wrapKeyToMember throws on it.
  const MALFORMED = 'pk-creator';

  // The skip is intentionally NOISY (a silent skip is how WI-6043 cost hours), so the warn is
  // asserted behaviour here, not incidental output the suite should tolerate.
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('SKIPS an unwrappable device, still grants to every well-formed member, and SAYS SO', async () => {
    const c = createHiveEpochCrypto();
    const b = await makeDevice('dev-guard-b');
    const cc = await makeDevice('dev-guard-c');

    // Pre-guard this THREW and aborted the whole pass, starving b and cc for one bad row.
    const res = await advanceEpochAndWrap(c, CTX, [b.pubkeyBase64, MALFORMED, cc.pubkeyBase64]);

    expect(res.wrapped.map((w) => w.memberDevicePubkey).sort()).toEqual(
      [b.pubkeyBase64, cc.pubkeyBase64].sort(),
    );
    expect(res.skippedDevicePubkeys).toEqual([MALFORMED]);
    // The boundary must still have ADVANCED — an aborted advance is what lets a revoked
    // member keep reading post-boundary content (the WI-6043 leak symptom).
    expect(res.newEpoch).toBe(1);
    // Must be diagnosable from logs alone, naming the offending key and WI-6044.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/WI-6044/);
    expect(warn.mock.calls[0]?.[0]).toContain(MALFORMED);
  });

  it('does NOT report skippedDevicePubkeys, or warn, on the healthy path', async () => {
    const c = createHiveEpochCrypto();
    const b = await makeDevice('dev-guard-healthy');
    const res = await advanceEpochAndWrap(c, CTX, [b.pubkeyBase64]);
    expect(res.skippedDevicePubkeys).toBeUndefined();
    expect(res.wrapped).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('THROWS when every remaining device is unwrappable, rather than persisting an epoch nobody can read', async () => {
    const c = createHiveEpochCrypto();
    // Degenerate case: skipping all of them would return wrapped:[] for an ALREADY-advanced
    // epoch, locking the whole pot out of its own content — strictly worse than failing.
    await expect(advanceEpochAndWrap(c, CTX, [MALFORMED, 'also-bad'])).rejects.toThrow(/WI-6044/);

    // EI-18714731283071702: this test's NAME has always claimed "rather than persisting", but
    // NOTHING asserted it — and the implementation advanced + COMMITTED the epoch on its first
    // line, before any wrap was attempted. The throw rolled back nothing (sql is undefined all
    // the way down from hive-revoke-contributor.ts:197, so setHiveSetting autocommits), leaving
    // exactly the pot-locked-out state the comment above calls "strictly worse than failing".
    // A throw that says "refusing to persist" must actually refuse to persist.
    expect(settings.get(sk(CTX.workspaceId, CTX.potHomeSlug, 'epoch'))).toBeUndefined();
  });

  it('does not CONSUME an epoch on the all-unwrappable throw — the next healthy boundary still gets 1', async () => {
    const c = createHiveEpochCrypto();
    const b = await makeDevice('dev-guard-nonconsuming');
    await expect(advanceEpochAndWrap(c, CTX, [MALFORMED, 'also-bad'])).rejects.toThrow(/WI-6044/);
    // If the failed boundary had burned epoch 1, this would come back 2 and every member's
    // key set would be off-by-one against a gap epoch nobody ever held a key for.
    expect((await advanceEpochAndWrap(c, CTX, [b.pubkeyBase64])).newEpoch).toBe(1);
  });

  it('still dedupes and ignores empty pubkeys while guarding', async () => {
    const c = createHiveEpochCrypto();
    const b = await makeDevice('dev-guard-dedupe');
    const res = await advanceEpochAndWrap(c, CTX, [
      '',
      b.pubkeyBase64,
      b.pubkeyBase64,
      MALFORMED,
      MALFORMED,
    ]);
    expect(res.wrapped).toHaveLength(1);
    expect(res.skippedDevicePubkeys).toEqual([MALFORMED]); // deduped, not counted twice
    expect(warn).toHaveBeenCalledTimes(1); // warned once, not once per duplicate
  });
});

describe('advanceEpochAndWrap — end-to-end cut-off (real crypto + serving)', () => {
  it('a remaining member unwraps the new key + decrypts content; a removed member cannot', async () => {
    const c = createHiveEpochCrypto();
    const remaining = await makeDevice('dev-remaining');
    const removed = await makeDevice('dev-removed-2');

    const res = await advanceEpochAndWrap(c, CTX, [remaining.pubkeyBase64]);
    expect(res.newEpoch).toBe(1);
    expect(res.wrapped.map((w) => w.memberDevicePubkey)).not.toContain(removed.pubkeyBase64);

    // Owner encrypts new-epoch content under the minted key.
    const ownerKey = await c.deriveEpochKey(CTX.potId, res.newEpoch);
    const opCtx = { potId: CTX.potId, epoch: res.newEpoch, id: { tableTag: 'harness-features', rowKey: 'F-9', authorPubkey: 'owner' } };
    const ct = await encryptOpPayload(c, enc('post-boundary secret'), opCtx, ownerKey);

    // REMAINING member: unwrap its row → decrypt → reads it.
    const row = res.wrapped.find((w) => w.memberDevicePubkey === remaining.pubkeyBase64)!;
    const memberKey = await c.unwrapEpochKey(row.wrappedKey, remaining.keychainId);
    const pt = await decryptOpPayload(c, ct, opCtx, memberKey);
    expect(new TextDecoder().decode(pt)).toBe('post-boundary secret');

    // REMOVED member: has no wrapped row, and cannot unwrap the remaining member's row
    // with its own device key → no epoch key → cut off.
    await expect(c.unwrapEpochKey(row.wrappedKey, removed.keychainId)).rejects.toBeTruthy();
  });
});
