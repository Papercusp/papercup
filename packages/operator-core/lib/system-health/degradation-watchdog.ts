/**
 * degradation-watchdog — the generic detector for a collapsed fail-open rate
 * (degradation-signals-on-condition-rail-2026-10-11 P-003; BARs R-2, R-7, R-8).
 *
 * WHY. A mechanism that can quietly fall back records each decision batch through
 * `observeFallback` (P-002, `harness_shared.fallback_observations`). Recording is
 * only half of a detector: until something READS the rate, a collapse is a number
 * nobody queries. Gate run 762a13a6 reused 0 of ~7,689 eligible tasks on a frozen
 * repair head, and nothing alarmed, because the only signal was a log line.
 *
 * WHAT. One periodic sweep over the REGISTERED mechanisms. For each mechanism (and,
 * for a scope-keyed mechanism, each scope) it summarises the trailing window and
 * decides, with a PURE function and pinned defaults:
 *
 *   - fewer than `minEligible` (20) eligible units  -> insufficient: change nothing.
 *   - applied rate <= `collapseRate` (0.2)           -> collapsed: open
 *     `degraded:<mechanism>[:<scope>]:<reason>`, where <reason> is the dominant
 *     rejection reason when it covers >= `dominantShare` (0.8) of eligible units,
 *     else `mixed` (R-7).
 *   - applied rate >= `recoverRate` (0.5)            -> recovered: resolve every open
 *     key for that mechanism/scope.
 *   - in between                                      -> hysteresis: change nothing.
 *
 * THE RAIL, NOT A NEW PATH (D-002). Opening is `broadcastSevereEvent({ conditionKey })`
 * and resolving is `broadcastSevereEventResolved`. `degraded:` is opted into the
 * actionable-condition catalog, so the condition bridge (condition-staleness-alarm's
 * tick -> `reconcileConditions`) mints exactly one owning work-item per open key and
 * settles it on resolution. This module files nothing itself.
 *
 * ONE ALARM PER EPISODE. Which keys are open is read from the durable condition fold
 * (`computeConditionStates`), not from process memory, so a restart neither re-alarms
 * an open condition nor forgets to resolve it. Because the sweep does not re-broadcast
 * while a key stays open, every alarm is marked `oneShot`, which stops the staleness
 * guard from reading that deliberate silence as recovery.
 *
 * RETENTION. The sweep also owns the P-002 pruner (R-12): at most once an hour it
 * deletes observations older than the retention bound.
 */
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { pinModuleState } from '@papercusp/module-singleton';

import { DEGRADATION_CONDITION_PREFIX } from '../coord/actionable-conditions';
import type { FallbackWindow, ScopedFallbackWindow } from '../degradation/fallback-observations';
import type { SevereEventBroadcast, SevereEventResolution } from '../severe-event-broadcast';

// ── Pinned defaults (D-006) ────────────────────────────────────────────────
export const DEGRADATION_MIN_ELIGIBLE = 20;
export const DEGRADATION_COLLAPSE_RATE = 0.2;
export const DEGRADATION_RECOVER_RATE = 0.5;
export const DEGRADATION_DOMINANT_SHARE = 0.8;
/** Reason segment used when no single rejection reason dominates (R-7). */
export const DEGRADATION_MIXED_REASON = 'mixed';
export const DEGRADATION_WINDOW_MS = 60 * 60_000;
export const DEGRADATION_SWEEP_INTERVAL_MS = 5 * 60_000;
export const DEGRADATION_PRUNE_EVERY_MS = 60 * 60_000;
/** Signal-actor-registry id for this watchdog (R-8). */
export const DEGRADATION_WATCHDOG_SIGNAL_ID = 'degradation-watchdog';

/** Float slack so a rate computed as e.g. 4/20 compares equal to a 0.2 threshold. */
const EPS = 1e-9;

export interface DegradationThresholds {
  minEligible: number;
  collapseRate: number;
  recoverRate: number;
  dominantShare: number;
}

