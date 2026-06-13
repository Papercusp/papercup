/**
 * authority-rpc-swarm-transport.test.ts — unit tests for the option-(c) RPC
 * transport over the Hyperswarm connection (shared-hive-hardening-2026-06-13
 * P-001 / D-005). A controllable fake swarm + fake Protomux (injected via the
 * `protomux` opt — the same seam cross-hive-swarm-transport.test.ts mocks) drive
 * the connect → pair → hello → req → res lifecycle without a real socket.
 *
 * Pins: a channel + HELLO per connection; HELLO sets the remote device pubkey;
 * rpc() routes ONLY to the channel whose remote matches (no broadcast); the
 * HTTP-parity error map (no channel / timeout / not_authority → PeerUnreachable;
 * handler_error → real Error); inbound req → dispatch → res; channel-close +
 * transport-close reject in-flight requests; retroactive attach to existing
 * connections; the outgoing op is device-signed when a signer is configured.
 */
import { describe, it, expect } from 'vitest';
import {
  makeAuthorityRpcSwarmTransport,
  AUTHORITY_RPC_PROTOCOL,
  type AuthorityRpcDispatch,
} from '../authority-rpc-swarm-transport';
import { PeerUnreachableError } from '../peer-rpc-transport';
import type { PeerRef } from '../lock-authority';
import { verifyAuthorityRpc, signAuthorityRpcWithPrivateKeyDer } from '../authority-rpc-envelope';
import { generateEd25519KeypairDer } from '../../identity/ed25519';

// ── Fake Protomux (one channel per connection) — the cross-hive test shape ──
interface FakeChannel {
  protocol: string;
  onopen?: () => void;
  onclose?: () => void;
  sent: any[];
  inbound?: (frame: unknown) => void;
  /** When linked to a peer channel, an outgoing frame is also delivered there
   *  (loopback). */
  linkedTo: FakeChannel | null;
  open(): void;
  addMessage(m: { onmessage?: (f: unknown) => void }): { send(v: unknown): void };
  /** Test helper: simulate the remote opening the matching protocol → onopen. */
  pair(): void;
  /** Test helper: simulate an inbound frame from the peer. */
  deliver(frame: unknown): void;
  fireClose(): void;
}

function makeFakeProtomux() {
  const created: FakeChannel[] = [];
  const protomux = {
    from(_socket: unknown) {
      return {
        createChannel(spec: { protocol: string; onopen?: () => void; onclose?: () => void }): FakeChannel {
          const ch: FakeChannel = {
            protocol: spec.protocol,
            onopen: spec.onopen,
            onclose: spec.onclose,
            sent: [],
            inbound: undefined,
            linkedTo: null,
            open() {},
            addMessage(m) {
              ch.inbound = m.onmessage;
              return {
                send(v: unknown) {
                  ch.sent.push(v);
                  if (ch.linkedTo) {
                    const peer = ch.linkedTo;
                    queueMicrotask(() => peer.inbound?.(v));
                  }
                },
              };
            },
            pair() {
              this.onopen?.();
            },
            deliver(frame: unknown) {
              this.inbound?.(frame);
            },
            fireClose() {
              this.onclose?.();
            },
          };
          created.push(ch);
          return ch;
        },
      };
    },
  };
  return { protomux, created };
}

function makeFakeSwarm(connections: unknown[] = []) {
  let handler: ((socket: unknown) => void) | null = null;
  return {
    swarm: {
      on(_e: 'connection', l: (s: unknown) => void) {
        handler = l;
      },
      off() {
        handler = null;
      },
      join() {
        return {};
      },
      leave() {},
      connections,
    },
    connect(socket: unknown = {}) {
      handler?.(socket);
    },
    get handler() {
      return handler;
    },
  };
}

const peer = (devicePubkey: string, machineLabel = devicePubkey): PeerRef =>
  ({ devicePubkey, machineLabel } as PeerRef);

const SELF = 'self-device-pubkey';
const REMOTE = 'remote-device-pubkey';

