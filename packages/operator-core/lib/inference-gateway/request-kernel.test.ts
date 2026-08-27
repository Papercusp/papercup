import { describe, expect, it, vi } from 'vitest';
import { makeGatewayLaneRegistry, type GatewayLaneDescriptor } from './provider-adapters';
import type { AccountPool, ActiveAccount } from './provider-contracts';
import {
  executeGatewayRequestKernel,
  GatewayRequestKernelError,
  type ExecuteGatewayRequestKernelOptions,
  type GatewayKernelAccountPin,
  type GatewayKernelAttemptContext,
  type GatewayKernelPolicy,
  type GatewayKernelRoute,
  type GatewayKernelUpstreamResponse,
} from './request-kernel';
import {
  GatewayRequestTelemetry,
  assertCompleteGatewayRequestTimeline,
  type GatewayTelemetryProvider,
} from './request-stage-telemetry';

const account = (id: string): ActiveAccount => ({
  accountId: id,
  token: async () => `${id}-token`,
});

const pool = (id: string): AccountPool => {
  const active = account(id);
  return {
    active: () => active,
    onExhausted: () => null,
    select: (accountId) => (accountId === id ? active : null),
  };
};

const laneRegistry = makeGatewayLaneRegistry({
  claudePool: pool('claude-a'),
  codexPool: pool('codex-a'),
  codexCliAccountCount: () => 1,
  anthropicUpstreamBase: 'https://anthropic.test',
  openaiUpstreamBase: 'https://openai.test',
});

const laneCases = Object.values(laneRegistry).map((lane) => ({ id: lane.id, lane }));

interface RouteValue {
  name: string;
}

interface ResponseMetadata {
  contentType: string;
}

interface PreparedAttempt {
  routeKey: string;
  body: Buffer;
}

type KernelResponse = GatewayKernelUpstreamResponse<Uint8Array, ResponseMetadata>;
type KernelOptions = ExecuteGatewayRequestKernelOptions<RouteValue, PreparedAttempt, Uint8Array, ResponseMetadata>;

const DEFAULT_POLICY: GatewayKernelPolicy = {
  maxBodyBytes: 1024,
  bodyReadTimeoutMs: 500,
  requestCeilingMs: 1_000,
  ttfbTimeoutMs: 500,
  bodyIdleTimeoutMs: 500,
  downstreamIdleTimeoutMs: 500,
  maxAttempts: 2,
};

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield Buffer.from(value);
}

function neverBody(): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        return: async () => ({ done: true, value: undefined }),
      };
    },
  };
}

interface FixtureOverrides {
  body?: AsyncIterable<Uint8Array | string>;
  pin?: GatewayKernelAccountPin | null;
  policy?: Partial<GatewayKernelPolicy>;
  signal?: AbortSignal;
  downstreamSignal?: AbortSignal;
  selectInitial?: (routeA: GatewayKernelRoute<RouteValue>) => Promise<GatewayKernelRoute<RouteValue>>;
  executeAttempt?: (
    prepared: PreparedAttempt,
    context: GatewayKernelAttemptContext<RouteValue>,
  ) => Promise<KernelResponse>;
  downstreamWrite?: (chunk: Uint8Array) => void | Promise<void>;
}