export const DEFAULT_DEGRADATION_THRESHOLDS: Readonly<DegradationThresholds> = Object.freeze({
  minEligible: DEGRADATION_MIN_ELIGIBLE,
  collapseRate: DEGRADATION_COLLAPSE_RATE,
  recoverRate: DEGRADATION_RECOVER_RATE,
  dominantShare: DEGRADATION_DOMINANT_SHARE,
});

// ── Mechanism registry ─────────────────────────────────────────────────────

/** A mechanism the watchdog sweeps. Only registered mechanisms can raise a condition. */
export interface DegradationMechanism {
  /** The `mechanism` name its producer passes to `observeFallback`. */
  mechanism: string;
  /** What falls back, and what a collapse means. Carried into the alarm body. */
  description: string;
  /**
   * When true, each observation `scope` is judged separately and appears in the key
   * (`degraded:<mechanism>:<scope>:<reason>`). Use it when the scope is a stable unit
   * (a gate task), never a per-run id, or every run would open its own condition.
   */
  scopeKeyed?: boolean;
  windowMs?: number;
  thresholds?: Partial<DegradationThresholds>;
}

interface RegistryState {
  mechanisms: Map<string, DegradationMechanism>;
  lastPrunedAt: number;
}

const state = pinModuleState<RegistryState>('@papercusp/operator-core.degradation-watchdog', () => ({
  mechanisms: new Map(),
  lastPrunedAt: 0,
}));

/** Register a mechanism. Throws on a duplicate name: one registration per mechanism (R-3). */
export function registerDegradationMechanism(m: DegradationMechanism): void {
  const name = m.mechanism.trim();
  if (!name) throw new Error('degradation-watchdog: mechanism name is required');
  if (state.mechanisms.has(name)) {
    throw new Error(`degradation-watchdog: mechanism "${name}" is already registered`);
  }
  state.mechanisms.set(name, Object.freeze({ ...m, mechanism: name }));
}

export function getDegradationMechanism(name: string): DegradationMechanism | undefined {
  return state.mechanisms.get(name.trim());
}

export function listDegradationMechanisms(): DegradationMechanism[] {
  return [...state.mechanisms.values()];
}

/** Test hook: remove a registration (only for mechanisms a test registered itself). */
export function _unregisterDegradationMechanismForTests(name: string): void {
  state.mechanisms.delete(name.trim());
}

/** Test hook: forget when the pruner last ran. */
export function _resetDegradationPruneClockForTests(): void {
  state.lastPrunedAt = 0;
}

