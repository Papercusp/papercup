/**
 * ref-announce.test.ts — G-3 pure core (P-027): signing bytes, verification,
 * acceptance ordering (self → membership → sig → version fence → budget), the
 * fixed-window budget, and the fetch-skip decision. No git, no I/O.
 *
 * Run: cd packages/operator-core && npx vitest run lib/sync/pot-git/ref-announce.test.ts
 */
import { describe, expect, it } from 'vitest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import {
  DEFAULT_ANNOUNCE_BUDGET,
  REF_ANNOUNCE_SCHEMA_VERSION,
  REF_ANNOUNCE_SIG_DOMAIN,
  type RefAnnouncePayload,
  type SignedRefAnnouncement,
  acceptRefAnnouncement,
  fetchedSnapshotHonoursAnnouncement,
  isSignedRefAnnouncement,
  refAnnounceSigningBytes,
  shouldFetchOnAnnouncement,
  takeAnnounceBudget,
  verifyRefAnnouncement,
} from './ref-announce';
import type { SignedSigrefs } from './sigrefs';
import { makeSignedProtocolContext } from './signed-context';

describe('fetchedSnapshotHonoursAnnouncement (WI-2142873: a fetch brings the peer AS IT IS NOW)', () => {
  const ctx = makeSignedProtocolContext('hive-a', 'gh-1', 'sg2-1-' + 'a'.repeat(40));
  const ann = (version: number, oid: string) => ({ ...ctx, version, sigrefs_oid: oid }) as unknown as SignedRefAnnouncement;
  const snap = (version: number, context = ctx) => ({ ...context, version }) as unknown as SignedSigrefs;
  const OID_ANNOUNCED = '1'.repeat(40);
  const OID_OTHER = '2'.repeat(40);

  it('accepts a NEWER device-signed snapshot than the queued announcement that drove the fetch', () => {
    // The Mac VM drained v2..v2683 while the tower was at v2921: every fetch was newer.
    expect(fetchedSnapshotHonoursAnnouncement(snap(2921), OID_OTHER, ann(2683, OID_ANNOUNCED))).toBe(true);
  });

  it('accepts exactly the announced snapshot', () => {
    expect(fetchedSnapshotHonoursAnnouncement(snap(7), OID_ANNOUNCED, ann(7, OID_ANNOUNCED))).toBe(true);
  });

  it('refuses the same version under a different blob (equivocation)', () => {
    expect(fetchedSnapshotHonoursAnnouncement(snap(7), OID_OTHER, ann(7, OID_ANNOUNCED))).toBe(false);
  });

  it('refuses a snapshot OLDER than announced (relay rollback)', () => {
    expect(fetchedSnapshotHonoursAnnouncement(snap(6), OID_OTHER, ann(7, OID_ANNOUNCED))).toBe(false);
  });

  it('refuses a newer snapshot from a different signed context or store generation', () => {
    const otherGen = makeSignedProtocolContext('hive-a', 'gh-1', 'sg2-2-' + 'b'.repeat(40));
    const otherRepo = makeSignedProtocolContext('hive-a', 'gh-2', 'sg2-1-' + 'a'.repeat(40));
    expect(fetchedSnapshotHonoursAnnouncement(snap(9, otherGen), OID_OTHER, ann(7, OID_ANNOUNCED))).toBe(false);
    expect(fetchedSnapshotHonoursAnnouncement(snap(9, otherRepo), OID_OTHER, ann(7, OID_ANNOUNCED))).toBe(false);
  });

  it('refuses a newer snapshot whose sigrefs ref could not be read back', () => {
    expect(fetchedSnapshotHonoursAnnouncement(snap(9), null, ann(7, OID_ANNOUNCED))).toBe(false);
  });
});

function mkSigner(): { pubkeyBase64: string; sign: (bytes: Buffer) => Promise<Buffer> } {
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  return { pubkeyBase64, sign: async (bytes: Buffer) => signWithPrivateKeyDer(privateKeyDer, bytes) };
}

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);

