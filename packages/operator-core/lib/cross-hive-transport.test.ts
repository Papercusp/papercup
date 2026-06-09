/**
 * cross-hive-transport.test.ts — the signed wire layer (cross-hive-boundary P-003/P-004).
 * Real Ed25519 signing/verification (node:crypto via the identity helpers); pure +
 * in-process (fake transport, in-memory outbox, fake boundary ports).
 */
import { describe, expect, it, vi } from 'vitest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from './identity/ed25519';
import type { CrossHiveGrant, CrossHiveBoundaryPorts } from './cross-hive-boundary';
import {
  signCrossHiveEnvelope,
  verifyCrossHiveEnvelope,
  sendCrossHive,
  flushCrossHiveOutbox,
  receiveCrossHive,
  InMemoryCrossHiveOutbox,
  type CrossHiveEnvelopeBody,
  type CrossHiveWireEnvelope,
  type CrossHiveTransport,
} from './cross-hive-transport';

function makeHive() {
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  return { pubkey: pubkeyBase64, signer: async (bytes: Buffer) => signWithPrivateKeyDer(privateKeyDer, bytes) };
}

const A = makeHive();
const B = makeHive();

const askBody = (over: Partial<CrossHiveEnvelopeBody> = {}): CrossHiveEnvelopeBody => ({
  id: 'env-1',
  fromHivePubkey: A.pubkey,
  toHivePubkey: B.pubkey,
  kind: 'ask',
  subject: 'review our auth schema?',
  body: 'details',
  ...over,
});

const grants = (kinds: CrossHiveGrant['allowedKinds']): CrossHiveGrant[] => [{ peerHivePubkey: A.pubkey, allowedKinds: kinds }];

function fakePorts(): CrossHiveBoundaryPorts & { openAsk: ReturnType<typeof vi.fn>; createWorkRequest: ReturnType<typeof vi.fn> } {
  return {
    openAsk: vi.fn(async () => ({ ref: 'conv-1' })),
    createWorkRequest: vi.fn(async () => ({ ref: 'WI-1' })),
  } as never;
}

describe('sign / verify', () => {
  it('a signed envelope verifies against the sender Hive pubkey', async () => {
    const env = await signCrossHiveEnvelope(askBody(), A.signer);
    expect(verifyCrossHiveEnvelope(env)).toBe(true);
  });

  it('a tampered BODY fails verification', async () => {
    const env = await signCrossHiveEnvelope(askBody(), A.signer);
    expect(verifyCrossHiveEnvelope({ ...env, body: 'tampered' })).toBe(false);
  });

  it('a forged sig (wrong key) fails verification', async () => {
    const env = await signCrossHiveEnvelope(askBody(), B.signer); // signed by B but claims from A
    expect(verifyCrossHiveEnvelope(env)).toBe(false);
  });
});

describe('store-and-forward (sendCrossHive + flush)', () => {
  function transport(fail: { now: boolean }): CrossHiveTransport & { sent: CrossHiveWireEnvelope[] } {
    const sent: CrossHiveWireEnvelope[] = [];
    return {
      sent,
      async send(_to, env) {
        if (fail.now) throw new Error('peer offline');
        sent.push(env);
      },
      subscribe() {},
    } as never;
  }

  it('delivers immediately when the peer is reachable', async () => {
    const env = await signCrossHiveEnvelope(askBody(), A.signer);
    const t = transport({ now: false });
    const outbox = new InMemoryCrossHiveOutbox();
    const r = await sendCrossHive(env, { transport: t, outbox });
    expect(r).toEqual({ delivered: true, queued: false });
    expect(t.sent).toHaveLength(1);
    expect(await outbox.pending()).toHaveLength(0);
  });

  it('queues when the peer is offline, then delivers on flush when it recovers', async () => {
    const env = await signCrossHiveEnvelope(askBody(), A.signer);
    const fail = { now: true };
    const t = transport(fail);
    const outbox = new InMemoryCrossHiveOutbox();

    const r = await sendCrossHive(env, { transport: t, outbox });
    expect(r).toEqual({ delivered: false, queued: true });
    expect(await outbox.pending()).toHaveLength(1); // durable: not lost

    fail.now = false; // peer comes back
    const flushed = await flushCrossHiveOutbox({ transport: t, outbox });
    expect(flushed).toEqual({ delivered: 1, pending: 0 });
    expect(t.sent).toHaveLength(1);
    expect(await outbox.pending()).toHaveLength(0);
  });
});

describe('receiveCrossHive — verify then dispatch', () => {
  const deps = (over: Partial<Parameters<typeof receiveCrossHive>[1]> = {}) => ({
    selfHivePubkey: B.pubkey,
    loadGrants: async () => grants(['ask', 'work-request']),
    requestPorts: fakePorts(),
    ...over,
  });

  it('an admitted ask request → routes to a conversation', async () => {
    const env = await signCrossHiveEnvelope(askBody(), A.signer);
    const d = deps();
    const r = await receiveCrossHive(env, d);
    expect(r).toMatchObject({ kind: 'request', route: { admitted: true, action: 'conversation', ref: 'conv-1' } });
    expect((d.requestPorts as ReturnType<typeof fakePorts>).openAsk).toHaveBeenCalledOnce();
  });

  it('a request from an UNGRANTED Hive → route rejected, no side effect', async () => {
    const env = await signCrossHiveEnvelope(askBody(), A.signer);
    const ports = fakePorts();
    const r = await receiveCrossHive(env, deps({ loadGrants: async () => [], requestPorts: ports }));
    expect(r).toMatchObject({ kind: 'request', route: { admitted: false } });
    expect(ports.openAsk).not.toHaveBeenCalled();
  });

  it('rejects a bad signature before any dispatch', async () => {
    const env = await signCrossHiveEnvelope(askBody(), A.signer);
    const ports = fakePorts();
    const r = await receiveCrossHive({ ...env, body: 'tampered' }, deps({ requestPorts: ports }));
    expect(r).toEqual({ ok: false, reason: 'signature verification failed' });
    expect(ports.openAsk).not.toHaveBeenCalled();
  });

  it('rejects an envelope not addressed to this Hive', async () => {
    const env = await signCrossHiveEnvelope(askBody({ toHivePubkey: 'someone-else' }), A.signer);
    const r = await receiveCrossHive(env, deps());
    expect(r).toEqual({ ok: false, reason: 'envelope not addressed to this Hive' });
  });

  it('a reply (answer) is surfaced with its correlation id, not routed through grants', async () => {
    const env = await signCrossHiveEnvelope(
      askBody({ id: 'reply-1', kind: 'answer', subject: 'here is the review', correlationId: 'env-1' }),
      A.signer,
    );
    const ports = fakePorts();
    const r = await receiveCrossHive(env, deps({ requestPorts: ports }));
    expect(r).toMatchObject({ kind: 'reply', replyKind: 'answer', correlationId: 'env-1' });
    expect(ports.openAsk).not.toHaveBeenCalled(); // replies don't translate through the request ports
  });
});