// Seed registrations. A producer migrated onto observeFallback registers here, in one
// place, so the set of mechanisms that can raise a condition is reviewable at a glance.
registerDegradationMechanism({
  mechanism: 'gate-pass-reuse',
  description:
    'green-checkpoint pass reuse: tasks whose prior passing proof could have been reused instead of re-running. ' +
    'A collapse means the gate is re-running work it should be reusing (run 762a13a6 reused 0 of ~7,689).',
  scopeKeyed: true,
});
registerDegradationMechanism({
  mechanism: 'retrieval',
  description: 'Searches whose authoritative leg verdict ran at full strength; each search contributes one eligible decision.',
  // Preserve the existing alarm floor of half the searches degrading, with recovery
  // hysteresis so a window at the alarm boundary cannot resolve its own episode.
  thresholds: { minEligible: 20, collapseRate: 0.5, recoverRate: 0.75 },
});
registerDegradationMechanism({
  mechanism: 'release-watchdog-pass', scopeKeyed: true,
  description: 'Release watchdog passes that completed without a swallowed exception; each install, routine and pass has its own window.',
  // One emitter runs every 15 minutes, below the 20-sample default in a one-hour
  // window. Retain the default rates, with a floor that also works on one host.
  thresholds: { minEligible: 1 },
});
registerDegradationMechanism({
  mechanism: 'coverage-snapshot-read', scopeKeyed: true,
  description: 'Search coverage requests served by a successfully measured snapshot rather than a fail-open empty snapshot.',
});
registerDegradationMechanism({
  mechanism: 'scout-state-read', scopeKeyed: true,
  description: 'Scout and learning-state reads that measured their primary state rather than continuing with a fail-open gate, config, rail, ledger or weight default.',
});
registerDegradationMechanism({
  mechanism: 'coordination-window-read', scopeKeyed: true,
  description: 'Inbox and outbox reads whose primary paged query completed rather than retrying the full-read fallback after a paging error.',
});
registerDegradationMechanism({
  mechanism: 'release-state-read', scopeKeyed: true,
  description: 'Release guard reads that returned their primary snapshot rather than a fail-open empty or partial snapshot.',
  thresholds: { minEligible: 1 },
});
registerDegradationMechanism({
  mechanism: 'release-verdict-event', scopeKeyed: true,
  description: 'Terminal inconclusive verdict pairs delivered through the existing awaited-event engine rather than left to timeout.',
  thresholds: { minEligible: 1 },
});
registerDegradationMechanism({
  mechanism: 'bm25-scan-score',
  description: 'Eligible lexical ranking calls whose index-scan score was verified rather than replaced by a standalone distance rerun.',
});
registerDegradationMechanism({
  mechanism: 'query-embedder-acquisition',
  description: 'Query embedder acquisitions that produced an embedder rather than leaving the caller on lexical-only search.',
});
registerDegradationMechanism({
  mechanism: 'jev-worker-transport',
  description: 'Jev requests whose exchange completed on the worker rather than the calling-thread transport.',
});
registerDegradationMechanism({
  mechanism: 'backfill-batch', scopeKeyed: true,
  description: 'Batch-eligible backfill rows served by batch inference rather than per-row retries after a failed or partial batch.',
});
registerDegradationMechanism({
  mechanism: 'embed-device',
  description: 'Requested GPU pipeline constructions that verified the primary device rather than accepting a sticky CPU demotion.',
  thresholds: { minEligible: 1 },
});
registerDegradationMechanism({
  mechanism: 'embed-worker',
  description: 'Local embed requests that completed on the worker rather than retrying inference on the calling thread.',
});

