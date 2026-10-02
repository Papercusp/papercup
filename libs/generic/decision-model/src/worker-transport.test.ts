/**
 * The worker transport keeps an answer that arrived while the calling thread was
 * blocked (plan jev-memory-timeouts-to-zero-2026-10-01 P-008, D-003).
 *
 * Real HTTP, real threads. The server runs in its OWN worker thread: a server on
 * the test's thread would be blocked along with the client and could not answer,
 * which is not the production shape (Jev is another machine).
 *
 * The block starts the instant the transport is called, inside the fetch call, so
 * the request has been handed over but the calling thread can run nothing until
 * after the deadline. That is the worst case for an in-thread fetch: it cannot even
 * send the request. The first test pins that as a positive control.
 */
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDecisionClient,
  createJevProvider,
  createWorkerTransport,
  WORKER_TRANSPORT_MAX_FAILURES,
  type DecisionCallRecord,
  type DecisionRequest,
  type FetchLike,
  type WorkerTransport,
  type WorkerTransportEvent,
} from './index.js';

const ANSWER = {
  model: 'jev-1.13.0',
  answers: { relevant: { type: 'noul', noul: 0.9 } },
  usage: { input_tokens: 10, output_tokens: 1 },
};

const request = {
  state: 'turn text',
  questions: { relevant: { type: 'yesNo', instructions: 'Relevant?' } },
} as const satisfies DecisionRequest;

/** Production's Jev budget. */
const DEADLINE_MS = 800;
/** Server answer time well inside the deadline. */
const FAST_MS = 100;
/** How long the calling thread is held: past the deadline. */
const BLOCK_MS = 1_100;
/** A provider that has genuinely not answered by the deadline. */
const SLOW_MS = 1_200;

const SERVER_SOURCE = String.raw`
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const http = require('node:http');
const stats = { connections: 0, requests: 0, aborted: 0 };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  if (url.pathname === '/stats') {
    res.end(JSON.stringify(stats));
    return;
  }
  stats.requests += 1;
  const delay = Number(url.searchParams.get('delay') || 0);
  req.resume();
  req.on('end', () => {
    const timer = setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(workerData.body) });
      res.end(workerData.body);
    }, delay);
    res.on('close', () => {
      if (!res.writableFinished) {
        stats.aborted += 1;
        clearTimeout(timer);
      }
    });
  });
});
server.on('connection', () => { stats.connections += 1; });
server.keepAliveTimeout = 60000;
server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
`;

let serverThread: Worker;
let baseUrl = '';
const transports: WorkerTransport[] = [];

