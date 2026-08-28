/**
 * Capless inference-gateway writer inventory (capless-inference-gateway-2026-08-28, P-001).
 *
 * This is deliberately a small, typed census of the places that can currently make a
 * gateway throughput number look like capacity.  The inventory is not a second governor
 * and it does not decide whether a value is safe at runtime.  It records the writer,
 * units, live effect, disposition, and the deletion/recurrence proof that the migration
 * must carry.  Keeping the evidence next to the writer list prevents a new constant or
 * derived clamp from arriving without an owner and a removal plan.
 */

export const INFERENCE_GATEWAY_CAPACITY_INVENTORY_SCHEMA_VERSION =
  'inference-gateway-capacity-inventory-v1' as const;

export type CapacityWriterDisposition =
  | 'remove'
  | 'transient-feedback'
  | 'explicit-control-recovery-bypass'
  | 'semantic-protocol-safety'
  | 'measured-external-physical-contract';

export type CapacityWriterDimension =
  | 'claude-admission'
  | 'codex-admission'
  | 'local-backend'
  | 'provider'
  | 'queue'
  | 'priority'
  | 'resource-profile'
  | 'deployment'
  | 'status';

export type CapacityWriterSourceKind = 'code' | 'deployment' | 'status-reader';

export interface InferenceGatewayCapacityWriter {
  readonly id: string;
  /** Repository-relative path of the exact production writer. */
  readonly file: string;
  /** Symbol or route/field that owns the write. */
  readonly symbol: string;
  /** A source fragment that must remain present while this row is live. */
  readonly sourceAnchor: string;
  readonly sourceKind: CapacityWriterSourceKind;
  readonly dimensions: readonly CapacityWriterDimension[];
  /** Unit/scale of the value (for example, requests, slots, milliseconds, or a fraction). */
  readonly units: string;
  /** Runtime owner responsible for changing or deleting the writer. */
  readonly owner: string;
  /** What the writer does today, including whether it binds admission or only reports it. */
  readonly liveEffect: string;
  /** The observed literal/formula, or null when the writer is a projection/reader. */
  readonly currentValue: number | string | null;
  readonly disposition: CapacityWriterDisposition;
  /** Plan item / release target that removes or reclassifies the writer. */
  readonly deletionTarget: string;
  /** Test or guard that must remain green after the writer is migrated. */
  readonly recurrenceTest: string;
  /** Durable source that should replace a local ceiling or seed. */
  readonly durableSource: string;
  /** Signal that explains how the value is measured/freshened. */
  readonly telemetry: string;
  /** Request/queue/status context in which the number is consumed. */
  readonly contextPath: string;
  /** Optional fan-out or consumer note. */
  readonly fanOut?: string;
}

function writer(
  row: Omit<InferenceGatewayCapacityWriter, 'dimensions'> & {
    dimensions: readonly CapacityWriterDimension[];
  },
): InferenceGatewayCapacityWriter {
  return Object.freeze({ ...row, dimensions: Object.freeze([...row.dimensions]) });
}

const GATEWAY = 'packages/operator-core/lib/inference-gateway/gateway.ts';
const LAUNCH = 'packages/operator-core/lib/inference-gateway/launch.ts';
const SIDECAR = 'packages/operator-core/lib/inference-gateway/sidecar-main.ts';
const PRIORITY = 'libs/papercusp-shared/src/resilience/priority-admission.ts';
const AIMD = 'libs/papercusp-shared/src/resilience/aimd-concurrency.ts';
const REGISTRY = 'libs/papercusp-shared/src/agent/governor-registry.ts';
const RATE_LIMIT = 'packages/operator-core/lib/rate-limit-config.ts';
const PROFILE = 'libs/generic/resource-profile/src/index.ts';

/**
 * Exact production writer census.  Rows intentionally include reporting readers: a
 * number that is correctly computed but reported without its binding term is still a
 * capacity bug (D-009).
 */