describe('makeAuthorityRpcSwarmTransport — construction + channel', () => {
  it('registers a connection handler and opens an authority-rpc channel per connection', () => {
    const f = makeFakeSwarm();
    const p = makeFakeProtomux();
    makeAuthorityRpcSwarmTransport({ swarm: f.swarm, selfDevicePubkey: SELF, protomux: p.protomux });
    expect(f.handler).toBeTypeOf('function');
    f.connect();
    expect(p.created).toHaveLength(1);
    expect(p.created[0].protocol).toBe(AUTHORITY_RPC_PROTOCOL);
  });

  it('sends our HELLO (device_pubkey) when the channel pairs', () => {
    const f = makeFakeSwarm();
    const p = makeFakeProtomux();
    makeAuthorityRpcSwarmTransport({ swarm: f.swarm, selfDevicePubkey: SELF, protomux: p.protomux });
    f.connect();
    p.created[0].pair();
    expect(p.created[0].sent).toEqual([{ t: 'hello', device_pubkey: SELF }]);
  });

  it('retroactively attaches to connections that already exist', () => {
    const f = makeFakeSwarm([{}, {}]);
    const p = makeFakeProtomux();
    const t = makeAuthorityRpcSwarmTransport({ swarm: f.swarm, selfDevicePubkey: SELF, protomux: p.protomux });
    expect(t.connectionCount).toBe(2);
    expect(p.created).toHaveLength(2);
  });
});

describe('makeAuthorityRpcSwarmTransport — rpc routing + error map', () => {
  it('routes a request to the channel whose remote device matches, and resolves on res', async () => {
    const f = makeFakeSwarm();
    const p = makeFakeProtomux();
    const t = makeAuthorityRpcSwarmTransport({
      swarm: f.swarm,
      selfDevicePubkey: SELF,
      protomux: p.protomux,
      genId: () => 'rid-1',
    });
    f.connect();
    const ch = p.created[0];
    ch.pair();
    ch.deliver({ t: 'hello', device_pubkey: REMOTE });

    const promise = t.rpc(peer(REMOTE), { harnessSlug: 'h1', kind: 'lock.acquire', payload: { path: 'a.ts' } });
    // Allow the (async, unsigned) send to flush.
    await Promise.resolve();
    const req = ch.sent.find((s) => s.t === 'req');
    expect(req).toMatchObject({ t: 'req', id: 'rid-1', harnessSlug: 'h1', kind: 'lock.acquire', payload: { path: 'a.ts' } });
    // The authority replies.
    ch.deliver({ t: 'res', id: 'rid-1', ok: true, result: { granted: true } });
    await expect(promise).resolves.toEqual({ granted: true });
  });

  it('throws PeerUnreachableError when no channel to the peer exists (fail-open)', async () => {
    const f = makeFakeSwarm();
    const p = makeFakeProtomux();
    const t = makeAuthorityRpcSwarmTransport({ swarm: f.swarm, selfDevicePubkey: SELF, protomux: p.protomux });
    await expect(t.rpc(peer(REMOTE), { harnessSlug: 'h', kind: 'lock.acquire', payload: {} })).rejects.toBeInstanceOf(
      PeerUnreachableError,
    );
  });

  it('does NOT route to a channel whose remote device is different', async () => {
    const f = makeFakeSwarm();
    const p = makeFakeProtomux();
    const t = makeAuthorityRpcSwarmTransport({ swarm: f.swarm, selfDevicePubkey: SELF, protomux: p.protomux });
    f.connect();
    p.created[0].pair();
    p.created[0].deliver({ t: 'hello', device_pubkey: 'some-other-device' });
    await expect(t.rpc(peer(REMOTE), { harnessSlug: 'h', kind: 'lock.acquire', payload: {} })).rejects.toBeInstanceOf(
      PeerUnreachableError,
    );
  });

  it('times out → PeerUnreachableError (fail-open)', async () => {
    const f = makeFakeSwarm();
    const p = makeFakeProtomux();
    const t = makeAuthorityRpcSwarmTransport({
      swarm: f.swarm,
      selfDevicePubkey: SELF,
      protomux: p.protomux,
      timeoutMs: 25,
    });
    f.connect();
    p.created[0].pair();
    p.created[0].deliver({ t: 'hello', device_pubkey: REMOTE });
    // No res is ever delivered → the timeout fires.
    await expect(t.rpc(peer(REMOTE), { harnessSlug: 'h', kind: 'lock.acquire', payload: {} })).rejects.toBeInstanceOf(
      PeerUnreachableError,
    );
  });

  it('maps res not_authority → PeerUnreachableError (failover gap → fail-open)', async () => {
    const f = makeFakeSwarm();
    const p = makeFakeProtomux();
    const t = makeAuthorityRpcSwarmTransport({
      swarm: f.swarm,
      selfDevicePubkey: SELF,
      protomux: p.protomux,
      genId: () => 'rid-x',
    });
    f.connect();
    p.created[0].pair();
    p.created[0].deliver({ t: 'hello', device_pubkey: REMOTE });
    const promise = t.rpc(peer(REMOTE), { harnessSlug: 'h', kind: 'lock.acquire', payload: {} });
    await Promise.resolve();
    p.created[0].deliver({ t: 'res', id: 'rid-x', ok: false, error: 'not_authority', message: 'moved' });
    await expect(promise).rejects.toBeInstanceOf(PeerUnreachableError);
  });

  it('maps res handler_error → a real Error (NOT fail-open — a genuine op failure)', async () => {
    const f = makeFakeSwarm();
    const p = makeFakeProtomux();
    const t = makeAuthorityRpcSwarmTransport({
      swarm: f.swarm,
      selfDevicePubkey: SELF,
      protomux: p.protomux,
      genId: () => 'rid-e',
    });
    f.connect();
    p.created[0].pair();
    p.created[0].deliver({ t: 'hello', device_pubkey: REMOTE });
    const promise = t.rpc(peer(REMOTE), { harnessSlug: 'h', kind: 'lock.acquire', payload: {} });
    await Promise.resolve();
    p.created[0].deliver({ t: 'res', id: 'rid-e', ok: false, error: 'handler_error', message: 'lock store down' });
    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PeerUnreachableError);
    expect(String(err)).toMatch(/lock store down/);
  });
});