// ── Keys ───────────────────────────────────────────────────────────────────
registerDegradationMechanism({
  mechanism: 'rerank-device',
  description: 'GPU cross-encoder constructions that verified the requested device rather than accepting CPU demotion.',
  thresholds: { minEligible: 1 },
});
registerDegradationMechanism({
  mechanism: 'rerank-worker',
  description: 'Cross-encoder requests completed on the worker rather than retrying inference on the calling thread.',
});
registerDegradationMechanism({
  mechanism: 'embed-sidecar-respawn',
  description: 'Embedding child readiness measured by READY handshakes and ready demand requests; unexpected crashes are degraded, deliberate idle exits are excluded.',
  thresholds: { minEligible: 1 },
});
registerDegradationMechanism({
  mechanism: 'spawner-sidecar-exec',
  description: 'Eligible command and stdin executions served by the spawner sidecar; primary child exits count as applied, local fallbacks and rejected execution count as unavailable. Disabled routing is excluded.',
});
registerDegradationMechanism({
  mechanism: 'bounded-operation', scopeKeyed: true,
  description: 'Named bounded operations that completed before the deadline rather than returning a timeout/error fallback; caller cancellation is excluded.',
});
registerDegradationMechanism({
  mechanism: 'cache-l2-operation', scopeKeyed: true,
  description: 'L2 get, set and invalidation requests completed by the backend rather than a fail-soft build; cache misses are healthy reads, disabled routing is excluded.',
});
registerDegradationMechanism({
  mechanism: 'primary-count-capability',
  description: 'Primary-count queries that measured permission to read all activity stats rather than relying on a missing capability probe or restricted read.',
  thresholds: { minEligible: 1 },
});
registerDegradationMechanism({
  mechanism: 'host-startup', scopeKeyed: true,
  description: 'Eligible cache, resolver and sidecar startup paths verified their primary startup rather than accepting a boot fallback; disabled paths and deliberate shutdown are excluded.',
  thresholds: { minEligible: 1 },
});
registerDegradationMechanism({
  mechanism: 'db-discovery-identity',
  description: 'Database pool identity probes that verified the trusted store rather than quarantining a proven foreign discovery endpoint; indeterminate attribution is excluded.',
  thresholds: { minEligible: 1 },
});
registerDegradationMechanism({
  mechanism: 'mcp-workspace-resolution',
  description: 'Scoped superuser workspace resolutions supplied explicitly or verified from the session, rather than guessed from the active registry. Deliberate unscoped administration is excluded.',
});
registerDegradationMechanism({
  mechanism: 'swarm-authority-route', scopeKeyed: true,
  description: 'Eligible plan claim, work-item claim and replica operations completed on the elected local or remote authority rather than an advisory fail-open grant; identity-only probes are excluded.',
});
registerDegradationMechanism({
  mechanism: 'substrate-activation-probe',
  description: 'Harness activation decisions supported by verified pending-write and presence probes rather than eagerly booting after an unreadable probe; empty sweeps are excluded.',
});
registerDegradationMechanism({
  mechanism: 'sync-relay-config',
  description: 'Sync relay configuration reads that completed, including deliberately empty configurations, rather than accepting unavailable relay-key storage.',
  thresholds: { minEligible: 1 },
});
registerDegradationMechanism({
  mechanism: 'authority-peer-addresses',
  description: 'Explicit peer-address environment maps parsed successfully rather than disabling remote addressing after invalid JSON; absent configuration and cached reads are excluded.',
  thresholds: { minEligible: 1 },
});
registerDegradationMechanism({
  mechanism: 'work-item-storage-resolution', scopeKeyed: true,
  description: 'Storage slug resolutions completed the shared pot resolver rather than substituting a literal slug after a resolver error; verified unpotted tenants remain healthy.',
});
registerDegradationMechanism({
  mechanism: 'substrate-binding-resolution', scopeKeyed: true,
  description: 'Binding lookups completed with an intended Hive, shared-repository or local configuration rather than an unresolved required Hive topic or unreadable identity.',
  thresholds: { minEligible: 1 },
});
registerDegradationMechanism({
  mechanism: 'substrate-boot-routing', scopeKeyed: true,
  description: 'Fresh engine boots made a decided route choice rather than timing out the routing latch; cached handles and coalesced callers are excluded.',
  thresholds: { minEligible: 1 },
});
registerDegradationMechanism({
  mechanism: 'substrate-activation-plan',
  description: 'Harnesses with measured registry provenance included in a completed activation plan rather than booted eagerly after a planning dependency failure. Empty and deliberately disabled sweeps are excluded.',
});
registerDegradationMechanism({
  mechanism: 'substrate-sidecar-boot',
  description: 'Configured sidecar boot attempts completed the remote boot sweep rather than restarting it in-process; deliberately configured in-process boots are excluded.',
  thresholds: { minEligible: 1 },
});
registerDegradationMechanism({
  mechanism: 'substrate-sidecar-cleanup',
  description: 'Cleanup attempts after a failed remote boot stopped the sidecar before an in-process retry rather than continuing while stop failed.',
  thresholds: { minEligible: 1 },
});
registerDegradationMechanism({ mechanism: 'substrate-sidecar-respawn', thresholds: { minEligible: 1 },
  description: 'Unexpected sidecar exits restored the preferred process rather than exhausting the respawn budget or failing to spawn; deliberate stops and coalesced callbacks are excluded.' });
registerDegradationMechanism({ mechanism: 'coord-delivery-receipt', scopeKeyed: true,
  description: 'Applied federated messages published their requested delivery receipt rather than falling back to sender-side reply or inbox confirmation; messages without an eligible receipt are excluded.' });
registerDegradationMechanism({ mechanism: 'merge-cursor-seed', scopeKeyed: true, thresholds: { minEligible: 1 },
  description: 'Unpositioned logs obtained durable cursor progress under the preferred apply binding rather than an alternate binding or an unreadable cursor; positioned logs are excluded.' });
