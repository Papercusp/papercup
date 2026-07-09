/**
 * cross-hive-grant-quotas.test.ts — P-013 grant quotas + expiry
 * (hive-network-surface-2026-06-11, D-005 hardening).
 *
 * Every grant carries a rolling per-hour rate cap, a payload size cap, and an
 * optional expiry; absent fields fall back to always-on defaults so a bare
 * grant is never unbounded. Unit-level: the pure admit checks both directions,
 * plus the wiring chokepoints (fake mesh, in-memory quota ledger) — over-quota
 * inbound is rejected before any port, admitted inbound is ledgered as the C-1
 * `in` row, and our replies settle that row. The real-PG legs (count via
 * `cross_hive_asks`, quota round-trip through hive_settings) live in
 * cross-hive-grants.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import {
  DEFAULT_CROSS_HIVE_MAX_BODY_BYTES,
  DEFAULT_CROSS_HIVE_MAX_PER_HOUR,
  admitCrossHiveEnvelope,
  admitOutboundCrossHive,
  type CrossHiveEnvelope,
  type CrossHiveGrant,
} from './cross-hive-boundary';
import {
  InMemoryCrossHiveOutbox,
  type CrossHiveTransport,
  type CrossHiveWireEnvelope,
} from './cross-hive-transport';
import { InMemoryCrossHiveQuotaLedger, wireCrossHiveBoundary } from './cross-hive-wiring';

const SELF = 'self-hive-pubkey';
const PEER = 'peer-hive-pubkey';

function env(over: Partial<CrossHiveEnvelope> = {}): CrossHiveEnvelope {
  return {
    fromHivePubkey: PEER,
    toHivePubkey: SELF,
    kind: 'ask',
    subject: 's',
    body: 'b',
    sig: 'sig',
    ...over,
  };
}

function grant(over: Partial<CrossHiveGrant> = {}): CrossHiveGrant {
  return { peerHivePubkey: PEER, allowedKinds: ['ask'], ...over };
}

describe('admitCrossHiveEnvelope — P-013 quotas (inbound)', () => {
  const NOW = 1_770_000_000_000;

  it('admits under quota (explicit context)', () => {
    const a = admitCrossHiveEnvelope(env(), {
      selfHivePubkey: SELF,
      grants: [grant()],
      nowMs: NOW,
      recentFromPeerCount: 0,
    });
    expect(a.admitted).toBe(true);
  });

  it('rejects an EXPIRED grant (and reports when it expired)', () => {
    const a = admitCrossHiveEnvelope(env(), {
      selfHivePubkey: SELF,
      grants: [grant({ expiresAt: NOW - 1 })],
      nowMs: NOW,
    });
    expect(a.admitted).toBe(false);
    expect(a.reason).toMatch(/expired/i);
  });

  it('a not-yet-expired grant still admits', () => {
    const a = admitCrossHiveEnvelope(env(), {
      selfHivePubkey: SELF,
      grants: [grant({ expiresAt: NOW + 1 })],
      nowMs: NOW,
    });
    expect(a.admitted).toBe(true);
  });

  it('rejects an oversize body per the grant cap (bytes, not chars)', () => {
    const a = admitCrossHiveEnvelope(env({ body: 'aaaaaaaaaaa' }), {
      selfHivePubkey: SELF,
      grants: [grant({ maxBodyBytes: 10 })],
      nowMs: NOW,
    });
    expect(a.admitted).toBe(false);
    expect(a.reason).toMatch(/exceeds the 10B cap/);
    // Multi-byte chars count as BYTES: 4 × '€' (3 bytes each) = 12B > 10B.
    const multi = admitCrossHiveEnvelope(env({ body: '€€€€' }), {
      selfHivePubkey: SELF,
      grants: [grant({ maxBodyBytes: 10 })],
      nowMs: NOW,
    });
    expect(multi.admitted).toBe(false);
  });

  it('applies the DEFAULT size cap when the grant sets none', () => {
    const a = admitCrossHiveEnvelope(env({ body: 'x'.repeat(DEFAULT_CROSS_HIVE_MAX_BODY_BYTES + 1) }), {
      selfHivePubkey: SELF,
      grants: [grant()],
      nowMs: NOW,
    });
    expect(a.admitted).toBe(false);
    expect(a.reason).toContain(`${DEFAULT_CROSS_HIVE_MAX_BODY_BYTES}B cap`);
  });

  it('rejects at the grant rate cap; one under still admits', () => {
    const capped = grant({ maxPerHour: 3 });
    const at = admitCrossHiveEnvelope(env(), {
      selfHivePubkey: SELF,
      grants: [capped],
      nowMs: NOW,
      recentFromPeerCount: 3,
    });
    expect(at.admitted).toBe(false);
    expect(at.reason).toMatch(/rate cap/i);
    const under = admitCrossHiveEnvelope(env(), {
      selfHivePubkey: SELF,
      grants: [capped],
      nowMs: NOW,
      recentFromPeerCount: 2,
    });
    expect(under.admitted).toBe(true);
  });

  it('applies the DEFAULT rate cap when the grant sets none', () => {
    const a = admitCrossHiveEnvelope(env(), {
      selfHivePubkey: SELF,
      grants: [grant()],
      nowMs: NOW,
      recentFromPeerCount: DEFAULT_CROSS_HIVE_MAX_PER_HOUR,
    });
    expect(a.admitted).toBe(false);
  });

  it('SKIPS the rate check when the count is absent (uncountable ≠ zero ≠ infinite)', () => {
    const a = admitCrossHiveEnvelope(env(), {
      selfHivePubkey: SELF,
      grants: [grant({ maxPerHour: 1 })],
      nowMs: NOW,
    });
    expect(a.admitted).toBe(true);
  });

  it('quota checks run AFTER the allow-list: an ungranted peer is still a grant reject', () => {
    const a = admitCrossHiveEnvelope(env({ fromHivePubkey: 'stranger' }), {
      selfHivePubkey: SELF,
      grants: [grant({ maxPerHour: 0 as never })],
      nowMs: NOW,
      recentFromPeerCount: 999,
    });
    expect(a.admitted).toBe(false);
    expect(a.reason).toMatch(/no capability grant/);
  });
});

describe('admitOutboundCrossHive — P-013 quotas (egress)', () => {
  const NOW = 1_770_000_000_000;

  it('rejects an expired outbound grant', () => {
    const a = admitOutboundCrossHive(
      { toHivePubkey: PEER, kind: 'ask' },
      { grants: [grant({ expiresAt: NOW - 1 })], nowMs: NOW },
    );
    expect(a.admitted).toBe(false);
    expect(a.reason).toMatch(/expired/i);
  });

  it('rejects an oversize outbound body', () => {
    const a = admitOutboundCrossHive(
      { toHivePubkey: PEER, kind: 'ask', bodyBytes: 11 },
      { grants: [grant({ maxBodyBytes: 10 })], nowMs: NOW },
    );
    expect(a.admitted).toBe(false);
    expect(a.reason).toMatch(/exceeds the 10B cap/);
  });

  it('rejects at the outbound rate cap; absent count skips', () => {
    const g = grant({ maxPerHour: 2 });
    expect(
      admitOutboundCrossHive(
        { toHivePubkey: PEER, kind: 'ask' },
        { grants: [g], nowMs: NOW, recentToPeerCount: 2 },
      ).admitted,
    ).toBe(false);
    expect(
      admitOutboundCrossHive({ toHivePubkey: PEER, kind: 'ask' }, { grants: [g], nowMs: NOW })
        .admitted,
    ).toBe(true);
  });
});

/* ── Wiring chokepoints: fake mesh, signed envelopes, in-memory quota ledger ── */

