import { describe, expect, it } from 'vitest';
import { channel } from 'node:diagnostics_channel';
import { errorMonitor, getEventListeners, once } from 'node:events';
import { connect, createServer, type Socket } from 'node:net';
import {
  PG_DEATH_LOG_WINDOW,
  startPostgresWithDiagnostics,
  type PostgresStartupDiagnostics,
} from '../../../libs/papercusp/packages/embedded-postgres-server/src/pg-supervisor.js';

type StartupFailure = Error & { cause?: unknown; postgresStartup: PostgresStartupDiagnostics };

async function withTcpServer<T>(
  run: (port: number) => Promise<T>,
  onConnection?: (socket: Socket) => void,
): Promise<T> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    onConnection?.(socket);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing TCP address');
    return await run(address.port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function diagnose<T>(port: number, start: () => Promise<T>) {
  return startPostgresWithDiagnostics({
    start, port, phase: 'bootstrap-query', dataDir: '/tmp/embedded-pg', recentLines: () => ['database system is ready'],
  });
}

describe('startPostgresWithDiagnostics', () => {
  it('turns a bare start rejection into an actionable bounded diagnostic', async () => {
    const recentLines = [
      ...Array.from({ length: PG_DEATH_LOG_WINDOW + 1 }, (_, index) => `postgres line ${index + 1}`),
      'FATAL: could not create any TCP/IP sockets',
    ];
    const failure = await startPostgresWithDiagnostics({
      start: () => Promise.reject(undefined),
      port: 55432,
      dataDir: '/tmp/papercusp-embedded-pg',
      recentLines: () => recentLines,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('localhost:55432');
    expect(message).toContain('"/tmp/papercusp-embedded-pg"');
    expect(message).toContain('rejected without an error value');
    expect(message).toContain(
      `Recent PostgreSQL startup output (last ${PG_DEATH_LOG_WINDOW} lines):`,
    );
    expect(message.split('\n')).not.toContain('postgres line 1');
    expect(message).toContain(`postgres line ${PG_DEATH_LOG_WINDOW + 1}`);
    expect(message).toContain('FATAL: could not create any TCP/IP sockets');
  });

  it('preserves a descriptive library Error as the cause', async () => {
    const cause = new Error('postmaster exited before ready');
    const failure = await startPostgresWithDiagnostics({
      start: () => Promise.reject(cause),
      port: 5532,
      dataDir: '/tmp/embedded-pg',
      recentLines: () => [],
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error & { cause?: unknown }).cause).toBe(cause);
    expect((failure as Error).message).toContain('Error: postmaster exited before ready');
    expect((failure as Error).message).toContain('No PostgreSQL startup output was captured.');
  });

  it('preserves the return value and removes observers after successful TCP work', async () => {
    const subscribedBefore = channel('net.client.socket').hasSubscribers;
    await withTcpServer(async (port) => {
      let socket!: Socket;
      const result = { ready: true };
      try {
        expect(await diagnose(port, async () => {
          socket = connect({ host: 'localhost', port });
          await once(socket, 'connect');
          expect(socket.listenerCount('data')).toBe(0);
          return result;
        })).toBe(result);
        expect(getEventListeners(socket, errorMonitor)).toHaveLength(0);
        for (const event of ['lookup', 'connectionAttempt', 'connect', 'timeout', 'close']) {
          expect(socket.listenerCount(event), event).toBe(0);
        }
      } finally {
        socket?.destroy();
      }
    });
    expect(channel('net.client.socket').hasSubscribers).toBe(subscribedBefore);
  });

  it('distinguishes a refused connection from a query failure and retains the transport cause', async () => {
    const port = await withTcpServer(async (port) => port);
    let socket!: Socket;
    const failure = await diagnose(port, async () => {
      socket = connect({ host: '127.0.0.1', port });
      await once(socket, 'connect');
    }).catch((error: StartupFailure) => error) as StartupFailure;
    try {
      expect((failure.cause as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
      expect(failure.postgresStartup.phase).toBe('bootstrap-query');
      expect(failure.postgresStartup.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: 'connectionAttempt', port }),
        expect.objectContaining({ event: 'error', code: 'ECONNREFUSED' }),
      ]));
      expect(failure.postgresStartup.events.some((event) => event.event === 'connect')).toBe(false);
      expect(failure.postgresStartup.sockets).toHaveLength(1);
      expect(failure.postgresStartup.sockets[0].bytesRead).toBe(0);
      expect(getEventListeners(socket, errorMonitor)).toHaveLength(0);
    } finally {
      socket?.destroy();
    }
  });

  it('records a completed connection and byte count without capturing query data', async () => {
    const cause = new Error('first query rejected');
    const privatePayload = 'private-query-result-that-must-not-be-logged';
    await withTcpServer(async (port) => {
      let socket!: Socket;
      const failure = await diagnose(port, async () => {
        socket = connect({ host: 'localhost', port });
        await once(socket, 'connect');
        expect(socket.listenerCount('data')).toBe(0);
        const [data] = await once(socket, 'data');
        expect(data.toString()).toBe(privatePayload);
        throw cause;
      }).catch((error: StartupFailure) => error);
      try {
        expect(failure.cause).toBe(cause);
        expect(failure.message).toContain('failed during bootstrap-query');
        expect(failure.postgresStartup.events).toEqual(expect.arrayContaining([
          expect.objectContaining({ event: 'lookup' }),
          expect.objectContaining({ event: 'connect' }),
        ]));
        expect(failure.postgresStartup.sockets[0].bytesRead).toBe(Buffer.byteLength(privatePayload));
        expect(JSON.stringify(failure.postgresStartup)).not.toContain(privatePayload);
        expect(failure.message).not.toContain(privatePayload);
        expect(getEventListeners(socket, errorMonitor)).toHaveLength(0);
      } finally {
        socket?.destroy();
      }
    }, (socket) => socket.end(privatePayload));
  });

  it('isolates simultaneous operations and leaves unrelated sockets unobserved', async () => {
    const subscribedBefore = channel('net.client.socket').hasSubscribers;
    await withTcpServer(async (port) => {
      const sockets: Socket[] = [];
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      let connected = 0;
      const run = (label: string) => diagnose(port, async () => {
        const socket = connect({ host: '127.0.0.1', port });
        sockets.push(socket);
        await once(socket, 'connect');
        if (++connected === 2) release();
        await barrier;
        throw new Error(label);
      }).catch((error: StartupFailure) => error);
      const first = run('first');
      const second = run('second');
      const unrelated = connect({ host: '127.0.0.1', port });
      sockets.push(unrelated);
      try {
        await once(unrelated, 'connect');
        const failures = await Promise.all([first, second]);
        expect(failures.map((failure) => (failure.cause as Error).message)).toEqual(['first', 'second']);
        for (const failure of failures) {
          expect(failure.postgresStartup.sockets).toHaveLength(1);
          expect(failure.postgresStartup.events.every((event) => event.socket === 1)).toBe(true);
        }
        for (const socket of sockets) expect(getEventListeners(socket, errorMonitor)).toHaveLength(0);
      } finally {
        for (const socket of sockets) socket.destroy();
      }
    });
    expect(channel('net.client.socket').hasSubscribers).toBe(subscribedBefore);
  });

  it('bounds diagnostic volume and cleans up every observed socket on failure', async () => {
    await withTcpServer(async (port) => {
      const sockets: Socket[] = [];
      const failure = await diagnose(port, async () => {
        await Promise.all(Array.from({ length: 12 }, async () => {
          const socket = connect({ host: '127.0.0.1', port });
          sockets.push(socket);
          await once(socket, 'connect');
        }));
        for (const socket of sockets) {
          for (let n = 0; n < 10; n++) socket.emit('timeout');
        }
        throw new Error('bounded failure');
      }).catch((error: StartupFailure) => error);
      try {
        expect(failure.postgresStartup.sockets).toHaveLength(8);
        expect(failure.postgresStartup.events).toHaveLength(32);
        for (const socket of sockets) {
          expect(getEventListeners(socket, errorMonitor)).toHaveLength(0);
          expect(socket.listenerCount('timeout')).toBe(0);
        }
      } finally {
        for (const socket of sockets) socket.destroy();
      }
    });
  });
});
