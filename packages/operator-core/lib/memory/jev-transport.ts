/**
 * Jev transport — keep ONE connection to api.typesafe.ai open between decision calls
 * (plan jev-memory-timeouts-to-zero-2026-10-01 P-006, EI-24748208098755918).
 *
 * Why this exists (measured 2026-10-01 21:20-21:35Z):
 *  - Global `fetch` uses undici's default dispatcher, which closes a socket after
 *    4 s idle when the server sends no `Keep-Alive` hint (api.typesafe.ai sends none).
 *  - Each operator process calls Jev roughly every 10 s, so the socket was almost
 *    always gone: a 75 s bpftrace connect() probe counted 48 new TCP connections to
 *    the Jev IPs against ~75 ledger calls.
 *  - A new connection costs a getaddrinfo on the 4-thread libuv pool (queued behind
 *    any async fs work on a busy host) plus TCP and TLS: +30-90 ms after a short idle,
 *    400-1400 ms fully cold — against the 800 ms decision budget. A reused socket
 *    answers the same transport probe in ~107 ms p50.
 *
 * The idle window is a deliberate number below the server's own idle limit: if we
 * keep a socket the server has already closed, the next POST fails (undici never
 * retries a non-idempotent request), which would turn a slow call into a lost one.
 */
import type { FetchLike } from '@papercusp/decision-model';
import { pinModuleState } from '@papercusp/module-singleton';
import { Agent } from 'undici';

/**
 * How long an idle Jev socket is kept. api.typesafe.ai (Cloudflare) was measured on
 * 2026-10-01 to reuse one idle HTTP/1.1 connection after 15, 30, 60, 90 and 120 s of
 * idle (.papercusp/scratch/jev-idle-limit.mts), so its limit is at least
 * JEV_SERVER_IDLE_OBSERVED_MS; 90 s keeps a 30 s margin inside that floor.
 */
export const JEV_SERVER_IDLE_OBSERVED_MS = 120_000;
export const JEV_KEEPALIVE_IDLE_MS = 90_000;

export interface JevDispatcherOptions {
  /** Idle time before a pooled socket is closed. Default {@link JEV_KEEPALIVE_IDLE_MS}. */
  readonly keepAliveTimeoutMs?: number;
}

/** A keep-alive undici Agent for decision-model traffic. */
export function createJevDispatcher(options: JevDispatcherOptions = {}): Agent {
  const idleMs = options.keepAliveTimeoutMs ?? JEV_KEEPALIVE_IDLE_MS;
  return new Agent({
    keepAliveTimeout: idleMs,
    // Caps any Keep-Alive hint the server might start sending, so a hint can only
    // shorten our window, never stretch it past the measured server limit.
    keepAliveMaxTimeout: idleMs,
  });
}

const state = pinModuleState('@papercusp/operator-core.jev-transport', () => ({
  dispatcher: null as Agent | null,
}));

/** The process-wide Jev dispatcher, created on first use. */
export function jevDispatcher(): Agent {
  if (!state.dispatcher) state.dispatcher = createJevDispatcher();
  return state.dispatcher;
}

/**
 * Build a {@link FetchLike} that sends every request through `dispatcher`.
 * It calls the GLOBAL fetch, resolved per call, so anything that stubs `fetch`
 * (tests, instrumentation) still intercepts; Node's bundled undici fetch accepts an
 * npm-undici v7 Agent as its dispatcher (proved by jev-transport.test.ts).
 */
export function fetchVia(dispatcher: Agent): FetchLike {
  return (url, init) => globalThis.fetch(url, { ...init, dispatcher } as RequestInit);
}

/** The fetch the Jev decision client uses: the shared keep-alive dispatcher. */
export const jevFetch: FetchLike = (url, init) => fetchVia(jevDispatcher())(url, init);

export async function __resetJevTransportForTest(): Promise<void> {
  const d = state.dispatcher;
  state.dispatcher = null;
  if (d) await d.close();
}
