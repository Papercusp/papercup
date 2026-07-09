/**
 * cross-hive-outbound-grants.test.ts — the OUTBOUND (egress) grant direction
 * (hive-network-surface-2026-06-11 P-004, brief B-05). Pure, no PG:
 *
 *   1. admitOutboundCrossHive — the egress twin of admitCrossHiveEnvelope: default-deny,
 *      allow-list, per-peer + per-kind.
 *   2. toDirectedGrantMap — parses the stored grant value; legacy flat shape reads as
 *      INBOUND-only (back-compat), the directed shape splits in/out, and a peer literally
 *      named `in`/`out` is never mistaken for the directed envelope.
 *   3. The send-path chokepoint in wireCrossHiveBoundary: an ungranted outbound REQUEST is
 *      DENIED before any enqueue/sign/send; a granted one is delivered; a reply
 *      (answer/decline) bypasses the egress gate entirely.
 */
import { describe, expect, it } from 'vitest';
import { admitOutboundCrossHive, type CrossHiveGrant } from './cross-hive-boundary';
import { toDirectedGrantMap } from './cross-hive-grants';
import { InMemoryCrossHiveOutbox, type CrossHiveTransport, type CrossHiveWireEnvelope } from './cross-hive-transport';
import { InMemoryCrossHiveQuotaLedger, wireCrossHiveBoundary } from './cross-hive-wiring';

const PEER = 'peer-hive-pubkey-b64';
const OTHER = 'other-hive-pubkey-b64';

describe('admitOutboundCrossHive (egress default-deny)', () => {
  const grants: CrossHiveGrant[] = [{ peerHivePubkey: PEER, allowedKinds: ['ask'] }];

  it('admits a granted peer for a granted kind', () => {
    const a = admitOutboundCrossHive({ toHivePubkey: PEER, kind: 'ask' }, { grants });
    expect(a.admitted).toBe(true);
  });

  it('denies a granted peer for an UNgranted kind', () => {
    const a = admitOutboundCrossHive({ toHivePubkey: PEER, kind: 'work-request' }, { grants });
    expect(a.admitted).toBe(false);
    expect(a.reason).toContain('work-request');
  });

  it('denies an unknown peer (no grant at all) — the owner must add it first', () => {
    const a = admitOutboundCrossHive({ toHivePubkey: OTHER, kind: 'ask' }, { grants });
    expect(a.admitted).toBe(false);
    expect(a.reason).toMatch(/no outbound grant/i);
  });

  it('denies everything when there are no grants', () => {
    expect(admitOutboundCrossHive({ toHivePubkey: PEER, kind: 'ask' }, { grants: [] }).admitted).toBe(false);
  });
});

describe('toDirectedGrantMap (storage shape + back-compat)', () => {
  // P-013: GrantMap values are ENTRY OBJECTS `{ kinds, maxPerHour?, maxBodyBytes?,
  // expiresAt? }`; a bare kinds ARRAY (any pre-P-013 write) parses as `{ kinds }`.
  it('parses the directed shape, splitting in/out (bare-array entries upgrade)', () => {
    const d = toDirectedGrantMap({ in: { [PEER]: ['ask'] }, out: { [OTHER]: ['ask', 'work-request'] } });
    expect(d.in).toEqual({ [PEER]: { kinds: ['ask'] } });
    expect(d.out).toEqual({ [OTHER]: { kinds: ['ask', 'work-request'] } });
  });

  it('parses P-013 entry objects, keeping quota knobs and dropping junk fields', () => {
    const d = toDirectedGrantMap({
      in: {
        [PEER]: { kinds: ['ask'], maxPerHour: 5, maxBodyBytes: 1024, expiresAt: 1770000000000 },
        [OTHER]: { kinds: ['work-request'], maxPerHour: -3, maxBodyBytes: 'big', extra: true },
      },
    });
    expect(d.in[PEER]).toEqual({ kinds: ['ask'], maxPerHour: 5, maxBodyBytes: 1024, expiresAt: 1770000000000 });
    // Junk quota values are dropped (defaults apply at admission), kinds survive.
    expect(d.in[OTHER]).toEqual({ kinds: ['work-request'] });
  });

  it('reads a LEGACY flat value as INBOUND-only (no outbound)', () => {
    const d = toDirectedGrantMap({ [PEER]: ['ask'], [OTHER]: ['work-request'] });
    expect(d.in).toEqual({ [PEER]: { kinds: ['ask'] }, [OTHER]: { kinds: ['work-request'] } });
    expect(d.out).toEqual({});
  });

  it('tolerates a half-directed value (only out present)', () => {
    const d = toDirectedGrantMap({ out: { [PEER]: ['ask'] } });
    expect(d.in).toEqual({});
    expect(d.out).toEqual({ [PEER]: { kinds: ['ask'] } });
  });

  it('drops junk kinds and empty peers', () => {
    const d = toDirectedGrantMap({ in: { [PEER]: ['ask', 'nope'], junk: [], also: 'bad' } });
    expect(d.in).toEqual({ [PEER]: { kinds: ['ask'] } });
  });

  it('does NOT mistake a legacy peer named "in"/"out" for the directed envelope', () => {
    // A legacy flat map whose peers happen to be named in/out carries ARRAY values,
    // not sub-maps — so it stays legacy-inbound, not split as directed.
    const d = toDirectedGrantMap({ in: ['ask'], out: ['work-request'] });
    expect(d.in).toEqual({ in: { kinds: ['ask'] }, out: { kinds: ['work-request'] } });
    expect(d.out).toEqual({});
  });

  it('returns empty for non-object junk', () => {
    expect(toDirectedGrantMap(null)).toEqual({ in: {}, out: {} });
    expect(toDirectedGrantMap('nope')).toEqual({ in: {}, out: {} });
    expect(toDirectedGrantMap([1, 2, 3])).toEqual({ in: {}, out: {} });
  });
});