function fixture(lane: GatewayLaneDescriptor, overrides: FixtureOverrides = {}) {
  const events: string[] = [];
  const written: Uint8Array[] = [];
  const started: Array<{ status: number; metadata: ResponseMetadata }> = [];
  const telemetry = new GatewayRequestTelemetry();
  const transport = lane.transports.find((candidate) => !candidate.degraded)?.id ?? lane.transports[0]!.id;
  const accountBacked = lane.capabilities.accountPinning !== 'none';
  const routeA: GatewayKernelRoute<RouteValue> = {
    key: `${lane.id}:a`,
    accountId: accountBacked ? 'account-a' : null,
    transport,
    value: { name: 'a' },
  };
  const routeB: GatewayKernelRoute<RouteValue> = {
    key: `${lane.id}:b`,
    accountId: accountBacked ? 'account-b' : null,
    transport,
    value: { name: 'b' },
  };
  let inFlightEntry: { isStreaming: () => boolean } | null = null;
  let releaseCount = 0;
  let unregisterCount = 0;
  let failoverCalls = 0;
  let discardCount = 0;

  async function* defaultBody() {
    events.push('body');
    yield Buffer.from('{"model":"test"}');
  }

  const options: KernelOptions = {
    request: {
      lane,
      body: overrides.body ?? defaultBody(),
      ownerId: 'su-contract',
      correlationId: `${lane.id}-correlation`,
      pin:
        overrides.pin === undefined ? (accountBacked ? { accountId: 'account-a', mode: 'soft' } : null) : overrides.pin,
      signal: overrides.signal,
    },
    policy: { ...DEFAULT_POLICY, ...overrides.policy },
    telemetry,
    admission: {
      async run({ route }, task) {
        events.push(`admit:${route.value.name}`);
        try {
          return await task();
        } finally {
          releaseCount++;
          events.push('release');
        }
      },
      observeAttempt({ context, response, error }) {
        events.push(`observe:${context.route.value.name}:${response?.status ?? error?.code ?? 'unknown'}`);
      },
    },
    adapter: {
      async selectInitial() {
        events.push('select:initial');
        return overrides.selectInitial?.(routeA) ?? routeA;
      },
      async selectFailover() {
        failoverCalls++;
        events.push('select:failover');
        return routeB;
      },
      async prepareAttempt(context) {
        events.push(`prepare:${context.route.value.name}`);
        return { routeKey: context.route.key, body: context.body };
      },
      async executeAttempt(prepared, context) {
        events.push(`execute:${context.route.value.name}`);
        if (overrides.executeAttempt) return overrides.executeAttempt(prepared, context);
        if (context.attempt === 1) {
          return {
            status: 503,
            streaming: false,
            transport: context.route.transport,
            metadata: { contentType: 'application/json' },
            body: null,
            retryable: true,
            discard: () => {
              discardCount++;
              events.push('discard');
            },
          };
        }
        return {
          status: 200,
          streaming: true,
          transport: context.route.transport,
          metadata: { contentType: 'text/event-stream' },
          body: chunks('first', 'second'),
        };
      },
    },
    downstream: {
      signal: overrides.downstreamSignal,
      async start(response) {
        started.push({ status: response.status, metadata: response.metadata });
        events.push(`downstream:start:${response.status}`);
      },
      async write(chunk) {
        await overrides.downstreamWrite?.(chunk);
        written.push(chunk);
        events.push(`downstream:write:${Buffer.from(chunk).toString()}`);
      },
      async end() {
        events.push('downstream:end');
      },
    },
    inFlight: {
      register(entry) {
        events.push('inflight:register');
        inFlightEntry = entry;
        return {
          unregister({ outcome, status }) {
            unregisterCount++;
            events.push(`inflight:unregister:${outcome}:${status ?? 'null'}`);
          },
        };
      },
    },
  };

  return {
    options,
    telemetry,
    events,
    written,
    started,
    routeA,
    routeB,
    counts: () => ({ releaseCount, unregisterCount, failoverCalls, discardCount }),
    inFlight: () => inFlightEntry,
  };
}

async function caughtKernelError(promise: Promise<unknown>): Promise<GatewayRequestKernelError> {
  try {
    await promise;
    throw new Error('expected gateway request kernel to reject');
  } catch (error) {
    if (!(error instanceof GatewayRequestKernelError)) throw error;
    return error;
  }
}

describe('gateway request kernel lane coverage', () => {
  it('enumerates every static lane descriptor exactly once', () => {
    expect(laneCases.map(({ id }) => id)).toEqual(['anthropic-messages', 'openai-responses', 'local-openai-chat']);
  });
});

