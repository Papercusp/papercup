/**
 * cross-hive-transport-robustness.test.ts — robustness + canonicalization coverage for
 * the signed wire layer (cross-hive-transport.ts), complementing cross-hive-transport.test.ts.
 *
 * Locks the contract edges the happy-path suite leaves open:
 *  - verifyCrossHiveEnvelope must NEVER throw on malformed input (garbage sig/pubkey) —
 *    it is fed attacker-controlled bytes off the wire.
 *  - the signed bytes are CANONICAL: stable across field insertion order (sender and
 *    receiver must agree) and they COVER correlationId, so a reply cannot be re-pointed
 *    at a different ask without breaking the signature.
 *  - store-and-forward survives PARTIAL failure (some peers up, some down) and the
 *    outbox dedups by envelope id.
 *  - the request/reply partition (isRequestKind) — the gate that decides what goes
 *    through grant admission vs what is surfaced as a correlated reply.
 */
import { describe, expect, it, vi } from 'vitest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from './identity/ed25519';
import type { CrossHiveGrant, CrossHiveBoundaryPorts } from './cross-hive-boundary';
import {
  signCrossHiveEnvelope,
  verifyCrossHiveEnvelope,
  crossHiveSigningBytes,
  flushCrossHiveOutbox,
  receiveCrossHive,
  isRequestKind,
  InMemoryCrossHiveOutbox,
  type CrossHiveEnvelopeBody,
  type CrossHiveWireEnvelope,
  type CrossHiveTransport,
  type CrossHiveWireKind,
} from './cross-hive-transport';

function makeHive() {
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  return { pubkey: pubkeyBase64, signer: async (bytes: Buffer) => signWithPrivateKeyDer(privateKeyDer, bytes) };
}

const A = makeHive();
const B = makeHive();

const body = (over: Partial<CrossHiveEnvelopeBody> = {}): CrossHiveEnvelopeBody => ({
  id: 'env-1',
  fromHivePubkey: A.pubkey,
  toHivePubkey: B.pubkey,
  kind: 'ask',
  subject: 'review our auth schema?',
  body: 'details',
  ...over,
});

const grants = (kinds: CrossHiveGrant['allowedKinds']): CrossHiveGrant[] => [
  { peerHivePubkey: A.pubkey, allowedKinds: kinds },
];

function fakePorts(): CrossHiveBoundaryPorts & { openAsk: ReturnType<typeof vi.fn>; createWorkRequest: ReturnType<typeof vi.fn> } {
  return {
    openAsk: vi.fn(async () => ({ ref: 'conv-1' })),
    createWorkRequest: vi.fn(async () => ({ ref: 'WI-1' })),
  } as never;
}

