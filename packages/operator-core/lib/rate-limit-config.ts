/**
 * Live-editable fleet rate-limit configuration (rate-limit-layer-v2 D-004).
 *
 * The user's `maxSimultaneousAgents` — the fleet-wide cap on concurrently-running agent spawns —
 * plus the AIMD `concurrencyFloor` (D-005). Stored as a single-row-per-workspace JSONB
 * (`harness_shared.operator_rate_limit_config`, migration 161) and propagated LIVE (no restart)
 * via an in-process bus that mirrors `flag-bus.ts`:
 *
 *   PUT → writeRateLimitConfig() → persist PG → applyCached() (push the cap into the governor's
 *   global gate immediately) → publish() (so any other in-process subscriber re-applies).
 *
 * The governor (libs/papercup-shared) reads the cap through the `setGlobalConcurrencyCap` host
 * seam — it never imports this module (lower lib). The orchestrator dispatch ceiling +
 * pty-bridge read `getCachedRateLimitConfig()` directly (same process). On the dev box the Hono
 * host, the DBOS orchestrator loop, and the agent spawns all live in ONE operator process, so an
 * in-process bus suffices; PG LISTEN/NOTIFY is the documented multi-process extension.
 */
import { getChannel } from '@papercusp/sse';
import { setGlobalConcurrencyCap, setGlobalConcurrencyFloor } from '@papercusp/papercup-shared/agent';
import { readOperatorState, writeOperatorState } from './operator-state-pg';

export interface RateLimitConfig {
  /** Fleet-wide cap on concurrently-running agent spawns. The governor's global gate + the
      orchestrator dispatch ceiling + pty-bridge all read this live. The user drops it to e.g. 2
      when using Claude personally so the fleet backs off. */
  maxSimultaneousAgents: number;
  /** AIMD floor (D-005): the effective concurrency never adapts below this. */
  concurrencyFloor: number;
}

/** Absolute ceiling the route/UI allow a user to set (defense-in-depth above the orchestrator's
    own SAFETY_CEILING backstop). */
export const RATE_LIMIT_MAX_CEILING = 64;
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = { maxSimultaneousAgents: 16, concurrencyFloor: 1 };

function clampInt(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? Math.floor(v) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

/** Coerce arbitrary input into a valid config (the route validates; this is the safety floor). */
export function clampRateLimitConfig(input: Partial<RateLimitConfig> | null | undefined): RateLimitConfig {
  const max = clampInt(input?.maxSimultaneousAgents, DEFAULT_RATE_LIMIT_CONFIG.maxSimultaneousAgents, 1, RATE_LIMIT_MAX_CEILING);
  const floor = clampInt(input?.concurrencyFloor, DEFAULT_RATE_LIMIT_CONFIG.concurrencyFloor, 1, max);
  return { maxSimultaneousAgents: max, concurrencyFloor: floor };
}

const CHANNEL = 'rate-limit-config-changes';
let cached: RateLimitConfig = { ...DEFAULT_RATE_LIMIT_CONFIG };
let booted = false;

export type RateLimitConfigEnvelope = { type: 'rate_limit_config_changed'; config: RateLimitConfig; ts: number };

export function getRateLimitBus() {
  return getChannel<RateLimitConfigEnvelope>(CHANNEL, { ringSize: 16 });
}

/** The live value (synchronous) the orchestrator + pty-bridge read every tick. Reflects the last
    PG load + bus publish in THIS process. */
export function getCachedRateLimitConfig(): RateLimitConfig {
  return cached;
}

function applyCached(cfg: RateLimitConfig): void {
  cached = cfg;
  // Push the fleet cap + AIMD floor into the governor registry's global gate — honored by the
  // next acquire (D-004/D-005).
  setGlobalConcurrencyCap(cfg.maxSimultaneousAgents);
  setGlobalConcurrencyFloor(cfg.concurrencyFloor);
}

/** Load from PG, install into the governor, and subscribe to live changes. Idempotent; call once
    at operator boot (alongside the governor store + observer wiring). */
export async function initRateLimitConfig(): Promise<void> {
  if (booted) return;
  booted = true;
  // Re-apply on any in-process publish (e.g. a PUT handled on another request in this process).
  getRateLimitBus().onPublish(({ event }) => applyCached(event.config));
  const stored = await readOperatorState<Partial<RateLimitConfig>>('operator_rate_limit_config').catch(() => null);
  applyCached(clampRateLimitConfig(stored ?? {}));
}

/** Read the persisted config (clamped), independent of the cached value. */
export async function readRateLimitConfig(): Promise<RateLimitConfig> {
  const stored = await readOperatorState<Partial<RateLimitConfig>>('operator_rate_limit_config').catch(() => null);
  return clampRateLimitConfig(stored ?? {});
}

/** Persist + propagate live. Returns the clamped value actually stored. */
export async function writeRateLimitConfig(input: Partial<RateLimitConfig>): Promise<RateLimitConfig> {
  const cfg = clampRateLimitConfig(input);
  await writeOperatorState('operator_rate_limit_config', cfg);
  applyCached(cfg); // update THIS process immediately (no wait for the publish round-trip)
  getRateLimitBus().publish({ type: 'rate_limit_config_changed', config: cfg, ts: Date.now() });
  return cfg;
}

/** Test hook — reset the module's cached state + boot latch. */
export function __resetRateLimitConfigForTest(): void {
  cached = { ...DEFAULT_RATE_LIMIT_CONFIG };
  booted = false;
  setGlobalConcurrencyCap(undefined);
  setGlobalConcurrencyFloor(undefined);
}
