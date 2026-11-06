import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { profile as beginProfile, profileEnd as endProfile } from 'node:console';

/** The lag monitor owns this recorder and its existing tick owns rotation.
 * Keeping one console recording alive retains V8's code map between captures;
 * enabling an inspector Session alone does not. 100 Hz limits sampling work.
 * Rotation is a soft bound: JS cannot rotate during a main-thread stall. An
 * overdue tick discards the old session instead of serializing its recordings.
 * There is deliberately no claim of a hard memory bound during such a stall.
 */
export const LOOP_CPU_SAMPLING_INTERVAL_US = 10_000;

interface ProfileSession {
  connect(): void;
  disconnect(): void;
  post(method: string, params?: Record<string, number>): Promise<unknown>;
  on(event: 'Profiler.consoleProfileFinished', listener: (event: {
    params: { title: string; profile: unknown };
  }) => void): unknown;
}

interface ThreadCpuUsage {
  user: number;
  system: number;
}

interface RecorderDeps {
  session(): Promise<ProfileSession>;
  begin(name: string): void;
  end(name: string): void;
  now(): number;
  threadCpuUsage?(previous?: ThreadCpuUsage): ThreadCpuUsage | undefined;
}

export interface CpuRecording {
  profile: unknown;
  samplingIntervalUs: number;
  startMs: number;
  stopMs: number;
  coverage?: 'pre-trigger' | 'post-trigger';
  windowStartMonoMs?: number;
  windowEndMonoMs?: number;
  /** Revocation also covers the asynchronous artifact write after sampling. */
  signal?: AbortSignal;
}

let nextRecorder = 0;

export class LoopCpuRecorder {
  private session: ProfileSession | null = null;
  private anchor: string | null = null;
  private rotatedAt = 0;
  private sequence = 0;
  private revision = 0;
  private initializing = false;
  private closed = false;
  private capture: AbortController | null = null;
  private lifetime: AbortController | null = null;
  private finishing: { name: string; start: number; end: number } | null = null;
  private preceding: CpuRecording | null = null;
  private readonly prefix = `papercusp-loop-${process.pid}-${++nextRecorder}-`;

  constructor(
    private readonly maxRotationGapMs: number,
    private readonly log: (line: string, detail: Record<string, number | string>) => void,
    private readonly deps: RecorderDeps = {
      session: async () => new (await import('node:inspector/promises')).Session(),
      begin: beginProfile,
      end: endProfile,
      now: () => performance.now(),
      threadCpuUsage: (previous) => process.threadCpuUsage?.(previous),
    },
  ) {}

  /** Fail closed on a disabled/failed gate or unsafe histogram. No timer here. */
  async update(enabled: boolean, safe: boolean): Promise<boolean> {
    if (this.closed || !enabled || !safe) {
      this.suspend();
      return false;
    }
    if (this.initializing) return false;
    if (this.session) {
      if (this.deps.now() - this.rotatedAt > this.maxRotationGapMs) {
        this.suspend();
        this.log('[event-loop-lag] CPU recorder discarded after delayed rotation', {
          maxRotationGapMs: this.maxRotationGapMs,
        });
        return false;
      }
      const before = this.deps.now();
      try {
        this.preceding = null;
        this.finishing = null;
        const next = this.prefix + ++this.sequence;
        // Start the successor FIRST: stopping the last recording destroys V8's
        // code map and makes the next capture pay the cold-start pause again.
        this.deps.begin(next);
        if (this.anchor) {
          this.finishing = { name: this.anchor, start: this.rotatedAt, end: this.deps.now() };
          this.deps.end(this.anchor);
        }
        this.anchor = next;
        this.rotatedAt = this.deps.now();
        const rotationMs = this.rotatedAt - before;
        if (rotationMs >= 20) this.log('[event-loop-lag] CPU recorder observer cost', { rotationMs });
        return true;
      } catch {
        this.suspend();
        return false;
      }
    }
    this.initializing = true;
    const revision = this.revision;
    const before = this.deps.now();
    const threadCpuBefore = this.readThreadCpuUsage();
    let session: ProfileSession | undefined;
    try {
      session = await this.deps.session();
      if (this.closed || revision !== this.revision) return false;
      session.connect();
      this.session = session;
      const lifetime = new AbortController();
      this.lifetime = lifetime;
      const connected = session;
      session.on('Profiler.consoleProfileFinished', ({ params }) => {
        const window = this.finishing;
        if (this.session !== connected || !window || params.title !== window.name) return;
        this.finishing = null;
        // Keep only the just-completed, bounded window. A notification arriving
        // after revocation or another rotation cannot resurrect an old profile.
        if (this.deps.now() - window.start > this.maxRotationGapMs) return;
        this.preceding = {
          profile: params.profile, samplingIntervalUs: LOOP_CPU_SAMPLING_INTERVAL_US,
          startMs: 0, stopMs: 0, coverage: 'pre-trigger',
          windowStartMonoMs: window.start, windowEndMonoMs: window.end,
          signal: lifetime.signal,
        };
      });
      await session.post('Profiler.enable');
      if (this.session !== session) return false;
      await session.post('Profiler.setSamplingInterval', { interval: LOOP_CPU_SAMPLING_INTERVAL_US });
      if (this.session !== session) return false;
      this.anchor = this.prefix + ++this.sequence;
      this.deps.begin(this.anchor);
      this.rotatedAt = this.deps.now();
      const threadCpu = threadCpuBefore && this.readThreadCpuUsage(threadCpuBefore);
      this.log('[event-loop-lag] CPU recorder observer cost', {
        warmupMs: this.rotatedAt - before,
        ...(threadCpu ? {
          warmupMainThreadUserCpuUs: threadCpu.user,
          warmupMainThreadSystemCpuUs: threadCpu.system,
        } : {}),
        samplingIntervalUs: LOOP_CPU_SAMPLING_INTERVAL_US,
      });
      return true;
    } catch {
      this.suspend();
      return false;
    } finally {
      this.initializing = false;
      if (session && this.session !== session) {
        try { session.disconnect(); } catch { /* best effort */ }
      }
    }
  }