async function mkAnnouncement(
  signer: ReturnType<typeof mkSigner>,
  fields: Partial<RefAnnouncePayload> = {},
): Promise<SignedRefAnnouncement> {
  const payload: RefAnnouncePayload = {
    v: REF_ANNOUNCE_SCHEMA_VERSION,
    device_pubkey: signer.pubkeyBase64,
    sigrefs_oid: OID_A,
    version: 3,
    ts: 1_000,
    ...fields,
  };
  const sig = (await signer.sign(refAnnounceSigningBytes(payload))).toString('base64');
  return { ...payload, sig };
}

describe('signing bytes + verification', () => {
  it('signing bytes are domain-tagged and field-order-stable', async () => {
    const s = mkSigner();
    const ann = await mkAnnouncement(s);
    const bytes = refAnnounceSigningBytes(ann);
    expect(bytes.toString('utf8').startsWith(`${REF_ANNOUNCE_SIG_DOMAIN}\n`)).toBe(true);
    // Same fields in a different construction order → identical bytes.
    const reordered = { ts: ann.ts, version: ann.version, sigrefs_oid: ann.sigrefs_oid, device_pubkey: ann.device_pubkey, v: ann.v };
    expect(refAnnounceSigningBytes(reordered as RefAnnouncePayload).equals(bytes)).toBe(true);
  });

  it('verifies a valid announcement; rejects tamper, wrong device, garbage', async () => {
    const s = mkSigner();
    const other = mkSigner();
    const ann = await mkAnnouncement(s);
    expect(verifyRefAnnouncement(ann)).toBe(true);
    expect(verifyRefAnnouncement(ann, s.pubkeyBase64)).toBe(true);
    expect(verifyRefAnnouncement(ann, other.pubkeyBase64)).toBe(false);
    expect(verifyRefAnnouncement({ ...ann, version: ann.version + 1 })).toBe(false);
    expect(verifyRefAnnouncement({ ...ann, sigrefs_oid: OID_B })).toBe(false);
    expect(isSignedRefAnnouncement({ ...ann, sigrefs_oid: 'not-a-sha' })).toBe(false);
    expect(verifyRefAnnouncement(null as unknown as SignedRefAnnouncement)).toBe(false);
  });

  it('binds v2 announcements to hive/repository/store context and rejects drift or legacy when required', async () => {
    const s = mkSigner();
    const context = makeSignedProtocolContext('hive-a', 'gh-1', 'sg2-1-' + 'a'.repeat(40));
    const ann = await mkAnnouncement(s, { v: 2, ...context });
    expect(verifyRefAnnouncement(ann)).toBe(true);
    expect(acceptRefAnnouncement(ann, { priorVersion: 0, expectedContext: context, allowLegacy: false })).toMatchObject({ ok: true });
    expect(acceptRefAnnouncement(ann, { priorVersion: 0, expectedContext: { ...context, repo_key: 'gh-2' } })).toMatchObject({
      ok: false,
      reason: 'context-mismatch',
    });
    const legacy = await mkAnnouncement(s);
    expect(acceptRefAnnouncement(legacy, { priorVersion: 0, expectedContext: context, allowLegacy: false })).toMatchObject({
      ok: false,
      reason: 'legacy-version',
    });
  });
});

