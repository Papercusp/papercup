import net from 'node:net';
import { describe, expect, it, afterEach } from 'vitest';
import { pidLivenessProbe, tcpPortProbe } from './adapters.js';

describe('pidLivenessProbe', () => {
  it('reports the current process alive', async () => {
    const probe = pidLivenessProbe(process.pid);
    await expect(probe.isAlive()).resolves.toBe(true);
  });

  it('reports a bogus/invalid pid as not alive', async () => {
    const probe = pidLivenessProbe(0);
    await expect(probe.isAlive()).resolves.toBe(false);
  });

  it('reports an almost-certainly-dead high pid as not alive', async () => {
    // Not perfectly deterministic on every OS, but a pid this high is never a
    // real live process in CI/dev sandboxes; guards against a false "alive".
    const probe = pidLivenessProbe(999_999);
    await expect(probe.isAlive()).resolves.toBe(false);
  });
});

describe('tcpPortProbe', () => {
  let server: net.Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  it('reports ready once something is listening on the port', async () => {
    server = net.createServer((socket) => socket.end());
    const port = await new Promise<number>((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        resolve((server?.address() as net.AddressInfo).port);
      });
    });
    const probe = tcpPortProbe(port);
    await expect(probe.checkReady()).resolves.toBe(true);
  });

  it('reports not-ready when nothing is listening', async () => {
    const probe = tcpPortProbe(1); // privileged/unused port — nothing listens here in a sandbox
    await expect(probe.checkReady()).resolves.toBe(false);
  });
});
