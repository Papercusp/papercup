/**
 * Bounded, privacy-safe request-stage telemetry for the inference gateway.
 *
 * This is an internal accumulator, not a second observability surface: gateway.ts publishes its
 * snapshots through the existing `/stats` and `/admin/owner-report` responses. The writer accepts
 * only enumerated dimensions plus bounded owner/model/account identifiers. Request bodies, prompt text,
 * credentials, headers, URLs, and raw error strings are deliberately absent from the contract.
 */
import { createHash } from 'node:crypto';

export interface GatewayCacheFingerprint {
  sha256: string;
  bytes: number;
  hashedBytes: number;
}

export interface GatewayCacheObservation {
  servingAccountId: string | null;
  providerRequestId: string | null;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reuse: 'unobserved' | 'zero-read' | 'partial-hit' | 'full-hit' | 'hit-unknown-write';
  /** A zero read alone cannot distinguish eviction, expiry, prefix drift or cold start. */
  missReason: 'unobserved' | 'unknown' | 'none';
  shape: 'unobserved' | 'observed' | 'oversized' | 'invalid';
  tools: GatewayCacheFingerprint | null;
  instructions: GatewayCacheFingerprint | null;
}

const emptyCacheObservation = (): GatewayCacheObservation => ({
  servingAccountId: null, providerRequestId: null, inputTokens: null, cacheReadTokens: null,
  cacheWriteTokens: null, reuse: 'unobserved', missReason: 'unobserved', shape: 'unobserved',
  tools: null, instructions: null,
});
const cloneCacheObservation = (cache: GatewayCacheObservation): GatewayCacheObservation => ({
  ...cache, tools: cache.tools ? { ...cache.tools } : null,
  instructions: cache.instructions ? { ...cache.instructions } : null,
});

/** Fingerprints are diagnostics, never cache keys. A capped digest is explicitly partial. */
function cacheFingerprint(value: unknown): GatewayCacheFingerprint | null {
  if (value === undefined || value === null) return null;
  const bytes = Buffer.from(JSON.stringify(value));
  const prefix = bytes.subarray(0, 65_536);
  return { sha256: createHash('sha256').update(prefix).digest('hex'), bytes: bytes.length, hashedBytes: prefix.length };
}

export const GATEWAY_REQUEST_STAGE_NAMES = [
  'routeSelection',
  'queueWait',
  'bodyRead',
  'auth',
  'upstreamTtfb',
  'stream',
  'gatewayOverhead',
  'total',
] as const;

export type GatewayRequestStageName = (typeof GATEWAY_REQUEST_STAGE_NAMES)[number];
export type GatewayTelemetryProvider = 'claude' | 'codex' | 'local';
export type GatewayTelemetryProtocol = 'anthropic-messages' | 'openai-responses' | 'openai-chat';
export type GatewayTelemetryTransport = 'bearer-http' | 'oauth-http' | 'cli-exec' | 'local-http' | 'unknown';
export type GatewayCacheRoutingDecision = 'disabled' | 'unchanged' | 'rewritten' | 'not-applicable';
export type GatewayRequestOutcome =
  | 'ok'
  | 'client-error'
  | 'upstream-429'
  | 'upstream-error'
  | 'shed'
  | 'cancelled'
  | 'gateway-error'
  | 'unclassified';

/** The admission layers one HTTP request crosses before provider work starts.
 * `payloadSpool` is the pre-admission durable body write; `durable` is the
 * resource-governor receipt/admission boundary; `provider` is the live
 * PriorityAdmissionQueue; `account` is reserved for a per-account governor
 * when a lane exposes that boundary explicitly. */
export const GATEWAY_ADMISSION_LAYERS = ['payloadSpool', 'durable', 'provider', 'account'] as const;
export type GatewayAdmissionLayer = (typeof GATEWAY_ADMISSION_LAYERS)[number];

/** Structural subset of PriorityAdmissionQueue.snapshot(). Keeping this type
 * local avoids coupling the privacy-safe telemetry module to one queue
 * implementation while still accepting the established queue's exact shape. */
