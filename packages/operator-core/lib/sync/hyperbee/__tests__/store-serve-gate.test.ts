/**
 * v1 R-5 (WI-6554700010049344): the per-connection serve gate on a corestore.
 *
 * Two real Corestores replicate over an in-memory protocol stream pair. The serving
 * side is gated; the reading side holds the serving core's key, which is exactly
 * the position of a revoked device. The gate must refuse every attach path
 * (eager, lazy on the remote's open, and re-attach on download) until it is
 * opened, and must stop serving new blocks once it is closed.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Corestore from 'corestore';
import { afterEach, describe, expect, it } from 'vitest';
import { installStoreServeGate } from '../corestore';

type Core = {
  key: Buffer;
  length: number;
  ready(): Promise<void>;
  append(block: Buffer): Promise<unknown>;
  get(index: number, opts?: { timeout?: number }): Promise<Buffer | null>;
};
// Standalone, not `Corestore & {…}`: the intersection resolves `get` to Corestore's own
// `unknown`-returning signature first, so the narrower Core shape never applies.
type Store = {
  get(opts: { name?: string; key?: Buffer }): Core;
  replicate(isInitiator: boolean): NodeJS.ReadWriteStream & { noiseStream: { userData: object } };
  close(): Promise<void>;
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => {});
});

async function pair(): Promise<{ server: Store; reader: Store; serverCore: Core; readerCore: Core }> {
  const dirs = await Promise.all([mkdtemp(join(tmpdir(), 'serve-gate-a-')), mkdtemp(join(tmpdir(), 'serve-gate-b-'))]);
  const server = new Corestore(dirs[0]) as unknown as Store;
  const reader = new Corestore(dirs[1]) as unknown as Store;
  cleanups.push(async () => {
    await Promise.allSettled([server.close(), reader.close()]);
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });
  const serverCore = server.get({ name: 'log' });
  await serverCore.ready();
  await serverCore.append(Buffer.from('before'));
  const readerCore = reader.get({ key: serverCore.key });
  await readerCore.ready();
  return { server, reader, serverCore, readerCore };
}

function connect(server: Store, reader: Store): object {
  const s = server.replicate(true);
  const r = reader.replicate(false);
  s.pipe(r).pipe(s);
  return s.noiseStream.userData;
}

const MISS_MS = 800;

describe('installStoreServeGate', () => {
  it('refuses every attach path until opened, then serves', async () => {
    const { server, reader, serverCore, readerCore } = await pair();
    let allowed = false;
    const gate = installStoreServeGate(server as unknown as Corestore,() => allowed);
    const muxer = connect(server, reader);

    await expect(readerCore.get(0, { timeout: MISS_MS })).rejects.toThrow();

    allowed = true;
    gate.open(muxer);
    expect((await readerCore.get(0, { timeout: 10_000 }))?.toString()).toBe('before');
    expect(serverCore.length).toBe(1);
  });

  it('stops serving new blocks once closed, and the remote cannot re-attach', async () => {
    const { server, reader, serverCore, readerCore } = await pair();
    let allowed = true;
    const gate = installStoreServeGate(server as unknown as Corestore,() => allowed);
    const muxer = connect(server, reader);
    expect((await readerCore.get(0, { timeout: 10_000 }))?.toString()).toBe('before');

    allowed = false;
    gate.close(muxer);
    await serverCore.append(Buffer.from('after'));
    await expect(readerCore.get(1, { timeout: MISS_MS })).rejects.toThrow();
    expect(readerCore.length).toBeLessThanOrEqual(1);
  });

  it('serves every connection again after release', async () => {
    const { server, reader, readerCore } = await pair();
    const gate = installStoreServeGate(server as unknown as Corestore,() => false);
    gate.release();
    connect(server, reader);
    expect((await readerCore.get(0, { timeout: 10_000 }))?.toString()).toBe('before');
  });

  it('throws when the corestore attach sites are missing', () => {
    expect(() => installStoreServeGate({} as Corestore, () => true)).toThrow(/corestore internals changed/);
  });
});