export const INFERENCE_GATEWAY_CAPACITY_INVENTORY: readonly InferenceGatewayCapacityWriter[] = Object.freeze([
  writer({
    id: 'gateway-claude-default-concurrency',
    file: GATEWAY,
    symbol: 'DEFAULT_CONCURRENCY',
    sourceAnchor: 'const DEFAULT_CONCURRENCY = 24',
    sourceKind: 'code',
    dimensions: ['claude-admission'],
    units: 'requests in flight',
    owner: 'inference-gateway Claude admission queue',
    liveEffect: 'Seeds the Claude PriorityAdmissionQueue and the AIMD cap; currently acts as a productive-capacity ceiling.',
    currentValue: 24,
    disposition: 'remove',
    deletionTarget: 'P-005/P-007: CaplessAdaptiveController desired window',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + unclassified-writer guard',
    durableSource: 'resource-governor durable desired/effective state and receipts',
    telemetry: 'gateway stats admission/aimd snapshots with generation and freshness',
    contextPath: 'createInferenceGateway → PriorityAdmissionQueue → executeLegacyLaneTask',
    fanOut: 'Claude messages, maintenance, and Anthropic-compatible callers',
  }),
  writer({
    id: 'gateway-codex-slots-per-account',
    file: GATEWAY,
    symbol: 'CODEX_ADMISSION_SLOTS_PER_ACCOUNT',
    sourceAnchor: 'export const CODEX_ADMISSION_SLOTS_PER_ACCOUNT = 4',
    sourceKind: 'code',
    dimensions: ['codex-admission'],
    units: 'requests per resolved account',
    owner: 'inference-gateway Codex admission sizing',
    liveEffect: 'Multiplies account count into a default Codex queue size and can cap healthy-account expansion.',
    currentValue: 4,
    disposition: 'remove',
    deletionTarget: 'P-007: provider feedback, not slots-per-account arithmetic',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + unclassified-writer guard',
    durableSource: 'resource-governor Codex admission class state',
    telemetry: 'Codex admission and provider outcome snapshots',
    contextPath: 'accountScaledCodexConcurrency → codexQueue',
  }),
  writer({
    id: 'gateway-aimd-floor',
    file: GATEWAY,
    symbol: 'DEFAULT_AIMD_FLOOR',
    sourceAnchor: 'const DEFAULT_AIMD_FLOOR =',
    sourceKind: 'code',
    dimensions: ['claude-admission', 'codex-admission'],
    units: 'requests in flight',
    owner: 'inference-gateway AIMD adapter',
    liveEffect: 'Prevents learned admission from contracting below a fixed four-request floor.',
    currentValue: 4,
    disposition: 'remove',
    deletionTarget: 'P-005/P-009: expiring controller feedback with no baked productive-capacity floor',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + unclassified-writer guard',
    durableSource: 'CaplessAdaptiveController minimum/protection state with causal expiry',
    telemetry: 'aimd effective/floor/decrease snapshots and health verdict generation',
    contextPath: 'AimdConcurrencyController construction for Claude and Codex queues',
  }),
  writer({
    id: 'gateway-aimd-decrease-threshold',
    file: GATEWAY,
    symbol: 'DEFAULT_AIMD_DECREASE_THRESHOLD',
    sourceAnchor: 'const DEFAULT_AIMD_DECREASE_THRESHOLD =',
    sourceKind: 'code',
    dimensions: ['claude-admission', 'codex-admission'],
    units: 'net throttle events',
    owner: 'inference-gateway AIMD adapter',
    liveEffect: 'Controls when transient throttle feedback trips a multiplicative contraction.',
    currentValue: 6,
    disposition: 'transient-feedback',
    deletionTarget: 'P-005: move tuning into versioned controller feedback state',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + AIMD controller tests',
    durableSource: 'health verdicts and scoped contraction feedback',
    telemetry: '429/throttle event stream, controller generation, contraction expiry',
    contextPath: 'AimdConcurrencyController.recordThrottle',
  }),
  writer({
    id: 'gateway-aimd-increase-every',
    file: GATEWAY,
    symbol: 'DEFAULT_AIMD_INCREASE_EVERY',
    sourceAnchor: 'const DEFAULT_AIMD_INCREASE_EVERY =',
    sourceKind: 'code',
    dimensions: ['claude-admission', 'codex-admission'],
    units: 'clean responses per increase',
    owner: 'inference-gateway AIMD adapter',
    liveEffect: 'Controls additive recovery toward the configured cap.',
    currentValue: 8,
    disposition: 'transient-feedback',
    deletionTarget: 'P-005: move recovery cadence into controller feedback state',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + AIMD controller tests',
    durableSource: 'fresh successful outcome feedback with recovery generation',
    telemetry: 'clean streak/increase count and health freshness',
    contextPath: 'AimdConcurrencyController.recordSuccess',
  }),
  writer({
    id: 'gateway-serviceable-per-account',
    file: GATEWAY,
    symbol: 'PER_ACCOUNT_ADMISSION',
    sourceAnchor: 'const PER_ACCOUNT_ADMISSION =',
    sourceKind: 'code',
    dimensions: ['claude-admission', 'codex-admission'],
    units: 'requests per serviceable account',
    owner: 'inference-gateway serviceability clamp',
    liveEffect: 'Multiplies an in-memory serviceable-account count into a live admission recommendation.',
    currentValue: 4,
    disposition: 'remove',
    deletionTarget: 'P-007: serviceability is routing/causal evidence, not a capacity formula',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + capless expansion tests',
    durableSource: 'per-class controller state learned from outcomes',
    telemetry: 'serviceability count with observation time and pool generation',
    contextPath: 'serviceableAdmissionCapFn → applyAdmissionCap',
  }),
  writer({
    id: 'gateway-serviceable-minimum',
    file: GATEWAY,
    symbol: 'MIN_SERVICEABLE_ADMISSION',
    sourceAnchor: 'const MIN_SERVICEABLE_ADMISSION =',
    sourceKind: 'code',
    dimensions: ['claude-admission', 'codex-admission'],
    units: 'requests in flight',
    owner: 'inference-gateway serviceability clamp',
    liveEffect: 'Forces a fixed minimum admission even when no serviceable account is observed.',
    currentValue: 2,
    disposition: 'remove',
    deletionTarget: 'P-007: replace with explicit control/recovery bypass and measured feedback',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + zero-serviceability fixtures',
    durableSource: 'durable queue plus registered control/recovery class',
    telemetry: 'unknown/stale serviceability state, never a synthetic minimum',
    contextPath: 'serviceableAdmissionCapFn',
  }),
  writer({
    id: 'gateway-serviceable-clamp-application',
    file: GATEWAY,
    symbol: 'applyAdmissionCap',
    sourceAnchor: "const capped = clampMode === 'off' ? Math.max(1, eff)",
    sourceKind: 'code',
    dimensions: ['claude-admission', 'codex-admission'],
    units: 'requests in flight',
    owner: 'inference-gateway admission application',
    liveEffect: 'Takes the minimum of AIMD effective admission and the serviceable recommendation.',
    currentValue: 'min(aimd effective, serviceable recommendation)',
    disposition: 'remove',
    deletionTarget: 'P-007: remove derived serviceable hard clamp; retain attribution only',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + admission-ceiling fixtures',
    durableSource: 'CaplessAdaptiveController per-class effective window',
    telemetry: 'binding term, recommendation, applied value, and freshness in status',
    contextPath: 'AIMD onChange / serviceable timer → queue.setMaxConcurrent',
  }),
  writer({
    id: 'gateway-serviceable-clamp-tick',
    file: GATEWAY,
    symbol: 'SERVICEABLE_CLAMP_TICK_MS',
    sourceAnchor: 'const SERVICEABLE_CLAMP_TICK_MS =',
    sourceKind: 'code',
    dimensions: ['claude-admission', 'codex-admission'],
    units: 'milliseconds between observations',
    owner: 'inference-gateway serviceability observer',
    liveEffect: 'Re-applies the serviceability recommendation while AIMD is unchanged.',
    currentValue: 2000,
    disposition: 'transient-feedback',
    deletionTarget: 'P-003/P-007: replace timer-driven clamp with paced live observation',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + observer lifecycle tests',
    durableSource: 'fresh pool/governor observations with explicit generation',
    telemetry: 'serviceability reading age and pool reload generation',
    contextPath: 'serviceableClampTimer',
  }),
  writer({
    id: 'gateway-max-queued',
    file: GATEWAY,
    symbol: 'DEFAULT_MAX_QUEUED',
    sourceAnchor: 'const DEFAULT_MAX_QUEUED =',
    sourceKind: 'code',
    dimensions: ['queue'],
    units: 'queued requests',
    owner: 'inference-gateway queue adapter',
    liveEffect: 'Turns a saturated in-memory PriorityAdmissionQueue into a QueueFullError/load-shed 429.',
    currentValue: 256,
    disposition: 'remove',
    deletionTarget: 'P-006: durable queue/receipt admission; resident depth no longer rejects accepted work',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + durable queue conformance tests',
    durableSource: 'resource-governor durable queue, payload references, and receipts',
    telemetry: 'durable queue depth/age with bounded payload residency',
    contextPath: 'PriorityAdmissionQueue.run → QueueFullError',
  }),
  writer({
    id: 'gateway-loadshed-retry-after',
    file: GATEWAY,
    symbol: 'LOADSHED_RETRY_AFTER_SEC',
    sourceAnchor: 'const LOADSHED_RETRY_AFTER_SEC = 5',
    sourceKind: 'code',
    dimensions: ['queue'],
    units: 'seconds',
    owner: 'inference-gateway HTTP protocol adapter',
    liveEffect: 'Supplies a retry hint on the legacy load-shed response; it does not represent provider capacity.',
    currentValue: 5,
    disposition: 'semantic-protocol-safety',
    deletionTarget: 'P-006/P-014: retain only if the protocol needs a retry hint after durable acceptance semantics',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + HTTP retry contract tests',
    durableSource: 'receipt status/retry-after policy with explicit reason',
    telemetry: 'response status, retry reason, and receipt state',
    contextPath: 'QueueFullError catch in the HTTP request handler',
  }),
  writer({
    id: 'gateway-priority-absorb-factors',
    file: GATEWAY,
    symbol: 'absorbTierFactor',
    sourceAnchor: 'function absorbTierFactor(tier: number | undefined): number',
    sourceKind: 'code',
    dimensions: ['priority'],
    units: 'dimensionless wait multiplier',
    owner: 'inference-gateway priority scheduler',
    liveEffect: 'Varies transient retry patience by priority tier, affecting ordering but not physical capacity.',
    currentValue: 'tier-dependent factors (1.5/1.25/1/0.6)',
    disposition: 'transient-feedback',
    deletionTarget: 'P-008: replace tier-specific capacity behavior with weighted fair scheduling and aging',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + priority fairness tests',
    durableSource: 'registered priority/service objective policy',
    telemetry: 'tier, wait age, and admitted receipt outcome',
    contextPath: 'retry/absorb path before provider re-acquisition',
  }),
  writer({
    id: 'capacity-probe-concurrency',
    file: 'packages/operator-core/lib/inference-gateway/capacity-probe.ts',
    symbol: 'PROBE_CONCURRENCY',
    sourceAnchor: 'const PROBE_CONCURRENCY =',
    sourceKind: 'code',
    dimensions: ['provider'],
    units: 'accounts probed concurrently',
    owner: 'inference-gateway capacity probe',
    liveEffect: 'Bounds simultaneous upstream probe requests during an evidence sweep; it does not bound productive inference admission.',
    currentValue: 3,
    disposition: 'transient-feedback',
    deletionTarget: 'P-003/P-009: pace observations from probe health and external response, not a productive-capacity cap',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + probe deadline tests',
    durableSource: 'probe sweep receipts and upstream response evidence',
    telemetry: 'probe concurrency, account id, status, and observation timestamp',
    contextPath: 'probeCapacityForAccounts → probeAccountCapacity',
  }),
  writer({
    id: 'gateway-stats-writer',
    file: GATEWAY,
    symbol: 'stats',
    sourceAnchor: 'function stats(): GatewayStats',
    sourceKind: 'status-reader',
    dimensions: ['status'],
    units: 'mixed; each field declares its own unit',
    owner: 'inference-gateway observability',
    liveEffect: 'Publishes admission, queue, AIMD, serviceability, and provider numbers consumed by operators.',
    currentValue: null,
    disposition: 'transient-feedback',
    deletionTarget: 'P-013: every field names writer, units, binding term, generation, and freshness',
    recurrenceTest: 'capacity-inventory.test.ts status-anchor guard',
    durableSource: 'live controller/pool snapshots and durable state history',
    telemetry: 'stats snapshot timestamp, controller generation, and observation ages',
    contextPath: 'GET /stats, /healthz, and admin endpoints',
  }),
  writer({
    id: 'gateway-admin-config-writer',
    file: GATEWAY,
    symbol: 'GET /admin/config',
    sourceAnchor: "url === '/admin/config'",
    sourceKind: 'status-reader',
    dimensions: ['status', 'deployment'],
    units: 'mixed; structured JSON fields',
    owner: 'inference-gateway admin surface',
    liveEffect: 'Reports configured/effective admission and the term currently binding it.',
    currentValue: null,
    disposition: 'transient-feedback',
    deletionTarget: 'P-013: preserve honest readback while removing cap fields',
    recurrenceTest: 'capacity-inventory.test.ts admin-config anchor guard',
    durableSource: 'controller state and deployment configuration provenance',
    telemetry: 'admissionCeiling boundBy, clamp recommendation/applied, and freshness',
    contextPath: 'gateway:status → GET /admin/config',
  }),
  writer({
    id: 'launch-default-reserve-fraction',
    file: LAUNCH,
    symbol: 'DEFAULT_T1_RESERVE_FRAC',
    sourceAnchor: 'export const DEFAULT_T1_RESERVE_FRAC = 0.15',
    sourceKind: 'code',
    dimensions: ['priority'],
    units: 'fraction of admission slots',
    owner: 'inference-gateway launch priority-tier resolver',
    liveEffect: 'Derives a fixed tier-1 reserve and indirectly caps lower-priority work.',
    currentValue: 0.15,
    disposition: 'remove',
    deletionTarget: 'P-008: weighted fair scheduling; no permanently idle reserve',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + fairness/borrowing tests',
    durableSource: 'priority service objectives and observed demand',
    telemetry: 'tier demand, wait age, and borrowed idle slots',
    contextPath: 'resolvePriorityTiers → defaultTierCaps',
  }),
  writer({
    id: 'launch-default-concurrency',
    file: LAUNCH,
    symbol: 'DEFAULT_CONCURRENCY',
    sourceAnchor: 'const DEFAULT_CONCURRENCY = 24; // mirrors gateway.ts\'s default',
    sourceKind: 'code',
    dimensions: ['claude-admission'],
    units: 'requests in flight',
    owner: 'inference-gateway launch adapter',
    liveEffect: 'Mirrors the gateway cap when constructing priority-tier and service options.',
    currentValue: 24,
    disposition: 'remove',
    deletionTarget: 'P-004/P-005: remove duplicated compatibility ceiling',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + launch wiring tests',
    durableSource: 'durable controller state seeded once for compatibility',
    telemetry: 'launch provenance and live gateway config version',
    contextPath: 'startGatewayService → createInferenceGateway',
  }),
  writer({
    id: 'launch-codex-derived-concurrency',
    file: LAUNCH,
    symbol: 'codexConcurrency',
    sourceAnchor: 'accountScaledCodexConcurrency(codexAccounts.length, claudeConcurrency)',
    sourceKind: 'code',
    dimensions: ['codex-admission'],
    units: 'requests in flight',
    owner: 'inference-gateway launch adapter',
    liveEffect: 'Derives a Codex queue size from account count and the Claude ceiling.',
    currentValue: 'min(claudeConcurrency, accountCount × slotsPerAccount)',
    disposition: 'remove',
    deletionTarget: 'P-007: provider/account observations feed class feedback directly',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + multi-account expansion tests',
    durableSource: 'Codex admission-class desired/effective state',
    telemetry: 'Codex pool health, provider responses, and controller generation',
    contextPath: 'startGatewayService → codexQueue',
  }),
  writer({
    id: 'launch-priority-tier-defaults',
    file: LAUNCH,
    symbol: 'resolvePriorityTiers',
    sourceAnchor: 'const { caps, reserve } = defaultTierCaps(poolSlots, tiers, frac)',
    sourceKind: 'code',
    dimensions: ['priority'],
    units: 'slots per tier / slots reserved',
    owner: 'inference-gateway launch priority-tier resolver',
    liveEffect: 'Creates per-tier caps and a reserve from the pool size.',
    currentValue: 'derived tier caps + reserve',
    disposition: 'remove',
    deletionTarget: 'P-008: fair scheduler with work-conserving borrowing',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + tier fairness tests',
    durableSource: 'priority policy and durable service objectives',
    telemetry: 'tier queue/in-flight/wait distributions',
    contextPath: 'GATEWAY_PRIORITY_TIERS flag → resolvePriorityTiers',
  }),
  writer({
    id: 'sidecar-concurrency-environment',
    file: SIDECAR,
    symbol: 'startGatewayService concurrency option',
    sourceAnchor: 'concurrency: Number(process.env.PAPERCUSP_GATEWAY_CONCURRENCY)',
    sourceKind: 'deployment',
    dimensions: ['deployment', 'claude-admission'],
    units: 'requests in flight',
    owner: 'packaged/systemd gateway sidecar',
    liveEffect: 'Threads an environment override into the launch adapter and can reinstate a cap on restart.',
    currentValue: 'PAPERCUSP_GATEWAY_CONCURRENCY (unset => launch default)',
    disposition: 'remove',
    deletionTarget: 'P-004/P-012: compatibility telemetry only; never an admission ceiling',
    recurrenceTest: 'capacity-inventory.test.ts deployment-anchor guard',
    durableSource: 'durable controller state plus explicit migration diagnostics',
    telemetry: 'environment provenance and live controller generation',
    contextPath: 'runGatewaySidecarMain → startGatewayService',
  }),
  writer({
    id: 'systemd-concurrency-environment',
    file: 'apps/operator/scripts/systemd/papercup-inference-gateway.service',
    symbol: 'PAPERCUSP_GATEWAY_CONCURRENCY environment',
    sourceAnchor: '# Optional: PAPERCUSP_GATEWAY_CONCURRENCY=24',
    sourceKind: 'deployment',
    dimensions: ['deployment', 'claude-admission'],
    units: 'requests in flight',
    owner: 'systemd gateway unit',
    liveEffect: 'Documents the restart-time cap override that can shadow live controller state.',
    currentValue: 24,
    disposition: 'remove',
    deletionTarget: 'P-004/P-012: delete cap-bearing deployment default after observe-only migration',
    recurrenceTest: 'capacity-inventory.test.ts deployment-anchor guard',
    durableSource: 'controller state and deployment provenance',
    telemetry: 'systemd environment plus gateway /admin/config readback',
    contextPath: 'systemd ExecStart → sidecar-main',
  }),
  writer({
    id: 'priority-admission-max-queued',
    file: PRIORITY,
    symbol: 'PriorityAdmissionQueue.maxQueued',
    sourceAnchor: 'private readonly maxQueued: number;',
    sourceKind: 'code',
    dimensions: ['queue'],
    units: 'queued tasks',
    owner: 'shared PriorityAdmissionQueue',
    liveEffect: 'Rejects a full resident queue with QueueFullError.',
    currentValue: 'constructor maxQueued option',
    disposition: 'remove',
    deletionTarget: 'P-006: durable queue replaces resident queue depth as acceptance authority',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + queue persistence tests',
    durableSource: 'durable receipt queue and payload references',
    telemetry: 'durable queue depth/age and persistence health',
    contextPath: 'PriorityAdmissionQueue.run',
  }),
  writer({
    id: 'priority-admission-tier-caps',
    file: PRIORITY,
    symbol: 'PriorityAdmissionQueue.tierCaps',
    sourceAnchor: 'private readonly tierCaps: Map<number, number> | null;',
    sourceKind: 'code',
    dimensions: ['priority'],
    units: 'requests in flight per tier',
    owner: 'shared PriorityAdmissionQueue',
    liveEffect: 'Applies per-tier in-flight caps before selecting a waiter.',
    currentValue: 'tiers.caps',
    disposition: 'remove',
    deletionTarget: 'P-008: priority ordering/fair share without hard tier ceilings',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + work-conserving tier tests',
    durableSource: 'priority scheduler state and service objectives',
    telemetry: 'tier demand, wait age, and borrow decisions',
    contextPath: 'PriorityAdmissionQueue.canAdmit / drain',
  }),
  writer({
    id: 'priority-admission-tier1-reserve',
    file: PRIORITY,
    symbol: 'PriorityAdmissionQueue.tier1Reserve',
    sourceAnchor: 'private tier1Reserve = 0;',
    sourceKind: 'code',
    dimensions: ['priority'],
    units: 'reserved slots',
    owner: 'shared PriorityAdmissionQueue',
    liveEffect: 'Holds slots open for tier 1 and can leave productive capacity idle.',
    currentValue: 'tiers.tier1Reserve',
    disposition: 'remove',
    deletionTarget: 'P-008: weighted fair scheduling with explicit control bypasses',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + idle-slot borrowing tests',
    durableSource: 'registered control/recovery class and service objectives',
    telemetry: 'tier waiters and actual borrowed idle slots',
    contextPath: 'PriorityAdmissionQueue.canAdmit / setMaxConcurrent',
  }),
  writer({
    id: 'priority-admission-default-tier-caps',
    file: PRIORITY,
    symbol: 'defaultTierCaps',
    sourceAnchor: 'export function defaultTierCaps(',
    sourceKind: 'code',
    dimensions: ['priority'],
    units: 'slots per tier',
    owner: 'shared priority policy',
    liveEffect: 'Derives fixed per-tier shares from a pool slot count.',
    currentValue: 'poolSlots/reserve fraction formula',
    disposition: 'remove',
    deletionTarget: 'P-008: no capacity formula derived from pool size',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + tier expansion tests',
    durableSource: 'scheduler policy and observed demand',
    telemetry: 'tier service/wait objectives',
    contextPath: 'launch.resolvePriorityTiers',
  }),
  writer({
    id: 'aimd-controller-cap-floor',
    file: AIMD,
    symbol: 'AimdConcurrencyController.cap/floor',
    sourceAnchor: 'private readonly cap: number;',
    sourceKind: 'code',
    dimensions: ['claude-admission', 'codex-admission'],
    units: 'requests in flight',
    owner: 'shared AimdConcurrencyController',
    liveEffect: 'Treats cap as an additive-increase ceiling and floor as a permanent lower bound.',
    currentValue: 'constructor cap/floor options',
    disposition: 'remove',
    deletionTarget: 'P-005: adapt the shared controller to unbounded desired windows and expiring feedback',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + controller expansion tests',
    durableSource: 'CaplessAdaptiveController state',
    telemetry: 'controller generation, health evidence, and expiry',
    contextPath: 'recordThrottle/recordSuccess → queue.setMaxConcurrent',
  }),
  writer({
    id: 'governor-default-floors',
    file: REGISTRY,
    symbol: 'DEFAULT_FLOORS',
    sourceAnchor: 'const DEFAULT_FLOORS:',
    sourceKind: 'code',
    dimensions: ['provider'],
    units: 'requests in flight and requests/minute',
    owner: 'shared provider governor registry',
    liveEffect: 'Seeds every provider/model bucket with maxConcurrent=3 and (for cloud providers) rpm=45.',
    currentValue: '{ anthropic: { maxConcurrent: 3, rpm: 45 }, openai: { maxConcurrent: 3, rpm: 45 } }',
    disposition: 'remove',
    deletionTarget: 'P-009: headers and measured provider outcomes are the only physical contract',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + provider feedback fixtures',
    durableSource: 'provider header observations with freshness/expiry',
    telemetry: 'rate-limit headers, penalties, account/model key, and observation age',
    contextPath: 'governorForBackend → RateLimitGovernor',
  }),
  writer({
    id: 'governor-global-cap',
    file: REGISTRY,
    symbol: 'globalCap',
    sourceAnchor: 'let globalCap = Infinity;',
    sourceKind: 'code',
    dimensions: ['provider', 'claude-admission', 'codex-admission'],
    units: 'requests in flight across buckets',
    owner: 'shared governor global gate',
    liveEffect: 'Installs the fleet-wide maxSimultaneousAgents ceiling above provider buckets.',
    currentValue: 'Infinity until a live config is applied; finite thereafter',
    disposition: 'remove',
    deletionTarget: 'P-009: global rate gate becomes measured feedback, not a productive-capacity maximum',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + cross-bucket expansion tests',
    durableSource: 'resource-governor class state and durable receipts',
    telemetry: 'global in-flight, effective window, and controller generation',
    contextPath: 'globalGate.tryAcquire → every RateLimitGovernor bucket',
  }),
  writer({
    id: 'governor-global-floor',
    file: REGISTRY,
    symbol: 'globalFloor',
    sourceAnchor: 'let globalFloor = 1;',
    sourceKind: 'code',
    dimensions: ['provider', 'claude-admission', 'codex-admission'],
    units: 'requests in flight',
    owner: 'shared governor global gate',
    liveEffect: 'Prevents the global AIMD effective window from falling below a fixed floor.',
    currentValue: 1,
    disposition: 'remove',
    deletionTarget: 'P-009: retain only explicit control/recovery protection and expiring causal feedback',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + recovery tests',
    durableSource: 'controller protection class and health evidence',
    telemetry: 'floor provenance, health severity, and expiry',
    contextPath: 'globalGate.notePenalty / setGlobalConcurrencyFloor',
  }),
  writer({
    id: 'governor-rpm-aimd-decrease',
    file: 'libs/papercusp-shared/src/resilience/governor.ts',
    symbol: 'RPM_AIMD_DECREASE',
    sourceAnchor: 'const RPM_AIMD_DECREASE =',
    sourceKind: 'code',
    dimensions: ['provider'],
    units: 'dimensionless multiplicative factor',
    owner: 'shared provider rate governor',
    liveEffect: 'Reduces the learned per-account RPM pace after a measured transient rate throttle.',
    currentValue: 0.5,
    disposition: 'transient-feedback',
    deletionTarget: 'P-003/P-009: retain as expiring, provider-scoped feedback rather than a ceiling',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + governor AIMD tests',
    durableSource: 'provider rate headers/429 evidence with expiry',
    telemetry: 'rpm factor, anchor time, penalty source, and account/model key',
    contextPath: 'RateLimitGovernor.penalize → effectiveRpm',
  }),
  writer({
    id: 'governor-rpm-aimd-min-factor',
    file: 'libs/papercusp-shared/src/resilience/governor.ts',
    symbol: 'RPM_AIMD_MIN_FACTOR',
    sourceAnchor: 'const RPM_AIMD_MIN_FACTOR =',
    sourceKind: 'code',
    dimensions: ['provider'],
    units: 'dimensionless factor',
    owner: 'shared provider rate governor',
    liveEffect: 'Sets the lower edge of the temporary learned RPM factor after throttling.',
    currentValue: 0.1,
    disposition: 'transient-feedback',
    deletionTarget: 'P-003/P-009: make the lower edge an expiring, evidence-backed policy',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + governor recovery tests',
    durableSource: 'provider rate observations and recovery timestamps',
    telemetry: 'factor, expiry/recovery age, and causal penalty scope',
    contextPath: 'effectiveRpmFactor / RateLimitGovernor.penalize',
  }),
  writer({
    id: 'governor-rpm-aimd-recovery',
    file: 'libs/papercusp-shared/src/resilience/governor.ts',
    symbol: 'RPM_AIMD_RECOVER_MS',
    sourceAnchor: 'const RPM_AIMD_RECOVER_MS =',
    sourceKind: 'code',
    dimensions: ['provider'],
    units: 'milliseconds',
    owner: 'shared provider rate governor',
    liveEffect: 'Controls how quickly a learned RPM contraction recovers toward the observed floor.',
    currentValue: 300000,
    disposition: 'transient-feedback',
    deletionTarget: 'P-003/P-009: preserve recovery freshness without a permanent cap',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + governor recovery tests',
    durableSource: 'provider response observations and recovery state',
    telemetry: 'factor anchor, elapsed recovery time, and provider/model scope',
    contextPath: 'effectiveRpmFactor → effectiveRpm → decideRate',
  }),
  writer({
    id: 'rate-limit-maximum-ceiling',
    file: RATE_LIMIT,
    symbol: 'RATE_LIMIT_MAX_CEILING',
    sourceAnchor: 'export const RATE_LIMIT_MAX_CEILING = 64;',
    sourceKind: 'code',
    dimensions: ['resource-profile', 'claude-admission', 'codex-admission'],
    units: 'requests in flight / agent spawns',
    owner: 'operator rate-limit config surface',
    liveEffect: 'Rejects or clamps live maxSimultaneousAgents above 64.',
    currentValue: 64,
    disposition: 'remove',
    deletionTarget: 'P-009/P-012: migrate user setting to observe-only controller input',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + config migration tests',
    durableSource: 'durable controller desired window and explicit operator intent',
    telemetry: 'config provenance, generation, and migration warning',
    contextPath: 'clampRateLimitConfig / operator:rate_limit_config',
  }),
  writer({
    id: 'rate-limit-provider-override-bounds',
    file: RATE_LIMIT,
    symbol: 'clampProviderFloors',
    sourceAnchor: 'const mc = optInt(raw.maxConcurrent, 1, 256);',
    sourceKind: 'code',
    dimensions: ['provider'],
    units: 'requests in flight and requests/minute',
    owner: 'operator provider-floor config surface',
    liveEffect: 'Clamps provider floor overrides to local 256/100000 bounds before applying them to governors.',
    currentValue: 'maxConcurrent 1..256; rpm 1..100000',
    disposition: 'remove',
    deletionTarget: 'P-009: provider limits are observed, not locally ceiling-bounded',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + provider override tests',
    durableSource: 'provider contract observations and paced probing',
    telemetry: 'override provenance, header freshness, and causal penalty scope',
    contextPath: 'operator_rate_limit_config → setProviderFloorOverride',
  }),
  writer({
    id: 'rate-limit-resource-profile-seed',
    file: RATE_LIMIT,
    symbol: 'DEFAULT_RATE_LIMIT_CONFIG.maxSimultaneousAgents',
    sourceAnchor: 'return getResourceProfile().maxSimultaneousAgents;',
    sourceKind: 'code',
    dimensions: ['resource-profile', 'claude-admission', 'codex-admission'],
    units: 'agent starts / requests in flight',
    owner: 'operator rate-limit config adapter',
    liveEffect: 'Seeds the gateway-adjacent fleet cap from a host profile when no persisted value exists.',
    currentValue: 'resource profile derived value',
    disposition: 'remove',
    deletionTarget: 'P-004/P-009: compatibility seed may not become a gateway ceiling',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + profile-seed migration tests',
    durableSource: 'controller bootstrap state with explicit expiry/provenance',
    telemetry: 'profile signals, seed timestamp, and persisted override state',
    contextPath: 'DEFAULT_RATE_LIMIT_CONFIG getter → clampRateLimitConfig',
  }),
  writer({
    id: 'resource-profile-agent-cap',
    file: PROFILE,
    symbol: 'deriveResourceProfile.maxSimultaneousAgents',
    sourceAnchor: 'const maxSimultaneousAgents = clamp(',
    sourceKind: 'code',
    dimensions: ['resource-profile'],
    units: 'agents',
    owner: 'generic resource-profile adapter',
    liveEffect: 'Derives a host-scaled value with a 1..16 clamp that is consumed as a fleet/gateway seed.',
    currentValue: 'clamp(derived agents, 1, 16)',
    disposition: 'remove',
    deletionTarget: 'P-004/P-009: stop treating host profile output as productive gateway capacity',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + profile consumer tests',
    durableSource: 'host observations as attribution/telemetry only; controller feedback for admission',
    telemetry: 'cores/RAM/power signal provenance and freshness',
    contextPath: 'getResourceProfile → DEFAULT_RATE_LIMIT_CONFIG',
  }),
  writer({
    id: 'local-backend-max-concurrent',
    file: 'packages/operator-core/lib/inference-gateway/local-backend-pool.ts',
    symbol: 'LocalBackend.maxConcurrent',
    sourceAnchor: 'c.inFlight < c.backend.maxConcurrent',
    sourceKind: 'code',
    dimensions: ['local-backend'],
    units: 'requests in flight per backend',
    owner: 'local-backend pool/router',
    liveEffect: 'Skips a backend at its registered maxConcurrent value and reports saturation to callers.',
    currentValue: 'durable registry maxConcurrent',
    disposition: 'measured-external-physical-contract',
    deletionTarget: 'P-003/P-011: retain only engine-reported physical slots/context with evidence',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + local backend physical-contract tests',
    durableSource: 'backend health/engine telemetry and explicit model-hardware contract',
    telemetry: 'live slots, health, latency, engine response, and observation age',
    contextPath: 'createLocalBackendPool.select / saturatedFor',
    fanOut: 'llama-server, vllm, and ollama registrations',
  }),
  writer({
    id: 'local-backend-client-max-in-flight',
    file: 'packages/operator-core/lib/inference-gateway/local-backend-client-circuit.ts',
    symbol: 'DEFAULT_CLIENT_MAX_IN_FLIGHT',
    sourceAnchor: 'export const DEFAULT_CLIENT_MAX_IN_FLIGHT = 2;',
    sourceKind: 'code',
    dimensions: ['local-backend'],
    units: 'requests in flight per owner',
    owner: 'local-backend client circuit',
    liveEffect: 'Hard-sheds a single owner after two local requests, independently of backend physical slots.',
    currentValue: 2,
    disposition: 'remove',
    deletionTarget: 'P-011: move owner fairness to the canonical admission class/scheduler',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + local client fairness tests',
    durableSource: 'resource-governor owner/class fairness and durable receipts',
    telemetry: 'owner demand, wait age, circuit outcome, and backend physical evidence',
    contextPath: 'gateway.proxyLocal → shouldShedClient / admitClient',
  }),
  writer({
    id: 'local-backend-provisioner-slots',
    file: 'packages/operator-core/lib/provisioner/provision.ts',
    symbol: 'gatewayRegisterInput.maxConcurrent',
    sourceAnchor: 'maxConcurrent: entry.serve.parallelSlots,',
    sourceKind: 'deployment',
    dimensions: ['local-backend', 'deployment'],
    units: 'engine parallel slots',
    owner: 'local backend provisioner/catalog adapter',
    liveEffect: 'Copies a catalog parallel-slot recommendation into the gateway registry.',
    currentValue: 'entry.serve.parallelSlots',
    disposition: 'measured-external-physical-contract',
    deletionTarget: 'P-011: require explicit engine/model/hardware evidence for physical slots',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + provisioner contract tests',
    durableSource: 'engine-reported slot/context contract and hardware evidence',
    telemetry: 'catalog provenance, health probe, and runtime engine response',
    contextPath: 'provision → registerLocalBackend → local-backend-pool',
  }),
  writer({
    id: 'spawn-readiness-max-queued-reader',
    file: 'packages/operator-core/lib/inference-gateway/spawn-readiness.ts',
    symbol: 'fetchGatewayReadinessSignals.admissionMaxQueued',
    sourceAnchor: "admissionMaxQueued: typeof s.maxQueued === 'number' ? s.maxQueued : 0,",
    sourceKind: 'status-reader',
    dimensions: ['queue', 'status'],
    units: 'queued requests',
    owner: 'spawn-readiness adapter',
    liveEffect: 'Uses the gateway queue cap to defer new spawns; a missing value is currently coerced to zero.',
    currentValue: 'gateway stats maxQueued or 0 fallback',
    disposition: 'semantic-protocol-safety',
    deletionTarget: 'P-006/P-013: attach spawn decisions to durable receipts and preserve unknown/stale',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + readiness unknown-state tests',
    durableSource: 'durable admission status and explicit unknown/stale signal',
    telemetry: 'gateway generation, queue age, and readiness observation time',
    contextPath: 'fetchGatewayReadinessSignals → decideSpawnAdmission',
  }),
  writer({
    id: 'gateway-status-tool-reader',
    file: 'packages/operator-core/lib/agent-tools/gateway/gateway.ts',
    symbol: 'gatewayStatusTool',
    sourceAnchor: "name: 'gateway:status'",
    sourceKind: 'status-reader',
    dimensions: ['status'],
    units: 'mixed; structured JSON fields',
    owner: 'gateway:status tool',
    liveEffect: 'Surfaces admission, tier, AIMD, pool, and binding-term values to operators.',
    currentValue: null,
    disposition: 'transient-feedback',
    deletionTarget: 'P-013: preserve writer/units/freshness explanations in the read model',
    recurrenceTest: 'capacity-inventory.test.ts status-reader anchor guard',
    durableSource: 'gateway /admin/config and controller snapshots',
    telemetry: 'reachable flag, generation, freshness, and boundBy explanation',
    contextPath: 'gateway:status → /admin/config',
  }),
  writer({
    id: 'gateway-wedge-status-reader',
    file: 'packages/operator-core/lib/inference-gateway/gateway-wedge.ts',
    symbol: 'gateway wedge metric normalization',
    sourceAnchor: 'const maxConcurrent = n(stats.admission?.maxConcurrent',
    sourceKind: 'status-reader',
    dimensions: ['status'],
    units: 'requests in flight',
    owner: 'gateway wedge detector',
    liveEffect: 'Interprets the reported admission max as a saturation/wedge ceiling.',
    currentValue: null,
    disposition: 'transient-feedback',
    deletionTarget: 'P-013: classify reported values by binding term and freshness',
    recurrenceTest: 'capacity-inventory.test.ts status-reader anchor guard',
    durableSource: 'live controller and durable queue state',
    telemetry: 'stats age, queue age, and controller generation',
    contextPath: 'gateway-wedge normalizeGatewayStats / evaluateGatewayWedge',
  }),
  writer({
    id: 'system-health-gateway-status-reader',
    file: 'packages/operator-core/lib/system-health/compute.ts',
    symbol: 'gateway health projection',
    sourceAnchor: 'gateway!.queueDepth',
    sourceKind: 'status-reader',
    dimensions: ['status', 'queue'],
    units: 'queued requests / requests in flight',
    owner: 'system-health gateway projection',
    liveEffect: 'Builds health messages from gateway queue depth and maxConcurrent.',
    currentValue: null,
    disposition: 'transient-feedback',
    deletionTarget: 'P-013: report the exact writer and binding physical evidence',
    recurrenceTest: 'capacity-inventory.test.ts status-reader anchor guard',
    durableSource: 'gateway stats/controller snapshots',
    telemetry: 'sample timestamp, queue age, and freshness status',
    contextPath: 'computeSystemHealth → gateway health tile/alert',
  }),
]);