export interface GatewayAdmissionQueueSnapshotInput {
  running: number;
  queued: number;
  maxConcurrent: number;
  tier1Reserve?: number;
  byTier?: readonly {
    tier: number;
    minShare: number | null;
    inFlight: number;
    queued: number;
  }[];
}

export interface GatewayAdmissionObservationInput {
  priority?: number | null;
  tier?: number | null;
  queue?: GatewayAdmissionQueueSnapshotInput | null;
}

/** One bounded, numeric-only observation at a queue boundary. It contains no
 * request body, headers, credential/account id, URL, or error prose. */
export interface GatewayAdmissionObservation {
  offsetMs: number;
  priority: number | null;
  tier: number | null;
  running: number | null;
  queued: number | null;
  maxConcurrent: number | null;
  tier1Reserve: number | null;
  tierMinShare: number | null;
  tierInFlight: number | null;
  tierQueued: number | null;
}

export interface GatewayAdmissionSegment {
  queued: GatewayAdmissionObservation | null;
  admitted: GatewayAdmissionObservation | null;
  waitMs: number | null;
}

export interface GatewayStageEvent {
  stage: GatewayRequestStageName;
  phase: 'start' | 'end';
  /** Monotonic within one request: milliseconds since that request entered the gateway. */
  offsetMs: number;
}

export interface GatewayRequestTimeline {
  requestId: number;
  ownerId: string | null;
  provider: GatewayTelemetryProvider;
  protocol: GatewayTelemetryProtocol;
  transport: GatewayTelemetryTransport;
  model: string | null;
  cacheRouting: GatewayCacheRoutingDecision;
  cache: GatewayCacheObservation;
  /** Gap to this owner's prior completed request in the bounded process-local ring; null is unknown. */
  previousObservedRequestGapMs: number | null;
  cacheObservationMs: number;
  startedAt: number;
  finalizedAt: number;
  attempts: number;
  failovers: number;
  finalStatus: number | null;
  outcome: GatewayRequestOutcome;
  streaming: boolean;
  durationsMs: Partial<Record<GatewayRequestStageName, number>>;
  /** Layer-specific evidence behind the aggregate `queueWait` duration. A
   * missing layer means that boundary was not instrumented on this lane. */
  admission: Partial<Record<GatewayAdmissionLayer, GatewayAdmissionSegment>>;
  events: GatewayStageEvent[];
  missingStages: GatewayRequestStageName[];
}