  /** The monitor rotates before capture: use that preceding window once, when
   * available. A fresh foreground profile is explicitly labelled post-trigger. */
  async recordTriggered(durationMs: number, signal?: AbortSignal): Promise<CpuRecording> {
    signal?.throwIfAborted();
    if (!this.session || !this.anchor || this.closed || this.capture) throw new Error('CPU recorder unavailable');
    const preceding = this.preceding;
    this.preceding = null;
    if (preceding && this.deps.now() - preceding.windowStartMonoMs! <= this.maxRotationGapMs) return preceding;
    return this.record(durationMs, signal);
  }

  async record(durationMs: number, signal?: AbortSignal): Promise<CpuRecording> {
    signal?.throwIfAborted();
    const session = this.session;
    const lifetime = this.lifetime;
    if (!session || !lifetime || !this.anchor || this.closed || this.capture) throw new Error('CPU recorder unavailable');
    const capture = new AbortController();
    this.capture = capture;
    const abort = () => capture.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let recording = false;
    try {
      const before = this.deps.now();
      await session.post('Profiler.start');
      recording = true;
      const startMs = this.deps.now() - before;
      const windowStartMonoMs = this.deps.now();
      if (this.session !== session) throw new Error('CPU recorder revoked');
      await delay(durationMs, undefined, { signal: capture.signal });
      const stopAt = this.deps.now();
      const { profile } = await session.post('Profiler.stop') as { profile: unknown };
      recording = false;
      capture.signal.throwIfAborted();
      if (this.session !== session) throw new Error('CPU recorder revoked');
      return { profile, startMs, stopMs: this.deps.now() - stopAt, samplingIntervalUs: LOOP_CPU_SAMPLING_INTERVAL_US,
        coverage: 'post-trigger', windowStartMonoMs, windowEndMonoMs: stopAt, signal: lifetime.signal };
    } finally {
      signal?.removeEventListener('abort', abort);
      if (recording && this.session === session) {
        try { await session.post('Profiler.stop'); } catch { this.suspend(); }
      }
      if (this.capture === capture) this.capture = null;
    }
  }

  private suspend(): void {
    this.revision++;
    this.capture?.abort();
    this.lifetime?.abort();
    this.lifetime = null;
    this.anchor = null;
    this.finishing = null;
    this.preceding = null;
    const session = this.session;
    this.session = null;
    // Disconnect discards native recordings. Do not console.profileEnd here:
    // that would materialize an arbitrarily delayed anchor just to throw it away.
    try { session?.disconnect(); } catch { /* best effort */ }
  }

  private readThreadCpuUsage(previous?: ThreadCpuUsage): ThreadCpuUsage | undefined {
    try { return this.deps.threadCpuUsage?.(previous); } catch { return undefined; }
  }

  stop(): void {
    this.closed = true;
    this.suspend();
  }
}