/** Backward/short-name aliases for callers that use the census vocabulary. */
export const INFERENCE_GATEWAY_WRITER_INVENTORY = INFERENCE_GATEWAY_CAPACITY_INVENTORY;
export const CAPACITY_WRITER_INVENTORY = INFERENCE_GATEWAY_CAPACITY_INVENTORY;
export type CapacityWriter = InferenceGatewayCapacityWriter;

export const INFERENCE_GATEWAY_CAPACITY_INVENTORY_FILES: readonly string[] = Object.freeze(
  [...new Set(INFERENCE_GATEWAY_CAPACITY_INVENTORY.map((row) => row.file))],
);

const DISPOSITIONS = new Set<CapacityWriterDisposition>([
  'remove',
  'transient-feedback',
  'explicit-control-recovery-bypass',
  'semantic-protocol-safety',
  'measured-external-physical-contract',
]);

/** Validate the manifest itself before any source scan uses it. */
export function validateInferenceGatewayCapacityInventory(
  rows: readonly InferenceGatewayCapacityWriter[] = INFERENCE_GATEWAY_CAPACITY_INVENTORY,
): string[] {
  const findings: string[] = [];
  const ids = new Set<string>();
  const writers = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) findings.push(`duplicate-inventory:${row.id}`);
    ids.add(row.id);
    const writerKey = `${row.file}::${row.symbol}`;
    if (writers.has(writerKey)) findings.push(`duplicate-writer:${writerKey}`);
    writers.add(writerKey);
    const required: Array<keyof InferenceGatewayCapacityWriter> = [
      'id',
      'file',
      'symbol',
      'sourceAnchor',
      'sourceKind',
      'units',
      'owner',
      'liveEffect',
      'deletionTarget',
      'recurrenceTest',
      'durableSource',
      'telemetry',
      'contextPath',
    ];
    for (const field of required) {
      const value = row[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        findings.push(`inventory-missing:${row.id}:${field}`);
      }
    }
    if (!Array.isArray(row.dimensions) || row.dimensions.length === 0) {
      findings.push(`inventory-missing:${row.id}:dimensions`);
    }
    if (row.currentValue === undefined) findings.push(`inventory-missing:${row.id}:currentValue`);
    if (!DISPOSITIONS.has(row.disposition)) findings.push(`inventory-disposition:${row.id}`);
    if (row.disposition === 'remove' && !/P-\d{3}/.test(row.deletionTarget)) {
      findings.push(`inventory-removal-target:${row.id}`);
    }
    if (row.sourceAnchor.trim().length < 8) findings.push(`inventory-anchor-too-short:${row.id}`);
    if (row.disposition === 'measured-external-physical-contract' && !/evidence|measured|contract|telemetry/i.test(`${row.liveEffect} ${row.durableSource} ${row.telemetry}`)) {
      findings.push(`inventory-external-evidence:${row.id}`);
    }
  }
  return findings;
}