beforeAll(async () => {
  serverThread = new Worker(SERVER_SOURCE, { eval: true, execArgv: [], workerData: { body: JSON.stringify(ANSWER) } });
  const port = await new Promise<number>((resolve, reject) => {
    serverThread.once('message', resolve);
    serverThread.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await Promise.all(transports.map((t) => t.close()));
  await serverThread.terminate();
});

async function serverStats(): Promise<{ connections: number; requests: number; aborted: number }> {
  const res = await fetch(`${baseUrl}/stats`);
  return (await res.json()) as { connections: number; requests: number; aborted: number };
}

function blockThread(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // Deliberately synchronous: this is the busy calling thread under test.
  }
}

/** Send to the local server (with a chosen answer delay), then hold the calling thread. */
function toServer(inner: FetchLike, delayMs: number, blockMs = 0): FetchLike {
  return (_url, init) => {
    const pending = inner(`${baseUrl}/v1/decide?delay=${delayMs}`, init);
    if (blockMs > 0) blockThread(blockMs);
    return pending;
  };
}

function newTransport(options: { fallback?: FetchLike; events?: WorkerTransportEvent[] } = {}): WorkerTransport {
  const t = createWorkerTransport({
    keepAliveIdleMs: 30_000,
    fallback: options.fallback,
    onEvent: (e) => options.events?.push(e),
  });
  transports.push(t);
  return t;
}

function client(fetchImpl: FetchLike, onCall?: (r: DecisionCallRecord) => void) {
  return createDecisionClient({
    provider: createJevProvider(),
    resolveKey: () => 'ts-test-key',
    timeoutMs: DEADLINE_MS,
    fetch: fetchImpl,
    onCall,
  });
}

const inThreadFetch: FetchLike = (url, init) => fetch(url, init);

describe('worker transport vs a blocked calling thread', () => {
  it('positive control: an in-thread fetch loses a fast answer when the thread is blocked past the deadline', async () => {
    // If this ever answers, the scenario no longer reproduces the defect and the
    // next test would pass vacuously. Do not delete or loosen it.
    const out = await client(toServer(inThreadFetch, FAST_MS, BLOCK_MS)).decide(request);
    expect(out).toMatchObject({ kind: 'inconclusive', reason: 'timeout' });
  });

  it('answers when the provider answered in time while the calling thread was blocked past the deadline', async () => {
    const transport = newTransport();
    const records: DecisionCallRecord[] = [];
    const out = await client(toServer(transport.fetch, FAST_MS, BLOCK_MS), (r) => records.push(r)).decide(request);
    expect(out).toMatchObject({ kind: 'answered', model: 'jev-1.13.0', answers: { relevant: { pYes: 0.9 } } });
    // The caller saw the whole block; the transport saw only the provider.
    expect(out.latencyMs).toBeGreaterThanOrEqual(BLOCK_MS - 50);
    expect(records).toHaveLength(1);
    const transportMs = records[0]!.transportLatencyMs;
    expect(transportMs).not.toBeNull();
    expect(transportMs!).toBeGreaterThanOrEqual(FAST_MS - 10);
    expect(transportMs!).toBeLessThan(DEADLINE_MS);
  });

  it('still times out at the deadline when the provider genuinely has not answered', async () => {
    const transport = newTransport();
    await client(toServer(transport.fetch, 0)).decide(request); // warm the worker and its socket
    const before = await serverStats();
    const records: DecisionCallRecord[] = [];
    const t0 = performance.now();
    const out = await client(toServer(transport.fetch, SLOW_MS), (r) => records.push(r)).decide(request);
    const elapsed = performance.now() - t0;
    expect(out).toMatchObject({ kind: 'inconclusive', reason: 'timeout' });
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 20);
    expect(elapsed).toBeLessThan(SLOW_MS - 100);
    expect(records[0]!.transportLatencyMs).toBeNull();
    // The worker gave up on the request instead of letting it run on.
    await expect.poll(async () => (await serverStats()).aborted - before.aborted, { timeout: 2_000 }).toBe(1);
  });

  it('times out on the worker-measured deadline even when the calling thread is also blocked', async () => {
    const transport = newTransport();
    const out = await client(toServer(transport.fetch, SLOW_MS, BLOCK_MS)).decide(request);
    expect(out).toMatchObject({ kind: 'inconclusive', reason: 'timeout' });
  });

  it('reuses one connection across calls (the worker owns a keep-alive agent)', async () => {
    const transport = newTransport();
    const before = await serverStats();
    const c = client(toServer(transport.fetch, 0));
    for (let i = 0; i < 3; i += 1) {
      expect(await c.decide(request)).toMatchObject({ kind: 'answered' });
    }
    const after = await serverStats();
    expect(after.requests - before.requests).toBe(3);
    expect(after.connections - before.connections).toBe(1);
  });
});

describe('worker transport failure handling', () => {
  it('a call in flight fails at once when the worker dies, and the next call restarts it', async () => {
    const events: WorkerTransportEvent[] = [];
    const transport = newTransport({ events });
    const c = client(toServer(transport.fetch, 500));
    const t0 = performance.now();
    const pending = c.decide(request);
    await new Promise((r) => setTimeout(r, 100));
    await transport.__killWorkerForTest();
    const out = await pending;
    expect(out).toMatchObject({ kind: 'inconclusive', reason: 'network-error' });
    expect(performance.now() - t0).toBeLessThan(DEADLINE_MS);
    expect(events).toEqual([expect.objectContaining({ kind: 'worker-lost', failures: 1 })]);
    expect(transport.mode()).toBe('worker');
    expect(await client(toServer(transport.fetch, 0)).decide(request)).toMatchObject({ kind: 'answered' });
  });

  it(`switches to the fallback after ${WORKER_TRANSPORT_MAX_FAILURES} worker deaths, and says so`, async () => {
    const events: WorkerTransportEvent[] = [];
    let fallbackCalls = 0;
    const fallback: FetchLike = (url, init) => {
      fallbackCalls += 1;
      return inThreadFetch(url, init);
    };
    const transport = newTransport({ fallback, events });
    const c = client(toServer(transport.fetch, 0));
    for (let i = 0; i < WORKER_TRANSPORT_MAX_FAILURES; i += 1) {
      expect(await c.decide(request)).toMatchObject({ kind: 'answered' }); // (re)starts the worker
      await transport.__killWorkerForTest();
    }
    expect(transport.mode()).toBe('fallback');
    expect(events.at(-1)).toEqual({ kind: 'fallback', reason: expect.any(String), hasFallback: true });
    expect(await c.decide(request)).toMatchObject({ kind: 'answered' });
    expect(fallbackCalls).toBe(1);
  });

  it('after close, calls fail instead of starting a new worker', async () => {
    const transport = newTransport();
    await transport.close();
    expect(transport.mode()).toBe('closed');
    expect(await client(toServer(transport.fetch, 0)).decide(request)).toMatchObject({
      kind: 'inconclusive',
      reason: 'network-error',
    });
  });
});
