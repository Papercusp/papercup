import type { GatewayLaneDescriptor, GatewayTransportId } from './provider-adapters';
import {
  GatewayRequestTelemetry,
  classifyGatewayTelemetryOutcome,
  type GatewayRequestOutcome,
  type GatewayRequestTimeline,
  type GatewayTelemetryProvider,
} from './request-stage-telemetry';

type MaybePromise<T> = T | Promise<T>;

export type GatewayKernelPinMode = 'hard' | 'soft' | 'none';

export interface GatewayKernelAccountPin {
  accountId: string;
  mode: Exclude<GatewayKernelPinMode, 'none'>;
}

export interface GatewayKernelRoute<T> {
  /** Stable identity used to prevent retry cycles. */
  key: string;
  /** Account identity when this is an account-backed route. */
  accountId?: string | null;
  transport: GatewayTransportId;
  value: T;
}

export interface GatewayKernelPolicy {
  maxBodyBytes: number;
  bodyReadTimeoutMs: number;
  requestCeilingMs: number;
  ttfbTimeoutMs: number;
  bodyIdleTimeoutMs: number;
  downstreamIdleTimeoutMs: number;
  maxAttempts: number;
}

export interface GatewayKernelRequest {
  lane: GatewayLaneDescriptor;
  body: AsyncIterable<Uint8Array | string>;
  ownerId?: string | null;
  correlationId?: string;
  pin?: GatewayKernelAccountPin | null;
  /** Caller/request cancellation. */
  signal?: AbortSignal;
}

export interface GatewayKernelContext {
  requestId: number;
  correlationId: string;
  lane: GatewayLaneDescriptor;
  ownerId: string | null;
  pin: GatewayKernelAccountPin | null;
  signal: AbortSignal;
  startedAt: number;
}

export interface GatewayKernelRouteContext<T, TChunk = unknown, TMetadata = unknown> extends GatewayKernelContext {
  currentRoute: GatewayKernelRoute<T> | null;
  triedRouteKeys: readonly string[];
  attempt: number;
  lastResponse: GatewayKernelUpstreamResponse<TChunk, TMetadata> | null;
  lastError: GatewayRequestKernelError | null;
}

export interface GatewayKernelAttemptContext<T> extends GatewayKernelContext {
  route: GatewayKernelRoute<T>;
  body: Buffer;
  attempt: number;
  maxAttempts: number;
  triedRouteKeys: readonly string[];
}

export interface GatewayKernelUpstreamResponse<TChunk, TMetadata> {
  status: number;
  streaming: boolean;
  transport: GatewayTransportId;
  metadata: TMetadata;
  body: AsyncIterable<TChunk> | null;
  /** Normalized at the protocol/transport boundary. */
  retryable?: boolean;
  /** Optional standardized override when status alone is insufficient. */
  outcome?: GatewayRequestOutcome;
  /** Release a response body/socket that will not be forwarded because the kernel retries. */
  discard?: () => MaybePromise<void>;
}

export interface GatewayKernelAttemptFeedback<TRoute, TChunk, TMetadata> {
  context: GatewayKernelAttemptContext<TRoute>;
  response: GatewayKernelUpstreamResponse<TChunk, TMetadata> | null;
  error: GatewayRequestKernelError | null;
}

export interface GatewayKernelAdmissionLease {
  release(result: { outcome: GatewayRequestOutcome; status: number | null }): MaybePromise<void>;
}

export interface GatewayKernelAdmissionController<TRoute, TChunk, TMetadata> {
  acquire(
    context: GatewayKernelContext & { route: GatewayKernelRoute<TRoute> },
  ): MaybePromise<GatewayKernelAdmissionLease>;
  /** AIMD/rate feedback remains lane-specific data, but the kernel guarantees one callback per attempt. */
  observeAttempt?(feedback: GatewayKernelAttemptFeedback<TRoute, TChunk, TMetadata>): MaybePromise<void>;
}

