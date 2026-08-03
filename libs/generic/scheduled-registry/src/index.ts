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

/**
 * The push-don't-poll DATA-SOURCE verdict for a timer (D-004,
 * stop-discarded-dedup-and-audit-server-polling-2026-07-26 / P-011) — orthogonal to
 * `ManagedCategory` above (which is about SCHEDULING MECHANISM/ownership, not data source):
 *
 *   - 'must-sample'   — no event source exists to subscribe to (port reachability, PID
 *                        liveness, disk usage, an external HTTP probe). Legitimately a timer.
 *   - 'timeout-reaper' — the passage of time IS the trigger (stale-claim sweep, presence
 *                        reaper, epoch-key reconcile, a deadline check). A timeout
 *                        implemented as a subscription is just a timer with extra steps.
 *   - 'violation'      — recomputes derived state from a store that ALREADY emits change
 *                        events, on a timer, regardless of subscriber presence. The actual
 *                        push-don't-poll sin — convert this to invalidate-on-write instead.
 *
 * OPTIONAL at the type level (a required field would force every one of the ~97 existing
 * `managedSetInterval`/`PeriodicCheck` call sites to be edited in this one change — too large
 * a blast radius for one PR). The real enforcement is `scripts/check-timer-classification.mjs`
 * (lint:timer-classification): a shrink-only BASELINE grandfathers today's unclassified call
 * sites; a NEW site outside the baseline that omits `classification` fails the build. This is
 * the SAME staged-rollout shape as `lint:no-raw-setinterval` (P-007/P-008) — visibility (an
 * optional field + inventory column) becoming enforceable control (a lint gate) without a
 * flag-day rewrite of every existing timer.
 */
export type TimerClassification = 'must-sample' | 'timeout-reaper' | 'violation';

