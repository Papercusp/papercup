/**
 * cross-hive-e2e.test.ts — the full mediated cross-Hive round-trip, in-process
 * (cross-hive-boundary-2026-06-08 P-005). TWO sovereign Hives (A, B) connected by an
 * in-memory transport bus (the stand-in for the federation layer's hyperdht delivery,
 * which is P-011-proven across real machines). Proves end-to-end:
 *   ask → B verifies sig → admits per ITS grants → opens a conversation → answers →
 *   reply routed back to A, correlated to the original ask.
 * Plus the sovereignty boundary (an ungranted Hive's ask is rejected, no B-side object)
 * and store-and-forward (A's send to an offline B queues, then delivers on flush).
 *
 * The ONLY thing not exercised here is the literal cross-machine hyperdht transport
 * (the injected `Bus` replaces it); that leg is owner-budget-gated (cloud), like
 * shared-hive-federation P-011.
 */
import { describe, expect, it } from 'vitest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from './identity/ed25519';
import type { CrossHiveGrant } from './cross-hive-boundary';
import {
  signCrossHiveEnvelope,
  receiveCrossHive,
  sendCrossHive,
  flushCrossHiveOutbox,
  InMemoryCrossHiveOutbox,
  type CrossHiveWireEnvelope,
  type CrossHiveTransport,
} from './cross-hive-transport';

function makeHive() {
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  return { pubkey: pubkeyBase64, signer: async (b: Buffer) => signWithPrivateKeyDer(privateKeyDer, b) };
}

/** An in-memory point-to-point bus — registry of Hive-pubkey → inbound handler. */
class Bus {
  readonly handlers = new Map<string, (env: CrossHiveWireEnvelope) => Promise<void>>();
  register(pubkey: string, handler: (env: CrossHiveWireEnvelope) => Promise<void>) {
    this.handlers.set(pubkey, handler);
  }
  unregister(pubkey: string) {
    this.handlers.delete(pubkey);
  }
  transport(): CrossHiveTransport {
    return {
      send: async (to, env) => {
        const h = this.handlers.get(to);
        if (!h) throw new Error(`Hive ${to} unreachable`);
        await h(env);
      },
      subscribe: () => {},
    };
  }
}