registerDegradationMechanism({ mechanism: 'swarm-transport-identity', thresholds: { minEligible: 1 },
  description: 'Fresh shared-swarm construction loaded its persisted transport seed rather than generating an ephemeral identity; cached swarm reads are excluded.' });
registerDegradationMechanism({ mechanism: 'swarm-relay-wiring', thresholds: { minEligible: 1 },
  description: 'Configured relay keys were passed into a successfully constructed shared swarm; direct-only configuration is excluded. This measures wiring, not relay reachability.' });
registerDegradationMechanism({ mechanism: 'browser-sync-transport', scopeKeyed: true, thresholds: { minEligible: 1 },
  description: 'Browser preferred-transport decisions: sustained failure selects fallback (0); an actual open sustained through the stability window records primary (1). Retry attempts, explicit polling and paused/inert streams are excluded.' });
registerDegradationMechanism({
  mechanism: 'routine-capability-read', scopeKeyed: true,
  description: 'Routine and loop capability reads completed their primary dependency probe rather than using reduced liveness, carry scope, or dispatch authority.',
  // Boot grants and memoized derivations can yield only one decision per process.
  thresholds: { minEligible: 1 },
});
registerDegradationMechanism({
  mechanism: 'routine-config', scopeKeyed: true,
  description: 'Explicit routine configuration passed validation rather than being rejected in favor of the safe default; absent overrides are ineligible.',
  thresholds: { minEligible: 1 },
});
registerDegradationMechanism({
  mechanism: 'routine-output-log', scopeKeyed: true,
  description: 'Routine output opened its primary durable log rather than falling back to piped output.',
  thresholds: { minEligible: 1 },
});
registerDegradationMechanism({
  mechanism: 'routine-scheduler-admission', scopeKeyed: true,
  description: 'Scheduler ticks admitted ordinary work rather than retaining only the critical-queue safety floor; this records the chosen policy, not a diagnosis of latency or successful routine execution.',
});

/**
 * One key segment. ':' separates segments and whitespace makes keys unreadable, so both
 * collapse to '-'. This keeps "does this key belong to that mechanism/scope" an exact
 * prefix test: a key belongs to a prefix only if the remainder has no ':'.
 */
export function degradationKeySegment(value: string): string {
  const s = value.trim().replace(/[:\s]+/g, '-');
  return s.length > 0 ? s : 'unnamed';
}

/** `degraded:<mechanism>[:<scope>]:` — every key for one mechanism/scope starts here. */
export function degradationKeyPrefix(mechanism: string, scope?: string | null): string {
  const scoped = scope != null && scope.trim().length > 0 ? `${degradationKeySegment(scope)}:` : '';
  return `${DEGRADATION_CONDITION_PREFIX}${degradationKeySegment(mechanism)}:${scoped}`;
}

/** `degraded:<mechanism>[:<scope>]:<reason>` (R-2, R-7). */
export function degradationConditionKey(mechanism: string, scope: string | null | undefined, reason: string): string {
  return `${degradationKeyPrefix(mechanism, scope)}${degradationKeySegment(reason)}`;
}

/** True when `key` is one of the reason keys under `prefix` (and not a deeper scope's). */
export function keyBelongsToPrefix(key: string, prefix: string): boolean {
  return key.startsWith(prefix) && key.length > prefix.length && !key.slice(prefix.length).includes(':');
}

// ── Pure decision (R-2, R-7) ───────────────────────────────────────────────

export type DegradationVerdict =
  | { kind: 'insufficient'; eligible: number; minEligible: number }
  | { kind: 'between'; appliedRate: number }
  | { kind: 'recovered'; appliedRate: number }
  | {
      kind: 'collapsed';
      appliedRate: number;
      /** The reason segment used in the key: the dominant reason, or `mixed`. */
      reason: string;
      /** The top rejection reason, even when it did not dominate. */
      topReason: string | null;
      /** Top reason's fallen-back units as a share of ALL eligible units. */
      topShare: number;
      conditionKey: string;
    };