export interface GatewayPercentileSummary {
  /** Lifetime number of observations written for this stage. */
  count: number;
  /** Observations retained in the bounded percentile window. */
  retained: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface GatewayRequestTelemetrySnapshot {
  schemaVersion: 1;
  requests: {
    started: number;
    finalized: number;
    active: number;
    sampled: number;
    /** sampled / finalized. Every eligible request is sampled, so this is 1 when finalized > 0. */
    coverage: number;
    /** Exact accounting guard: started === finalized + active. */
    reconciled: boolean;
    /** Exact outcome guard: every finalized request has one and only one classified outcome. */
    outcomeReconciled: boolean;
    missingStageTimelines: number;
    cacheUsageObserved: number;
    cacheUsageCoverage: number | null;
    cacheWriteObserved: number;
  };
  outcomes: Record<GatewayRequestOutcome, number>;
  stages: Record<GatewayRequestStageName, GatewayPercentileSummary>;
  missingStageByName: Record<GatewayRequestStageName, number>;
  sampleCapacity: number;
  recentCapacity: number;
  recent: GatewayRequestTimeline[];
}

export interface GatewayOwnerStageTelemetry {
  ownerId: string;
  finalized: number;
  outcomes: Record<GatewayRequestOutcome, number>;
  stages: Record<GatewayRequestStageName, GatewayPercentileSummary>;
  recent: GatewayRequestTimeline[];
}

const OUTCOMES: readonly GatewayRequestOutcome[] = [
  'ok',
  'client-error',
  'upstream-429',
  'upstream-error',
  'shed',
  'cancelled',
  'gateway-error',
  'unclassified',
];

const emptyOutcomes = (): Record<GatewayRequestOutcome, number> =>
  Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<GatewayRequestOutcome, number>;

const emptyMissingStages = (): Record<GatewayRequestStageName, number> =>
  Object.fromEntries(GATEWAY_REQUEST_STAGE_NAMES.map((stage) => [stage, 0])) as Record<GatewayRequestStageName, number>;

function boundedIdentifier(value: string | null | undefined, max = 160): string | null {
  if (!value) return null;
  // Owner ids and model ids are operational dimensions, not arbitrary prose. Replace control/
  // whitespace characters and cap length so neither surface becomes an unbounded log channel.
  return value.trim().replace(/[^A-Za-z0-9._:@/+\-]/g, '?').slice(0, max) || null;
}

function boundedOwnerId(value: string | null | undefined): string | null {
  if (!value) return null;
  // The owner header is one coord/spawn identifier. Never let whitespace-delimited arbitrary text
  // piggyback on that dimension (for example, a copied Authorization value after the real id).
  return boundedIdentifier(value.trim().split(/\s/, 1)[0], 120);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const n = finiteNumber(value);
  return n == null ? null : Math.max(0, Math.floor(n));
}

function cloneAdmission(
  admission: Partial<Record<GatewayAdmissionLayer, GatewayAdmissionSegment>>,
): Partial<Record<GatewayAdmissionLayer, GatewayAdmissionSegment>> {
  const out: Partial<Record<GatewayAdmissionLayer, GatewayAdmissionSegment>> = {};
  for (const layer of GATEWAY_ADMISSION_LAYERS) {
    const segment = admission[layer];
    if (!segment) continue;
    out[layer] = {
      queued: segment.queued ? { ...segment.queued } : null,
      admitted: segment.admitted ? { ...segment.admitted } : null,
      waitMs: segment.waitMs,
    };
  }
  return out;
}

class BoundedSamples {
  private readonly values: number[] = [];
  private cursor = 0;
  private observed = 0;

  constructor(private readonly capacity: number) {}

  add(value: number): void {
    if (!Number.isFinite(value)) return;
    const safe = Math.max(0, value);
    this.observed++;
    if (this.values.length < this.capacity) this.values.push(safe);
    else {
      this.values[this.cursor] = safe;
      this.cursor = (this.cursor + 1) % this.capacity;
    }
  }

  snapshot(): GatewayPercentileSummary {
    return summarize(this.values, this.observed);
  }
}

function nearestRank(sorted: readonly number[], percentile: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)] ?? null;
}

function summarize(values: readonly number[], observed = values.length): GatewayPercentileSummary {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: observed,
    retained: sorted.length,
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99),
  };
}

function emptyStageSummaries(): Record<GatewayRequestStageName, GatewayPercentileSummary> {
  return Object.fromEntries(
    GATEWAY_REQUEST_STAGE_NAMES.map((stage) => [stage, summarize([])]),
  ) as Record<GatewayRequestStageName, GatewayPercentileSummary>;
}

/**
 * The strict completeness guard used by tests and canary validation. The hot-path collector records
 * violations rather than throwing, so telemetry can never break request serving.
 */
export function assertCompleteGatewayRequestTimeline(timeline: GatewayRequestTimeline): void {
  if (timeline.missingStages.length) {
    throw new Error(
      `gateway request ${timeline.requestId} missing required stage(s): ${timeline.missingStages.join(', ')}`,
    );
  }
  if (timeline.outcome === 'unclassified') {
    throw new Error(`gateway request ${timeline.requestId} has an unclassified outcome`);
  }
  if (timeline.finalStatus === null && timeline.outcome !== 'cancelled') {
    throw new Error(`gateway request ${timeline.requestId} has no final status for outcome ${timeline.outcome}`);
  }
}

