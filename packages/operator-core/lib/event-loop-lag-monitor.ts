/**
 * event-loop-lag-monitor.ts — cheap, always-on event-loop-lag gauge
 * (EI-79 observability). Booted by the Hono host; also the central SLO
 * instrument of the p2p-perf suite (`lib/sync/hyperbee/perf/`), which is why
 * it lives in operator-core rather than apps/operator
 * (p2p-performance-suite-2026-06-07 P-007 / D-003).
 *
 * EI-79 was a forensic slog precisely because nothing on the host reported the
 * one number that explained it: the event loop was carrying sustained CPU work
 * (a 1Hz full-history hyperbee re-merge), so every `await` hop paid the loop
 * delay and hop-heavy agent-mcp routes degraded to 12-30s while `/api/health`
 * (≈2 hops) stayed fast. A standing lag gauge makes that self-evident next time.
 *
 * Implementation: `perf_hooks.monitorEventLoopDelay()` is a native libuv
 * histogram timer — it samples loop delay in C with negligible JS overhead (far
 * cheaper than a `setInterval` drift probe, which itself competes for the loop).
 * We read + reset it on a slow cadence and log a single structured line ONLY
 * when p95 lag crosses a threshold, so a healthy host is silent.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { managedSetInterval } from '@papercusp/scheduled-registry';

export interface LagMonitorOpts {
  /** How often to sample + evaluate the histogram (ms). Default 10_000. */
  intervalMs?: number;
  /** Log a warning when p95 loop lag (ms) over the window exceeds this. Default 100. */
  warnP95Ms?: number;
  /** Sink for the structured warning line. Default console.warn. (Values are
   *  numbers for the lag gauge; the profiler also passes the profile `file` path.) */
  log?: (line: string, detail: Record<string, number | string>) => void;
  /**
   * infra round-3 F1: when a window crosses `profileTriggerP95Ms`, capture a short
   * V8 CPU profile (`.cpuprofile`) so the SYNCHRONOUS culprit eating the loop is
   * identifiable — the histogram says "the loop is blocked", the profile says "by
   * what". Default OFF (the p2p-perf SLO instrument + tests must not be perturbed
   * by a profiler); the production host turns it on. Saturation is sustained
   * (350-630 windows/hr observed), so a profile started just AFTER a critical
   * window reliably catches the ongoing block. All inspector use is best-effort:
   * any failure degrades silently to today's symptom-only logging.
   */
  profileOnSaturation?: boolean;
  /** Dir for `.cpuprofile` artifacts. Default ~/.papercusp/loop-profiles. */
  profileDir?: string;
  /** p95 loop-delay (ms) that triggers a capture. Default = the critical band (600ms). */
  profileTriggerP95Ms?: number;
  /** How long each capture samples (ms). Default 3000. */
  profileDurationMs?: number;
  /** Minimum gap between captures (ms) — rate-limit so a long burst can't profile-storm. Default 300_000 (5 min). */
  minProfileGapMs?: number;
  /** Retain at most this many `.cpuprofile` files (oldest pruned). Default 20. */
  maxProfiles?: number;
}

export interface LagMonitorHandle {
  /** Stop sampling (clears the timer + disables the histogram). */
  stop(): void;
  /** Read the current window's stats without resetting (for an endpoint/test). */
  sample(): { p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number };
}

export type LoopPressure = 'ok' | 'elevated' | 'critical';

// P5-1 (operator-scalability-event-loop-2026-06-16): the running monitor's live
// read fn, published module-globally so the Layer-2 feedback governor (background
// load-shedding + spawn admission) can read loop pressure WITHOUT its own probe.
// Null until the host boots the monitor (e.g. a request-only worker that never
// started one) — callers treat null as 'ok' (no signal ⇒ don't shed).
let _liveRead: (() => { p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number }) | null = null;

/** p95 loop-delay (ms) thresholds for the pressure bands. Env-tunable so a small
 *  host can be stricter. elevated ⇒ start widening cadences; critical ⇒ shed. */
