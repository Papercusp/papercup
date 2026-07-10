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
  isSignedRefAnnouncement,
  refAnnounceSigningBytes,
  shouldFetchOnAnnouncement,
  takeAnnounceBudget,
  verifyRefAnnouncement,
} from './ref-announce';

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
});

describe('acceptRefAnnouncement ordering', () => {
  it('accepts a fresh valid announcement from a member', async () => {
    const s = mkSigner();
    const ann = await mkAnnouncement(s);
    const r = acceptRefAnnouncement(ann, { allowedDevices: [s.pubkeyBase64], priorVersion: 2 });
    expect(r.ok).toBe(true);
  });

  it('filters our own announcements (self)', async () => {
    const s = mkSigner();
    const ann = await mkAnnouncement(s);
    const r = acceptRefAnnouncement(ann, { selfDevice: s.pubkeyBase64, priorVersion: null });
    expect(r).toMatchObject({ ok: false, reason: 'self' });
  });

  it('membership-gates the embedded device (wrong-device)', async () => {
    const s = mkSigner();
    const member = mkSigner();
    const ann = await mkAnnouncement(s);
    const r = acceptRefAnnouncement(ann, { allowedDevices: [member.pubkeyBase64], priorVersion: null });
    expect(r).toMatchObject({ ok: false, reason: 'wrong-device' });
  });

  it('rejects a forged signature', async () => {
    const s = mkSigner();
    const ann = await mkAnnouncement(s);
    const forged = { ...ann, version: ann.version + 5 };
    const r = acceptRefAnnouncement(forged, { allowedDevices: [s.pubkeyBase64], priorVersion: null });
    expect(r).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('fences stale/replayed versions against the mirror watermark', async () => {
    const s = mkSigner();
    const ann = await mkAnnouncement(s, { version: 3 });
    expect(acceptRefAnnouncement(ann, { priorVersion: 3 })).toMatchObject({ ok: false, reason: 'stale-version' });
    expect(acceptRefAnnouncement(ann, { priorVersion: 7 })).toMatchObject({ ok: false, reason: 'stale-version' });
    expect(acceptRefAnnouncement(ann, { priorVersion: 2 }).ok).toBe(true);
    expect(acceptRefAnnouncement(ann, { priorVersion: null }).ok).toBe(true);
  });

  it('charges the budget only on otherwise-acceptable announcements', async () => {
    const s = mkSigner();
    const cfg = { windowMs: 60_000, maxPerWindow: 2 };
    // A stale announcement does NOT consume budget.
    const stale = await mkAnnouncement(s, { version: 1 });
    const r0 = acceptRefAnnouncement(stale, {
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
      const r = acceptRefAnnouncement(ann, {
        priorVersion: 5,
        budget: { state, nowMs: 1_000, config: cfg },
      });
      expect(r.ok).toBe(wantOk);
      if (!r.ok) expect(r.reason).toBe('over-budget');
      state = r.budgetState;
    }
    // A new window refills.
    const later = await mkAnnouncement(s, { version: 13 });
    const r3 = acceptRefAnnouncement(later, {
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
