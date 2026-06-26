/**
 * @papercusp/scheduled-registry — a generic, named, listable wrapper over setInterval.
 *
 * The problem (schedule-inventory-and-ephemeral-tier-2026-06-26): raw `setInterval`
 * calls are runtime-INVISIBLE — no registry, no names, no fire history — so "what is
 * running on a timer?" is answerable only by grep. This wraps `setInterval` so every
 * armed timer is REGISTERED with a name + category + last-fire/last-error/armed state,
 * and `listManaged()` returns the whole set. A `lint:no-raw-setinterval` guard (host
 * side) then forbids bare `setInterval`, so nothing escapes the inventory.
 *
 * KEY PRINCIPLE — visibility != control. Registering a timer does NOT centralize its
 * scheduling: a watchdog still runs as its own out-of-band interval; it just becomes
 * LISTABLE. The category records WHY (lifecycle / watchdog / cache stay bespoke;
 * global-sweep / ephemeral-harness are the centrally-driven classes).
 *
 * Pure registry over INJECTED time + timers (configure*() seam): tests pass a fake
 * setInterval/now/shouldShed and drive ticks deterministically; production defaults to
 * the Node globals. Zero domain coupling, zero runtime deps. Two papercusp consumers:
 * the in-process host health sweeps (ex-in-process-periodic) and the ephemeral blueprint
 * cadence tier — both register here rather than each owning a bespoke scheduler (D-006:
 * one in-process mechanism, not three).
 */

/** Why a timer exists — drives the inventory's scope/tier and whether it's centrally driven. */
export type ManagedCategory =
  | 'lifecycle' // per-connection/stream/spawn — bespoke, cannot be central
  | 'watchdog' // out-of-band sentinel — bespoke, must survive what it watches
  | 'cache' // per-process memo refresh — bespoke
  | 'global-sweep' // host-wide idempotent sweep — centrally driven (in-process tier)
  | 'ephemeral-harness' // per-harness frequent cadence — centrally driven (ephemeral tier)
  | 'external-process' // a separate process's timer (gateway/launcher/bench)
  | (string & {}); // forward-compat: any host-defined category

export interface ManagedTimerOptions {
  category: ManagedCategory;
  /** Heavy ticks shed a cycle under load when the injected shouldShed(name) returns true. Light ticks omit it. */
  shed?: boolean;
  /** Also run ONCE immediately on arm (heal-on-startup), not only after the first interval. */
  fireOnArm?: boolean;
}

/** The public, listable view of one armed timer. */
export interface ManagedEntry {
  name: string;
  category: ManagedCategory;
  intervalMs: number;
  /** epoch ms when armed. */
  armedAt: number;
  /** epoch ms of the last successful (or attempted) fire, or null if never fired. */
  lastFireAt: number | null;
  /** last tick error message, or null if the last tick succeeded / none yet. */
  lastError: string | null;
  /** true while a tick is in flight (the re-entrancy guard is engaged). */
  running: boolean;
  /** count of fires (including ones that threw). */
  fires: number;
  /** whether this timer participates in load-shedding. */
  shed: boolean;
}

export interface ManagedHandle {
  /** Clear the timer and deregister it from the inventory. Idempotent. */
  stop(): void;
}

/** A minimal timer handle — the Node Timeout's `.unref()` is honored when present. */
export interface TimerHandle {
  unref?: () => void;
}

export type SetIntervalImpl = (cb: () => void, ms: number) => TimerHandle;
export type SetTimeoutImpl = (cb: () => void, ms: number) => TimerHandle;
export type ClearTimerImpl = (h: TimerHandle) => void;

export interface ScheduledRegistryConfig {
  setIntervalImpl?: SetIntervalImpl;
  clearIntervalImpl?: ClearTimerImpl;
  setTimeoutImpl?: SetTimeoutImpl;
  /** epoch-ms clock; defaults to Date.now. */
  now?: () => number;
  /** category-aware shed gate for `shed: true` timers; defaults to never-shed. */
  shouldShed?: (name: string) => boolean;
  log?: (msg: string) => void;
}

type ResolvedConfig = Required<ScheduledRegistryConfig>;

function defaults(): ResolvedConfig {
  return {
    setIntervalImpl: (cb, ms) => setInterval(cb, ms) as unknown as TimerHandle,
    clearIntervalImpl: (h) => clearInterval(h as unknown as ReturnType<typeof setInterval>),
    setTimeoutImpl: (cb, ms) => setTimeout(cb, ms) as unknown as TimerHandle,
    now: () => Date.now(),
    shouldShed: () => false,
    log: (m) => console.warn(`[scheduled-registry] ${m}`),
  };
}

let resolved: ResolvedConfig = defaults();

