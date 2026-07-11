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
  /**
   * bg-host-freeze-eventloop-stall-2026-06-30 P-002: heap-snapshot-on-high-RSS.
   * When true, capture a V8 heap snapshot (.heapsnapshot) whenever process RSS
   * crosses `heapSnapshotRssMb`. Default OFF and no longer enabled by
   * PAPERCUSP_HEAP_SNAPSHOT; only an explicit option or
   * PAPERCUSP_FULL_HEAP_SNAPSHOT=1 turns on the blocking full snapshot path.
   * The production bg-host should normally use heap sampling instead so a growing
   * memory leak self-captures without freezing the live event loop.
   * All inspector use is best-effort: any failure degrades silently.
   */
  heapSnapshotOnHighRss?: boolean;
  /** Dir for `.heapsnapshot` artifacts. Default ~/.papercusp/heap-snapshots. */
  heapSnapshotDir?: string;
  /**
   * RSS threshold in MB that triggers a heap capture. Read from
   * PAPERCUSP_HEAP_SNAPSHOT_RSS_MB if not passed. Default 8192 (8 GB).
   */
  heapSnapshotRssMb?: number;
  /** Minimum gap between heap captures (ms) — rate-limit. Default 600_000 (10 min). */
  minHeapSnapshotGapMs?: number;
  /** Retain at most this many `.heapsnapshot` files (oldest pruned). Default 5. */
  maxHeapSnapshots?: number;
  /**
   * WI-1088 leak hunt round 2: SAMPLING heap profiler. A FULL snapshot of a
   * multi-GB heap takes minutes to serialize and the leaking process dies first
   * (three 5-6 GB `.partial`s and zero completed captures on 2026-07-01). The
   * sampling profiler is the tool that CANNOT lose that race: it runs from boot
   * at O(1) overhead and its dump is a few-KB JSON of ALLOCATION STACKS —
   * written instantly at the same RSS trigger, with the top allocation sites
   * logged straight to the journal (self-pinpointing). Defaults to
   * heapSnapshotOnHighRss (same enable, no new knob).
   */
  heapSamplingOnHighRss?: boolean;
  /**
   * When the loop is already saturated enough to trigger a CPU profile, also dump
   * the live heap-sampling profile even if RSS has not yet crossed the full
   * heap-snapshot threshold. This closes the "CPU-bound stall below 8 GB leaves no
   * allocation artifact" gap that remained after the main leak flattened (WI-1088).
   * Default = same cadence as CPU profiles (`minProfileGapMs`).
   */
  minHeapSamplingDumpGapMs?: number;
  /**
   * WI-4189: retain at most this many `.heapprofile` files (oldest pruned).
   * Unlike `.heapsnapshot` (pruned via `maxHeapSnapshots`), sampling-profile
   * dumps had NO retention at all — on a host that sustains critical p95 lag
   * for hours (one dump every `minHeapSamplingDumpGapMs`, default 5 min), they
   * accumulate forever. Confirmed root cause of ~854MB / 1300+ stale
   * `.heapprofile` files during the 2026-07-11 root-disk-100% incident.
   * Default 50 (≈4hrs of dumps at the default 5-min gap).
   */
  maxSamplingProfiles?: number;
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

// Idempotency guard: at most one monitor per process. The host boots it from BOTH
// the request plane (startRequestServers) and the background machinery (runBootstrap),
// so the cluster bg-host PRIMARY — which serves no HTTP and so never ran the request-
// plane monitor — also gets a live gauge. Without it, currentLoopLag() returns null on
// the bg primary and the perf-regression rig's loop_lag_p95 never populates there (the
// "no event-loop-lag monitor on this thread" watchdog note — infra round-4 P-014). A
// repeat call returns the already-running handle instead of spawning a 2nd histogram.
let _runningHandle: LagMonitorHandle | null = null;

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

/** True when the request loop is critically saturated — the most severe band;
 *  kept for callers that specifically distinguish critical from elevated. */
export function isLoopSaturated(): boolean {
  return loopPressure() === 'critical';
}

/** True when the loop is at least ELEVATED (elevated OR critical) — heavy background
 *  ticks should start shedding at this band, before reaching fully critical saturation.
 *  Returns false when no monitor is running (absence of signal must never cause shedding). */