export interface ManagedTimerOptions {
  category: ManagedCategory;
  /** Heavy ticks shed a cycle under load when the injected shouldShed(name) returns true. Light ticks omit it. */
  shed?: boolean;
  /** Also run ONCE immediately on arm (heal-on-startup), not only after the first interval. */
  fireOnArm?: boolean;
  /**
   * Allow MANY live timers under one `name` (per-connection lifecycle timers — a WS/SSE
   * keepalive armed per socket). Without this, re-arming a name stops the previous timer
   * (a collision). With it, each arm coexists under a unique internal key and listManaged()
   * AGGREGATES them into ONE inventory row carrying the live instance count + most-recent
   * fire — so the timer is VISIBLE without per-connection churn.
   */
  instanced?: boolean;
  /** D-004 push-don't-poll classification (P-011) — see `TimerClassification`. Declaring it
   *  makes the timer's data-source verdict VISIBLE in schedule:inventory instead of living
   *  only in a plan/audit document that goes stale; omit only for a call site the shrink-only
   *  lint BASELINE still grandfathers. */
  classification?: TimerClassification;
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
  /** true for per-connection instanced timers (aggregated by name in listManaged). */
  instanced: boolean;
  /** number of live instances aggregated into this row (1 for a singleton). */
  instances: number;
  /** D-004 push-don't-poll classification (P-011), or null when the call site hasn't
   *  declared one yet (grandfathered by the shrink-only lint BASELINE). */
  classification: TimerClassification | null;
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

interface InternalRecord {
  entry: ManagedEntry;
  /** unique registry key (== name for singletons; `name#N` for instanced timers). */
  key: string;
  timer: TimerHandle;
  running: boolean;
  stopped: boolean;
}

/**
 * Mutable state, PINNED TO globalThis rather than held in module scope.
 *
 * Why (EI-19451658870832332, measured live on bg-host 2026-08-03): this module can be
 * instantiated TWICE inside ONE process. The host entry runs under tsx (a CJS preflight
 * alongside an ESM loader), importers reach this package through both bare-specifier and
 * relative paths, and `node_modules/@papercusp/*` are symlinks into the repo. Any one of
 * those seams yields two module records — and module-scoped state then splits into two
 * DISJOINT inventories.
 *
 * The resulting failure is silent and expensive: a timer armed through instance A is absent
 * from `listManaged()` served by instance B, so `/api/internal/managed-timers` — and
 * `schedule:inventory` above it — reports a RUNNING timer as missing. Measured: the
 * dbos-executor-reaper reaped workflows every 2 minutes inside bg-host while absent from
 * that same process's own inventory, which read as "the reaper is dark" and cost hours of
 * investigation across several sessions. Absence from an inventory is evidence only when
 * there is exactly ONE inventory.
 *
 * A global-symbol key fixes the whole class without depending on WHICH seam duplicated the
 * module: it is correct under dual-package, symlink, CJS/ESM-split and bundled-copy alike.
 * `Symbol.for` is deliberate — it is the cross-realm symbol registry, so a second instance
 * resolves the SAME key instead of minting a fresh one.
 */
interface RegistryState {
  registry: Map<string, InternalRecord>;
  instanceCounter: number;
  resolved: ResolvedConfig;
  /**
   * How many times THIS module's body has been evaluated in this realm.
   *
   * The pin above fixes the split — but it also HIDES it: once both module
   * records share one state object, nothing distinguishes one record from two,
   * so the packaging fault survives forever and the next split is discovered the
   * same expensive way. Counting evaluations is what turns the fix into a
   * standing recurrence guard: > 1 means the duplication is BACK, reported by
   * the very surface it used to blind.
   *
   * Cannot itself split — it lives in the pinned state, not module scope.
   */
  moduleEvaluations: number;
}

const STATE_KEY = Symbol.for('@papercusp/scheduled-registry.state');

const globalStore = globalThis as unknown as Record<symbol, RegistryState | undefined>;
let sharedState = globalStore[STATE_KEY];
if (!sharedState) {
  sharedState = {
    registry: new Map<string, InternalRecord>(),
    instanceCounter: 0,
    resolved: defaults(),
    moduleEvaluations: 0,
  };
  globalStore[STATE_KEY] = sharedState;
}

const state: RegistryState = sharedState;

/**
 * Runs on EVERY evaluation of this module body — the first sets it to 1, a
 * duplicate record takes it to 2. Deliberately placed at module scope: it is a
 * count of module RECORDS, so it must not be reachable from any function.
 *
 * `?? 0` guards a state object pinned by an older build that predates this field.
 */
state.moduleEvaluations = (state.moduleEvaluations ?? 0) + 1;

/**
 * The one shared inventory. Safe to alias into module scope because the Map IDENTITY never
 * changes — every instance binds the same object. `resolved` and `instanceCounter` are
 * reassigned, so those are always read through `state` and must never be aliased this way.
 */
const registry = state.registry;

/**
 * Override the injected seams (timer fns, clock, shed gate, logger). Partial merge —
 * unspecified fields keep their current value. Call once at host boot (e.g. to wire the
 * host's tick-load-shed into `shouldShed`); tests call it to inject a controllable timer.
 */
export function configureScheduledRegistry(config: ScheduledRegistryConfig): void {
  state.resolved = { ...state.resolved, ...stripUndefined(config) };
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
      state.resolved.log(`${name} tick failed (next interval retries): ${rec.entry.lastError}`);
    }
    rec.entry.lastFireAt = state.resolved.now();
    rec.entry.fires += 1;
    rec.running = false;
    rec.entry.running = false;
  };
  return () => {
    if (rec.stopped) return;
    if (rec.running) return; // re-entrancy guard — a slow tick never piles up a second run
    if (opts.shed && state.resolved.shouldShed(name)) return; // shed this cycle under load
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
  const instanced = opts.instanced ?? false;
  // Singletons key by name (re-arming replaces); instanced timers get a unique key so many
  // coexist under one display name (aggregated in listManaged).
  const key = instanced ? `${name}#${(state.instanceCounter += 1)}` : name;
  if (!instanced && registry.has(key)) {
    // Idempotent re-arm: silently stop the previous timer and register fresh. No warn —
    // host watchdogs re-arm across boot retries / test cases, and the inventory always
    // reflects the single latest registration. (A genuine name COLLISION is a code-review
    // concern surfaced by two distinct sites sharing a name, not a runtime warning.)
    stopManaged(key);
  }
  const entry: ManagedEntry = {
    name,
    category: opts.category,
    intervalMs,
    armedAt: state.resolved.now(),
    lastFireAt: null,
    lastError: null,
    running: false,
    fires: 0,
    shed: opts.shed ?? false,
    instanced,
    instances: 1,
    classification: opts.classification ?? null,
  };
  const rec: InternalRecord = { entry, key, timer: { unref: undefined }, running: false, stopped: false };
  const tick = makeTick(name, fn, opts, rec);
  rec.timer = state.resolved.setIntervalImpl(tick, intervalMs);
  rec.timer.unref?.();
  if (opts.fireOnArm) {
    const t = state.resolved.setTimeoutImpl(tick, 0);
    t.unref?.();
  }
  registry.set(key, rec);
  return { stop: () => stopManaged(key) };
}

