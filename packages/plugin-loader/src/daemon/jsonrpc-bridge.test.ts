/**
 * Tests for JsonRpcBridge — the newline-delimited JSON-RPC 2.0 framing used by
 * the subprocess daemon runtime: id correlation, reply/error dispatch,
 * notifications, garbage tolerance, partial-line buffering, timeout, shutdown.
 * Driven with in-memory PassThrough streams (no real subprocess).
 * Run with: npx vitest run packages/plugin-loader/src/daemon/jsonrpc-bridge.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { JsonRpcBridge, type JsonRpcNotification } from './jsonrpc-bridge';

let peerStdout: PassThrough; // peer → bridge (the bridge reads this)
let peerStdin: PassThrough; // bridge → peer (the bridge writes this)
let bridge: JsonRpcBridge;
let sent: string[];

const flush = () => new Promise((r) => setImmediate(r));
const lastSent = () => JSON.parse(sent.join('').trim().split('\n').pop()!);
/** Push a peer→bridge line. */
const peerSend = (obj: unknown) => peerStdout.write(`${JSON.stringify(obj)}\n`);

beforeEach(() => {
  peerStdout = new PassThrough();
  peerStdin = new PassThrough();
  sent = [];
  peerStdin.on('data', (c) => sent.push(c.toString()));
  bridge = new JsonRpcBridge(peerStdout, peerStdin);
});
afterEach(() => bridge.shutdown());

describe('call', () => {
  it('writes a tagged request and resolves with the matching reply result', async () => {
    const p = bridge.call('ping', { x: 1 });
    await flush();
    expect(lastSent()).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'ping', params: { x: 1 } });
    peerSend({ jsonrpc: '2.0', id: 1, result: 'pong' });
    expect(await p).toBe('pong');
  });

  it('rejects with the error code + message on an error reply', async () => {
    // .catch(e=>e) attaches the handler synchronously so the rejection is never "unhandled".
    const p = bridge.call('boom').catch((e: Error) => e);
    await flush();
    peerSend({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'kaboom' } });
    expect(String(await p)).toContain('-32000: kaboom');
  });

  it('assigns monotonic ids and routes each reply to its own caller', async () => {
    const a = bridge.call('a');
    const b = bridge.call('b');
    await flush();
    peerSend({ jsonrpc: '2.0', id: 2, result: 'B' }); // reply out of order
    peerSend({ jsonrpc: '2.0', id: 1, result: 'A' });
    expect(await a).toBe('A');
    expect(await b).toBe('B');
  });

  it('times out a call with no reply', async () => {
    const err = await bridge.call('slow', undefined, 20).catch((e: Error) => e);
    expect(String(err)).toMatch(/timed out after 20ms: slow/);
  });
});

describe('onData framing', () => {
  it('ignores garbage lines without crashing the bridge', async () => {
    peerStdout.write('this is not json\n');
    await flush();
    const p = bridge.call('ok');
    await flush();
    peerSend({ jsonrpc: '2.0', id: 1, result: 'still works' });
    expect(await p).toBe('still works');
  });

  it('ignores a stale reply for an unknown id', async () => {
    peerSend({ jsonrpc: '2.0', id: 999, result: 'nobody waiting' });
    await flush(); // no throw
    expect(true).toBe(true);
  });

  it('dispatches two messages delivered in one chunk', async () => {
    const fired: JsonRpcNotification[] = [];
    bridge.onNotification((n) => fired.push(n));
    peerStdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'e1' })}\n${JSON.stringify({ jsonrpc: '2.0', method: 'e2' })}\n`,
    );
    await flush();
    expect(fired.map((n) => n.method)).toEqual(['e1', 'e2']);
  });

  it('reassembles a reply split across two chunks', async () => {
    const p = bridge.call('x');
    await flush();
    peerStdout.write('{"jsonrpc":"2.0","id":1,"res');
    await flush();
    peerStdout.write('ult":"reassembled"}\n');
    expect(await p).toBe('reassembled');
  });
});

describe('notifications', () => {
  it('fires every registered handler for an id-less message', async () => {
    const got: unknown[] = [];
    bridge.onNotification((n) => got.push(n.params));
    bridge.onNotification((n) => got.push(`2:${n.method}`));
    peerSend({ jsonrpc: '2.0', method: 'hello', params: { a: 1 } });
    await flush();
    expect(got).toEqual([{ a: 1 }, '2:hello']);
  });
});

describe('shutdown', () => {
  it('rejects in-flight calls and refuses new ones', async () => {
    const p = bridge.call('inflight').catch((e: Error) => e);
    bridge.shutdown(new Error('peer died'));
    expect(String(await p)).toContain('peer died');
    const after = await bridge.call('after').catch((e: Error) => e);
    expect(String(after)).toContain('bridge closed');
  });

  it('notify after shutdown is a silent no-op', async () => {
    bridge.shutdown();
    sent.length = 0;
    bridge.notify('event', { a: 1 });
    await flush();
    expect(sent.join('')).toBe('');
  });
});