/** Remove comments and quoted literals while preserving line breaks for diagnostics. */
function executableSource(source: string): string {
  let out = '';
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'line') {
      if (ch === '\n') {
        state = 'code';
        out += '\n';
      } else out += ' ';
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        out += '  ';
        i += 1;
        state = 'code';
      } else {
        out += ch === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      if (escaped) {
        out += ch === '\n' ? '\n' : ' ';
        escaped = false;
      } else if (ch === '\\') {
        out += ' ';
        escaped = true;
      } else if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"') || (state === 'template' && ch === '`')) {
        out += ' ';
        state = 'code';
      } else {
        out += ch === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      out += '  ';
      i += 1;
      state = 'line';
    } else if (ch === '/' && next === '*') {
      out += '  ';
      i += 1;
      state = 'block';
    } else if (ch === "'") {
      out += ' ';
      state = 'single';
    } else if (ch === '"') {
      out += ' ';
      state = 'double';
    } else if (ch === '`') {
      out += ' ';
      state = 'template';
    } else {
      out += ch;
    }
  }
  return out;
}

/** Names whose numeric declarations can create a gateway capacity ceiling or seed. */
export const CAPACITY_WRITER_SYMBOL_PATTERN =
  /^(?:[A-Z][A-Z0-9_]*(?:CONCURRENCY|MAX_QUEUED|MAX_CONCURRENT|SLOTS_PER_ACCOUNT|AIMD|SERVICEABLE|ADMISSION|TIER1_RESERVE|RATE_LIMIT_MAX_CEILING|FLOOR)[A-Z0-9_]*|DEFAULT_FLOORS)$/;