export function isLoopElevated(): boolean {
  return loopPressure() !== 'ok';
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
  // One monitor per process (see _runningHandle). A 2nd call — single-process mode
  // boots both the request plane AND the bg machinery — returns the live handle so we
  // never run two histograms/timers (or two profilers) against one event loop.
  if (_runningHandle) return _runningHandle;
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

  // P-002: heap-snapshot-on-high-RSS state. WI-3255: full V8 heap snapshots
  // pause the live loop while V8 serializes the heap, and on multi-GB bg-hosts
  // that pause is itself a production incident. Keep full snapshots explicit-only;
  // the sampling heap profiler below remains the default diagnostic artifact.
  const heapSnapshotOnHighRss =
    opts.heapSnapshotOnHighRss ??
    (process.env.PAPERCUSP_FULL_HEAP_SNAPSHOT === '1' || process.env.PAPERCUSP_FULL_HEAP_SNAPSHOT === 'true');
  const heapSnapshotRssMb =
    opts.heapSnapshotRssMb ??
    Math.max(1, Number(process.env.PAPERCUSP_HEAP_SNAPSHOT_RSS_MB) || 8192);
  const minHeapSnapshotGapMs = opts.minHeapSnapshotGapMs ?? 600_000;
  const maxHeapSnapshots = opts.maxHeapSnapshots ?? 5;
  const heapSnapshotDir = opts.heapSnapshotDir;
  let snapshotting = false;
  let lastSnapshotAt = 0;
  // WI-1088 round 2: sampling heap profiler — armed lazily on the first tick so
  // startup cost is off the boot path; dumped at the same RSS trigger.
  const heapSamplingOnHighRss =
    opts.heapSamplingOnHighRss ??
    (heapSnapshotOnHighRss ||
      process.env.PAPERCUSP_HEAP_SNAPSHOT === '1' ||
      process.env.PAPERCUSP_HEAP_SNAPSHOT === 'true');
  const minHeapSamplingDumpGapMs = opts.minHeapSamplingDumpGapMs ?? minProfileGapMs;
  const maxSamplingProfiles = opts.maxSamplingProfiles ?? 50;
  let samplingArmed = false;
  let samplingDumping = false;
  let lastSamplingDumpAt = 0;

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
    // WI-1088 round 2: arm the sampling heap profiler on the first tick (O(1)
    // overhead from here on; allocation stacks accumulate from ~boot).
    if (heapSamplingOnHighRss && !samplingArmed) {
      samplingArmed = true;
      void ensureHeapSampling((line, detail) => log(line, detail ?? {}));
    }
    // WI-1088 follow-up: a host can be deeply CPU-bound while RSS stays below the
    // full heap-snapshot threshold, which leaves only a CPU profile and no live
    // allocation-site artifact. Dump the sampling profile on sustained saturation
    // too, rate-limited independently from full snapshots.
    if (
      heapSamplingOnHighRss &&
      samplingArmed &&
      !samplingDumping &&
      s.p95Ms >= profileTriggerP95Ms &&
      Date.now() - lastSamplingDumpAt >= minHeapSamplingDumpGapMs
    ) {
      samplingDumping = true;
      lastSamplingDumpAt = Date.now();
      const rssMb = process.memoryUsage().rss / 1_048_576;
      void dumpHeapSamplingProfile({
        dir: heapSnapshotDir,
        rssMb,
        maxProfiles: maxSamplingProfiles,
        log: (line, detail) => log(line, detail ?? {}),
      })
        .catch(() => {})
        .finally(() => {
          if (!stopped) samplingDumping = false;
        });
    }
    // P-002: when RSS is high, capture a heap snapshot so the leak is identifiable.
    // Checked on each tick (cheap: one memoryUsage() call). Single-flight + rate-limited.
    if (
      heapSnapshotOnHighRss &&
      !snapshotting &&
      Date.now() - lastSnapshotAt >= minHeapSnapshotGapMs
    ) {
      const rssMb = process.memoryUsage().rss / 1_048_576;
      if (rssMb >= heapSnapshotRssMb) {
        snapshotting = true;
        lastSnapshotAt = Date.now();
        // Dump the sampling profile FIRST — it is instant (KBs) and survives even
        // if the full snapshot below dies mid-serialization (the 2026-07-01 mode).
        if (heapSamplingOnHighRss && !samplingDumping) {
          samplingDumping = true;
          dumpHeapSamplingProfile({ dir: heapSnapshotDir, rssMb, maxProfiles: maxSamplingProfiles, log: (line, detail) => log(line, detail ?? {}) })
            .catch(() => {})
            .finally(() => {
              if (!stopped) samplingDumping = false;
            });
        }
        captureHeapSnapshot({
          dir: heapSnapshotDir,
          maxSnapshots: maxHeapSnapshots,
          rssMb,
          log,
        })
          .catch(() => {})
          .finally(() => {
            if (!stopped) snapshotting = false;
          });
      }
    }
    // Reset so each window is independent (a one-off spike doesn't pin the
    // gauge high forever).
    h.reset();
  }, { category: 'watchdog' });

  const handle: LagMonitorHandle = {
    stop() {
      stopped = true;
      timer.stop();
      h.disable();
      if (_liveRead === read) _liveRead = null;
      if (_runningHandle === handle) _runningHandle = null;
    },
    sample: read,
  };
  _runningHandle = handle;
  return handle;
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