function resolveThresholds(t?: Partial<DegradationThresholds>): DegradationThresholds {
  return { ...DEFAULT_DEGRADATION_THRESHOLDS, ...(t ?? {}) };
}

/**
 * PURE: what one window says. No clock, no Postgres, no broadcast, so every threshold
 * edge (19 vs 20 eligible, 0.20 vs 0.21 applied, 0.49 vs 0.50 recovery, 0.79 vs 0.80
 * dominance) is unit-testable.
 *
 * Dominance is measured against ELIGIBLE units, as R-7 states it: a reason dominates when
 * the units that fell back under it are at least `dominantShare` of everything that could
 * have taken the primary path.
 */
export function judgeDegradation(
  window: FallbackWindow,
  target: { mechanism: string; scope?: string | null },
  thresholds?: Partial<DegradationThresholds>,
): DegradationVerdict {
  const t = resolveThresholds(thresholds);
  if (window.appliedRate === null || window.eligible < t.minEligible) {
    return { kind: 'insufficient', eligible: window.eligible, minEligible: t.minEligible };
  }
  const rate = window.appliedRate;
  if (rate >= t.recoverRate - EPS) return { kind: 'recovered', appliedRate: rate };
  if (rate > t.collapseRate + EPS) return { kind: 'between', appliedRate: rate };
  const top = window.reasons.find((r) => r.fellBack > 0) ?? null;
  const topShare = top ? top.fellBack / window.eligible : 0;
  const dominates = top !== null && topShare >= t.dominantShare - EPS;
  const reason = dominates && top ? top.reason : DEGRADATION_MIXED_REASON;
  return {
    kind: 'collapsed',
    appliedRate: rate,
    reason,
    topReason: top ? top.reason : null,
    topShare,
    conditionKey: degradationConditionKey(target.mechanism, target.scope ?? null, reason),
  };
}

/**
 * PURE: turn a verdict plus the currently-open keys into the rail actions.
 *   collapsed -> open its key unless already open; resolve sibling keys of that
 *                mechanism/scope (the dominant reason changed).
 *   recovered -> resolve every open key of that mechanism/scope.
 *   otherwise -> nothing (hysteresis / no evidence).
 */
export function planDegradationActions(
  verdict: DegradationVerdict,
  prefix: string,
  openKeys: ReadonlySet<string> | readonly string[],
): { open: string | null; resolve: string[] } {
  const open = [...openKeys].filter((k) => keyBelongsToPrefix(k, prefix)).sort();
  if (verdict.kind === 'collapsed') {
    return {
      open: open.includes(verdict.conditionKey) ? null : verdict.conditionKey,
      resolve: open.filter((k) => k !== verdict.conditionKey),
    };
  }
  if (verdict.kind === 'recovered') return { open: null, resolve: open };
  return { open: null, resolve: [] };
}

// ── Alarm text ─────────────────────────────────────────────────────────────

function pct(x: number): string {
  return `${(x * 100).toFixed(x < 0.01 && x > 0 ? 2 : 0)}%`;
}

export function renderDegradationAlarm(
  m: DegradationMechanism,
  scope: string | null,
  window: FallbackWindow,
  verdict: Extract<DegradationVerdict, { kind: 'collapsed' }>,
  t: DegradationThresholds,
): Pick<SevereEventBroadcast, 'summary' | 'body'> {
  const where = scope ? `${m.mechanism} (${scope})` : m.mechanism;
  const top = window.reasons
    .slice(0, 5)
    .map((r) => `${r.reason}: ${r.fellBack} fell back of ${r.eligible} eligible over ${r.samples} batch(es)`)
    .join('\n  - ');
  return {
    summary:
      `Degraded: ${where} took its primary path for ${window.applied} of ${window.eligible} eligible units ` +
      `(${pct(verdict.appliedRate)}) in the last ${Math.round(window.windowMs / 60_000)}min — ` +
      (verdict.reason === DEGRADATION_MIXED_REASON ? 'no single reason dominates' : `dominant reason ${verdict.reason}`),
    body:
      `${m.description}\n\n` +
      `Window: ${window.samples} decision batch(es), ${window.eligible} eligible, ${window.applied} applied ` +
      `(rate ${verdict.appliedRate.toFixed(3)}; collapse <= ${t.collapseRate}, recover >= ${t.recoverRate}, ` +
      `min eligible ${t.minEligible}).\n` +
      `Top reasons:\n  - ${top || '(none)'}\n\n` +
      `This condition is owned by one auto-filed work item and resolves itself once the rate reaches ` +
      `${t.recoverRate}. Data: harness_shared.fallback_observations WHERE mechanism = '${m.mechanism}'` +
      (scope ? ` AND scope = '${scope}'` : '') +
      `.`,
  };
}