/**
 * Find named numeric capacity declarations in a source file.  This intentionally stays
 * conservative: protocol timeouts and unrelated collection bounds are not capacity
 * writers, while a new named concurrency/queue/floor/reserve declaration is surfaced.
 */
export function findInferenceGatewayCapacityDeclarations(source: string): Array<{ symbol: string; line: number }> {
  const code = executableSource(source);
  const declarations: Array<{ symbol: string; line: number }> = [];
  const declaration = /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*[^;\n]*\b\d+(?:\.\d+)?\b/g;
  for (const match of code.matchAll(declaration)) {
    const symbol = match[1];
    if (!CAPACITY_WRITER_SYMBOL_PATTERN.test(symbol)) continue;
    const line = code.slice(0, match.index ?? 0).split('\n').length;
    declarations.push({ symbol, line });
  }
  return declarations;
}

export interface CapacityInventorySourceFile {
  readonly path: string;
  readonly source: string;
}

export interface ScanInferenceGatewayCapacityOptions {
  readonly rows?: readonly InferenceGatewayCapacityWriter[];
  /** Prefixes to scan for newly declared named writers. Omit to use the production scope. */
  readonly scopePrefixes?: readonly string[];
  /** Skip the source-declaration scan while doing a narrow anchor-only check. */
  readonly declarations?: boolean;
}