/** Stop + deregister one timer by name. Returns whether it existed. Idempotent. */
export function stopManaged(name: string): boolean {
  const rec = registry.get(name);
  if (!rec) return false;
  rec.stopped = true;
  state.resolved.clearIntervalImpl(rec.timer);
  registry.delete(name);
  return true;
}

/**
 * The whole inventory of armed timers, sorted by name. Singletons appear one-per-name;
 * instanced timers are AGGREGATED into ONE row per name (instances = live count,
 * lastFireAt = most-recent across instances, fires = sum). Snapshot copies (mutation-safe).
 */
export function listManaged(): ManagedEntry[] {
  const singletons: ManagedEntry[] = [];
  const grouped = new Map<string, ManagedEntry>();
  for (const r of registry.values()) {
    if (!r.entry.instanced) {
      singletons.push({ ...r.entry });
      continue;
    }
    const g = grouped.get(r.entry.name);
    if (!g) {
      grouped.set(r.entry.name, { ...r.entry });
    } else {
      g.instances += 1;
      g.fires += r.entry.fires;
      g.armedAt = Math.min(g.armedAt, r.entry.armedAt);
      if (r.entry.lastFireAt != null) g.lastFireAt = Math.max(g.lastFireAt ?? 0, r.entry.lastFireAt);
      if (r.entry.lastError) g.lastError = r.entry.lastError;
      g.running = g.running || r.entry.running;
      if (g.classification == null && r.entry.classification != null) g.classification = r.entry.classification;
    }
  }
  return [...singletons, ...grouped.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** One timer's current entry (singleton) or the aggregated row (instanced base name), or undefined. */
export function getManaged(name: string): ManagedEntry | undefined {
  const direct = registry.get(name);
  if (direct && !direct.entry.instanced) return { ...direct.entry };
  // instanced base name (keys are name#N) → return the aggregated row.
  return listManaged().find((e) => e.name === name);
}

/** Count of currently-armed timers (raw instances, NOT aggregated rows). */
export function managedCount(): number {
  return registry.size;
}

/**
 * How many times this module's body was evaluated in this process.
 *
 * `1` is healthy. `> 1` means the module is DUPLICATED — the state is still
 * shared (pinned), so the inventory is correct, but a duplicate module record is
 * a packaging fault that will silently split any NEW module-scoped state added
 * here later. `0` is impossible from a caller that imported this module.
 */
export function moduleEvaluationCount(): number {
  return state.moduleEvaluations;
}

/**
 * Standing recurrence guard for EI-19451658870832332 — the split that made an
 * armed, firing timer absent from its own process's inventory for 6+ days.
 *
 * Returns `null` when healthy, or a ready-to-log warning when this module has
 * been evaluated more than once. Surfaces embed this beside the timer list so
 * the inventory reports its OWN trustworthiness: the failure mode was an
 * inventory that looked complete while being half of one, and the reader had no
 * way to tell. This is deliberately a property OF the inventory rather than a
 * separate health check, because a separate check is exactly what nobody ran.
 */
export function moduleDuplicationWarning(): string | null {
  const n = state.moduleEvaluations;
  if (n <= 1) return null;
  return (
    `SPLIT MODULE SINGLETON: @papercusp/scheduled-registry was evaluated ${n}x in this process. ` +
    `State is pinned so this inventory is still complete, but a duplicate module record is a ` +
    `packaging fault (CJS/ESM double-load, a bare-vs-relative import of the same file, or a ` +
    `symlinked node_modules copy). Any NEW module-scoped state added to this file will split.`
  );
}

/** Stop ALL timers (graceful shutdown / test teardown). */
export function stopAllManaged(): void {
  for (const name of [...registry.keys()]) stopManaged(name);
}

/** Reset the registry AND restore default seams — for test isolation. */
export function resetScheduledRegistry(): void {
  stopAllManaged();
  state.resolved = defaults();
}