const ELEVATED_P95_MS = Math.max(1, Number(process.env.PAPERCUSP_LOOP_ELEVATED_MS) || 120);
const CRITICAL_P95_MS = Math.max(
  ELEVATED_P95_MS + 1,
  Number(process.env.PAPERCUSP_LOOP_CRITICAL_MS) || 600,
);

/** The live loop-delay sample (current partial window), or null if no monitor. */
export function currentLoopLag(): { p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number } | null {
  return _liveRead ? _liveRead() : null;
}

/** Pure band classification from a p95 loop-delay (ms). Exported for tests. */
export function classifyLoopPressure(
  p95Ms: number,
  elevatedMs: number = ELEVATED_P95_MS,
  criticalMs: number = CRITICAL_P95_MS,
): LoopPressure {
  if (!Number.isFinite(p95Ms)) return 'ok';
  if (p95Ms >= criticalMs) return 'critical';
  if (p95Ms >= elevatedMs) return 'elevated';
  return 'ok';
}

/** Current loop pressure band from the live p95. 'ok' when no monitor is running
 *  (absence of signal must never cause shedding). */
export function loopPressure(): LoopPressure {
  const s = _liveRead?.();
  if (!s) return 'ok';
  return classifyLoopPressure(s.p95Ms);
}

/** True when the request loop is critically saturated — admission gates + heavy
 *  background ticks should back off this cycle. */
export function isLoopSaturated(): boolean {
  return loopPressure() === 'critical';
}

/** Yield the macrotask queue once so any pending timer/IO callback — most
 *  importantly the routine TICKER — runs before this loop continues. A `setImmediate`
 *  fires after the current poll phase, so the ticker is never starved by a long
 *  synchronous CPU-loop on the main thread. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Cooperative-yield gate for a hot boot/drain LOOP that would otherwise hog the
 * main thread (the EI / event-loop-lag class: "host is CPU-bound on the main
 * thread", routine ticker starved → watchdog restart loop). Call it once per
 * iteration; it yields (lets the ticker + IO run) when EITHER the loop has done
 * `everyN` iterations since the last yield OR loop pressure is already elevated —
 * so a quiet boot pays at most one macrotask hop per `everyN` items, but a
 * saturated one yields aggressively. Returns the running count so callers can keep
 * a single `let n = 0` cursor.
 *
 *   let n = 0;
 *   for (const item of heavy) { await work(item); n = await cooperativeYield(n); }
 */
export async function cooperativeYield(count: number, everyN = 4): Promise<number> {
  const next = count + 1;
  if (next % Math.max(1, everyN) === 0 || loopPressure() !== 'ok') {
    await yieldToEventLoop();
  }
  return next;
}

/**
 * Start the event-loop-lag monitor. Returns a handle; the underlying timer is
 * `unref`'d so it never keeps the process alive on its own. Idempotent enough
 * for one-per-process use — call once at host boot.
 */
