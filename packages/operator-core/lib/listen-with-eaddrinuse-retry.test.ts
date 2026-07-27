/**
 * listen-with-eaddrinuse-retry.test.ts — EI-18734124566158657 regression.
 *
 * Exercises listenWithEaddrinuseRetry against REAL TCP sockets (no mocking of
 * net/http) so the EADDRINUSE recovery is proven against the actual OS
 * behavior, not an assumption about it.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { listenWithEaddrinuseRetry } from './listen-with-eaddrinuse-retry';

const openServers: Server[] = [];

function trackedServer(): Server {
  const s = createServer((_req, res) => res.end('ok'));
  openServers.push(s);
  return s;
}

function closeAll(): Promise<void[]> {
  return Promise.all(
    openServers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          if (!s.listening) return resolve();
          s.close(() => resolve());
        }),
    ),
  );
}

/** Grab an OS-assigned free port up front (bind :0, read it back, close). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => resolve(p));
    });
  });
}

afterEach(async () => {
  await closeAll();
});

describe('listenWithEaddrinuseRetry (EI-18734124566158657)', () => {
  it('succeeds immediately when the port is free (no retry needed)', async () => {
    const port = await freePort();
    const srv = trackedServer();
    const warnings: string[] = [];

    await new Promise<void>((resolve, reject) => {
      listenWithEaddrinuseRetry(srv, {
        port,
        host: '127.0.0.1',
        maxAttempts: 3,
        retryDelayMs: 20,
        warn: (m) => warnings.push(m),
        onListening: () => resolve(),
        onFatal: (err) => reject(err),
      });
    });

    expect(srv.listening).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('recovers from a transient straggler: retries until the port frees, then binds', async () => {
    const port = await freePort();
    const squatter = trackedServer();
    await new Promise<void>((resolve, reject) => {
      squatter.listen(port, '127.0.0.1', () => resolve());
      squatter.on('error', reject);
    });

    // Free the squatter's hold shortly after the first bind attempt fails —
    // well within the retry budget (3 attempts x 50ms > the ~30-60ms close).
    setTimeout(() => {
      squatter.close();
    }, 40);

    const srv = trackedServer();
    const warnings: string[] = [];

    await new Promise<void>((resolve, reject) => {
      listenWithEaddrinuseRetry(srv, {
        port,
        host: '127.0.0.1',
        maxAttempts: 6,
        retryDelayMs: 50,
        warn: (m) => warnings.push(m),
        onListening: () => resolve(),
        onFatal: (err) => reject(err),
      });
    });

    expect(srv.listening).toBe(true);
    // At least one EADDRINUSE retry must have actually happened — this is
    // what distinguishes "recovered via retry" from "never contended".
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('EADDRINUSE');
    expect(warnings[0]).toContain('EI-18734124566158657');
  });

  it('gives up and calls onFatal after exhausting retries against a persistent squatter', async () => {
    const port = await freePort();
    const squatter = trackedServer();
    await new Promise<void>((resolve, reject) => {
      squatter.listen(port, '127.0.0.1', () => resolve());
      squatter.on('error', reject);
    });
    // Deliberately never closed during this test — a persistent conflict.

    const srv = trackedServer();
    const warnings: string[] = [];
    let fatalErr: NodeJS.ErrnoException | undefined;
    let listeningCalled = false;

    await new Promise<void>((resolve) => {
      listenWithEaddrinuseRetry(srv, {
        port,
        host: '127.0.0.1',
        maxAttempts: 3,
        retryDelayMs: 15,
        warn: (m) => warnings.push(m),
        onListening: () => {
          listeningCalled = true;
          resolve();
        },
        onFatal: (err) => {
          fatalErr = err;
          resolve();
        },
      });
    });

    expect(listeningCalled).toBe(false);
    expect(fatalErr?.code).toBe('EADDRINUSE');
    // 3 max attempts -> exactly 2 retry warnings (attempts 1 and 2 retry; attempt 3 is fatal).
    expect(warnings).toHaveLength(2);
  });

  it('calls onFatal immediately (no retry) for a non-EADDRINUSE listen error', async () => {
    const srv = trackedServer();
    const warnings: string[] = [];
    let fatalErr: NodeJS.ErrnoException | undefined;

    await new Promise<void>((resolve) => {
      listenWithEaddrinuseRetry(srv, {
        // An invalid host well outside the loopback/any range reliably fails
        // with EADDRNOTAVAIL rather than EADDRINUSE.
        host: '203.0.113.254',
        port: 39999,
        maxAttempts: 5,
        retryDelayMs: 15,
        warn: (m) => warnings.push(m),
        onListening: () => resolve(),
        onFatal: (err) => {
          fatalErr = err;
          resolve();
        },
      });
    });

    expect(fatalErr).toBeDefined();
    expect(fatalErr?.code).not.toBe('EADDRINUSE');
    expect(warnings).toHaveLength(0);
  });
});