describe('verifyCrossHiveEnvelope — never throws on malformed input', () => {
  it('returns false (no throw) for a non-base64 garbage signature', async () => {
    const env = await signCrossHiveEnvelope(body(), A.signer);
    let result!: boolean;
    expect(() => {
      result = verifyCrossHiveEnvelope({ ...env, sig: '!!!not base64!!!' });
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it('returns false (no throw) for a garbage fromHivePubkey that is not a valid key', async () => {
    const env = await signCrossHiveEnvelope(body(), A.signer);
    let result!: boolean;
    expect(() => {
      result = verifyCrossHiveEnvelope({ ...env, fromHivePubkey: 'not-a-real-pubkey' });
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it('returns false for an empty fromHivePubkey (decodes to 0 bytes, not 32)', async () => {
    const env = await signCrossHiveEnvelope(body(), A.signer);
    expect(verifyCrossHiveEnvelope({ ...env, fromHivePubkey: '' })).toBe(false);
  });

  it('returns false for a well-formed-base64 but wrong-length signature', async () => {
    const env = await signCrossHiveEnvelope(body(), A.signer);
    // 8 bytes of valid base64 — parses fine, but is not a 64-byte Ed25519 sig.
    expect(verifyCrossHiveEnvelope({ ...env, sig: Buffer.alloc(8, 1).toString('base64') })).toBe(false);
  });

  it('returns false when sig is missing/empty', async () => {
    const env = await signCrossHiveEnvelope(body(), A.signer);
    expect(verifyCrossHiveEnvelope({ ...env, sig: '' })).toBe(false);
    expect(verifyCrossHiveEnvelope({ ...(env as object), sig: undefined } as CrossHiveWireEnvelope)).toBe(false);
  });
});

describe('crossHiveSigningBytes — canonical + covers correlationId', () => {
  it('is independent of field insertion order (sender and receiver compute identical bytes)', () => {
    const a = crossHiveSigningBytes({
      id: 'x', fromHivePubkey: 'F', toHivePubkey: 'T', kind: 'ask', subject: 's', body: 'b',
    });
    // Same fields, different literal order.
    const b = crossHiveSigningBytes({
      body: 'b', subject: 's', kind: 'ask', toHivePubkey: 'T', fromHivePubkey: 'F', id: 'x',
    });
    expect(a.equals(b)).toBe(true);
  });

  it('an absent correlationId equals an explicit undefined correlationId, and differs from a present one', () => {
    const absent = crossHiveSigningBytes(body({ kind: 'answer' }));
    const explicitUndef = crossHiveSigningBytes(body({ kind: 'answer', correlationId: undefined }));
    const present = crossHiveSigningBytes(body({ kind: 'answer', correlationId: 'env-1' }));
    expect(absent.equals(explicitUndef)).toBe(true);
    expect(absent.equals(present)).toBe(false);
  });

  it('a signed reply cannot have its correlationId re-pointed without breaking the signature', async () => {
    const env = await signCrossHiveEnvelope(
      body({ id: 'reply-1', kind: 'answer', subject: 'here', correlationId: 'env-1' }),
      A.signer,
    );
    expect(verifyCrossHiveEnvelope(env)).toBe(true);
    expect(verifyCrossHiveEnvelope({ ...env, correlationId: 'env-99' })).toBe(false);
  });
});

describe('flushCrossHiveOutbox — partial failure + recovery', () => {
  function transport(downIds: Set<string>): CrossHiveTransport & { sent: string[] } {
    const sent: string[] = [];
    return {
      sent,
      async send(_to: string, env: CrossHiveWireEnvelope) {
        if (downIds.has(env.id)) throw new Error(`peer for ${env.id} offline`);
        sent.push(env.id);
      },
      subscribe() {},
    } as never;
  }
  const wire = (id: string): CrossHiveWireEnvelope => ({ ...body({ id }), sig: 'x' });

  it('delivers the reachable envelopes and leaves the unreachable one queued', async () => {
    const outbox = new InMemoryCrossHiveOutbox();
    await outbox.enqueue(wire('env-1'));
    await outbox.enqueue(wire('env-2'));
    await outbox.enqueue(wire('env-3'));

    const down = new Set(['env-2']);
    const t = transport(down);
    const r1 = await flushCrossHiveOutbox({ transport: t, outbox });
    expect(r1).toEqual({ delivered: 2, pending: 1 });
    expect(t.sent.sort()).toEqual(['env-1', 'env-3']);
    expect((await outbox.pending()).map((e) => e.id)).toEqual(['env-2']);

    // Peer recovers → a later flush drains the remaining one.
    down.delete('env-2');
    const r2 = await flushCrossHiveOutbox({ transport: t, outbox });
    expect(r2).toEqual({ delivered: 1, pending: 0 });
  });
});

describe('InMemoryCrossHiveOutbox — id-keyed dedup', () => {
  it('enqueuing the same id twice keeps a single entry (last write wins)', async () => {
    const outbox = new InMemoryCrossHiveOutbox();
    await outbox.enqueue({ ...body({ id: 'env-1', subject: 'first' }), sig: 'x' });
    await outbox.enqueue({ ...body({ id: 'env-1', subject: 'second' }), sig: 'x' });
    const pending = await outbox.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0].subject).toBe('second');
  });

  it('markDelivered removes the entry; marking an unknown id is a no-op', async () => {
    const outbox = new InMemoryCrossHiveOutbox();
    await outbox.enqueue({ ...body({ id: 'env-1' }), sig: 'x' });
    await outbox.markDelivered('does-not-exist');
    expect(await outbox.pending()).toHaveLength(1);
    await outbox.markDelivered('env-1');
    expect(await outbox.pending()).toHaveLength(0);
  });
});

describe('receiveCrossHive — reply + work-request dispatch edges', () => {
  const deps = (over: Partial<Parameters<typeof receiveCrossHive>[1]> = {}) => ({
    selfHivePubkey: B.pubkey,
    loadGrants: async () => grants(['ask', 'work-request']),
    requestPorts: fakePorts(),
    ...over,
  });

  it('surfaces a "decline" reply (the other reply kind) without touching the request ports', async () => {
    const env = await signCrossHiveEnvelope(
      body({ id: 'r1', kind: 'decline', subject: 'cannot help right now', correlationId: 'env-1' }),
      A.signer,
    );
    const ports = fakePorts();
    const r = await receiveCrossHive(env, deps({ requestPorts: ports }));
    expect(r).toMatchObject({ kind: 'reply', replyKind: 'decline', correlationId: 'env-1' });
    expect(ports.openAsk).not.toHaveBeenCalled();
    expect(ports.createWorkRequest).not.toHaveBeenCalled();
  });

  it('a reply with no correlationId surfaces correlationId: null', async () => {
    const env = await signCrossHiveEnvelope(body({ id: 'r2', kind: 'answer', subject: 'fyi' }), A.signer);
    const r = await receiveCrossHive(env, deps());
    expect(r).toMatchObject({ kind: 'reply', replyKind: 'answer', correlationId: null });
  });

  it('an admitted work-request request routes through the boundary to createWorkRequest', async () => {
    const env = await signCrossHiveEnvelope(body({ id: 'w1', kind: 'work-request', subject: 'add OAuth' }), A.signer);
    const ports = fakePorts();
    const r = await receiveCrossHive(env, deps({ requestPorts: ports }));
    expect(r).toMatchObject({ kind: 'request', route: { admitted: true, action: 'work_item', ref: 'WI-1' } });
    expect(ports.createWorkRequest).toHaveBeenCalledOnce();
    expect(ports.openAsk).not.toHaveBeenCalled();
  });
});

describe('isRequestKind — the grant-gating partition', () => {
  it('requests (grant-gated) are ask + work-request', () => {
    expect(isRequestKind('ask')).toBe(true);
    expect(isRequestKind('work-request')).toBe(true);
  });
  it('replies (correlated, NOT grant-gated) are answer + decline', () => {
    expect(isRequestKind('answer' as CrossHiveWireKind)).toBe(false);
    expect(isRequestKind('decline' as CrossHiveWireKind)).toBe(false);
  });
});