// ── Sweep ──────────────────────────────────────────────────────────────────

export interface DegradationSweepDeps {
  mechanisms: () => readonly DegradationMechanism[];
  /** One window per scope (scope-keyed) or one unscoped window. */
  readWindows: (m: DegradationMechanism, windowMs: number, now: Date) => Promise<ScopedFallbackWindow[]>;
  /** Every currently-OPEN `degraded:` key, from the durable condition fold. */
  readOpenConditionKeys: () => Promise<string[]>;
  broadcast: (ev: SevereEventBroadcast) => Promise<boolean>;
  resolve: (res: SevereEventResolution) => Promise<boolean>;
  /** Retention pruner; null disables the prune leg. */
  prune: (() => Promise<number>) | null;
  now: () => Date;
  pruneEveryMs: number;
}

export interface DegradationSweepResult {
  evaluated: Array<{ mechanism: string; scope: string | null; verdict: DegradationVerdict['kind'] }>;
  opened: string[];
  resolved: string[];
  pruned: number | null;
  errors: string[];
}

async function defaultReadWindows(m: DegradationMechanism, windowMs: number, now: Date): Promise<ScopedFallbackWindow[]> {
  const fo = await import('../degradation/fallback-observations');
  if (m.scopeKeyed) return fo.readFallbackWindowsByScope(m.mechanism, windowMs, { now });
  return [{ scope: null, window: await fo.readFallbackWindow(m.mechanism, windowMs, { now }) }];
}

async function defaultReadOpenConditionKeys(): Promise<string[]> {
  const { computeConditionStates, readConditionEnvelopes } = await import(
    '../agent-tools/coordination/tools/conditions'
  );
  return computeConditionStates(await readConditionEnvelopes())
    .filter((s) => s.open && s.condition_key.startsWith(DEGRADATION_CONDITION_PREFIX))
    .map((s) => s.condition_key);
}

async function defaultBroadcast(ev: SevereEventBroadcast): Promise<boolean> {
  const { broadcastSevereEvent } = await import('../severe-event-broadcast');
  return broadcastSevereEvent(ev);
}

async function defaultResolve(res: SevereEventResolution): Promise<boolean> {
  const { broadcastSevereEventResolved } = await import('../severe-event-broadcast');
  return broadcastSevereEventResolved(res);
}

async function defaultPrune(): Promise<number> {
  const { pruneFallbackObservations } = await import('../degradation/fallback-observations');
  return pruneFallbackObservations();
}