describe.each(laneCases)('$id shared request lifecycle', ({ lane }) => {
  it('runs route, admission, bounded body, failover, telemetry, streaming, and cleanup invariants', async () => {
    const f = fixture(lane);
    const result = await executeGatewayRequestKernel(f.options);

    expect(result).toMatchObject({
      laneId: lane.id,
      correlationId: `${lane.id}-correlation`,
      status: 200,
      outcome: 'ok',
      attempts: 2,
      failovers: 1,
      finalRoute: f.routeB,
    });
    expect(result.timeline).toMatchObject({
      ownerId: 'su-contract',
      protocol: lane.protocol,
      transport: f.routeB.transport,
      attempts: 2,
      failovers: 1,
      finalStatus: 200,
      outcome: 'ok',
      streaming: true,
      missingStages: [],
    });
    const expectedProvider: GatewayTelemetryProvider =
      lane.observability.provider === 'anthropic'
        ? 'claude'
        : lane.observability.provider === 'openai'
          ? 'codex'
          : 'local';
    expect(result.timeline.provider).toBe(expectedProvider);
    assertCompleteGatewayRequestTimeline(result.timeline);
    expect(Buffer.concat(f.written.map((chunk) => Buffer.from(chunk))).toString()).toBe('firstsecond');
    expect(f.started).toEqual([{ status: 200, metadata: { contentType: 'text/event-stream' } }]);
    expect(f.counts()).toEqual({
      releaseCount: 1,
      unregisterCount: 1,
      failoverCalls: 1,
      discardCount: 1,
    });
    expect(f.inFlight()?.isStreaming()).toBe(true);
    expect(f.events).toEqual(
      expect.arrayContaining([
        'select:initial',
        'admit:a',
        'inflight:register',
        'body',
        'prepare:a',
        'execute:a',
        'observe:a:503',
        'select:failover',
        'discard',
        'prepare:b',
        'execute:b',
        'observe:b:200',
        'downstream:start:200',
        'downstream:write:first',
        'downstream:write:second',
        'downstream:end',
        'inflight:unregister:ok:200',
        'release',
      ]),
    );
    expect(f.events.indexOf('inflight:unregister:ok:200')).toBeLessThan(f.events.indexOf('release'));
    expect(f.telemetry.snapshot().requests).toMatchObject({
      started: 1,
      finalized: 1,
      active: 0,
      reconciled: true,
      outcomeReconciled: true,
      missingStageTimelines: 0,
    });
  });

  it('rejects an oversized request body before any upstream attempt and still releases the slot', async () => {
    const f = fixture(lane, {
      body: chunks('four'),
      policy: { maxBodyBytes: 3 },
    });
    const error = await caughtKernelError(executeGatewayRequestKernel(f.options));

    expect(error).toMatchObject({ code: 'body-too-large', outcome: 'client-error', status: 413 });
    expect(error.timeline).toMatchObject({ attempts: 0, outcome: 'client-error', finalStatus: 413 });
    assertCompleteGatewayRequestTimeline(error.timeline!);
    expect(f.events.some((event) => event.startsWith('execute:'))).toBe(false);
    expect(f.counts()).toMatchObject({ releaseCount: 1, unregisterCount: 1 });
  });

  it('bounds a request body producer that never completes', async () => {
    const f = fixture(lane, {
      body: neverBody(),
      policy: { bodyReadTimeoutMs: 5 },
    });
    const error = await caughtKernelError(executeGatewayRequestKernel(f.options));

    expect(error).toMatchObject({ code: 'body-read-timeout', outcome: 'client-error', status: 408 });
    assertCompleteGatewayRequestTimeline(error.timeline!);
    expect(f.counts()).toMatchObject({ releaseCount: 1, unregisterCount: 1 });
  });

  it('propagates caller cancellation through the current attempt and cleans up exactly once', async () => {
    const controller = new AbortController();
    let attemptStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      attemptStarted = resolve;
    });
    const f = fixture(lane, {
      signal: controller.signal,
      executeAttempt: async (_prepared, context) => {
        attemptStarted();
        return new Promise<KernelResponse>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
        });
      },
    });
    const pending = executeGatewayRequestKernel(f.options);
    await started;
    controller.abort(new Error('caller disconnected'));
    const error = await caughtKernelError(pending);

    expect(error).toMatchObject({ code: 'cancelled', outcome: 'cancelled', status: null });
    assertCompleteGatewayRequestTimeline(error.timeline!);
    expect(f.counts()).toMatchObject({ releaseCount: 1, unregisterCount: 1, failoverCalls: 0 });

    const downstreamController = new AbortController();
    let downstreamAttemptStarted!: () => void;
    const downstreamStarted = new Promise<void>((resolve) => {
      downstreamAttemptStarted = resolve;
    });
    const downstream = fixture(lane, {
      downstreamSignal: downstreamController.signal,
      executeAttempt: async (_prepared, context) => {
        downstreamAttemptStarted();
        return new Promise<KernelResponse>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
        });
      },
    });
    const downstreamPending = executeGatewayRequestKernel(downstream.options);
    await downstreamStarted;
    downstreamController.abort(new Error('downstream disconnected'));
    const downstreamCancellation = await caughtKernelError(downstreamPending);
    expect(downstreamCancellation).toMatchObject({
      code: 'cancelled',
      outcome: 'cancelled',
      status: null,
    });
    assertCompleteGatewayRequestTimeline(downstreamCancellation.timeline!);
    expect(downstream.counts()).toMatchObject({ releaseCount: 1, unregisterCount: 1 });
  });

  it('enforces the whole-request ceiling even when an attempt ignores cancellation', async () => {
    const f = fixture(lane, {
      policy: { requestCeilingMs: 5, ttfbTimeoutMs: 500 },
      executeAttempt: async () => new Promise<KernelResponse>(() => undefined),
    });
    const error = await caughtKernelError(executeGatewayRequestKernel(f.options));

    expect(error).toMatchObject({ code: 'request-ceiling', outcome: 'gateway-error', status: 504 });
    expect(f.counts()).toMatchObject({ releaseCount: 1, unregisterCount: 1 });
  });

  it('enforces the TTFB deadline and stops at the configured attempt budget', async () => {
    const f = fixture(lane, {
      policy: { maxAttempts: 1, ttfbTimeoutMs: 5 },
      executeAttempt: async () => new Promise<KernelResponse>(() => undefined),
    });
    const error = await caughtKernelError(executeGatewayRequestKernel(f.options));

    expect(error).toMatchObject({ code: 'ttfb-timeout', outcome: 'upstream-error', status: 504 });
    assertCompleteGatewayRequestTimeline(error.timeline!);
    expect(f.events.filter((event) => event.startsWith('execute:'))).toHaveLength(1);
    expect(f.counts()).toMatchObject({ releaseCount: 1, unregisterCount: 1, failoverCalls: 0 });
  });

  it('closes a failed TTFB stage before selecting the failover route', async () => {
    const f = fixture(lane, {
      executeAttempt: async (_prepared, context) => {
        if (context.attempt === 1) {
          throw new GatewayRequestKernelError('retry this route', {
            code: 'upstream-error',
            outcome: 'upstream-error',
            status: 502,
            retryable: true,
          });
        }
        return {
          status: 200,
          streaming: true,
          transport: context.route.transport,
          metadata: { contentType: 'text/event-stream' },
          body: chunks('recovered'),
        };
      },
    });
    const result = await executeGatewayRequestKernel(f.options);
    const stages = result.timeline.events.map(({ stage, phase }) => `${stage}:${phase}`);
    const failedTtfbEnd = stages.indexOf('upstreamTtfb:end');
    const failoverSelectionStart = stages.indexOf('routeSelection:start', failedTtfbEnd + 1);

    expect(result).toMatchObject({ status: 200, outcome: 'ok', attempts: 2, failovers: 1 });
    expect(failedTtfbEnd).toBeGreaterThan(-1);
    expect(failoverSelectionStart).toBeGreaterThan(failedTtfbEnd);
    assertCompleteGatewayRequestTimeline(result.timeline);
  });

  it('enforces upstream body-idle and downstream backpressure deadlines', async () => {
    const bodyDiscard = vi.fn();
    const bodyIdle = fixture(lane, {
      executeAttempt: async (_prepared, context) => ({
        status: 200,
        streaming: true,
        transport: context.route.transport,
        metadata: { contentType: 'text/event-stream' },
        body: neverBody(),
        discard: bodyDiscard,
      }),
      policy: { bodyIdleTimeoutMs: 5 },
    });
    const bodyError = await caughtKernelError(executeGatewayRequestKernel(bodyIdle.options));
    expect(bodyError).toMatchObject({
      code: 'upstream-body-idle',
      outcome: 'upstream-error',
      status: 504,
    });
    assertCompleteGatewayRequestTimeline(bodyError.timeline!);
    expect(bodyDiscard).toHaveBeenCalledTimes(1);
    expect(bodyIdle.counts()).toMatchObject({ releaseCount: 1, unregisterCount: 1 });

    const downstreamDiscard = vi.fn();
    const downstreamIdle = fixture(lane, {
      executeAttempt: async (_prepared, context) => ({
        status: 200,
        streaming: true,
        transport: context.route.transport,
        metadata: { contentType: 'text/event-stream' },
        body: chunks('blocked'),
        discard: downstreamDiscard,
      }),
      downstreamWrite: async () => new Promise<void>(() => undefined),
      policy: { downstreamIdleTimeoutMs: 5 },
    });
    const downstreamError = await caughtKernelError(executeGatewayRequestKernel(downstreamIdle.options));
    expect(downstreamError).toMatchObject({
      code: 'downstream-idle',
      outcome: 'cancelled',
      status: null,
    });
    assertCompleteGatewayRequestTimeline(downstreamError.timeline!);
    expect(downstreamDiscard).toHaveBeenCalledTimes(1);
    expect(downstreamIdle.counts()).toMatchObject({ releaseCount: 1, unregisterCount: 1 });
  });

  it('forwards the last retryable response instead of exceeding maxAttempts', async () => {
    const f = fixture(lane, { policy: { maxAttempts: 1 } });
    const result = await executeGatewayRequestKernel(f.options);

    expect(result).toMatchObject({ status: 503, outcome: 'upstream-error', attempts: 1, failovers: 0 });
    expect(f.counts()).toMatchObject({ failoverCalls: 0, discardCount: 0, releaseCount: 1 });
    assertCompleteGatewayRequestTimeline(result.timeline);
  });
});