/** A capturing transport: records every wire envelope it is asked to deliver. */
function capturingTransport(): { transport: CrossHiveTransport; sent: CrossHiveWireEnvelope[] } {
  const sent: CrossHiveWireEnvelope[] = [];
  return {
    sent,
    transport: {
      subscribe() {},
      async send(_to, env) {
        sent.push(env);
      },
    },
  };
}

describe('wireCrossHiveBoundary send-path egress gate (the chokepoint, no PG)', () => {
  const baseDeps = (loadOutboundGrants: () => Promise<readonly CrossHiveGrant[]>) => {
    const { transport, sent } = capturingTransport();
    const wiring = wireCrossHiveBoundary({
      workspaceId: 'ws',
      potSlug: 'me',
      hivePubkey: 'my-pubkey',
      transport,
      signer: async () => Buffer.from('sig'),
      loadGrants: async () => [],
      loadOutboundGrants,
      // Inbound path is unused here, but the wiring eagerly builds its ports.
      requestPorts: { async openAsk() { return { ref: 'x' }; }, async createWorkRequest() { return { ref: 'x' }; } },
      outbox: new InMemoryCrossHiveOutbox(),
      quotaLedger: new InMemoryCrossHiveQuotaLedger(),
    });
    return { wiring, sent };
  };

  it('DENIES an outbound request to a peer with no out grant — nothing is signed or sent', async () => {
    const { wiring, sent } = baseDeps(async () => []);
    const r = await wiring.send(PEER, { kind: 'ask', subject: 's', body: 'b' });
    expect(r.denied).toBe(true);
    expect(r.delivered).toBe(false);
    expect(r.queued).toBe(false);
    expect(r.reason).toMatch(/no outbound grant/i);
    expect(sent).toHaveLength(0); // never touched the transport
  });

  it('DENIES an ungranted KIND even when the peer has another kind granted', async () => {
    const { wiring, sent } = baseDeps(async () => [{ peerHivePubkey: PEER, allowedKinds: ['ask'] }]);
    const r = await wiring.send(PEER, { kind: 'work-request', subject: 's', body: 'b' });
    expect(r.denied).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('ALLOWS an outbound request once the owner grants the peer the kind', async () => {
    const { wiring, sent } = baseDeps(async () => [{ peerHivePubkey: PEER, allowedKinds: ['ask', 'work-request'] }]);
    const r = await wiring.send(PEER, { kind: 'work-request', subject: 's', body: 'b' });
    expect(r.denied).toBeFalsy();
    expect(r.delivered).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ toHivePubkey: PEER, kind: 'work-request' });
  });

  it('a REPLY (answer/decline) bypasses the egress gate entirely', async () => {
    // No outbound grants at all — a reply must still go out (it rides the originating ask).
    const { wiring, sent } = baseDeps(async () => []);
    const r = await wiring.reply(PEER, { kind: 'answer', subject: 're', body: 'yes', correlationId: 'ask-1' });
    expect(r.denied).toBeFalsy();
    expect(r.delivered).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'answer', correlationId: 'ask-1' });
  });
});