export function startEventLoopLagMonitor(opts: LagMonitorOpts = {}): LagMonitorHandle {
  const intervalMs = opts.intervalMs ?? 10_000;
  const warnP95Ms = opts.warnP95Ms ?? 100;
  const log =
    opts.log ??
    ((line, detail) => {
      console.warn(line, detail);
    });

  // resolution: histogram bucket granularity (ms). 20ms is plenty for a
  // "the loop is blocked" gauge and keeps the timer overhead trivial.
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();

  const ns2ms = (ns: number) => Math.round((ns / 1e6) * 10) / 10;
  const read = () => ({
    p50Ms: ns2ms(h.percentile(50)),
    p95Ms: ns2ms(h.percentile(95)),
    p99Ms: ns2ms(h.percentile(99)),
    maxMs: ns2ms(h.max),
  });
  // P5-1: publish the live read so loopPressure()/isLoopSaturated() work fleet-wide.
  _liveRead = read;

  // infra round-3 F1: lag-triggered CPU-profile capture state.
  const profileOnSaturation =
    opts.profileOnSaturation ??
    (process.env.PAPERCUSP_LOOP_PROFILER === '1' || process.env.PAPERCUSP_LOOP_PROFILER === 'true');
  const profileTriggerP95Ms = opts.profileTriggerP95Ms ?? CRITICAL_P95_MS;
  const profileDurationMs = opts.profileDurationMs ?? 3000;
  const minProfileGapMs = opts.minProfileGapMs ?? 300_000;
  const maxProfiles = opts.maxProfiles ?? 20;
  const profileDir = opts.profileDir;
  let profiling = false;
  let lastProfileAt = 0;
  let stopped = false;

  const timer = managedSetInterval('event-loop-lag-monitor', intervalMs, () => {
    const s = read();
    if (s.p95Ms >= warnP95Ms) {
      log('[event-loop-lag] high loop delay — host is CPU-bound on the main thread', {
        p50Ms: s.p50Ms,
        p95Ms: s.p95Ms,
        p99Ms: s.p99Ms,
        maxMs: s.maxMs,
        windowMs: intervalMs,
      });
    }
    // F1: when saturated, capture a short CPU profile so the synchronous culprit
    // is identifiable. Rate-limited + single-flight; fully best-effort.
    if (
      profileOnSaturation &&
      !profiling &&
      s.p95Ms >= profileTriggerP95Ms &&
      Date.now() - lastProfileAt >= minProfileGapMs
    ) {
      profiling = true;
      lastProfileAt = Date.now();
      captureCpuProfile({ durationMs: profileDurationMs, dir: profileDir, maxProfiles, trigger: s, log })
        .catch(() => {})
        .finally(() => {
          if (!stopped) profiling = false;
        });
    }
    // Reset so each window is independent (a one-off spike doesn't pin the
    // gauge high forever).
    h.reset();
  }, { category: 'watchdog' });

  return {
    stop() {
      stopped = true;
      timer.stop();
      h.disable();
      if (_liveRead === read) _liveRead = null;
    },
    sample: read,
  };
}

/**
 * infra round-3 F1 — capture a short V8 CPU profile and persist it as a
 * `.cpuprofile` (loadable in Chrome DevTools / speedscope). The V8 sampling
 * profiler interrupts even synchronous JS, so unlike a JS timer it captures the
 * frames blocking the loop. Entirely best-effort: any failure (no inspector,
 * an attached debugger, fs error) resolves quietly — the gauge must never break
 * the host it is observing.
 */
export async function captureCpuProfile(args: {
  durationMs: number;
  dir?: string;
  maxProfiles: number;
  trigger: { p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number };
  log: (line: string, detail: Record<string, number | string>) => void;
}): Promise<string | null> {
  const { durationMs, maxProfiles, trigger, log } = args;
  try {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const inspector = await import('node:inspector/promises');

    const dir = args.dir ?? path.join(os.homedir(), '.papercusp', 'loop-profiles');
    await fs.mkdir(dir, { recursive: true });

    const session = new inspector.Session();
    session.connect();
    try {
      await session.post('Profiler.enable');
      await session.post('Profiler.start');
      await new Promise((r) => setTimeout(r, durationMs));
      const { profile } = (await session.post('Profiler.stop')) as { profile: unknown };
      // Timestamp without Date.now-in-name collisions: epoch ms + pid.
      const stamp = `${Date.now()}-pid${process.pid}-p95_${Math.round(trigger.p95Ms)}ms`;
      const file = path.join(dir, `loop-saturation-${stamp}.cpuprofile`);
      await fs.writeFile(file, JSON.stringify(profile));
      log('[event-loop-lag] captured CPU profile of the saturated loop — load in DevTools/speedscope', {
        p95Ms: trigger.p95Ms,
        maxMs: trigger.maxMs,
        durationMs,
        file,
      });

      // Prune to the most-recent maxProfiles to bound disk use.
      try {
        const entries = (await fs.readdir(dir))
          .filter((f) => f.endsWith('.cpuprofile'))
          .sort();
        const excess = entries.length - maxProfiles;
        for (let i = 0; i < excess; i++) {
          await fs.rm(path.join(dir, entries[i]), { force: true }).catch(() => {});
        }
      } catch {
        /* prune is best-effort */
      }
      return file;
    } finally {
      try {
        session.disconnect();
      } catch {
        /* ignore */
      }
    }
  } catch {
    // No inspector available, a debugger already attached, or an fs error —
    // degrade silently to symptom-only logging.
    return null;
  }
}
