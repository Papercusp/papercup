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

import { pinModuleState } from '@papercusp/module-singleton';
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
 * is the reliable discriminator; the narrow path-pattern set covers canonical
 * control streams without classifying finite lifecycle endpoints such as
 * `/pty/spawn` as streams.
 */
// Path hints are only a fallback for callers that open a stream with `fetch`
// and forget to advertise `Accept: text/event-stream`. Do not use a generic
// `/events` suffix here: `/api/backups/events` is a finite JSON history query
// and must still enter the origin scheduler. Keep this list aligned with the
// route-owned stream contracts; response content-type remains the server's
// authoritative signal once a request is actually opened.
const STREAM_PATH_PATTERNS: readonly RegExp[] = [
  /\/sse$/,
  /\/stream$/,
  /-stream$/,
  /\/event-stream$/,
  /\/state-snapshot$/,
  /\/frame-view$/,
  /\/admin\/run$/,
  /\/session\/thinking$/,
  /\/su-session\/events$/,
  /\/agent-mcp\/events$/,
  /\/plugins\/host\/events$/,
  /\/hosted\/connectors\/events$/,
];

// Bulk/media traffic has a separate BYOC lane (P-021). It must not consume
// the finite control queue, even when the caller uses a plain fetch.
const BULK_PATH_PATTERNS: readonly RegExp[] = [/\/updates\/download$/];

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
  return STREAM_PATH_PATTERNS.some((pattern) => pattern.test(url.pathname));
}