/**
 * bg-host-freeze-eventloop-stall-2026-06-30 P-002 — capture a V8 heap snapshot
 * and persist it as a `.heapsnapshot` (loadable in Chrome DevTools Memory tab or
 * via `node scripts/analyze-heap-snapshots.mjs`). The snapshot records every live
 * JS object with its class, self_size, and retainer chain — the authoritative tool
 * for tracing a memory leak when RSS is growing uncontrollably.
 *
 * Entirely best-effort: any failure (no inspector, an attached debugger, OOM
 * during the snapshot itself, fs error) resolves to null quietly — the gauge must
 * never break the host it is observing.
 *
 * ⚠ Taking a heap snapshot pauses V8 for the duration of the capture. On a large
 * heap (several GB) this pause can be tens of seconds. This is acceptable only
 * when the host is already in a degraded state (RSS well above the threshold) and
 * the tradeoff of a transient pause versus a self-diagnosing artifact is worth it.
 */
export async function captureHeapSnapshot(args: {
  dir?: string;
  maxSnapshots: number;
  rssMb: number;
  log: (line: string, detail: Record<string, number | string>) => void;
}): Promise<string | null> {
  const { maxSnapshots, rssMb, log } = args;
  try {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    // Use the callback-based inspector so we can set up the chunk listener BEFORE
    // posting the takeHeapSnapshot command — the promise-based Session inherits
    // EventEmitter, but the chunk events arrive synchronously within the post() call
    // and must be wired before the command is sent.
    const inspector = await import('node:inspector');

    const dir = args.dir ?? path.join(os.homedir(), '.papercusp', 'heap-snapshots');
    await fs.mkdir(dir, { recursive: true });

    const session = new inspector.Session();
    session.connect();
    // Stream snapshot chunks STRAIGHT TO DISK — V8 emits them as
    // HeapProfiler.addHeapSnapshotChunk events as it serializes the heap. The
    // original implementation buffered every chunk in a string[] and joined at
    // the end: on the multi-GB heap this tool exists to diagnose, that buffer
    // ~doubles RSS mid-capture and OOM-kills the process BEFORE the write — the
    // capture itself accelerated the 2026-07-01 bg-host cgroup OOM and left the
    // snapshot dir empty (WI-1088). Writing each chunk as it arrives keeps the
    // capture's JS-side memory O(chunk), so it survives on the heaps that matter.
    // The `.partial` name keeps a half-written file invisible to the analyzer
    // (and to the pruner) until the rename marks it complete.
    const stamp = `${Date.now()}-pid${process.pid}-rss_${Math.round(rssMb)}mb`;
    const file = path.join(dir, `heap-${stamp}.heapsnapshot`);
    const partial = `${file}.partial`;
    const fsSync = await import('node:fs');
    const out = fsSync.createWriteStream(partial);
    const outFailed = new Promise<never>((_, reject) => out.once('error', reject));
    session.on(
      'HeapProfiler.addHeapSnapshotChunk',
      (message: { params: { chunk: string } }) => {
        out.write(message.params.chunk);
      },
    );
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          session.post('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, (err) => {
            if (err) reject(err);
            else resolve();
          });
        }),
        outFailed,
      ]);
      await Promise.race([
        new Promise<void>((resolve) => out.end(resolve)),
        outFailed,
      ]);
      await fs.rename(partial, file);
      log(
        '[heap-snapshot] captured heap snapshot on high RSS — load in Chrome DevTools Memory tab or run analyze-heap-snapshots.mjs',
        { rssMb: Math.round(rssMb), file },
      );

      // Prune to maxSnapshots oldest-first to bound disk use.
      try {
        const entries = (await fs.readdir(dir))
          .filter((f) => f.endsWith('.heapsnapshot'))
          .sort();
        const excess = entries.length - maxSnapshots;
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
      // On any failure path the .partial is left behind — destroy the stream and
      // sweep it so a dead capture can't masquerade as progress (best-effort; a
      // hard crash mid-capture still leaves the .partial as visible evidence,
      // which the analyzer + pruner both ignore by extension).
      try {
        out.destroy();
      } catch {
        /* ignore */
      }
      await fs.rm(partial, { force: true }).catch(() => {});
    }
  } catch {
    // No inspector, an attached debugger, OOM during snapshot, or fs error —
    // degrade silently; the host must never crash because of a capture attempt.
    return null;
  }
}