interface InternalRecord {
  entry: ManagedEntry;
  timer: TimerHandle;
  running: boolean;
  stopped: boolean;
}

const registry = new Map<string, InternalRecord>();

/**
 * Override the injected seams (timer fns, clock, shed gate, logger). Partial merge —
 * unspecified fields keep their current value. Call once at host boot (e.g. to wire the
 * host's tick-load-shed into `shouldShed`); tests call it to inject a controllable timer.
 */
export function configureScheduledRegistry(config: ScheduledRegistryConfig): void {
  resolved = { ...resolved, ...stripUndefined(config) };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as (keyof T)[]) {
    if (o[k] !== undefined) out[k] = o[k];
  }
  return out;
}

function makeTick(name: string, fn: () => void | Promise<void>, opts: ManagedTimerOptions, rec: InternalRecord): () => void {
  // Record a fire. fires + lastFireAt count every ATTEMPT (including throws); only lastError differs.
  const settle = (err?: unknown): void => {
    if (err === undefined) {
      rec.entry.lastError = null;
    } else {
      rec.entry.lastError = err instanceof Error ? err.message : String(err);
      resolved.log(`${name} tick failed (next interval retries): ${rec.entry.lastError}`);
    }
    rec.entry.lastFireAt = resolved.now();
    rec.entry.fires += 1;
    rec.running = false;
    rec.entry.running = false;
  };
  return () => {
    if (rec.stopped) return;
    if (rec.running) return; // re-entrancy guard — a slow tick never piles up a second run
    if (opts.shed && resolved.shouldShed(name)) return; // shed this cycle under load
    rec.running = true;
    rec.entry.running = true;
    // Run a SYNCHRONOUS tick synchronously — this preserves the bare-setInterval timing
    // semantics (a sync watchdog tick must complete in THIS turn, not a deferred microtask);
    // only a genuinely-async tick (returns a thenable) is awaited, so the re-entrancy guard
    // still holds across a slow async run.
    let result: void | Promise<void>;
    try {
      result = fn();
    } catch (e) {
      settle(e);
      return;
    }
    if (result && typeof (result as Promise<void>).then === 'function') {
      void Promise.resolve(result).then(
        () => settle(undefined),
        (e: unknown) => settle(e),
      );
    } else {
      settle(undefined);
    }
  };
}

/**
 * Arm a NAMED, listable interval. Returns a handle whose stop() clears + deregisters it.
 * Re-arming an existing name stops the previous timer first (no duplicate names, no leak).
 * The timer is unref'd so it never holds the process open.
 */
export function managedSetInterval(
  name: string,
  intervalMs: number,
  fn: () => void | Promise<void>,
  opts: ManagedTimerOptions,
): ManagedHandle {
  if (registry.has(name)) {
    resolved.log(`re-registering '${name}' — stopping the previous timer (duplicate name)`);
    stopManaged(name);
  }
  const entry: ManagedEntry = {
    name,
    category: opts.category,
    intervalMs,
    armedAt: resolved.now(),
    lastFireAt: null,
    lastError: null,
    running: false,
    fires: 0,
    shed: opts.shed ?? false,
  };
  const rec: InternalRecord = { entry, timer: { unref: undefined }, running: false, stopped: false };
  const tick = makeTick(name, fn, opts, rec);
  rec.timer = resolved.setIntervalImpl(tick, intervalMs);
  rec.timer.unref?.();
  if (opts.fireOnArm) {
    const t = resolved.setTimeoutImpl(tick, 0);
    t.unref?.();
  }
  registry.set(name, rec);
  return { stop: () => stopManaged(name) };
}

/** Stop + deregister one timer by name. Returns whether it existed. Idempotent. */
export function stopManaged(name: string): boolean {
  const rec = registry.get(name);
  if (!rec) return false;
  rec.stopped = true;
  resolved.clearIntervalImpl(rec.timer);
  registry.delete(name);
  return true;
}

/** The whole inventory of armed timers, sorted by name. Snapshot copies (mutation-safe). */
export function listManaged(): ManagedEntry[] {
  return [...registry.values()].map((r) => ({ ...r.entry })).sort((a, b) => a.name.localeCompare(b.name));
}

/** One timer's current entry, or undefined. Snapshot copy. */
export function getManaged(name: string): ManagedEntry | undefined {
  const r = registry.get(name);
  return r ? { ...r.entry } : undefined;
}

/** Count of currently-armed timers. */
export function managedCount(): number {
  return registry.size;
}

/** Stop ALL timers (graceful shutdown / test teardown). */
export function stopAllManaged(): void {
  for (const name of [...registry.keys()]) stopManaged(name);
}

/** Reset the registry AND restore default seams — for test isolation. */
export function resetScheduledRegistry(): void {
  stopAllManaged();
  resolved = defaults();
}
