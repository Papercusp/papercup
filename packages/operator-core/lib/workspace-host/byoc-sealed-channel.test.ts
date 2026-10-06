import { describe, expect, it } from 'vitest';
import SecretStream from '@hyperswarm/secret-stream';
import {
  ByocSealedChannel,
  byocSealedContentType,
  type ByocSealedPacket,
} from './byoc-sealed-channel';

async function pair(overrides: {
  clientExpected?: Buffer;
  hostExpected?: Buffer;
  hostVerify?: (remotePublicKey: Buffer) => Promise<boolean>;
  clientPacket?: (packet: ByocSealedPacket) => ByocSealedPacket;
} = {}) {
  const clientKey = SecretStream.keyPair(Buffer.alloc(32, 11));
  const hostKey = SecretStream.keyPair(Buffer.alloc(32, 22));
  const clientPackets: ByocSealedPacket[] = [];
  const hostPackets: ByocSealedPacket[] = [];
  const clientFrames: Record<string, unknown>[] = [];
  const hostFrames: Record<string, unknown>[] = [];
  const errors: Error[] = [];
  let client!: ByocSealedChannel;
  let host!: ByocSealedChannel;
  client = new ByocSealedChannel({
    initiator: true,
    localKeyPair: clientKey,
    expectedRemotePublicKey: overrides.clientExpected ?? hostKey.publicKey,
    sendPacket(packet) {
      clientPackets.push(packet);
      queueMicrotask(() => host.receive(overrides.clientPacket?.(packet) ?? packet));
    },
    onFrame: (frame) => clientFrames.push(frame),
    onError: (error) => errors.push(error),
  });
  host = new ByocSealedChannel({
    initiator: false,
    localKeyPair: hostKey,
    ...(overrides.hostVerify
      ? { verifyRemotePublicKey: overrides.hostVerify }
      : { expectedRemotePublicKey: overrides.hostExpected ?? clientKey.publicKey }),
    sendPacket(packet) {
      hostPackets.push(packet);
      queueMicrotask(() => client.receive(packet));
    },
    onFrame: (frame) => hostFrames.push(frame),
    onError: (error) => errors.push(error),
  });
  return { client, host, clientPackets, hostPackets, clientFrames, hostFrames, errors, clientKey, hostKey };
}

describe('BYOC sealed relay channel', () => {
  it('carries content end to end while relay packets expose only the frame type', async () => {
    const p = await pair();
    await Promise.all([p.client.opened, p.host.opened]);
    const marker = 'BYOC_SECRET_4c92';
    await p.client.send({ type: 'pty.input', data: Buffer.from(marker).toString('base64') });
    await p.host.send({ type: 'pty.data', data: Buffer.from(marker + '-reply').toString('base64') });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(p.hostFrames).toEqual([{ type: 'pty.input', data: Buffer.from(marker).toString('base64') }]);
    expect(p.clientFrames).toEqual([{ type: 'pty.data', data: Buffer.from(marker + '-reply').toString('base64') }]);
    expect(p.clientPackets.some((packet) => byocSealedContentType(packet) === 'pty.input')).toBe(true);
    expect(p.hostPackets.some((packet) => byocSealedContentType(packet) === 'pty.data')).toBe(true);
    expect(JSON.stringify([...p.clientPackets, ...p.hostPackets])).not.toContain(marker);
    p.client.close();
    p.host.close();
  });

  it('refuses a remote static key that differs from the independently verified key', async () => {
    const p = await pair({ clientExpected: SecretStream.keyPair(Buffer.alloc(32, 33)).publicKey });
    await expect(p.client.opened).rejects.toThrow(/key|handshake|noise/i);
    expect(p.hostFrames).toEqual([]);
    p.client.close();
    p.host.close();
  });

  it('responder verifier mode accepts any peer key it resolves (one key per paired phone)', async () => {
    const seen: string[] = [];
    const p = await pair({
      hostVerify: async (key) => { seen.push(key.toString('base64')); return true; },
    });
    await Promise.all([p.client.opened, p.host.opened]);
    expect(seen).toEqual([p.clientKey.publicKey.toString('base64')]);
    await p.client.send({ type: 'http.request', id: 'r1' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(p.hostFrames).toEqual([{ type: 'http.request', id: 'r1' }]);
    p.client.close();
    p.host.close();
  });

  it('responder verifier mode refuses a peer key it does not resolve, before any frame', async () => {
    const p = await pair({ hostVerify: async () => false });
    await expect(p.host.opened).rejects.toThrow(/remote key mismatch/);
    expect(p.hostFrames).toEqual([]);
    p.client.close();
    p.host.close();
  });

  it('refuses ambiguous key configuration and an initiator-side verifier', () => {
    const k = SecretStream.keyPair(Buffer.alloc(32, 44));
    const base = { localKeyPair: k, sendPacket: () => {}, onFrame: () => {} };
    expect(() => new ByocSealedChannel({ ...base, initiator: false })).toThrow(/exactly one/);
    expect(() => new ByocSealedChannel({ ...base, initiator: false, expectedRemotePublicKey: k.publicKey, verifyRemotePublicKey: async () => true })).toThrow(/exactly one/);
    expect(() => new ByocSealedChannel({ ...base, initiator: true, verifyRemotePublicKey: async () => true })).toThrow(/responder-only/);
  });

  it('detects relay relabelling instead of delivering ciphertext under another allowed type', async () => {
    const p = await pair({
      clientPacket: (packet) => packet.contentType === 'pty.input'
        ? { ...packet, contentType: 'file.write' }
        : packet,
    });
    await Promise.all([p.client.opened, p.host.opened]);
    await p.client.send({ type: 'pty.input', data: 'opaque' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(p.errors.some((error) => /content type mismatch/.test(error.message))).toBe(true);
    p.client.close();
    p.host.close();
  });
});
