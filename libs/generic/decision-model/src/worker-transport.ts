/**
 * A decision transport whose answer survives a busy calling thread
 * (plan jev-memory-timeouts-to-zero-2026-10-01 P-008, evidence D-003).
 *
 * WHY. An in-thread fetch needs the calling thread's event loop to connect, send,
 * and read the response. When that thread is blocked (a synchronous fs walk, a long
 * callback, a GC), the request may not even be sent before the deadline, and an
 * answer that did arrive sits unread in the socket. Production measured 17 of 21
 * remaining timeouts with the calling thread's event-loop utilization at 0.9 or
 * more. The one-phase abort deferral in `createDeadline` (P-007) rescues only an
 * answer that a single poll phase can read in full.
 *
 * HOW. The HTTP exchange runs on one worker thread per transport. The worker owns a
 * keep-alive agent, sends the request at once, reads the whole response, and posts
 * `{ status, headers, text, transportMs }` on a per-call MessagePort. That is the
 * decisive change: the request goes out and the answer is complete however busy the
 * calling thread is, and handing it over is then ONE event. The calling thread
 * receives it in one of two ways:
 *  - as a 'message' event. After a block, that event is dispatched in the poll phase,
 *    which runs before the client's deferred abort (P-007), so it already wins;
 *  - when the deadline timer fires, by `receiveMessageOnPort`, synchronously, inside
 *    the client's deadline hook. This makes the hand-over independent of the order
 *    in which the loop dispatches the port message and the abort. Measured
 *    2026-10-02 with the hook stripped: the answer was still rescued, so the drain
 *    is a guarantee, not the fix.
 *
 * The worker enforces the same deadline on its own loop, so a provider that is
 * genuinely slow still times out at the deadline, measured where the request runs.
 *
 * The worker source is a CommonJS string evaluated with `eval: true` and uses only
 * Node built-ins. That keeps it free of the two failure classes a worker FILE has in
 * this repo: a host bundle that does not stage the file beside its entry, and a
 * `.ts` entry that the worker cannot load without the parent's loader hooks.
 */
import { performance } from 'node:perf_hooks';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import type { FetchLike } from './client.js';

/** Budget used when a caller passes no deadline. The client always passes one. */
const NO_DEADLINE_BUDGET_MS = 30_000;
/** Worker deaths after which the transport stops restarting it and uses the fallback. */
export const WORKER_TRANSPORT_MAX_FAILURES = 3;

const WORKER_SOURCE = String.raw`
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const http = require('node:http');
const https = require('node:https');

const idleMs = workerData.keepAliveIdleMs;
// keepAlive keeps the socket between calls; timeout is the idle limit of a pooled
// socket (the agent destroys a free socket when it fires). A server Keep-Alive hint
// can only shorten it.
const agents = {
  'http:': new http.Agent({ keepAlive: true, timeout: idleMs }),
  'https:': new https.Agent({ keepAlive: true, timeout: idleMs }),
};

function clock() {
  return performance.timeOrigin + performance.now();
}

function flattenHeaders(raw) {
  const out = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

parentPort.on('message', (call) => {
  const port = call.port;
  const started = performance.now();
  // Time the call waited between the calling thread posting it and this worker taking it.
  const queuedMs = typeof call.postedAt === 'number' ? Math.max(0, clock() - call.postedAt) : null;
  const controller = new AbortController();
  let done = false;
  let timer = null;
  let phase = 'started';

  // Tell the calling side how far the request got, so a deadline that passes on the
  // calling side before this worker replies still knows where the call was.
  function progress(next) {
    if (done) return;
    phase = next;
    try {
      port.postMessage({ progress: next, atMs: performance.now() - started, queuedMs });
    } catch {
      // The calling side already closed the port: nobody is waiting.
    }
  }

  function reply(message) {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    message.transportMs = performance.now() - started;
    message.phase = phase;
    message.queuedMs = queuedMs;
    try {
      port.postMessage(message);
    } catch {
      // The calling side already closed the port: nobody is waiting.
    }
  }
  progress('started');

  // The calling side closes the port once it has an outcome. If that happened before
  // the response completed (it gave up), stop the request. After a reply there is
  // nothing to stop, and the socket is already back in the pool.
  port.on('close', () => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    controller.abort();
  });

  timer = setTimeout(() => {
    controller.abort();
    reply({ ok: false, timedOut: true, error: 'transport deadline passed before the response completed' });
  }, Math.max(0, call.expiresAt - clock()));

  let url;
  try {
    url = new URL(call.url);
  } catch {
    reply({ ok: false, error: 'invalid url' });
    return;
  }
  const lib = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
  if (!lib) {
    reply({ ok: false, error: 'unsupported protocol ' + url.protocol });
    return;
  }

  const body = Buffer.from(call.body, 'utf8');
  const headers = {};
  for (const [name, value] of Object.entries(call.headers)) {
    if (name.toLowerCase() !== 'content-length') headers[name] = value;
  }
  headers['content-length'] = String(body.length);

  const req = lib.request(
    url,
    { method: call.method, headers, agent: agents[url.protocol], signal: controller.signal },
    (res) => {
      progress('headers');
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        reply({
          ok: true,
          status: res.statusCode || 0,
          headers: flattenHeaders(res.headers),
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('error', (err) => reply({ ok: false, error: err.message }));
      res.on('close', () => {
        if (!res.complete) reply({ ok: false, error: 'response closed before it completed' });
      });
    },
  );
  req.on('error', (err) => reply({ ok: false, error: err.message }));
  req.on('finish', () => progress('sent'));
  req.end(body);
});
`;