export interface GatewayKernelAdapter<TRoute, TPrepared, TChunk, TMetadata> {
  selectInitial(
    context: GatewayKernelRouteContext<TRoute, TChunk, TMetadata>,
  ): MaybePromise<GatewayKernelRoute<TRoute>>;
  selectFailover(
    context: GatewayKernelRouteContext<TRoute, TChunk, TMetadata>,
  ): MaybePromise<GatewayKernelRoute<TRoute> | null>;
  /** Protocol/transport-owned parsing, auth, URL, header, model, and cache work. */
  prepareAttempt(context: GatewayKernelAttemptContext<TRoute>): MaybePromise<TPrepared>;
  /** Returns a response whose retryability/outcome has already been normalized at the boundary. */
  executeAttempt(
    prepared: TPrepared,
    context: GatewayKernelAttemptContext<TRoute>,
  ): Promise<GatewayKernelUpstreamResponse<TChunk, TMetadata>>;
}

export interface GatewayKernelDownstream<TChunk, TMetadata> {
  /** Downstream disconnect/backpressure cancellation. */
  signal?: AbortSignal;
  start(response: {
    status: number;
    streaming: boolean;
    transport: GatewayTransportId;
    metadata: TMetadata;
  }): MaybePromise<void>;
  write(chunk: TChunk): MaybePromise<void>;
  end(): MaybePromise<void>;
}

export interface GatewayKernelInFlightEntry {
  requestId: number;
  correlationId: string;
  laneId: GatewayLaneDescriptor['id'];
  provider: GatewayTelemetryProvider;
  startedAt: number;
  isStreaming: () => boolean;
  abort: (reason: string) => void;
}

export interface GatewayKernelInFlightHandle {
  unregister(result: { outcome: GatewayRequestOutcome; status: number | null }): MaybePromise<void>;
}

export interface GatewayKernelInFlightRegistry {
  register(entry: GatewayKernelInFlightEntry): MaybePromise<GatewayKernelInFlightHandle>;
}

export interface ExecuteGatewayRequestKernelOptions<TRoute, TPrepared, TChunk, TMetadata> {
  request: GatewayKernelRequest;
  policy: GatewayKernelPolicy;
  telemetry: GatewayRequestTelemetry;
  admission: GatewayKernelAdmissionController<TRoute, TChunk, TMetadata>;
  adapter: GatewayKernelAdapter<TRoute, TPrepared, TChunk, TMetadata>;
  downstream: GatewayKernelDownstream<TChunk, TMetadata>;
  inFlight: GatewayKernelInFlightRegistry;
}

export interface GatewayKernelExecutionResult<TRoute> {
  requestId: number;
  correlationId: string;
  laneId: GatewayLaneDescriptor['id'];
  status: number;
  outcome: GatewayRequestOutcome;
  attempts: number;
  failovers: number;
  finalRoute: GatewayKernelRoute<TRoute>;
  timeline: GatewayRequestTimeline;
}

export type GatewayRequestKernelErrorCode =
  | 'invalid-policy'
  | 'invalid-pin'
  | 'invalid-route'
  | 'route-cycle'
  | 'body-too-large'
  | 'body-read-timeout'
  | 'request-ceiling'
  | 'ttfb-timeout'
  | 'upstream-body-idle'
  | 'downstream-idle'
  | 'cancelled'
  | 'upstream-error'
  | 'gateway-error';

export class GatewayRequestKernelError extends Error {
  readonly code: GatewayRequestKernelErrorCode;
  readonly outcome: GatewayRequestOutcome;
  readonly status: number | null;
  readonly retryable: boolean;
  timeline?: GatewayRequestTimeline;