export const INFERENCE_GATEWAY_CAPACITY_SCOPE_PREFIXES: readonly string[] = Object.freeze([
  'packages/operator-core/lib/inference-gateway/',
  'packages/operator-core/lib/rate-limit-config.ts',
  'packages/operator-core/lib/resource-profile.ts',
  'packages/operator-core/lib/agent-tools/gateway/',
  'packages/operator-core/lib/fleet/capacity-dispatch.ts',
  'packages/operator-core/lib/provisioner/provision.ts',
  'packages/operator-core/lib/system-health/compute.ts',
  'libs/papercusp-shared/src/resilience/',
  'libs/papercusp-shared/src/agent/governor-registry.ts',
  'libs/generic/resource-profile/src/index.ts',
  'apps/operator/scripts/systemd/papercup-inference-gateway.service',
]);

function inScope(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix));
}

function isCapacityInventorySourceFileList(
  files: readonly CapacityInventorySourceFile[] | ReadonlyMap<string, string>,
): files is readonly CapacityInventorySourceFile[] {
  return Array.isArray(files);
}

/**
 * Verify every row against its exact source anchor and detect a new named numeric
 * capacity declaration that has no row.  The function accepts synthetic sources so
 * the recurrence guard can prove its negative path without mutating the shared tree.
 */