function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
}

function hiveIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pubkey: rawPubkeyBase64(publicKey),
    signer: async (bytes: Buffer) => nodeSign(null, bytes, privateKey),
  };
}

function makeTransportMesh() {
  const subs = new Map<string, (env: CrossHiveWireEnvelope) => void | Promise<unknown>>();
  return (selfPubkey: string): CrossHiveTransport => ({
    subscribe(handler) {
      subs.set(selfPubkey, handler);
    },
    async send(toHivePubkey, wireEnv) {
      const h = subs.get(toHivePubkey);
      if (!h) throw new Error(`mesh: no peer ${toHivePubkey}`);
      await h(wireEnv);
    },
  });
}

describe('wiring — quota enforcement at the chokepoints (no PG)', () => {
  function twoHives(opts: { receiverGrant?: (peer: string) => CrossHiveGrant } = {}) {
    const A = hiveIdentity(); // receiver (self)
    const B = hiveIdentity(); // sender peer
    const mesh = makeTransportMesh();
    const aQuota = new InMemoryCrossHiveQuotaLedger();
    const bQuota = new InMemoryCrossHiveQuotaLedger();
    const opened: string[] = [];

    const aWiring = wireCrossHiveBoundary({
      workspaceId: 'ws-quota', potSlug: 'hive-a', hivePubkey: A.pubkey,
      transport: mesh(A.pubkey), signer: A.signer,
      requestPorts: {
        async openAsk(e) { opened.push(e.subject); return { ref: 'conv-1' }; },
        async createWorkRequest() { return { ref: 'wi-1' }; },
      },
      loadGrants: async () => [opts.receiverGrant?.(B.pubkey) ?? { peerHivePubkey: B.pubkey, allowedKinds: ['ask'] }],
      loadOutboundGrants: async () => [],
      outbox: new InMemoryCrossHiveOutbox(),
      quotaLedger: aQuota,
      emitEvent: async () => {},
    });
    const bWiring = wireCrossHiveBoundary({
      workspaceId: 'ws-quota', potSlug: 'hive-b', hivePubkey: B.pubkey,
      transport: mesh(B.pubkey), signer: B.signer,
      requestPorts: { async openAsk() { return { ref: 'x' }; }, async createWorkRequest() { return { ref: 'x' }; } },
      loadGrants: async () => [],
      loadOutboundGrants: async () => [{ peerHivePubkey: A.pubkey, allowedKinds: ['ask', 'work-request'] }],
      outbox: new InMemoryCrossHiveOutbox(),
      quotaLedger: bQuota,
      emitEvent: async () => {},
    });
    return { A, B, aQuota, bQuota, opened, aWiring, bWiring };
  }

  it('an ADMITTED inbound request is ledgered as the C-1 `in` row', async () => {
    const t = twoHives();
    const r = await t.bWiring.send(t.A.pubkey, { kind: 'ask', subject: 'help?', body: 'with X', id: 'corr-1' });
    expect(r.delivered).toBe(true);
    expect(t.opened).toEqual(['help?']);
    expect(t.aQuota.inbound).toHaveLength(1);
    expect(t.aQuota.inbound[0]).toMatchObject({
      peerPubkey: t.B.pubkey,
      kind: 'ask',
      correlationId: 'corr-1',
      subject: 'help?',
      body: 'with X',
    });
  });

  it('an over-rate inbound request is REJECTED and NOT ledgered (no port touched)', async () => {
    const t = twoHives({ receiverGrant: (peer) => ({ peerHivePubkey: peer, allowedKinds: ['ask'], maxPerHour: 2 }) });
    await t.bWiring.send(t.A.pubkey, { kind: 'ask', subject: 'one', body: 'b' });
    await t.bWiring.send(t.A.pubkey, { kind: 'ask', subject: 'two', body: 'b' });
    await t.bWiring.send(t.A.pubkey, { kind: 'ask', subject: 'three', body: 'b' });
    // The third arrival sees recentFromPeerCount=2 ≥ cap → rejected at the boundary.
    expect(t.opened).toEqual(['one', 'two']);
    expect(t.aQuota.inbound).toHaveLength(2);
  });

  it('an oversize inbound body is rejected by the receiver grant cap', async () => {
    const t = twoHives({ receiverGrant: (peer) => ({ peerHivePubkey: peer, allowedKinds: ['ask'], maxBodyBytes: 8 }) });
    await t.bWiring.send(t.A.pubkey, { kind: 'ask', subject: 'big', body: 'way more than eight bytes' });
    expect(t.opened).toEqual([]);
    expect(t.aQuota.inbound).toHaveLength(0);
  });

  it('our REPLY settles the inbound row (best-effort ledger symmetry)', async () => {
    const t = twoHives();
    await t.bWiring.send(t.A.pubkey, { kind: 'ask', subject: 'q', body: 'b', id: 'corr-9' });
    expect(t.aQuota.inbound).toHaveLength(1);
    // A answers B's ask — the reply rides corr-9 and settles A's `in` row.
    const r = await t.aWiring.reply(t.B.pubkey, {
      kind: 'answer',
      subject: 're: q',
      body: 'here you go',
      correlationId: 'corr-9',
    });
    expect(r.denied).toBeUndefined(); // replies are never grant/quota-gated
    expect(t.aQuota.settled).toEqual([
      { correlationId: 'corr-9', peerPubkey: t.B.pubkey, replyKind: 'answer', replyBody: 'here you go' },
    ]);
  });

  it('an outbound request over the egress rate cap is denied before any send', async () => {
    const t = twoHives();
    t.bQuota.outboundCount = DEFAULT_CROSS_HIVE_MAX_PER_HOUR;
    const r = await t.bWiring.send(t.A.pubkey, { kind: 'ask', subject: 's', body: 'b' });
    expect(r.denied).toBe(true);
    expect(r.reason).toMatch(/rate cap/i);
    expect(t.opened).toEqual([]);
  });

  it('an outbound oversize body is denied before any send (default cap)', async () => {
    const t = twoHives();
    const r = await t.bWiring.send(t.A.pubkey, {
      kind: 'ask',
      subject: 's',
      body: 'x'.repeat(DEFAULT_CROSS_HIVE_MAX_BODY_BYTES + 1),
    });
    expect(r.denied).toBe(true);
    expect(r.reason).toMatch(/exceeds/);
    expect(t.opened).toEqual([]);
  });
});