export class GatewayRequestSpan {
  private readonly stageStartedAt = new Map<GatewayRequestStageName, number>();
  private readonly durations: Partial<Record<GatewayRequestStageName, number>> = {};
  private readonly events: GatewayStageEvent[] = [];
  private transport: GatewayTelemetryTransport;
  private model: string | null = null;
  private cacheRouting: GatewayCacheRoutingDecision = 'not-applicable';
  private readonly cache = emptyCacheObservation();
  private readonly previousObservedRequestGapMs: number | null;
  private cacheObservationMs = 0;
  private attempts = 0;
  private failovers = 0;
  private streaming = false;
  private finished = false;
  private readonly admission: Partial<Record<GatewayAdmissionLayer, GatewayAdmissionSegment>> = {};

  constructor(
    private readonly collector: GatewayRequestTelemetry,
    readonly requestId: number,
    readonly ownerId: string | null,
    readonly provider: GatewayTelemetryProvider,
    readonly protocol: GatewayTelemetryProtocol,
    transport: GatewayTelemetryTransport,
    readonly startedAt: number,
  ) {
    this.transport = transport;
    this.previousObservedRequestGapMs = collector.previousRequestGap(ownerId, startedAt);
    this.beginStage('routeSelection');
  }

  private now(): number {
    return this.collector.clock();
  }

  private event(stage: GatewayRequestStageName, phase: 'start' | 'end', at: number): void {
    // Eight stages × start/end = 16 in normal operation. Cap protects against a buggy caller
    // repeatedly toggling a stage and turning the recent ring into an unbounded event log.
    if (this.events.length < 32) this.events.push({ stage, phase, offsetMs: Math.max(0, at - this.startedAt) });
  }

  beginStage(stage: GatewayRequestStageName): void {
    if (this.finished || this.stageStartedAt.has(stage)) return;
    const at = this.now();
    this.stageStartedAt.set(stage, at);
    this.event(stage, 'start', at);
  }

  endStage(stage: GatewayRequestStageName): void {
    if (this.finished) return;
    const started = this.stageStartedAt.get(stage);
    if (started === undefined) return;
    const at = this.now();
    this.stageStartedAt.delete(stage);
    this.durations[stage] = (this.durations[stage] ?? 0) + Math.max(0, at - started);
    this.event(stage, 'end', at);
  }

  routeSelected(): void {
    this.endStage('routeSelection');
    this.beginStage('queueWait');
  }

  admitted(): void {
    this.endStage('queueWait');
  }

  private admissionObservation(input: GatewayAdmissionObservationInput = {}): GatewayAdmissionObservation {
    const tier = nonNegativeInteger(input.tier);
    const queue = input.queue ?? null;
    const tierRow = tier == null ? null : queue?.byTier?.find((row) => row.tier === tier) ?? null;
    return {
      offsetMs: Math.max(0, this.now() - this.startedAt),
      priority: finiteNumber(input.priority),
      tier,
      running: nonNegativeInteger(queue?.running),
      queued: nonNegativeInteger(queue?.queued),
      maxConcurrent: nonNegativeInteger(queue?.maxConcurrent),
      tier1Reserve: nonNegativeInteger(queue?.tier1Reserve),
      tierMinShare: tierRow?.minShare == null ? null : nonNegativeInteger(tierRow.minShare),
      tierInFlight: nonNegativeInteger(tierRow?.inFlight),
      tierQueued: nonNegativeInteger(tierRow?.queued),
    };
  }

  /** Record entry into one admission layer. Duplicate entry calls are ignored:
   * a retry must update its own attempt telemetry, not rewrite the request's
   * original queue evidence. */
  admissionQueued(layer: GatewayAdmissionLayer, input: GatewayAdmissionObservationInput = {}): void {
    if (this.finished || this.admission[layer]?.queued) return;
    this.admission[layer] = {
      queued: this.admissionObservation(input),
      admitted: null,
      waitMs: null,
    };
  }