describe.each(laneCases.filter(({ lane }) => lane.capabilities.accountPinning !== 'none'))(
  '$id account pin contract',
  ({ lane }) => {
    it('never invokes failover for a hard-pinned request', async () => {
      const f = fixture(lane, {
        pin: { accountId: 'account-a', mode: 'hard' },
      });
      const result = await executeGatewayRequestKernel(f.options);

      expect(result).toMatchObject({ status: 503, outcome: 'upstream-error', attempts: 1, failovers: 0 });
      expect(result.finalRoute).toBe(f.routeA);
      expect(f.counts()).toMatchObject({ failoverCalls: 0, discardCount: 0, releaseCount: 1 });
    });
  },
);

describe('gateway request kernel contract guards', () => {
  it('fails closed when a local lane is given an account pin', async () => {
    const f = fixture(laneRegistry.localOpenAiChat, {
      pin: { accountId: 'impossible', mode: 'hard' },
    });
    const error = await caughtKernelError(executeGatewayRequestKernel(f.options));
    expect(error).toMatchObject({ code: 'invalid-pin', outcome: 'client-error', status: 400 });
    expect(f.counts()).toMatchObject({ releaseCount: 0, unregisterCount: 0 });
  });

  it('fails closed on a failover cycle instead of retrying the same route', async () => {
    const f = fixture(laneRegistry.anthropicMessages);
    f.options.adapter.selectFailover = vi.fn(async () => f.routeA);
    const error = await caughtKernelError(executeGatewayRequestKernel(f.options));
    expect(error).toMatchObject({ code: 'route-cycle', outcome: 'gateway-error', status: 500 });
    assertCompleteGatewayRequestTimeline(error.timeline!);
    expect(f.counts()).toMatchObject({
      releaseCount: 1,
      unregisterCount: 1,
      discardCount: 1,
    });
  });
});
