/**
 * Origin-wide finite-fetch scheduling for the portal bootstrap (P-019).
 *
 * `@papercusp/sync` already owns the process-pinned scheduler used by named
 * sync queries.  The portal also has a large set of imperative callers
 * (authentication, lifecycle actions, route loaders, and small shell reads)
 * that quite reasonably call `fetch` directly.  Patching each caller would
 * create a second policy surface and would miss the next caller.  This adapter
 * wraps the fetch function once, after the desktop/workspace wrappers have
 * installed, so every operator API request shares the same origin scheduler.
 *
 * The wrapper is deliberately narrow:
 *   - only operator-owned `/api/*` URLs are scheduled;
 *   - `rest-query` is already admitted by the sync fetcher and is skipped to
 *     avoid nested admission;
 *   - long-lived/streaming requests are left to their transport owners (P-020
 *     and P-021);
 *   - the captured fetch is still the next layer, so desktop `ipcFetch` and
 *     its idempotent/ambiguous-write retry policy remain authoritative.
 */

import {
  getOriginScheduler,
  type OriginSchedulerClass,
  type OriginSchedulerRunOptions,
} from '@papercusp/sync';
import { isOperatorApiUrl } from './workspace-api-target';

const WRAPPED_MARK = '__pcOriginSchedulerFetchWrapped__';

/** Sync's named-query fetcher already owns this path's scheduler admission. */
const REST_QUERY_SUFFIX = '/rest-query';

/**
 * A fetch whose response is intentionally long-lived must not be held in the
 * finite request queue.  EventSource is handled by the SSE adapter, but fetch
 * is also used for POST-SSE and relay handshakes.  The explicit response hint
 * is the reliable discriminator; the small path suffix set covers the canonical
 * control streams without classifying finite lifecycle endpoints such as
 * `/pty/spawn` as streams.
 */
const STREAM_PATH_SUFFIXES = ['/sse', '/events', '/event-stream'] as const;

const SAFE_READ_METHODS = new Set(['GET', 'HEAD']);
const NON_MUTATING_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface OriginSchedulerFetchDecision {
  schedule: boolean;
  /** Why a request was bypassed; useful in tests and diagnostics. */
  reason?:
    | 'not-browser'
    | 'not-operator-api'
    | 'sync-query'
    | 'stream'
    | 'bulk';
  origin?: string;
  requestClass?: OriginSchedulerClass;
  method?: string;
}

interface InstallHandle {
  uninstall: () => void;
}

type FetchWithMarker = typeof window.fetch & { [WRAPPED_MARK]?: boolean };

function rawUrlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  // `RequestInfo` is a union whose Request member is available in browsers;
  // the structural fallback also handles cross-realm Request objects in an
  // embedded webview where `instanceof Request` can be false.
  const candidate = input as Request;
  return typeof candidate?.url === 'string' ? candidate.url : String(input);
}

function requestSignalOf(input: RequestInfo | URL, init?: RequestInit): AbortSignal | undefined {
  if (init?.signal) return init.signal;
  const candidate = input as Request;
  return candidate && typeof candidate === 'object' && 'signal' in candidate
    ? (candidate.signal as AbortSignal | undefined)
    : undefined;
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  const candidate = input as Request;
  const method = init?.method ?? (candidate && typeof candidate === 'object' ? candidate.method : undefined);
  return String(method ?? 'GET').toUpperCase();
}

function headersOf(input: RequestInfo | URL, init?: RequestInit): Headers {
  const candidate = input as Request;
  // Constructing Headers is intentionally best effort: native fetch will
  // still perform its own validation, while a malformed test double should
  // not make the scheduler wrapper swallow the call.
  try {
    return new Headers(init?.headers ?? (candidate && typeof candidate === 'object' ? candidate.headers : undefined));
  } catch {
    return new Headers();
  }
}