describe('cross-Hive ask → answer round-trip (two sovereign Hives)', () => {
  it('A asks B; B admits per its grant, opens a conversation, and answers back to A', async () => {
    const A = makeHive();
    const B = makeHive();
    const bus = new Bus();
    const bConversations: CrossHiveWireEnvelope[] = [];
    const aReplies: { correlationId: string | null; body: string }[] = [];
    const bGrants: CrossHiveGrant[] = [{ peerHivePubkey: A.pubkey, allowedKinds: ['ask'] }];

    // B's boundary: verify → admit (its grants) → open a conversation → ANSWER back to A.
    bus.register(B.pubkey, async (env) => {
      const r = await receiveCrossHive(env, {
        selfHivePubkey: B.pubkey,
        loadGrants: async () => bGrants,
        requestPorts: {
          openAsk: async (e) => {
            bConversations.push(env);
            return { ref: `conv-${e.subject}` };
          },
          createWorkRequest: async () => ({ ref: 'WI' }),
        },
      });
      if ('kind' in r && r.kind === 'request' && r.route.admitted) {
        const answer = await signCrossHiveEnvelope(
          {
            id: `ans-${env.id}`,
            fromHivePubkey: B.pubkey,
            toHivePubkey: env.fromHivePubkey,
            kind: 'answer',
            subject: `RE: ${env.subject}`,
            body: 'reviewed — schema looks good',
            correlationId: env.id,
          },
          B.signer,
        );
        await bus.transport().send(answer.toHivePubkey, answer);
      }
    });

    // A's boundary: receive the reply, correlate it.
    bus.register(A.pubkey, async (env) => {
      const r = await receiveCrossHive(env, {
        selfHivePubkey: A.pubkey,
        loadGrants: async () => [],
        requestPorts: { openAsk: async () => ({ ref: 'x' }), createWorkRequest: async () => ({ ref: 'x' }) },
      });
      if ('kind' in r && r.kind === 'reply') aReplies.push({ correlationId: r.correlationId, body: r.body });
    });

    // A sends the ask.
    const ask = await signCrossHiveEnvelope(
      { id: 'ask-1', fromHivePubkey: A.pubkey, toHivePubkey: B.pubkey, kind: 'ask', subject: 'review auth schema', body: '...' },
      A.signer,
    );
    const sent = await sendCrossHive(ask, { transport: bus.transport(), outbox: new InMemoryCrossHiveOutbox() });

    expect(sent.delivered).toBe(true);
    // B admitted + opened exactly one conversation from A's ask.
    expect(bConversations.map((e) => e.id)).toEqual(['ask-1']);
    // A received B's answer, correlated to the original ask.
    expect(aReplies).toEqual([{ correlationId: 'ask-1', body: 'reviewed — schema looks good' }]);
  });

  it('an UNGRANTED Hive\'s ask is rejected — no B-side conversation, no answer', async () => {
    const B = makeHive();
    const C = makeHive(); // not in B's grants
    const bus = new Bus();
    const bConversations: string[] = [];
    let bAnswered = false;

    bus.register(B.pubkey, async (env) => {
      const r = await receiveCrossHive(env, {
        selfHivePubkey: B.pubkey,
        loadGrants: async () => [], // C has NO grant
        requestPorts: {
          openAsk: async (e) => {
            bConversations.push(e.subject);
            return { ref: 'conv' };
          },
          createWorkRequest: async () => ({ ref: 'WI' }),
        },
      });
      if ('kind' in r && r.kind === 'request' && r.route.admitted) bAnswered = true;
    });

    const ask = await signCrossHiveEnvelope(
      { id: 'ask-c', fromHivePubkey: C.pubkey, toHivePubkey: B.pubkey, kind: 'ask', subject: 'sneaky', body: '...' },
      C.signer,
    );
    await sendCrossHive(ask, { transport: bus.transport(), outbox: new InMemoryCrossHiveOutbox() });

    expect(bConversations).toEqual([]); // sovereignty held — nothing created
    expect(bAnswered).toBe(false);
  });

  it('store-and-forward: A\'s ask to an OFFLINE B queues, then delivers on flush', async () => {
    const A = makeHive();
    const B = makeHive();
    const bus = new Bus();
    const opened: string[] = [];

    const ask = await signCrossHiveEnvelope(
      { id: 'ask-sf', fromHivePubkey: A.pubkey, toHivePubkey: B.pubkey, kind: 'ask', subject: 'while you were out', body: '...' },
      A.signer,
    );
    const outbox = new InMemoryCrossHiveOutbox();

    // B is OFFLINE (not registered) — the send queues.
    const sent = await sendCrossHive(ask, { transport: bus.transport(), outbox });
    expect(sent).toEqual({ delivered: false, queued: true });
    expect(await outbox.pending()).toHaveLength(1);

    // B comes online + flush redelivers.
    bus.register(B.pubkey, async (env) => {
      await receiveCrossHive(env, {
        selfHivePubkey: B.pubkey,
        loadGrants: async () => [{ peerHivePubkey: A.pubkey, allowedKinds: ['ask'] }],
        requestPorts: { openAsk: async (e) => { opened.push(e.subject); return { ref: 'c' }; }, createWorkRequest: async () => ({ ref: 'w' }) },
      });
    });
    const flushed = await flushCrossHiveOutbox({ transport: bus.transport(), outbox });
    expect(flushed).toEqual({ delivered: 1, pending: 0 });
    expect(opened).toEqual(['while you were out']); // delivered + admitted after reconnect
  });
});