function isBulkRequest(url: URL, input: RequestInfo | URL, init?: RequestInit): boolean {
  const headers = headersOf(input, init);
  if (BULK_PATH_PATTERNS.some((pattern) => pattern.test(url.pathname))) return true;
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
  if (isBulkRequest(url, input, init)) {
    return { schedule: false, reason: 'bulk', origin: url.origin, method };
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
 * Single-flight coalescing for identical concurrent idempotent reads.
 *
 * The finite queue is only `CONNECTION_CAPPED_MAX_IN_FLIGHT` (2) slots wide on
 * a real connection-capped path — a plain browser tab, and the desktop's
 * pre-IPC-ready startup window. Startup measurably issues the SAME read more
 * than once: duplicate bootstrap/options, auth, and profile requests were
 * observed sharing that two-slot queue with visible reads and delaying
 * dispatch by up to 6.040s (EI-22365555120139128, rolled up under
 * EI-22367004519166693). Every duplicate burns one of the two slots to fetch
 * bytes the page is already fetching.
 *
 * Coalescing is applied ONLY where it is semantically transparent:
 *   - a safe method (GET/HEAD — the same bar `isIdempotentReadMethod` already
 *     uses for transparent retry). OPTIONS is excluded because a CORS preflight
 *     is issued by the browser itself and never passes through `window.fetch`;
 *   - no request body;
 *   - a byte-identical request identity: same absolute URL AND every
 *     `RequestInit` field that can change the response (headers, credentials,
 *     cache, redirect, mode, integrity).
 * Anything else runs on its own, so two requests that could legitimately
 * differ are never merged.
 *
 * The shared request runs on its OWN `AbortController` rather than on any one
 * caller's signal: a caller cancelling must not cancel the read another caller
 * is still waiting on. Waiters are ref-counted and the shared read is aborted
 * only when the LAST of them goes away, which preserves today's cancellation
 * behaviour exactly for the uncoalesced single-caller case.
 *
 * This is strictly an IN-FLIGHT concern, never a response cache: the entry is
 * dropped the moment the shared read settles, so a later identical read always
 * goes to the network.
 */
interface InFlightRead {
  promise: Promise<Response>;
  /** Waiters still expecting a response; the shared read aborts at zero. */
  waiting: number;
  /** Total joiners ever — decides whether a response must be cloned. */
  joined: number;
  controller: AbortController | null;
}

/** Pinned per the shared-lib singleton rule: a second module record would give
 *  the wrapper a second, empty map and silently stop coalescing. */
const dedupeState = pinModuleState(
  '@papercusp/operator-core.transport-adapters.origin-scheduler-fetch',
  () => ({ inFlightReads: new Map<string, InFlightRead>() }),
);

/** Test seam: coalescing is in-flight state, so a suite that installs the
 *  wrapper repeatedly must be able to start from an empty map. */
export function _resetOriginSchedulerFetchDedupeForTests(): void {
  dedupeState.inFlightReads.clear();
}

/** Everything about a request, other than method and URL, that can change the
 *  response. Two requests may only be coalesced when this matches exactly. */
function requestVariantOf(input: RequestInfo | URL, init?: RequestInit): string {
  const req =
    typeof input === 'object' && input !== null ? (input as Partial<Request>) : undefined;
  const headers = headersOf(input, init);
  const entries: string[] = [];
  headers.forEach((value, name) => {
    entries.push(`${name}:${value}`);
  });
  entries.sort();
  // JSON keeps the key unambiguous without embedding a control-byte delimiter
  // (`lint:no-control-bytes` is a green-checkpoint leg).
  return JSON.stringify([
    init?.credentials ?? req?.credentials ?? '',
    init?.cache ?? req?.cache ?? '',
    init?.redirect ?? req?.redirect ?? '',
    init?.mode ?? req?.mode ?? '',
    init?.integrity ?? req?.integrity ?? '',
    entries,
  ]);
}

function hasRequestBody(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (init && init.body !== undefined && init.body !== null) return true;
  const req =
    typeof input === 'object' && input !== null ? (input as Partial<Request>) : undefined;
  return Boolean(req && 'body' in req && req.body);
}

/** The coalescing key, or `null` when this request must run on its own. */
function coalescableReadKey(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  decision: OriginSchedulerFetchDecision,
): string | null {
  const method = decision.method ?? methodOf(input, init);
  if (!SAFE_READ_METHODS.has(method)) return null;
  if (hasRequestBody(input, init)) return null;
  let href: string;
  try {
    href = new URL(rawUrlOf(input), window.location.href).href;
  } catch {
    return null;
  }
  return JSON.stringify([method, href, requestVariantOf(input, init)]);
}

function abortErrorOf(signal: AbortSignal | undefined): unknown {
  const reason = signal ? (signal as AbortSignal & { reason?: unknown }).reason : undefined;
  if (reason !== undefined) return reason;
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/** Attach one caller to an in-flight shared read. */
function joinInFlightRead(entry: InFlightRead, signal: AbortSignal | undefined): Promise<Response> {
  entry.joined += 1;
  if (signal?.aborted) return Promise.reject(abortErrorOf(signal));

  entry.waiting += 1;
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      // Only THIS caller gives up. The shared read is abandoned solely when
      // the last waiter has gone, so a peer still awaiting it is unaffected.
      entry.waiting -= 1;
      if (entry.waiting <= 0) entry.controller?.abort();
      reject(abortErrorOf(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    entry.promise.then(
      (response) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        // A single consumer owns the response outright; cloning would buffer
        // the body for nothing. Only a genuinely coalesced read needs a copy,
        // and a test double without `clone` is handed the response as-is.
        resolve(
          entry.joined > 1 && typeof response.clone === 'function' ? response.clone() : response,
        );
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function runScheduledFetch(
  inner: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  origin: string,
  requestClass: OriginSchedulerClass,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const scheduler = getOriginScheduler(origin);
  const runOptions: OriginSchedulerRunOptions = {
    class: requestClass,
    ...(signal ? { signal } : {}),
  };

  return scheduler.run((schedulerSignal, context) => {
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
  }, runOptions);
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

    const { origin, requestClass } = decision;
    const signal = requestSignalOf(input, init);

    const key = coalescableReadKey(input, init, decision);
    if (key === null) return runScheduledFetch(inner, input, init, origin, requestClass, signal);

    const { inFlightReads } = dedupeState;
    const existing = inFlightReads.get(key);
    if (existing) return joinInFlightRead(existing, signal);

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const entry: InFlightRead = {
      promise: runScheduledFetch(inner, input, init, origin, requestClass, controller?.signal),
      waiting: 0,
      joined: 0,
      controller,
    };
    inFlightReads.set(key, entry);

    // In-flight only, never a cache: drop the entry the moment it settles so a
    // later identical read always reaches the network.
    const drop = (): void => {
      if (inFlightReads.get(key) === entry) inFlightReads.delete(key);
    };
    void entry.promise.then(drop, drop);

    return joinInFlightRead(entry, signal);
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