  /** Record the moment one admission layer let the request through. */
  admissionAdmitted(layer: GatewayAdmissionLayer, input: GatewayAdmissionObservationInput = {}): void {
    if (this.finished || this.admission[layer]?.admitted) return;
    const admitted = this.admissionObservation(input);
    const queued = this.admission[layer]?.queued ?? null;
    this.admission[layer] = {
      queued,
      admitted,
      waitMs: queued ? Math.max(0, admitted.offsetMs - queued.offsetMs) : null,
    };
  }

  setTransport(transport: GatewayTelemetryTransport): void {
    this.transport = transport;
  }

  setModel(model: string | null | undefined): void {
    this.model = boundedIdentifier(model);
  }

  setCacheRouting(decision: GatewayCacheRoutingDecision): void {
    this.cacheRouting = decision;
  }

  /** Inspect only the already-buffered shaped body, with a hard parse-size ceiling. */
  setCacheShape(body: Uint8Array): void {
    if (this.finished) return;
    const started = this.now();
    try {
      if (body.byteLength > 2_097_152) { this.cache.shape = 'oversized'; return; }
      const parsed = JSON.parse(Buffer.from(body).toString('utf8')) as { tools?: unknown; system?: unknown; instructions?: unknown };
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { this.cache.shape = 'invalid'; return; }
      this.cache.tools = cacheFingerprint(parsed.tools);
      this.cache.instructions = cacheFingerprint(parsed.system ?? parsed.instructions);
      this.cache.shape = 'observed';
    } catch { this.cache.shape = 'invalid'; }
    finally { this.cacheObservationMs += Math.max(0, this.now() - started); }
  }

  setServingAccount(accountId: string): void {
    if (!this.finished) this.cache.servingAccountId = boundedIdentifier(accountId, 120);
  }

  recordCacheUsage(input: number, read: number, write: number | undefined, requestId?: string): void {
    if (this.finished || [input, read, ...(write === undefined ? [] : [write])].some((n) => !Number.isFinite(n) || n < 0)) return;
    this.cache.inputTokens = input;
    this.cache.cacheReadTokens = read;
    this.cache.cacheWriteTokens = write ?? null;
    this.cache.providerRequestId = boundedIdentifier(requestId, 160);
    this.cache.reuse = read === 0 ? 'zero-read' : write === undefined ? 'hit-unknown-write' : input + write === 0 ? 'full-hit' : 'partial-hit';
    this.cache.missReason = read === 0 ? 'unknown' : 'none';
  }

  setStreaming(streaming: boolean): void {
    this.streaming = streaming;
  }

  recordAttempt(): void {
    this.attempts++;
  }

  recordFailover(): void {
    this.failovers++;
  }

  finish(outcome: GatewayRequestOutcome, finalStatus: number | null): GatewayRequestTimeline | null {
    if (this.finished) return null;
    const finalizedAt = this.now();
    this.finished = true;

    // Close stages that are meaningful even on early exits. Other open stages remain missing and are
    // reported below; silently manufacturing them would defeat the explicit missing-stage guard.
    for (const stage of ['routeSelection', 'queueWait'] as const) {
      const started = this.stageStartedAt.get(stage);
      if (started !== undefined) {
        this.stageStartedAt.delete(stage);
        this.durations[stage] = (this.durations[stage] ?? 0) + Math.max(0, finalizedAt - started);
        this.event(stage, 'end', finalizedAt);
      }
    }
    this.durations.total = Math.max(0, finalizedAt - this.startedAt);
    this.event('total', 'end', finalizedAt);
    const gatewayOverhead =
      (this.durations.routeSelection ?? 0) +
      (this.durations.bodyRead ?? 0) +
      (this.durations.auth ?? 0);
    this.durations.gatewayOverhead = gatewayOverhead;

    const early = outcome === 'shed' || outcome === 'cancelled' || outcome === 'client-error';
    const required: GatewayRequestStageName[] = ['routeSelection', 'queueWait', 'total'];
    if (!early) {
      required.push('bodyRead');
      if (this.attempts > 0 || outcome === 'ok') required.push('upstreamTtfb');
      if (this.provider !== 'local') required.push('auth');
      if (this.streaming) required.push('stream');
    }
    const missingStages = required.filter((stage) => this.durations[stage] === undefined);
    const timeline: GatewayRequestTimeline = {
      requestId: this.requestId,
      ownerId: this.ownerId,
      provider: this.provider,
      protocol: this.protocol,
      transport: this.transport,
      model: this.model,
      cacheRouting: this.cacheRouting,
      cache: cloneCacheObservation(this.cache),
      previousObservedRequestGapMs: this.previousObservedRequestGapMs,
      cacheObservationMs: this.cacheObservationMs,
      startedAt: this.startedAt,
      finalizedAt,
      attempts: this.attempts,
      failovers: this.failovers,
      finalStatus,
      outcome,
      streaming: this.streaming,
      durationsMs: { ...this.durations },
      admission: cloneAdmission(this.admission),
      events: this.events.map((event) => ({ ...event })),
      missingStages,
    };
    this.collector.complete(timeline);
    return timeline;
  }
}