describe('acceptRefAnnouncement ordering', () => {
  it('accepts a fresh valid announcement from a member', async () => {
    const s = mkSigner();
    const ann = await mkAnnouncement(s);
    const r = acceptRefAnnouncement(ann, { allowLegacy: true, allowedDevices: [s.pubkeyBase64], priorVersion: 2 });
    expect(r.ok).toBe(true);
  });

  it('filters our own announcements (self)', async () => {
    const s = mkSigner();
    const ann = await mkAnnouncement(s);
    const r = acceptRefAnnouncement(ann, { allowLegacy: true, selfDevice: s.pubkeyBase64, priorVersion: null });
    expect(r).toMatchObject({ ok: false, reason: 'self' });
  });

  it('membership-gates the embedded device (wrong-device)', async () => {
    const s = mkSigner();
    const member = mkSigner();
    const ann = await mkAnnouncement(s);
    const r = acceptRefAnnouncement(ann, { allowLegacy: true, allowedDevices: [member.pubkeyBase64], priorVersion: null });
    expect(r).toMatchObject({ ok: false, reason: 'wrong-device' });
  });

  it('rejects a forged signature', async () => {
    const s = mkSigner();
    const ann = await mkAnnouncement(s);
    const forged = { ...ann, version: ann.version + 5 };
    const r = acceptRefAnnouncement(forged, { allowLegacy: true, allowedDevices: [s.pubkeyBase64], priorVersion: null });
    expect(r).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('fences stale/replayed versions against the mirror watermark', async () => {
    const s = mkSigner();
    const ann = await mkAnnouncement(s, { version: 3 });
    expect(acceptRefAnnouncement(ann, { allowLegacy: true, priorVersion: 3 })).toMatchObject({ ok: false, reason: 'stale-version' });
    expect(acceptRefAnnouncement(ann, { allowLegacy: true, priorVersion: 7 })).toMatchObject({ ok: false, reason: 'stale-version' });
    expect(acceptRefAnnouncement(ann, { allowLegacy: true, priorVersion: 2 }).ok).toBe(true);
    expect(acceptRefAnnouncement(ann, { allowLegacy: true, priorVersion: null }).ok).toBe(true);
  });

  it('charges the budget only on otherwise-acceptable announcements', async () => {
    const s = mkSigner();
    const cfg = { windowMs: 60_000, maxPerWindow: 2 };
    // A stale announcement does NOT consume budget.
    const stale = await mkAnnouncement(s, { version: 1 });
    const r0 = acceptRefAnnouncement(stale, { allowLegacy: true,
      priorVersion: 5,
      budget: { state: null, nowMs: 0, config: cfg },
    });
    expect(r0).toMatchObject({ ok: false, reason: 'stale-version', budgetState: null });
    // Fresh ones consume it; the third in-window is deferred.
    let state = r0.budgetState;
    for (const [version, wantOk] of [
      [10, true],
      [11, true],
      [12, false],
    ] as const) {
      const ann = await mkAnnouncement(s, { version });
      const r = acceptRefAnnouncement(ann, { allowLegacy: true,
        priorVersion: 5,
        budget: { state, nowMs: 1_000, config: cfg },
      });
      expect(r.ok).toBe(wantOk);
      if (!r.ok) expect(r.reason).toBe('over-budget');
      state = r.budgetState;
    }
    // A new window refills.
    const later = await mkAnnouncement(s, { version: 13 });
    const r3 = acceptRefAnnouncement(later, { allowLegacy: true,
      priorVersion: 5,
      budget: { state, nowMs: 1_000 + cfg.windowMs, config: cfg },
    });
    expect(r3.ok).toBe(true);
  });
});

describe('takeAnnounceBudget', () => {
  it('fills a fixed window and resets after it', () => {
    const cfg = { windowMs: 100, maxPerWindow: 2 };
    const t1 = takeAnnounceBudget(null, 0, cfg);
    expect(t1).toEqual({ ok: true, state: { windowStartMs: 0, count: 1 } });
    const t2 = takeAnnounceBudget(t1.state, 50, cfg);
    expect(t2.ok).toBe(true);
    const t3 = takeAnnounceBudget(t2.state, 99, cfg);
    expect(t3).toMatchObject({ ok: false });
    expect(t3.state).toEqual(t2.state);
    const t4 = takeAnnounceBudget(t3.state, 100, cfg);
    expect(t4).toEqual({ ok: true, state: { windowStartMs: 100, count: 1 } });
  });

  it('default budget allows a burst but caps it', () => {
    let state: ReturnType<typeof takeAnnounceBudget>['state'] | null = null;
    let accepted = 0;
    for (let i = 0; i < DEFAULT_ANNOUNCE_BUDGET.maxPerWindow + 5; i++) {
      const t = takeAnnounceBudget(state, 10, DEFAULT_ANNOUNCE_BUDGET);
      if (t.ok) accepted++;
      state = t.state;
    }
    expect(accepted).toBe(DEFAULT_ANNOUNCE_BUDGET.maxPerWindow);
  });
});

describe('shouldFetchOnAnnouncement', () => {
  it('skips when the mirror already holds the advertised snapshot', async () => {
    const s = mkSigner();
    const ann = await mkAnnouncement(s, { sigrefs_oid: OID_A });
    expect(shouldFetchOnAnnouncement(ann, OID_A)).toBe(false);
    expect(shouldFetchOnAnnouncement(ann, OID_B)).toBe(true);
    expect(shouldFetchOnAnnouncement(ann, null)).toBe(true);
  });
});
