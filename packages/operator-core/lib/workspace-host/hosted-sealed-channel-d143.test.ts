import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SecretStream from '@hyperswarm/secret-stream';
import { ByocSealedChannel, type ByocSealedPacket } from './byoc-sealed-channel';
import {
  createByocClientKey,
  rotateByocClientKey,
  withByocClientKey,
  type RotatedByocClientKey,
} from './byoc-client-key-custody';

const stored = new Map<string, Buffer>();
vi.mock('../identity/keychain', () => ({
  keychainStore: vi.fn(async (id: string, value: Buffer, service: string) => {
    stored.set(`${service}:${id}`, Buffer.from(value));
  }),
  keychainLoad: vi.fn(async (id: string, service: string) => {
    const value = stored.get(`${service}:${id}`);
    return value
      ? { kind: 'ok', value: Buffer.from(value) }
      : { kind: 'error', error: { kind: 'not_found' } };
  }),
  keychainDelete: vi.fn(async (id: string, service: string) => {
    stored.delete(`${service}:${id}`);
  }),
}));

const scope = {
  organizationId: 'org-a',
  workspaceId: 'workspace-a',
  hostId: 'host-a',
  clientId: 'desktop-a',
};
const previousDesktop = process.env.PAPERCUSP_DESKTOP;

type NoiseKeyPair = { publicKey: Buffer; secretKey: Buffer };

class CustomerHostAdmission {
  readonly hostKey = SecretStream.keyPair(Buffer.alloc(32, 91));
  private generation = 0;
  private readonly authorized = new Map<string, number>();
  private readonly live = new Map<string, Set<ByocSealedChannel>>();

  authorize = async (publicKeyBase64: string): Promise<void> => {
    this.generation += 1;
    this.authorized.set(publicKeyBase64, this.generation);
  };

  bumpGeneration = async (publicKeyBase64: string): Promise<number> => {
    if (!this.authorized.has(publicKeyBase64)) throw new Error('client key is not authorized on the customer host');
    this.generation += 1;
    this.authorized.set(publicKeyBase64, this.generation);
    for (const channel of this.live.get(publicKeyBase64) ?? []) channel.close();
    this.live.delete(publicKeyBase64);
    return this.generation;
  };

  revoke = async (publicKeyBase64: string): Promise<void> => {
    this.authorized.delete(publicKeyBase64);
    for (const channel of this.live.get(publicKeyBase64) ?? []) channel.close();
    this.live.delete(publicKeyBase64);
  };

  async connect(claimedPublicKeyBase64: string, clientKey: NoiseKeyPair, claimedGeneration?: number) {
    const generation = this.authorized.get(claimedPublicKeyBase64);
    if (!generation) throw new Error('client key is not authorized on the customer host');
    if (claimedGeneration !== undefined && claimedGeneration !== generation) {
      throw new Error(`stale connector generation ${claimedGeneration}; current generation is ${generation}`);
    }

    const clientFrames: Record<string, unknown>[] = [];
    const hostFrames: Record<string, unknown>[] = [];
    let client!: ByocSealedChannel;
    let host!: ByocSealedChannel;
    client = new ByocSealedChannel({
      initiator: true,
      localKeyPair: clientKey,
      expectedRemotePublicKey: this.hostKey.publicKey,
      sendPacket: (packet: ByocSealedPacket) => queueMicrotask(() => host.receive(packet)),
      onFrame: (frame) => clientFrames.push(frame),
    });
    host = new ByocSealedChannel({
      initiator: false,
      localKeyPair: this.hostKey,
      expectedRemotePublicKey: Buffer.from(claimedPublicKeyBase64, 'base64'),
      sendPacket: (packet: ByocSealedPacket) => queueMicrotask(() => client.receive(packet)),
      onFrame: (frame) => hostFrames.push(frame),
    });
    try {
      await Promise.all([client.opened, host.opened]);
    } catch (error) {
      client.close();
      host.close();
      throw error;
    }
    const channels = this.live.get(claimedPublicKeyBase64) ?? new Set<ByocSealedChannel>();
    channels.add(client);
    channels.add(host);
    this.live.set(claimedPublicKeyBase64, channels);
    return {
      generation,
      client,
      host,
      clientFrames,
      hostFrames,
      close: () => {
        client.close();
        host.close();
        channels.delete(client);
        channels.delete(host);
      },
    };
  }
}

beforeEach(() => {
  stored.clear();
  process.env.PAPERCUSP_DESKTOP = '1';
});

afterEach(() => {
  if (previousDesktop === undefined) delete process.env.PAPERCUSP_DESKTOP;
  else process.env.PAPERCUSP_DESKTOP = previousDesktop;
});

describe('BYOC sealed-channel D-143 lifecycle (P-007)', () => {
  it('connects, reconnects, advances generation, revokes live and future old-key sessions, and refuses key substitution', async () => {
    const admission = new CustomerHostAdmission();
    const first = await createByocClientKey(scope);
    await admission.authorize(first.publicKeyBase64);
    let rotated!: RotatedByocClientKey;

    await withByocClientKey(scope, first.publicKeyBase64, async (firstKey) => {
      const initial = await admission.connect(first.publicKeyBase64, firstKey);
      expect(initial.generation).toBe(1);
      await initial.client.send({ type: 'pty.input', data: 'initial' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(initial.hostFrames).toEqual([{ type: 'pty.input', data: 'initial' }]);
      initial.close();

      const reconnect = await admission.connect(first.publicKeyBase64, firstKey);
      expect(reconnect.generation).toBe(1);
      await reconnect.client.send({ type: 'file.read', path: '/workspace/reconnected.txt' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(reconnect.hostFrames).toEqual([
        { type: 'file.read', path: '/workspace/reconnected.txt' },
      ]);

      expect(await admission.bumpGeneration(first.publicKeyBase64)).toBe(2);
      await expect(reconnect.client.send({ type: 'pty.input', data: 'stale-live-generation' }))
        .rejects.toThrow(/closed/);
      await expect(admission.connect(first.publicKeyBase64, firstKey, 1))
        .rejects.toThrow(/stale connector generation/);

      const afterBump = await admission.connect(first.publicKeyBase64, firstKey);
      expect(afterBump.generation).toBe(2);
      await afterBump.client.send({ type: 'pty.input', data: 'current-generation' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(afterBump.hostFrames).toEqual([{ type: 'pty.input', data: 'current-generation' }]);

      rotated = await rotateByocClientKey(
        scope,
        first.publicKeyBase64,
        admission.authorize,
        admission.revoke,
      );
      expect(rotated.status).toBe('complete');
      await expect(afterBump.client.send({ type: 'pty.input', data: 'after-revocation' }))
        .rejects.toThrow(/closed/);
    });

    await withByocClientKey(scope, rotated.publicKeyBase64, async (replacementKey) => {
      const current = await admission.connect(rotated.publicKeyBase64, replacementKey);
      expect(current.generation).toBe(3);
      await current.client.send({ type: 'http.request', requestId: 'generation-2' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(current.hostFrames).toEqual([
        { type: 'http.request', requestId: 'generation-2' },
      ]);
      current.close();

      const substituted = SecretStream.keyPair(Buffer.alloc(32, 92));
      await expect(admission.connect(rotated.publicKeyBase64, substituted))
        .rejects.toThrow(/key|handshake|noise/i);
    });

    const revokedKey = SecretStream.keyPair(Buffer.from(first.recoverySeedBase64, 'base64'));
    await expect(admission.connect(first.publicKeyBase64, revokedKey))
      .rejects.toThrow(/not authorized/);
  });
});