// ── WI-1088 round 2: the SAMPLING heap profiler (the capture that can't lose the race) ──

/** The one long-lived sampling session (armed once per process; never re-armed). */
let _samplingSession: import('node:inspector').Session | null = null;

/**
 * Start the V8 sampling heap profiler once for this process. O(1) overhead
 * (default 256 KiB sampling interval); allocation stacks accumulate from here.
 * Best-effort: any failure logs once and degrades silently — the gauge must
 * never break the host it observes.
 */
export async function ensureHeapSampling(
  log: (line: string, detail?: Record<string, number | string>) => void = () => {},
): Promise<boolean> {
  if (_samplingSession) return true;
  try {
    const inspector = await import('node:inspector');
    const session = new inspector.Session();
    session.connect();
    await new Promise<void>((resolve, reject) => {
      session.post('HeapProfiler.startSampling', { samplingInterval: 262_144 }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
    _samplingSession = session;
    log('[heap-sampling] sampling heap profiler armed (256KiB interval) — allocation stacks accumulate from now');
    return true;
  } catch (e) {
    log(`[heap-sampling] failed to arm (degrading silently): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** One node of the V8 sampling-profile tree. */
interface SamplingNode {
  callFrame: { functionName?: string; url?: string; lineNumber?: number };
  selfSize: number;
  children?: SamplingNode[];
}

/** Flatten the sampling tree to the top-N allocation SITES by live self size.
 *  Exported for tests. */
export function topAllocationSites(
  head: SamplingNode,
  topN = 8,
): Array<{ site: string; mb: number }> {
  const bySite = new Map<string, number>();
  const walk = (n: SamplingNode) => {
    if (n.selfSize > 0) {
      const f = n.callFrame ?? {};
      const site = `${f.functionName || '(anonymous)'} @ ${(f.url || '(unknown)').replace(/^file:\/\//, '')}:${(f.lineNumber ?? -1) + 1}`;
      bySite.set(site, (bySite.get(site) ?? 0) + n.selfSize);
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(head);
  return [...bySite.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([site, bytes]) => ({ site, mb: Math.round((bytes / 1_048_576) * 10) / 10 }));
}

/**
 * Dump the accumulated sampling profile: a few-KB `.heapprofile` JSON (Chrome
 * DevTools-loadable) written INSTANTLY at the RSS trigger, plus the top
 * allocation sites logged to the journal — the leak names itself with no
 * external analysis, even if the process dies seconds later. Sampling keeps
 * running so later dumps show growth.
 */
export async function dumpHeapSamplingProfile(args: {
  dir?: string;
  rssMb: number;
  /** Retain at most this many `.heapprofile` files (oldest pruned). Default 50.
   *  WI-4189: unbounded before this — 1300+ files / 854MB accumulated on a host
   *  that sustained critical p95 lag for hours (one dump per rate-limit gap). */
  maxProfiles?: number;
  log: (line: string, detail?: Record<string, number | string>) => void;
}): Promise<string | null> {
  const { rssMb, log, maxProfiles = 50 } = args;
  if (!_samplingSession) return null;
  try {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const dir = args.dir ?? path.join(os.homedir(), '.papercusp', 'heap-snapshots');
    await fs.mkdir(dir, { recursive: true });
    const profile = await new Promise<{ head: SamplingNode }>((resolve, reject) => {
      _samplingSession!.post('HeapProfiler.getSamplingProfile', (err, r) =>
        err ? reject(err) : resolve((r as { profile: { head: SamplingNode } }).profile),
      );
    });
    const file = path.join(dir, `heap-sampling-${Date.now()}-pid${process.pid}-rss_${Math.round(rssMb)}mb.heapprofile`);
    await fs.writeFile(file, JSON.stringify(profile));
    const top = topAllocationSites(profile.head);
    log('[heap-sampling] profile dumped on high RSS — top live allocation sites:', { rssMb: Math.round(rssMb), file });
    for (const t of top) log(`[heap-sampling]   ${t.mb} MB  ${t.site}`);

    // Prune to maxProfiles oldest-first to bound disk use (WI-4189 — this was
    // the missing counterpart to captureHeapSnapshot's own pruning below;
    // .heapprofile files had no retention at all before this).
    try {
      const entries = (await fs.readdir(dir))
        .filter((f) => f.endsWith('.heapprofile'))
        .sort();
      const excess = entries.length - maxProfiles;
      for (let i = 0; i < excess; i++) {
        await fs.rm(path.join(dir, entries[i]), { force: true }).catch(() => {});
      }
    } catch {
      /* prune is best-effort */
    }
    return file;
  } catch (e) {
    log(`[heap-sampling] dump failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
