/** Regression tests for the shared OS-level port availability probe. */
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { portAvailable, portAvailableSync } from './port-availability';

const openServers: ReturnType<typeof createServer>[] = [];

async function freePort(): Promise<number> {
  const probe = createServer();
  return new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function closeAll(): Promise<void> {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
        }),
    ),
  );
}

afterEach(closeAll);

describe('portAvailable', () => {
  it('returns true for a free port and false for a held port', async () => {
    const port = await freePort();
    expect(await portAvailable(port, '127.0.0.1')).toBe(true);
    expect(portAvailableSync(port, '127.0.0.1')).toBe(true);

    const holder = createServer();
    openServers.push(holder);
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.listen(port, '127.0.0.1', () => resolve());
    });
    expect(await portAvailable(port, '127.0.0.1')).toBe(false);
    expect(portAvailableSync(port, '127.0.0.1')).toBe(false);
  });

  it('returns false for an invalid numeric port', async () => {
    await expect(portAvailable(-1, '127.0.0.1')).resolves.toBe(false);
    await expect(portAvailable(65536, '127.0.0.1')).resolves.toBe(false);
    await expect(portAvailable(Number.NaN, '127.0.0.1')).resolves.toBe(false);
    expect(portAvailableSync(-1, '127.0.0.1')).toBe(false);
    expect(portAvailableSync(65536, '127.0.0.1')).toBe(false);
    expect(portAvailableSync(Number.NaN, '127.0.0.1')).toBe(false);
  });
});