  constructor(
    message: string,
    opts: {
      code: GatewayRequestKernelErrorCode;
      outcome: GatewayRequestOutcome;
      status: number | null;
      retryable?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'GatewayRequestKernelError';
    this.code = opts.code;
    this.outcome = opts.outcome;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
  }
}

function telemetryProviderForLane(lane: GatewayLaneDescriptor): GatewayTelemetryProvider {
  if (lane.observability.provider === 'anthropic') return 'claude';
  if (lane.observability.provider === 'openai') return 'codex';
  return 'local';
}

function boundedCorrelationId(value: string | undefined, fallback: string): string {
  const bounded = value
    ?.trim()
    .replace(/[^A-Za-z0-9._:@/+\-]/g, '?')
    .slice(0, 160);
  return bounded || fallback;
}

function validatePolicy(policy: GatewayKernelPolicy): void {
  const positive: Array<keyof GatewayKernelPolicy> = [
    'maxBodyBytes',
    'bodyReadTimeoutMs',
    'requestCeilingMs',
    'ttfbTimeoutMs',
    'bodyIdleTimeoutMs',
    'downstreamIdleTimeoutMs',
    'maxAttempts',
  ];
  for (const key of positive) {
    if (!Number.isFinite(policy[key]) || policy[key] <= 0) {
      throw new GatewayRequestKernelError(`gateway request kernel policy ${key} must be positive`, {
        code: 'invalid-policy',
        outcome: 'gateway-error',
        status: 500,
      });
    }
  }
  if (!Number.isInteger(policy.maxAttempts)) {
    throw new GatewayRequestKernelError('gateway request kernel maxAttempts must be an integer', {
      code: 'invalid-policy',
      outcome: 'gateway-error',
      status: 500,
    });
  }
}

function cancellationError(message = 'gateway request cancelled'): GatewayRequestKernelError {
  return new GatewayRequestKernelError(message, {
    code: 'cancelled',
    outcome: 'cancelled',
    status: null,
  });
}

function abortReason(signal: AbortSignal): GatewayRequestKernelError {
  return signal.reason instanceof GatewayRequestKernelError
    ? signal.reason
    : cancellationError(signal.reason instanceof Error ? signal.reason.message : undefined);
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function withDeadline<T>(opts: {
  parent: AbortSignal;
  timeoutMs: number;
  error: () => GatewayRequestKernelError;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(abortReason(opts.parent));
  if (opts.parent.aborted) forwardAbort();
  else opts.parent.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(opts.error()), opts.timeoutMs);
  timer.unref?.();
  try {
    return await abortable(opts.run(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
    opts.parent.removeEventListener('abort', forwardAbort);
  }
}

export async function readBoundedGatewayRequestBody(opts: {
  source: AsyncIterable<Uint8Array | string>;
  maxBytes: number;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<Buffer> {
  return withDeadline({
    parent: opts.signal,
    timeoutMs: opts.timeoutMs,
    error: () =>
      new GatewayRequestKernelError(`gateway request body read exceeded ${opts.timeoutMs}ms`, {
        code: 'body-read-timeout',
        outcome: 'client-error',
        status: 408,
      }),
    run: async (signal) => {
      const iterator = opts.source[Symbol.asyncIterator]();
      const chunks: Buffer[] = [];
      let total = 0;
      let completed = false;
      try {
        for (;;) {
          const next = await abortable(Promise.resolve(iterator.next()), signal);
          if (next.done) {
            completed = true;
            return Buffer.concat(chunks, total);
          }
          const chunk = typeof next.value === 'string' ? Buffer.from(next.value) : Buffer.from(next.value);
          total += chunk.byteLength;
          if (total > opts.maxBytes) {
            throw new GatewayRequestKernelError(`gateway request body exceeded ${opts.maxBytes} bytes`, {
              code: 'body-too-large',
              outcome: 'client-error',
              status: 413,
            });
          }
          chunks.push(chunk);
        }
      } finally {
        if (!completed) await iterator.return?.().catch(() => undefined);
      }
    },
  });
}

function normalizeError(error: unknown, signal: AbortSignal): GatewayRequestKernelError {
  if (error instanceof GatewayRequestKernelError) return error;
  if (signal.aborted) return abortReason(signal);
  return new GatewayRequestKernelError(error instanceof Error ? error.message : String(error), {
    code: 'gateway-error',
    outcome: 'gateway-error',
    status: 500,
    cause: error,
  });
}

function validateRoute<TRoute>(
  lane: GatewayLaneDescriptor,
  route: GatewayKernelRoute<TRoute>,
  pin: GatewayKernelAccountPin | null,
  initial: boolean,
): void {
  if (!route.key.trim()) {
    throw new GatewayRequestKernelError('gateway route key must be non-empty', {
      code: 'invalid-route',
      outcome: 'gateway-error',
      status: 500,
    });
  }
  if (!lane.transports.some((transport) => transport.id === route.transport)) {
    throw new GatewayRequestKernelError(`gateway lane ${lane.id} does not support transport ${route.transport}`, {
      code: 'invalid-route',
      outcome: 'gateway-error',
      status: 500,
    });
  }
  if (lane.capabilities.accountPinning === 'none' && pin) {
    throw new GatewayRequestKernelError(`gateway lane ${lane.id} does not support account pinning`, {
      code: 'invalid-pin',
      outcome: 'client-error',
      status: 400,
    });
  }
  if (initial && pin?.mode === 'hard' && route.accountId !== pin.accountId) {
    throw new GatewayRequestKernelError(
      `hard-pinned account ${pin.accountId} is unavailable on gateway lane ${lane.id}`,
      { code: 'invalid-pin', outcome: 'client-error', status: 409 },
    );
  }
}

async function selectFailover<TRoute, TPrepared, TChunk, TMetadata>(opts: {
  adapter: GatewayKernelAdapter<TRoute, TPrepared, TChunk, TMetadata>;
  base: GatewayKernelContext;
  currentRoute: GatewayKernelRoute<TRoute>;
  triedRouteKeys: Set<string>;
  attempt: number;
  pin: GatewayKernelAccountPin | null;
  lastResponse: GatewayKernelUpstreamResponse<TChunk, TMetadata> | null;
  lastError: GatewayRequestKernelError | null;
}): Promise<GatewayKernelRoute<TRoute> | null> {
  if (opts.pin?.mode === 'hard') return null;
  const next = await abortable(
    Promise.resolve(
      opts.adapter.selectFailover({
        ...opts.base,
        currentRoute: opts.currentRoute,
        triedRouteKeys: [...opts.triedRouteKeys],
        attempt: opts.attempt,
        lastResponse: opts.lastResponse,
        lastError: opts.lastError,
      }),
    ),
    opts.base.signal,
  );
  if (!next) return null;
  validateRoute(opts.base.lane, next, opts.pin, false);
  if (opts.triedRouteKeys.has(next.key)) {
    throw new GatewayRequestKernelError(`gateway failover selected already-tried route ${next.key}`, {
      code: 'route-cycle',
      outcome: 'gateway-error',
      status: 500,
    });
  }
  return next;
}

async function pumpResponse<TChunk, TMetadata>(opts: {
  response: GatewayKernelUpstreamResponse<TChunk, TMetadata>;
  downstream: GatewayKernelDownstream<TChunk, TMetadata>;
  signal: AbortSignal;
  bodyIdleTimeoutMs: number;
  downstreamIdleTimeoutMs: number;
}): Promise<void> {
  let iterator: AsyncIterator<TChunk> | undefined;
  let bodyCompleted = false;
  try {
    await withDeadline({
      parent: opts.signal,
      timeoutMs: opts.downstreamIdleTimeoutMs,
      error: () =>
        new GatewayRequestKernelError(`gateway downstream start exceeded ${opts.downstreamIdleTimeoutMs}ms`, {
          code: 'downstream-idle',
          outcome: 'cancelled',
          status: null,
        }),
      run: () =>
        Promise.resolve(
          opts.downstream.start({
            status: opts.response.status,
            streaming: opts.response.streaming,
            transport: opts.response.transport,
            metadata: opts.response.metadata,
          }),
        ),
    });
    iterator = opts.response.body?.[Symbol.asyncIterator]();
    bodyCompleted = !iterator;
    while (iterator) {
      const activeIterator = iterator;
      const next = await withDeadline({
        parent: opts.signal,
        timeoutMs: opts.bodyIdleTimeoutMs,
        error: () =>
          new GatewayRequestKernelError(`gateway upstream body idle exceeded ${opts.bodyIdleTimeoutMs}ms`, {
            code: 'upstream-body-idle',
            outcome: 'upstream-error',
            status: 504,
          }),
        run: (signal) => abortable(Promise.resolve(activeIterator.next()), signal),
      });
      if (next.done) {
        bodyCompleted = true;
        break;
      }
      await withDeadline({
        parent: opts.signal,
        timeoutMs: opts.downstreamIdleTimeoutMs,
        error: () =>
          new GatewayRequestKernelError(`gateway downstream write exceeded ${opts.downstreamIdleTimeoutMs}ms`, {
            code: 'downstream-idle',
            outcome: 'cancelled',
            status: null,
          }),
        run: () => Promise.resolve(opts.downstream.write(next.value)),
      });
    }
    await withDeadline({
      parent: opts.signal,
      timeoutMs: opts.downstreamIdleTimeoutMs,
      error: () =>
        new GatewayRequestKernelError(`gateway downstream end exceeded ${opts.downstreamIdleTimeoutMs}ms`, {
          code: 'downstream-idle',
          outcome: 'cancelled',
          status: null,
        }),
      run: () => Promise.resolve(opts.downstream.end()),
    });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (!bodyCompleted) {
      try {
        await iterator?.return?.();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await opts.response.discard?.();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length) {
      throw new AggregateError([error, ...cleanupErrors], 'gateway response forwarding and cleanup both failed');
    }
    throw error;
  }
}

export async function executeGatewayRequestKernel<TRoute, TPrepared, TChunk, TMetadata>(
  opts: ExecuteGatewayRequestKernelOptions<TRoute, TPrepared, TChunk, TMetadata>,
): Promise<GatewayKernelExecutionResult<TRoute>> {
  validatePolicy(opts.policy);
  const provider = telemetryProviderForLane(opts.request.lane);
  const span = opts.telemetry.begin({
    ownerId: opts.request.ownerId,
    provider,
    protocol: opts.request.lane.protocol,
  });
  const correlationId = boundedCorrelationId(opts.request.correlationId, `gateway-${span.requestId}`);
  const pin = opts.request.pin ?? null;
  const requestController = new AbortController();
  const cancel = (source: AbortSignal) =>
    requestController.abort(
      source.reason instanceof GatewayRequestKernelError
        ? source.reason
        : cancellationError(source.reason instanceof Error ? source.reason.message : undefined),
    );
  const onCallerAbort = () => cancel(opts.request.signal!);
  const onDownstreamAbort = () => cancel(opts.downstream.signal!);
  if (opts.request.signal?.aborted) onCallerAbort();
  else opts.request.signal?.addEventListener('abort', onCallerAbort, { once: true });
  if (opts.downstream.signal?.aborted) onDownstreamAbort();
  else opts.downstream.signal?.addEventListener('abort', onDownstreamAbort, { once: true });
  const ceilingTimer = setTimeout(
    () =>
      requestController.abort(
        new GatewayRequestKernelError(`gateway request exceeded ${opts.policy.requestCeilingMs}ms ceiling`, {
          code: 'request-ceiling',
          outcome: 'gateway-error',
          status: 504,
        }),
      ),
    opts.policy.requestCeilingMs,
  );
  ceilingTimer.unref?.();

  const base: GatewayKernelContext = {
    requestId: span.requestId,
    correlationId,
    lane: opts.request.lane,
    ownerId: span.ownerId,
    pin,
    signal: requestController.signal,
    startedAt: span.startedAt,
  };
  const triedRouteKeys = new Set<string>();
  const chooseFailover = async (args: {
    currentRoute: GatewayKernelRoute<TRoute>;
    attempt: number;
    lastResponse: GatewayKernelUpstreamResponse<TChunk, TMetadata> | null;
    lastError: GatewayRequestKernelError | null;
  }): Promise<GatewayKernelRoute<TRoute> | null> => {
    span.beginStage('routeSelection');
    try {
      return await selectFailover({
        adapter: opts.adapter,
        base,
        currentRoute: args.currentRoute,
        triedRouteKeys,
        attempt: args.attempt,
        pin,
        lastResponse: args.lastResponse,
        lastError: args.lastError,
      });
    } finally {
      span.endStage('routeSelection');
    }
  };
  let route: GatewayKernelRoute<TRoute> | null = null;
  let lease: GatewayKernelAdmissionLease | null = null;
  let inFlight: GatewayKernelInFlightHandle | null = null;
  let streaming = false;
  let attempts = 0;
  let failovers = 0;
  let finalStatus: number | null = null;
  let finalOutcome: GatewayRequestOutcome = 'unclassified';
  let failure: GatewayRequestKernelError | null = null;
  let cleanupFailure: GatewayRequestKernelError | null = null;
  let timeline: GatewayRequestTimeline | null = null;

  try {
    route = await abortable(
      Promise.resolve(
        opts.adapter.selectInitial({
          ...base,
          currentRoute: null,
          triedRouteKeys: [],
          attempt: 0,
          lastResponse: null,
          lastError: null,
        }),
      ),
      requestController.signal,
    );
    validateRoute(opts.request.lane, route, pin, true);
    triedRouteKeys.add(route.key);
    span.setTransport(route.transport);
    span.routeSelected();
    let currentRoute: GatewayKernelRoute<TRoute> = route;

    lease = await abortable(
      Promise.resolve(opts.admission.acquire({ ...base, route: currentRoute })),
      requestController.signal,
    );
    span.admitted();
    inFlight = await abortable(
      Promise.resolve(
        opts.inFlight.register({
          requestId: base.requestId,
          correlationId,
          laneId: opts.request.lane.id,
          provider,
          startedAt: base.startedAt,
          isStreaming: () => streaming,
          abort: (reason) => requestController.abort(cancellationError(reason)),
        }),
      ),
      requestController.signal,
    );

    span.beginStage('bodyRead');
    let body: Buffer;
    try {
      body = await readBoundedGatewayRequestBody({
        source: opts.request.body,
        maxBytes: opts.policy.maxBodyBytes,
        timeoutMs: opts.policy.bodyReadTimeoutMs,
        signal: requestController.signal,
      });
    } finally {
      span.endStage('bodyRead');
    }

    for (let attempt = 1; attempt <= opts.policy.maxAttempts; attempt++) {
      attempts = attempt;
      const attemptContext: GatewayKernelAttemptContext<TRoute> = {
        ...base,
        route: currentRoute,
        body,
        attempt,
        maxAttempts: opts.policy.maxAttempts,
        triedRouteKeys: [...triedRouteKeys],
      };
      span.setTransport(currentRoute.transport);
      const measureAuth = provider !== 'local';
      if (measureAuth) span.beginStage('auth');
      let prepared!: TPrepared;
      let preparationFailure: GatewayRequestKernelError | null = null;
      try {
        prepared = await abortable(
          Promise.resolve(opts.adapter.prepareAttempt(attemptContext)),
          requestController.signal,
        );
      } catch (error) {
        preparationFailure = normalizeError(error, requestController.signal);
      } finally {
        if (measureAuth) span.endStage('auth');
      }
      if (preparationFailure) {
        await opts.admission.observeAttempt?.({
          context: attemptContext,
          response: null,
          error: preparationFailure,
        });
        if (preparationFailure.retryable && attempt < opts.policy.maxAttempts) {
          const next = await chooseFailover({
            currentRoute,
            attempt,
            lastResponse: null,
            lastError: preparationFailure,
          });
          if (next) {
            route = currentRoute = next;
            triedRouteKeys.add(next.key);
            span.recordFailover();
            failovers++;
            continue;
          }
        }
        throw preparationFailure;
      }

      span.recordAttempt();
      span.beginStage('upstreamTtfb');
      let response!: GatewayKernelUpstreamResponse<TChunk, TMetadata>;
      let attemptFailure: GatewayRequestKernelError | null = null;
      try {
        response = await withDeadline({
          parent: requestController.signal,
          timeoutMs: opts.policy.ttfbTimeoutMs,
          error: () =>
            new GatewayRequestKernelError(`gateway upstream TTFB exceeded ${opts.policy.ttfbTimeoutMs}ms`, {
              code: 'ttfb-timeout',
              outcome: 'upstream-error',
              status: 504,
              retryable: true,
            }),
          run: (signal) => opts.adapter.executeAttempt(prepared, { ...attemptContext, signal }),
        });
      } catch (error) {
        attemptFailure = normalizeError(error, requestController.signal);
      } finally {
        span.endStage('upstreamTtfb');
      }
      if (attemptFailure) {
        await opts.admission.observeAttempt?.({
          context: attemptContext,
          response: null,
          error: attemptFailure,
        });
        if (attemptFailure.retryable && attempt < opts.policy.maxAttempts) {
          const next = await chooseFailover({
            currentRoute,
            attempt,
            lastResponse: null,
            lastError: attemptFailure,
          });
          if (next) {
            route = currentRoute = next;
            triedRouteKeys.add(next.key);
            span.recordFailover();
            failovers++;
            continue;
          }
        }
        throw attemptFailure;
      }

      validateRoute(opts.request.lane, { ...currentRoute, transport: response.transport }, pin, false);
      span.setTransport(response.transport);
      try {
        await opts.admission.observeAttempt?.({ context: attemptContext, response, error: null });
      } catch (error) {
        try {
          await response.discard?.();
        } catch (discardError) {
          throw new AggregateError(
            [error, discardError],
            'gateway attempt observation and response cleanup both failed',
          );
        }
        throw error;
      }
      if (response.retryable && attempt < opts.policy.maxAttempts) {
        let next: GatewayKernelRoute<TRoute> | null;
        try {
          next = await chooseFailover({
            currentRoute,
            attempt,
            lastResponse: response,
            lastError: null,
          });
        } catch (error) {
          try {
            await response.discard?.();
          } catch (discardError) {
            throw new AggregateError(
              [error, discardError],
              'gateway failover selection and response cleanup both failed',
            );
          }
          throw error;
        }
        if (next) {
          await response.discard?.();
          route = currentRoute = next;
          triedRouteKeys.add(next.key);
          span.recordFailover();
          failovers++;
          continue;
        }
      }

      streaming = response.streaming;
      span.setStreaming(streaming);
      if (streaming) span.beginStage('stream');
      try {
        await pumpResponse({
          response,
          downstream: opts.downstream,
          signal: requestController.signal,
          bodyIdleTimeoutMs: opts.policy.bodyIdleTimeoutMs,
          downstreamIdleTimeoutMs: opts.policy.downstreamIdleTimeoutMs,
        });
      } finally {
        if (streaming) span.endStage('stream');
      }
      finalStatus = response.status;
      finalOutcome = response.outcome ?? classifyGatewayTelemetryOutcome(response.status);
      break;
    }

    if (finalStatus === null || !route) {
      throw new GatewayRequestKernelError('gateway request exhausted its attempt budget without a response', {
        code: 'upstream-error',
        outcome: 'upstream-error',
        status: 502,
      });
    }
  } catch (error) {
    failure = normalizeError(error, requestController.signal);
    finalOutcome = failure.outcome;
    finalStatus = failure.status;
  } finally {
    clearTimeout(ceilingTimer);
    opts.request.signal?.removeEventListener('abort', onCallerAbort);
    opts.downstream.signal?.removeEventListener('abort', onDownstreamAbort);
    const cleanup = await Promise.allSettled([
      inFlight?.unregister({ outcome: finalOutcome, status: finalStatus }),
      lease?.release({ outcome: finalOutcome, status: finalStatus }),
    ]);
    const rejected = cleanup.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) {
      cleanupFailure = normalizeError(rejected.reason, requestController.signal);
      if (!failure) {
        finalOutcome = 'gateway-error';
        finalStatus = 500;
      }
    }
    timeline = span.finish(finalOutcome, finalStatus);
  }

  const terminalFailure = failure ?? cleanupFailure;
  if (terminalFailure) {
    terminalFailure.timeline = timeline ?? undefined;
    throw terminalFailure;
  }
  if (!route || finalStatus === null || !timeline) {
    throw new GatewayRequestKernelError('gateway request kernel failed to produce a terminal result', {
      code: 'gateway-error',
      outcome: 'gateway-error',
      status: 500,
    });
  }
  return {
    requestId: span.requestId,
    correlationId,
    laneId: opts.request.lane.id,
    status: finalStatus,
    outcome: finalOutcome,
    attempts,
    failovers,
    finalRoute: route,
    timeline,
  };
}