function sweepDeps(overrides: Partial<DegradationSweepDeps>): DegradationSweepDeps {
  return {
    mechanisms: listDegradationMechanisms,
    readWindows: defaultReadWindows,
    readOpenConditionKeys: defaultReadOpenConditionKeys,
    broadcast: defaultBroadcast,
    resolve: defaultResolve,
    prune: defaultPrune,
    now: () => new Date(),
    pruneEveryMs: DEGRADATION_PRUNE_EVERY_MS,
    ...overrides,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * One sweep. Fail-soft per mechanism: one unreadable mechanism must not stop the rest
 * from being judged. If the open-key read fails the sweep makes NO rail writes, because
 * without it every collapsed window would re-broadcast and no recovery could be matched.
 */
export async function runDegradationSweepOnce(
  overrides: Partial<DegradationSweepDeps> = {},
): Promise<DegradationSweepResult> {
  const deps = sweepDeps(overrides);
  const now = deps.now();
  const out: DegradationSweepResult = { evaluated: [], opened: [], resolved: [], pruned: null, errors: [] };

  if (deps.prune && now.getTime() - state.lastPrunedAt >= deps.pruneEveryMs) {
    state.lastPrunedAt = now.getTime();
    try {
      out.pruned = await deps.prune();
    } catch (e) {
      out.errors.push(`prune: ${errMsg(e)}`);
    }
  }

  let openKeys: Set<string>;
  try {
    openKeys = new Set(await deps.readOpenConditionKeys());
  } catch (e) {
    out.errors.push(`open-condition read: ${errMsg(e)}`);
    return out;
  }

  for (const m of deps.mechanisms()) {
    const t = resolveThresholds(m.thresholds);
    const windowMs = m.windowMs ?? DEGRADATION_WINDOW_MS;
    let windows: ScopedFallbackWindow[];
    try {
      windows = await deps.readWindows(m, windowMs, now);
    } catch (e) {
      out.errors.push(`${m.mechanism}: ${errMsg(e)}`);
      continue;
    }
    for (const { scope: rawScope, window } of windows) {
      const scope = m.scopeKeyed ? rawScope : null;
      const verdict = judgeDegradation(window, { mechanism: m.mechanism, scope }, t);
      out.evaluated.push({ mechanism: m.mechanism, scope, verdict: verdict.kind });
      const prefix = degradationKeyPrefix(m.mechanism, scope);
      const plan = planDegradationActions(verdict, prefix, openKeys);
      for (const key of plan.resolve) {
        const ok = await deps.resolve({
          conditionKey: key,
          summary:
            verdict.kind === 'recovered'
              ? `RECOVERED: ${m.mechanism}${scope ? ` (${scope})` : ''} applied rate is back to ${pct(verdict.appliedRate)}`
              : `Superseded: ${m.mechanism}${scope ? ` (${scope})` : ''} is still degraded, now keyed by a different reason`,
        });
        if (ok) {
          openKeys.delete(key);
          out.resolved.push(key);
        } else out.errors.push(`resolve failed: ${key}`);
      }
      if (plan.open && verdict.kind === 'collapsed') {
        const text = renderDegradationAlarm(m, scope, window, verdict, t);
        const ok = await deps.broadcast({
          ...text,
          category: 'degradation',
          conditionKey: plan.open,
          oneShot: true,
        });
        if (ok) {
          openKeys.add(plan.open);
          out.opened.push(plan.open);
        } else out.errors.push(`broadcast failed: ${plan.open}`);
      }
    }
  }
  return out;
}

let watchdogTimer: ManagedHandle | null = null;

/** Start the degradation watchdog. Idempotent. */
export function startDegradationWatchdog(opts: { intervalMs?: number } = {}): void {
  const intervalMs = opts.intervalMs ?? DEGRADATION_SWEEP_INTERVAL_MS;
  if (watchdogTimer) watchdogTimer.stop();
  let sweeping = false;
  watchdogTimer = managedSetInterval(
    'degradation-watchdog',
    intervalMs,
    () => {
      if (sweeping) return;
      sweeping = true;
      void runDegradationSweepOnce()
        .then((r) => {
          if (r.errors.length > 0) {
            console.warn(`[degradation-watchdog] sweep completed with ${r.errors.length} error(s): ${r.errors.slice(0, 3).join(' | ')}`);
          }
        })
        .catch((e) => {
          console.warn(`[degradation-watchdog] sweep failed (non-fatal): ${errMsg(e)}`);
        })
        .finally(() => {
          sweeping = false;
        });
    },
    // 'must-sample': fallback_observations rows are written by many processes and emit no
    // change event, so a collapse has to be read on a cadence.
    { category: 'watchdog', classification: 'must-sample' },
  );
}

/** Stop the watchdog (tests / shutdown). */
export function stopDegradationWatchdog(): void {
  watchdogTimer?.stop();
  watchdogTimer = null;
}
