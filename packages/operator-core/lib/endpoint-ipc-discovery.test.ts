import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mutable home so each test points `homedir()` at its own temp dir. ESM
// namespaces aren't spy-able, so mock the module with a holder set in
// beforeEach (vi.mock is hoisted above the imports).
const h = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, homedir: () => h.home || actual.tmpdir() };
});

import {
  writeEndpointIpcDiscovery,
  readEndpointIpcDiscovery,
  endpointIpcDiscoveryPath,
} from './endpoint-ipc-discovery';

beforeEach(async () => {
  h.home = await mkdtemp(join(tmpdir(), 'ipc-disc-'));
});

afterEach(async () => {
  const home = h.home;
  h.home = '';
  await rm(home, { recursive: true, force: true });
});

describe('endpoint-ipc discovery file', () => {
  it('writes the path under ~/.papercusp/endpoint-ipc.json', () => {
    expect(endpointIpcDiscoveryPath()).toBe(join(h.home, '.papercusp', 'endpoint-ipc.json'));
  });

  it('round-trips the socket path + stamps pid/startedAt', async () => {
    const sock = '/run/user/1000/.papercusp/sockets/42.sock';
    await writeEndpointIpcDiscovery(sock);

    const back = await readEndpointIpcDiscovery();
    expect(back).not.toBeNull();
    expect(back!.socketPath).toBe(sock);
    expect(back!.pid).toBe(process.pid);
    expect(typeof back!.startedAt).toBe('number');
    expect(back!.startedAt).toBeGreaterThan(0);

    // The on-disk JSON is exactly the documented shape (the Rust dev reader
    // parses `socketPath` off this file).
    const raw = JSON.parse(await readFile(endpointIpcDiscoveryPath(), 'utf8'));
    expect(raw).toMatchObject({ socketPath: sock, pid: process.pid });
  });

  it('returns null when the file is missing', async () => {
    expect(await readEndpointIpcDiscovery()).toBeNull();
  });

  it('returns null when the file is corrupt / lacks socketPath', async () => {
    await mkdir(join(h.home, '.papercusp'), { recursive: true });
    await writeFile(endpointIpcDiscoveryPath(), '{ not json', 'utf8');
    expect(await readEndpointIpcDiscovery()).toBeNull();

    await writeFile(endpointIpcDiscoveryPath(), JSON.stringify({ pid: 1 }), 'utf8');
    expect(await readEndpointIpcDiscovery()).toBeNull();
  });
});