describe('makeAuthorityRpcSwarmTransport — receiving side (dispatch)', () => {
  it('dispatches an inbound req to the local authority and replies with a res', async () => {
    const f = makeFakeSwarm();
    const p = makeFakeProtomux();
    const dispatch: AuthorityRpcDispatch = async (env) => ({ ok: true, result: { echoed: env.kind } });
    makeAuthorityRpcSwarmTransport({ swarm: f.swarm, selfDevicePubkey: SELF, protomux: p.protomux, dispatch });
    f.connect();
    const ch = p.created[0];
    ch.pair();
    ch.deliver({ t: 'req', id: 'in-1', harnessSlug: 'h', kind: 'lock.acquire', payload: { path: 'z' } });
    // Allow the async dispatch + reply to flush.
    await new Promise((r) => setTimeout(r, 0));
    const res = ch.sent.find((s) => s.t === 'res');
    expect(res).toMatchObject({ t: 'res', id: 'in-1', ok: true, result: { echoed: 'lock.acquire' } });
  });

  it('a throwing dispatch replies handler_error (reachable-authority failure)', async () => {
    const f = makeFakeSwarm();
    const p = makeFakeProtomux();
    const dispatch: AuthorityRpcDispatch = async () => {
      throw new Error('boom');
    };
    makeAuthorityRpcSwarmTransport({ swarm: f.swarm, selfDevicePubkey: SELF, protomux: p.protomux, dispatch });
    f.connect();
    const ch = p.created[0];
    ch.pair();
    ch.deliver({ t: 'req', id: 'in-2', harnessSlug: 'h', kind: 'lock.acquire', payload: {} });
    await new Promise((r) => setTimeout(r, 0));
    const res = ch.sent.find((s) => s.t === 'res');
    expect(res).toMatchObject({ t: 'res', id: 'in-2', ok: false, error: 'handler_error', message: 'boom' });
  });

  it('with no dispatch wired, answers unknown_kind (send-only transport)', async () => {
    const f = makeFakeSwarm();
    const p = makeFakeProtomux();
    makeAuthorityRpcSwarmTransport({ swarm: f.swarm, selfDevicePubkey: SELF, protomux: p.protomux });
    f.connect();
    const ch = p.created[0];
    ch.pair();
    ch.deliver({ t: 'req', id: 'in-3', harnessSlug: 'h', kind: 'lock.acquire', payload: {} });
    await new Promise((r) => setTimeout(r, 0));
    expect(ch.sent.find((s) => s.t === 'res')).toMatchObject({ t: 'res', id: 'in-3', ok: false, error: 'unknown_kind' });
  });
});

