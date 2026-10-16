import postgres from 'postgres';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercise the installed driver, including the maintained patch, rather than a
// copied scheduler. No server is needed: the socket factory records each open.
const drivers = await Promise.all([
  ['esm', './connection.js'],
  ['commonjs', '../cjs/src/connection.js'],
  ['cloudflare', '../cf/src/connection.js'],
].map(async ([name, path]) => [name, (await import(
  /* @vite-ignore */ new URL(path, import.meta.resolve('postgres')).href
)).default] as const));

afterEach(() => vi.useRealTimers());

describe.each(drivers)('%s postgres shutdown before its deferred connect', (_name, Connection) => {
function fixture() {
  const open = vi.fn(() => { throw new Error('test socket factory'); });
  const sql = postgres('postgres://test:test@127.0.0.1:1/test', { socket: open });
  const connection = Connection(sql.options);
  const query = { reserve: true, reject: vi.fn() };
  return { connection, open, query };
}

  it('does not open a socket after terminating a scheduled connection', async () => {
    vi.useFakeTimers();
    const { connection, open, query } = fixture();
    connection.connect(query);
    connection.terminate();
    expect(query.reject).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(open).not.toHaveBeenCalled();
  });

  it('still opens a socket for an admitted connection', async () => {
    vi.useFakeTimers();
    const { connection, open, query } = fixture();
    connection.connect(query);
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledOnce();
    connection.terminate();
  });

  it('allows an explicit pool reuse after terminating the earlier attempt', async () => {
    vi.useFakeTimers();
    const { connection, open, query } = fixture();
    connection.connect(query);
    connection.terminate();
    connection.connect({ reserve: true, reject: vi.fn() });
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledOnce();
    connection.terminate();
  });

  it('discards a socket factory result that completes after termination', async () => {
    vi.useFakeTimers();
    let resolveSocket!: (socket: net.Socket) => void;
    const open = vi.fn(() => new Promise<net.Socket>(resolve => { resolveSocket = resolve; }));
    const sql = postgres('postgres://test:test@127.0.0.1:1/test', { socket: open });
    const connection = Connection(sql.options);
    connection.connect({ reserve: true, reject: vi.fn() });
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledOnce();
    connection.terminate();
    const socket = new net.Socket();
    resolveSocket(socket);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
