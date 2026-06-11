/**
 * cross-hive-reply-persistence.test.ts — the durable receive-side reply path
 * (hive-network-surface-2026-06-11 P-002, brief B-03).
 *
 * An inbound answer/decline must PERSIST (C-1 transition on the originating OUT
 * ask) and EMIT (the C-4 event `cross-hive:answered|declined:<correlationId>`,
 * payload = the ledger row) — the ephemeral onReply callback is a test-only
 * observer, no longer the production path. Unit-level: fake mesh transport,
 * in-memory C-1 ledger, recorded emit port. The real-PG + real-await-store leg
 * lives in cross-hive-reply-events.integration.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import {
  InMemoryCrossHiveAskLedger,
  InMemoryCrossHiveOutbox,
  crossHiveReplyEventKey,
  type CrossHiveAskRow,
  type CrossHiveTransport,
  type CrossHiveWireEnvelope,
} from './cross-hive-transport';
import { wireCrossHiveBoundary, type CrossHiveInboundReply } from './cross-hive-wiring';
import type { EmitAwaitedEventOpts } from './events/await/engine';

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
    async send(toHivePubkey, env) {
      const h = subs.get(toHivePubkey);
      if (!h) throw new Error(`mesh: no peer ${toHivePubkey}`);
      await h(env);
    },
  });
}

const WS = 'ws-reply-unit';

function outAsk(correlationId: string, peerPubkey: string, over: Partial<CrossHiveAskRow> = {}): CrossHiveAskRow {
  const now = new Date().toISOString();
  return {
    workspaceId: WS,
    hiveSlug: 'hive-a',
    id: `uuid-${correlationId}`,
    peerPubkey,
    direction: 'out',
    kind: 'ask',
    subject: 'can you help',
    body: 'with X?',
    correlationId,
    state: 'sent',
    replyBody: null,
    replyTs: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe('InMemoryCrossHiveAskLedger — the C-1 reference state machine', () => {
  const B = 'peer-pubkey-b64';

  it('transitions sent → answered with the reply persisted', async () => {
    const ledger = new InMemoryCrossHiveAskLedger();
    ledger.seed(outAsk('ask-1', B));
    const res = await ledger.recordReply({ correlationId: 'ask-1', replyKind: 'answer', replyBody: 'yes', peerPubkey: B });
    expect(res.outcome).toBe('transitioned');
    if (res.outcome !== 'transitioned') return;
    expect(res.row.state).toBe('answered');
    expect(res.row.replyBody).toBe('yes');
    expect(res.row.replyTs).not.toBeNull();
  });

  it('transitions queued → declined (a reply can land before the sent flip)', async () => {
    const ledger = new InMemoryCrossHiveAskLedger();
    ledger.seed(outAsk('ask-2', B, { state: 'queued' }));
    const res = await ledger.recordReply({ correlationId: 'ask-2', replyKind: 'decline', replyBody: 'no', peerPubkey: B });
    expect(res.outcome).toBe('transitioned');
    if (res.outcome !== 'transitioned') return;
    expect(res.row.state).toBe('declined');
  });

  it('a second reply is already-settled (dup deliveries never re-transition)', async () => {
    const ledger = new InMemoryCrossHiveAskLedger();
    ledger.seed(outAsk('ask-3', B));
    await ledger.recordReply({ correlationId: 'ask-3', replyKind: 'answer', replyBody: 'yes', peerPubkey: B });
    const dup = await ledger.recordReply({ correlationId: 'ask-3', replyKind: 'decline', replyBody: 'no', peerPubkey: B });
    expect(dup.outcome).toBe('already-settled');
    expect(ledger.get('ask-3')!.state).toBe('answered'); // the first reply won
  });

  it('not-found: unknown correlation, a third-party peer, and an IN row', async () => {
    const ledger = new InMemoryCrossHiveAskLedger();
    ledger.seed(outAsk('ask-4', B));
    ledger.seed(outAsk('ask-in', B, { direction: 'in' }));
    const unknown = await ledger.recordReply({ correlationId: 'nope', replyKind: 'answer', replyBody: 'x', peerPubkey: B });
    const impostor = await ledger.recordReply({ correlationId: 'ask-4', replyKind: 'answer', replyBody: 'x', peerPubkey: 'someone-else' });
    const inbound = await ledger.recordReply({ correlationId: 'ask-in', replyKind: 'answer', replyBody: 'x', peerPubkey: B });
    expect(unknown.outcome).toBe('not-found');
    expect(impostor.outcome).toBe('not-found');
    expect(inbound.outcome).toBe('not-found');
  });
});

describe('crossHiveReplyEventKey — the C-4 keys', () => {
  it('maps answer→answered and decline→declined', () => {
    expect(crossHiveReplyEventKey('answer', 'abc')).toBe('cross-hive:answered:abc');
    expect(crossHiveReplyEventKey('decline', 'abc')).toBe('cross-hive:declined:abc');
  });
});

describe('wiring reply path — persist + emit is the production path (B-03)', () => {
  function twoHives(opts: { askedBy?: string | null; emitThrows?: boolean } = {}) {
    const A = hiveIdentity();
    const B = hiveIdentity();
    const mesh = makeTransportMesh();
    const ledger = new InMemoryCrossHiveAskLedger();
    const emits: EmitAwaitedEventOpts[] = [];
    const replies: CrossHiveInboundReply[] = [];

    ledger.seed(outAsk('ask-1', B.pubkey, opts.askedBy !== undefined ? { askedBy: opts.askedBy } : {}));

    wireCrossHiveBoundary({
      workspaceId: WS, hiveSlug: 'hive-a', hivePubkey: A.pubkey,
      transport: mesh(A.pubkey), signer: A.signer,
      requestPorts: { async openAsk() { return { ref: 'x' }; }, async createWorkRequest() { return { ref: 'x' }; } },
      loadGrants: async () => [],
      outbox: new InMemoryCrossHiveOutbox(),
      askLedger: ledger,
      emitEvent: async (o) => {
        emits.push(o);
        if (opts.emitThrows) throw new Error('emit down');
      },
      onReply: (r) => replies.push(r),
    });
    const bWiring = wireCrossHiveBoundary({
      workspaceId: WS, hiveSlug: 'hive-b', hivePubkey: B.pubkey,
      transport: mesh(B.pubkey), signer: B.signer,
      requestPorts: { async openAsk() { return { ref: 'x' }; }, async createWorkRequest() { return { ref: 'x' }; } },
      loadGrants: async () => [],
      outbox: new InMemoryCrossHiveOutbox(),
      emitEvent: async () => {},
    });
    return { A, B, ledger, emits, replies, bWiring };
  }

  it('answer → row answered + C-4 emit with the ledger row as payload', async () => {
    const t = twoHives();
    const r = await t.bWiring.reply(t.A.pubkey, { kind: 'answer', subject: 're: help', body: 'yes', correlationId: 'ask-1' });
    expect(r.delivered).toBe(true);
    expect(t.ledger.get('ask-1')!.state).toBe('answered');
    expect(t.emits).toHaveLength(1);
    expect(t.emits[0].key).toBe('cross-hive:answered:ask-1');
    expect(t.emits[0].payload).toMatchObject({ correlationId: 'ask-1', state: 'answered', replyBody: 'yes' });
    expect(t.emits[0].workspaceId).toBe(WS);
    expect(t.emits[0].source).toBe('cross-hive:hive-a');
    expect(t.emits[0].to).toBeUndefined(); // no askedBy on the row → no notify audience
    expect(t.replies).toHaveLength(1); // the test-only observer still fires
  });

  it('decline → declined key', async () => {
    const t = twoHives();
    await t.bWiring.reply(t.A.pubkey, { kind: 'decline', subject: 're: help', body: 'busy', correlationId: 'ask-1' });
    expect(t.ledger.get('ask-1')!.state).toBe('declined');
    expect(t.emits[0].key).toBe('cross-hive:declined:ask-1');
  });

  it('askedBy on the row → the emit coord-notifies the asking owner', async () => {
    const t = twoHives({ askedBy: 'su-queen-1' });
    await t.bWiring.reply(t.A.pubkey, { kind: 'answer', subject: 're', body: 'yes', correlationId: 'ask-1' });
    expect(t.emits[0].to).toEqual(['su-queen-1']);
  });

  it('a dup delivery does NOT re-emit (already-settled)', async () => {
    const t = twoHives();
    await t.bWiring.reply(t.A.pubkey, { kind: 'answer', subject: 're', body: 'yes', correlationId: 'ask-1' });
    await t.bWiring.reply(t.A.pubkey, { kind: 'answer', subject: 're', body: 'yes', correlationId: 'ask-1' });
    expect(t.emits).toHaveLength(1);
  });

  it('an unmatched correlationId never emits (spoof guard) — but the test observer still sees it', async () => {
    const t = twoHives();
    await t.bWiring.reply(t.A.pubkey, { kind: 'answer', subject: 'forged', body: 'gotcha', correlationId: 'never-asked' });
    expect(t.emits).toHaveLength(0);
    expect(t.replies).toHaveLength(1);
  });

  it('an emit failure is contained — the row is persisted and the loop survives', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const t = twoHives({ emitThrows: true });
      const r = await t.bWiring.reply(t.A.pubkey, { kind: 'answer', subject: 're', body: 'yes', correlationId: 'ask-1' });
      expect(r.delivered).toBe(true); // the inbound handler did not poison the transport
      expect(t.ledger.get('ask-1')!.state).toBe('answered'); // durable truth survives the lost emit
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('C-4 emit failed'));
    } finally {
      warn.mockRestore();
    }
  });
});