/** What the worker posts back for one call. */
type WorkerReply =
  | { ok: true; status: number; headers: Record<string, string>; text: string; transportMs: number }
  | { ok: false; error: string; timedOut?: boolean; transportMs: number };

export type WorkerTransportEvent =
  /** The worker died; calls in flight failed. It is restarted on the next call. */
  | { kind: 'worker-lost'; error: string; failures: number }
  /** The worker died too often; every later call goes through the fallback (or fails). */
  | { kind: 'fallback'; reason: string; hasFallback: boolean };

export interface WorkerTransportOptions {
  /** Idle time a pooled socket is kept by the worker's agent. */
  readonly keepAliveIdleMs: number;
  /**
   * Used for every call after the worker died {@link WORKER_TRANSPORT_MAX_FAILURES}
   * times. Without one, those calls fail (the client records network-error).
   */
  readonly fallback?: FetchLike;
  /** Told when the worker dies or the transport switches to the fallback. Never awaited. */
  readonly onEvent?: (event: WorkerTransportEvent) => void;
}

export interface WorkerTransport {
  readonly fetch: FetchLike;
  /** Which path calls take now. */
  mode(): 'worker' | 'fallback' | 'closed';
  /** Stop the worker. Calls in flight fail; later calls fail. */
  close(): Promise<void>;
  /** Test-only: terminate the current worker as a crash would (counts as a failure). */
  __killWorkerForTest(): Promise<void>;
}

function timeoutError(message: string): Error {
  return new DOMException(message, 'TimeoutError');
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

export function createWorkerTransport(options: WorkerTransportOptions): WorkerTransport {
  let worker: Worker | null = null;
  let failures = 0;
  let mode: 'worker' | 'fallback' | 'closed' = 'worker';
  /** Fail functions of calls waiting on the current worker. */
  const pending = new Set<(err: Error) => void>();

  function emit(event: WorkerTransportEvent): void {
    try {
      options.onEvent?.(event);
    } catch {
      // A faulty listener must not reach the call path.
    }
  }

  function failPending(err: Error): void {
    const waiting = [...pending];
    pending.clear();
    for (const fail of waiting) fail(err);
  }

  function lost(w: Worker, err: Error): void {
    if (worker !== w) return; // 'error' and 'exit' both fire for one death.
    worker = null;
    failures += 1;
    failPending(err);
    emit({ kind: 'worker-lost', error: err.message, failures });
    if (failures >= WORKER_TRANSPORT_MAX_FAILURES && mode === 'worker') {
      mode = 'fallback';
      emit({ kind: 'fallback', reason: `transport worker died ${failures} times`, hasFallback: Boolean(options.fallback) });
    }
  }

  function ensureWorker(): Worker {
    if (worker) return worker;
    const w = new Worker(WORKER_SOURCE, {
      eval: true,
      // The worker needs no loader hooks; inheriting the parent's (tsx) would only slow its start.
      execArgv: [],
      workerData: { keepAliveIdleMs: options.keepAliveIdleMs },
    });
    // An idle transport must not keep the process alive; a call in flight does, through its port.
    w.unref();
    w.on('error', (err) => lost(w, err instanceof Error ? err : new Error(String(err))));
    w.on('exit', (code) => lost(w, new Error(`transport worker exited with code ${code}`)));
    worker = w;
    return w;
  }

  const fetchViaWorker: FetchLike = (url, init) => {
    if (init.signal.aborted) return Promise.reject(abortReason(init.signal));
    const w = ensureWorker();
    const { port1, port2 } = new MessageChannel();
    const expiresAt = init.deadline?.expiresAt ?? performance.timeOrigin + performance.now() + NO_DEADLINE_BUDGET_MS;

    return new Promise((resolve, reject) => {
      let settled = false;
      let unhook: () => void = () => {};

      function settle(finish: () => void): void {
        if (settled) return;
        settled = true;
        unhook();
        init.signal.removeEventListener('abort', onAbort);
        pending.delete(onLost);
        port1.close();
        finish();
      }

      function accept(reply: WorkerReply): void {
        settle(() => {
          if (reply.ok) {
            const headers = reply.headers;
            resolve({
              status: reply.status,
              headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
              text: async () => reply.text,
              transportLatencyMs: reply.transportMs,
            });
          } else {
            reject(reply.timedOut ? timeoutError(reply.error) : new Error(reply.error));
          }
        });
      }

      /** Take an answer the worker already posted, without waiting for this thread's loop. */
      function drain(): void {
        const got = receiveMessageOnPort(port1);
        if (got) accept(got.message as WorkerReply);
      }

      function onAbort(): void {
        drain();
        settle(() => reject(abortReason(init.signal)));
      }

      function onLost(err: Error): void {
        settle(() => reject(err));
      }

      port1.on('message', (reply: WorkerReply) => accept(reply));
      init.signal.addEventListener('abort', onAbort, { once: true });
      if (init.deadline) unhook = init.deadline.onExpiring(drain);
      pending.add(onLost);
      try {
        w.postMessage(
          { url, method: init.method, headers: init.headers, body: init.body, expiresAt, port: port2 },
          [port2],
        );
      } catch (err) {
        onLost(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  return {
    fetch: (url, init) => {
      if (mode === 'worker') return fetchViaWorker(url, init);
      if (mode === 'fallback' && options.fallback) return options.fallback(url, init);
      return Promise.reject(new Error(mode === 'closed' ? 'worker transport closed' : 'worker transport unavailable'));
    },
    mode: () => mode,
    async close() {
      mode = 'closed';
      const w = worker;
      worker = null;
      failPending(new Error('worker transport closed'));
      if (w) await w.terminate();
    },
    async __killWorkerForTest() {
      const w = worker;
      if (w) await w.terminate();
    },
  };
}