export class GatewayRequestTelemetry {
  private nextRequestId = 0;
  private started = 0;
  private finalized = 0;
  private sampled = 0;
  private missingStageTimelines = 0;
  private cacheUsageObserved = 0;
  private cacheWriteObserved = 0;
  private readonly active = new Set<number>();
  private readonly outcomes = emptyOutcomes();
  private readonly missingStageByName = emptyMissingStages();
  private readonly stageSamples: Record<GatewayRequestStageName, BoundedSamples>;
  private readonly recent: GatewayRequestTimeline[] = [];
  private readonly sampleCapacity: number;
  private readonly recentCapacity: number;
  private readonly now: () => number;

  constructor(opts: { sampleCapacity?: number; recentCapacity?: number; now?: () => number } = {}) {
    this.sampleCapacity = Math.max(1, Math.floor(opts.sampleCapacity ?? 4096));
    this.recentCapacity = Math.max(1, Math.floor(opts.recentCapacity ?? 256));
    this.now = opts.now ?? Date.now;
    this.stageSamples = Object.fromEntries(
      GATEWAY_REQUEST_STAGE_NAMES.map((stage) => [stage, new BoundedSamples(this.sampleCapacity)]),
    ) as Record<GatewayRequestStageName, BoundedSamples>;
  }

  clock(): number {
    return this.now();
  }

  previousRequestGap(ownerId: string | null, at: number): number | null {
    if (!ownerId) return null;
    for (let i = this.recent.length - 1; i >= 0; i--) {
      if (this.recent[i].ownerId === ownerId) return Math.max(0, at - this.recent[i].startedAt);
    }
    return null;
  }

  begin(seed: {
    ownerId?: string | null;
    provider: GatewayTelemetryProvider;
    protocol: GatewayTelemetryProtocol;
    transport?: GatewayTelemetryTransport;
  }): GatewayRequestSpan {
    const requestId = ++this.nextRequestId;
    const startedAt = this.clock();
    this.started++;
    this.active.add(requestId);
    return new GatewayRequestSpan(
      this,
      requestId,
      boundedOwnerId(seed.ownerId),
      seed.provider,
      seed.protocol,
      seed.transport ?? 'unknown',
      startedAt,
    );
  }

  complete(timeline: GatewayRequestTimeline): void {
    if (!this.active.delete(timeline.requestId)) return;
    this.finalized++;
    this.sampled++;
    if (timeline.cache.reuse !== 'unobserved') this.cacheUsageObserved++;
    if (timeline.cache.cacheWriteTokens !== null) this.cacheWriteObserved++;
    this.outcomes[timeline.outcome]++;
    if (timeline.missingStages.length) {
      this.missingStageTimelines++;
      for (const stage of timeline.missingStages) this.missingStageByName[stage]++;
    }
    for (const stage of GATEWAY_REQUEST_STAGE_NAMES) {
      const value = timeline.durationsMs[stage];
      if (value !== undefined) this.stageSamples[stage].add(value);
    }
    this.recent.push(timeline);
    if (this.recent.length > this.recentCapacity) {
      this.recent.splice(0, this.recent.length - this.recentCapacity);
    }
  }