export function scanInferenceGatewayCapacityInventory(
  files: readonly CapacityInventorySourceFile[] | ReadonlyMap<string, string>,
  options: ScanInferenceGatewayCapacityOptions = {},
): string[] {
  const rows = options.rows ?? INFERENCE_GATEWAY_CAPACITY_INVENTORY;
  const sourceMap = new Map<string, string>();
  if (isCapacityInventorySourceFileList(files)) {
    for (const file of files) sourceMap.set(file.path, file.source);
  } else {
    for (const [path, source] of files) sourceMap.set(path, source);
  }
  const findings = [...validateInferenceGatewayCapacityInventory(rows)];
  const byWriter = new Set(rows.map((row) => `${row.file}::${row.symbol}`));
  for (const row of rows) {
    const source = sourceMap.get(row.file);
    if (source === undefined) {
      findings.push(`writer-source-missing:${row.id}:${row.file}`);
    } else if (!source.includes(row.sourceAnchor)) {
      findings.push(`writer-anchor-missing:${row.id}:${row.file}:${row.symbol}`);
    }
  }
  if (options.declarations === false) return findings;
  const prefixes = options.scopePrefixes ?? INFERENCE_GATEWAY_CAPACITY_SCOPE_PREFIXES;
  for (const [path, source] of sourceMap) {
    if (!inScope(path, prefixes) || /(?:^|\/)(?:dist|node_modules)\//.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) continue;
    for (const declaration of findInferenceGatewayCapacityDeclarations(source)) {
      if (!byWriter.has(`${path}::${declaration.symbol}`)) {
        findings.push(`unclassified-writer:${path}:${declaration.symbol}:${declaration.line}`);
      }
    }
  }
  return findings;
}

/** Short aliases used by source-census tests and downstream migration items. */
export const validateCapacityInventory = validateInferenceGatewayCapacityInventory;
export const scanCapacityInventory = scanInferenceGatewayCapacityInventory;