describe('makeAuthorityRpcSwarmTransport — lifecycle', () => {
  it('a closed channel rejects its in-flight requests as unreachable', async () => {
    const f = makeFakeSwarm();
    const p = makeFakeProtomux();
    const t = makeAuthorityRpcSwarmTransport({
      swarm: f.swarm,
      selfDevicePubkey: SELF,
      protomux: p.protomux,
      genId: () => 'rid-c',
      timeoutMs: 10_000,
    });
    f.connect();
    const ch = p.created[0];
    ch.pair();
    ch.deliver({ t: 'hello', device_pubkey: REMOTE });
    const promise = t.rpc(peer(REMOTE), { harnessSlug: 'h', kind: 'lock.acquire', payload: {} });
    await Promise.resolve();
    expect(t.openChannelCount).toBe(1);
    ch.fireClose();
    expect(t.openChannelCount).toBe(0);
    await expect(promise).rejects.toBeInstanceOf(PeerUnreachableError);
  });

  it('close() detaches the handler and rejects in-flight requests', async () => {
    const f = makeFakeSwarm();
    const p = makeFakeProtomux();
    const t = makeAuthorityRpcSwarmTransport({
      swarm: f.swarm,
      selfDevicePubkey: SELF,
      protomux: p.protomux,
      genId: () => 'rid-close',
      timeoutMs: 10_000,
    });
    f.connect();
    const ch = p.created[0];
    ch.pair();
    ch.deliver({ t: 'hello', device_pubkey: REMOTE });
    const promise = t.rpc(peer(REMOTE), { harnessSlug: 'h', kind: 'lock.acquire', payload: {} });
    await Promise.resolve();
    t.close();
    expect(f.handler).toBeNull();
    await expect(promise).rejects.toBeInstanceOf(PeerUnreachableError);
  });
});

describe('makeAuthorityRpcSwarmTransport — EI-322 signing', () => {
  it('signs the outgoing request with the device key when a signer is configured', async () => {
    const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
    const f = makeFakeSwarm();
    const p = makeFakeProtomux();
    const t = makeAuthorityRpcSwarmTransport({
      swarm: f.swarm,
      selfDevicePubkey: SELF,
      protomux: p.protomux,
      genId: () => 'rid-sig',
      envelopeSigner: {
        devicePubkey: pubkeyBase64,
        sign: async (bytes: Buffer) => signAuthorityRpcWithPrivateKeyDer(privateKeyDer, bytes),
      },
    });
    f.connect();
    const ch = p.created[0];
    ch.pair();
    ch.deliver({ t: 'hello', device_pubkey: REMOTE });
    const payload = { path: 'apps/x.ts', holderPubkey: pubkeyBase64 };
    void t.rpc(peer(REMOTE), { harnessSlug: 'papercup', kind: 'lock.acquire', payload });
    // Let the async signer resolve + the req flush.
    await new Promise((r) => setTimeout(r, 0));
    const req = ch.sent.find((s) => s.t === 'req');
    expect(req.auth).toBeTruthy();
    expect(req.auth.device_pubkey).toBe(pubkeyBase64);
    // The signature verifies over the same op fields the receiver will canonicalize.
    expect(
      verifyAuthorityRpc({ harnessSlug: 'papercup', kind: 'lock.acquire', payload }, req.auth),
    ).toBe(true);
  });
});