  snapshot(): GatewayRequestTelemetrySnapshot {
    const stages = Object.fromEntries(
      GATEWAY_REQUEST_STAGE_NAMES.map((stage) => [stage, this.stageSamples[stage].snapshot()]),
    ) as Record<GatewayRequestStageName, GatewayPercentileSummary>;
    return {
      schemaVersion: 1,
      requests: {
        started: this.started,
        finalized: this.finalized,
        active: this.active.size,
        sampled: this.sampled,
        coverage: this.finalized ? this.sampled / this.finalized : 1,
        reconciled: this.started === this.finalized + this.active.size,
        outcomeReconciled:
          this.finalized === OUTCOMES.reduce((sum, outcome) => sum + this.outcomes[outcome], 0),
        missingStageTimelines: this.missingStageTimelines,
        cacheUsageObserved: this.cacheUsageObserved,
        cacheUsageCoverage: this.finalized ? this.cacheUsageObserved / this.finalized : null,
        cacheWriteObserved: this.cacheWriteObserved,
      },
      outcomes: { ...this.outcomes },
      stages,
      missingStageByName: { ...this.missingStageByName },
      sampleCapacity: this.sampleCapacity,
      recentCapacity: this.recentCapacity,
      recent: this.recent.map((timeline) => ({
        ...timeline,
        cache: cloneCacheObservation(timeline.cache),
        durationsMs: { ...timeline.durationsMs },
        admission: cloneAdmission(timeline.admission),
        events: timeline.events.map((event) => ({ ...event })),
        missingStages: [...timeline.missingStages],
      })),
    };
  }

  snapshotForOwner(ownerId: string): GatewayOwnerStageTelemetry {
    const safeOwner = boundedOwnerId(ownerId) ?? '';
    const timelines = this.recent.filter((timeline) => timeline.ownerId === safeOwner);
    const outcomes = emptyOutcomes();
    const byStage = Object.fromEntries(
      GATEWAY_REQUEST_STAGE_NAMES.map((stage) => [stage, [] as number[]]),
    ) as Record<GatewayRequestStageName, number[]>;
    for (const timeline of timelines) {
      outcomes[timeline.outcome]++;
      for (const stage of GATEWAY_REQUEST_STAGE_NAMES) {
        const value = timeline.durationsMs[stage];
        if (value !== undefined) byStage[stage].push(value);
      }
    }
    const stages = Object.fromEntries(
      GATEWAY_REQUEST_STAGE_NAMES.map((stage) => [stage, summarize(byStage[stage])]),
    ) as Record<GatewayRequestStageName, GatewayPercentileSummary>;
    return {
      ownerId: safeOwner,
      finalized: timelines.length,
      outcomes,
      stages,
      recent: timelines.map((timeline) => ({
        ...timeline,
        cache: cloneCacheObservation(timeline.cache),
        durationsMs: { ...timeline.durationsMs },
        admission: cloneAdmission(timeline.admission),
        events: timeline.events.map((event) => ({ ...event })),
        missingStages: [...timeline.missingStages],
      })),
    };
  }
}

export function classifyGatewayTelemetryOutcome(
  status: number | null,
  opts: { cancelled?: boolean; shed?: boolean; gatewayError?: boolean } = {},
): GatewayRequestOutcome {
  if (opts.cancelled) return 'cancelled';
  if (opts.shed) return 'shed';
  if (opts.gatewayError) return 'gateway-error';
  if (status === null) return 'unclassified';
  if (status >= 200 && status < 400) return 'ok';
  if (status === 429) return 'upstream-429';
  if (status >= 400 && status < 500) return 'client-error';
  if (status >= 500) return 'upstream-error';
  return 'unclassified';
}

export function emptyGatewayStageSummariesForTest(): Record<GatewayRequestStageName, GatewayPercentileSummary> {
  return emptyStageSummaries();
}