function isStreamRequest(url: URL, input: RequestInfo | URL, init?: RequestInit): boolean {
  const headers = headersOf(input, init);
  const accept = headers.get('accept')?.toLowerCase() ?? '';
  if (accept.includes('text/event-stream')) return true;
  if (STREAM_PATH_SUFFIXES.some((suffix) => url.pathname.endsWith(suffix))) return true;
  // A range request or a streaming upload belongs to the bulk/reverse-
  // connector lane (P-021), not the finite control queue.
  if (headers.has('range')) return true;
  const duplex = (init as (RequestInit & { duplex?: unknown }) | undefined)?.duplex;
  if (duplex === 'half') return true;
  const body = init?.body;
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return true;
  return false;
}

/**
 * Classify the request without touching the scheduler.  Exported so the
 * recurrence tests can prove that a new raw caller is covered by the same
 * boundary as existing callers.
 */
export function classifyOriginSchedulerFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): OriginSchedulerFetchDecision {
  if (typeof window === 'undefined') return { schedule: false, reason: 'not-browser' };

  const rawUrl = rawUrlOf(input);
  if (!isOperatorApiUrl(rawUrl)) return { schedule: false, reason: 'not-operator-api' };

  let url: URL;
  try {
    url = new URL(rawUrl, window.location.href);
  } catch {
    return { schedule: false, reason: 'not-operator-api' };
  }

  const method = methodOf(input, init);
  if (url.pathname.endsWith(REST_QUERY_SUFFIX)) {
    return { schedule: false, reason: 'sync-query', origin: url.origin, method };
  }
  if (isStreamRequest(url, input, init)) {
    return { schedule: false, reason: 'stream', origin: url.origin, method };
  }

  // Writes are interactive-control work so a background/read wave cannot
  // consume the reserved lane. OPTIONS is a browser preflight and remains a
  // foreground read; all other safe methods are foreground reads as well.
  const requestClass: OriginSchedulerClass = NON_MUTATING_METHODS.has(method)
    ? 'foreground-read'
    : 'interactive-control';
  return { schedule: true, origin: url.origin, requestClass, method };
}

/** Whether the method is safe for a transparent retry. Kept private to this
 * adapter so the scheduler never acquires retry semantics of its own. */
export function isIdempotentReadMethod(method: string): boolean {
  return SAFE_READ_METHODS.has(method.toUpperCase());
}

/**
 * Install the one global fetch wrapper.  The current function is captured and
 * called for the actual request, preserving whatever transport wrapper was
 * installed before us (desktop IPC, workspace headers, or native HTTP).
 */
export function installOriginSchedulerFetch(): InstallHandle | null {
  if (typeof window === 'undefined') return null;
  const current = window.fetch as FetchWithMarker | undefined;
  if (!current || current[WRAPPED_MARK]) return null;

  const original = current;
  const inner = current.bind(window);

  const wrapped = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const decision = classifyOriginSchedulerFetch(input, init);
    if (!decision.schedule || !decision.origin || !decision.requestClass) {
      return inner(input, init);
    }

    const scheduler = getOriginScheduler(decision.origin);
    const signal = requestSignalOf(input, init);
    const runOptions: OriginSchedulerRunOptions = {
      class: decision.requestClass,
      ...(signal ? { signal } : {}),
    };

    return scheduler.run(
      (schedulerSignal, context) => {
        // Keep the caller's Request/RequestInit merge semantics intact.  The
        // scheduler signal is the only override: it chains caller cancellation
        // and guarantees a total deadline can release a stuck slot.
        const nextInit: RequestInit = { ...(init ?? {}), signal: schedulerSignal };
        return inner(input, nextInit).then((response) => {
          const length = response.headers.get('content-length');
          if (length !== null) {
            const bytes = Number(length);
            if (Number.isFinite(bytes) && bytes >= 0) context.recordBytes(bytes);
          }
          context.recordProtocol(response.headers.get('x-papercusp-protocol'));
          return response;
        });
      },
      runOptions,
    );
  }) as FetchWithMarker;

  wrapped[WRAPPED_MARK] = true;
  window.fetch = wrapped;

  return {
    uninstall: () => {
      // Do not clobber a later wrapper installed by a host or test.  If the
      // identity changed, the caller that owns that newer layer must unwind it.
      if (window.fetch === wrapped) window.fetch = original;
    },
  };
}

