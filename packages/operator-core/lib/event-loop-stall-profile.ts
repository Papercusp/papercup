/**
 * event-loop-stall-profile.ts — the PURE half of the sentinel's in-stall CPU
 * profile (WI-10004766, WI-10003454).
 *
 * The event-loop sentinel already says WHAT KIND of stall it saw: `spinning`
 * (the main thread burns CPU), `parked` (blocked in a syscall, with `wchan`,
 * the blocked directory and live children naming the wait). For a spinning
 * stall it could not say WHICH CODE was spinning. Every R-state stall on :3170
 * and the bg-host therefore ended as "cause unknown": the lag monitor's own
 * profiler runs on the main thread and cannot start during the stall it would
 * need to see.
 *
 * The sentinel worker can. Measured 2026-10-01 (node 25.9): an inspector
 * Session opened in a worker with `connectToMainThread()` gets `Profiler.start`
 * serviced 95-183 ms after asking, WHILE the main thread is blocked, because V8
 * dispatches inspector messages through interrupts. Measured for a named JS spin
 * in a timer callback, an 18 s catastrophic regex, and a JSON.stringify loop;
 * the hot frame was named in all three.
 *
 * This file holds the decisions the worker makes, so they are tested without a
 * worker: WHEN to capture, and how to turn a `.cpuprofile` into a few readable
 * hot stacks for the journal line (the file itself can be pruned later; the
 * journal line survives).
 *
 * Plain, erasable TypeScript with no imports: the worker loads this through
 * Node's native type stripping (see `worker-entry-plain-node-loadable.test.ts`).
 */

/** The CPU verdict the worker already computes (`proc-thread-cpu.ts`). */
export type StallCpuKind = 'spinning' | 'parked' | 'partial' | 'unknown';

export interface StallProfileConfig {
  /** Directory for `stall-*.cpuprofile` artifacts. */
  dir: string;
  /** Start a capture once the heartbeat has been stale this long. */
  afterMs: number;
  /** Sampling window. Short, so it ends inside the stall it is describing. */
  captureMs: number;
  /** At most one capture per process per this window. */
  cooldownMs: number;
  /** Retention: newest N artifacts are kept. */
  maxProfiles: number;
}

/**
 * Defaults.
 *
 * - `afterMs` 4 s: the sentinel observes every 2 s and warns at 10 s, so the
 *   first observation past 4 s lands at 4-6 s. A capture started there finishes
 *   by ~8.5 s, inside the stalls this targets: :3170's R-state stalls are logged
 *   at 10 s and end before the 20 s kill. Normal loop lag here peaks ~3.5 s
 *   (SENTINEL_DEFAULTS), so 4 s of a stale heartbeat is already abnormal.
 * - `captureMs` 2.5 s: ~2,500 samples at V8's default 1 ms interval, plenty to
 *   rank a spin.
 * - `cooldownMs` 10 min: a host stalling every few minutes gets one profile per
 *   10 min, not a profiler running all the time.
 * - `maxProfiles` 20: ~100-200 KB each.
 */
export const STALL_PROFILE_DEFAULTS = {
  afterMs: 4_000,
  captureMs: 2_500,
  cooldownMs: 10 * 60_000,
  maxProfiles: 20,
} as const;

export interface StallCaptureInput {
  stalenessMs: number;
  cpuKind: StallCpuKind;
  /** A capture already ran during THIS contiguous stall. */
  capturedThisStall: boolean;
  inFlight: boolean;
  lastCaptureAtMs: number | null;
  nowMs: number;
}

/**
 * Capture only a stall the existing evidence cannot explain: a thread that is
 * burning CPU (`spinning`, or `partial` when the sample straddles the stall's
 * start). A `parked` thread is blocked in a syscall, where the inspector
 * interrupt is not serviced until the syscall returns, and the worker already
 * names the wait. `unknown` means no CPU baseline, so the kind cannot be
 * trusted either way.
 */
export function shouldCaptureStallProfile(
  input: StallCaptureInput,
  cfg: Pick<StallProfileConfig, 'afterMs' | 'cooldownMs'>,
): boolean {
  if (input.inFlight || input.capturedThisStall) return false;
  if (!(input.stalenessMs >= cfg.afterMs)) return false;
  if (input.cpuKind !== 'spinning' && input.cpuKind !== 'partial') return false;
  if (input.lastCaptureAtMs != null && input.nowMs - input.lastCaptureAtMs < cfg.cooldownMs) {
    return false;
  }
  return true;
}

/** The subset of the DevTools `.cpuprofile` shape this file reads. */
export interface CpuProfileLike {
  nodes: Array<{
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number; columnNumber?: number };
    children?: number[];
    /** Per-line self ticks inside this function (1-based lines, DevTools protocol). */
    positionTicks?: Array<{ line: number; ticks: number }>;
  }>;
  samples?: number[];
}

export interface HotStack {
  /** Samples whose stack (truncated to `depth`) reads exactly like `stack`. */
  count: number;
  /** Share of all samples, 0-100, one decimal. */
  pct: number;
  /** Leaf first: `fn@file:line:col < caller@file:line:col < …`. */
  stack: string;
}

export interface HotStackSummary {
  samples: number;
  hot: HotStack[];
}

/** `file:///a/b/hono-host.mjs` → `hono-host.mjs`; '' for a native frame. */
function frameFile(url: string): string {
  if (!url) return '';
  const cut = url.split(/[?#]/)[0];
  const parts = cut.split('/');
  return parts[parts.length - 1] || cut;
}

/** One frame, 1-based line:col as editors show them (cpuprofile is 0-based). */
export function formatFrame(callFrame: CpuProfileLike['nodes'][number]['callFrame']): string {
  const name = callFrame.functionName || '(anonymous)';
  const file = frameFile(callFrame.url);
  if (!file) return name;
  const line = callFrame.lineNumber >= 0 ? `:${callFrame.lineNumber + 1}` : '';
  const col =
    line && callFrame.columnNumber != null && callFrame.columnNumber >= 0
      ? `:${callFrame.columnNumber + 1}`
      : '';
  return `${name}@${file}${line}${col}`;
}

function hottestLine(ticks: Array<{ line: number; ticks: number }> | undefined): number | null {
  if (!Array.isArray(ticks) || ticks.length === 0) return null;
  let best: { line: number; ticks: number } | null = null;
  for (const t of ticks) {
    if (typeof t?.line !== 'number' || typeof t?.ticks !== 'number') continue;
    if (!best || t.ticks > best.ticks) best = t;
  }
  return best ? best.line : null;
}

/**
 * Rank the stacks the main thread spent its samples in.
 *
 * Self-time per leaf node, then the leaf's ancestor chain (leaf first, up to
 * `depth` frames, the synthetic `(root)` dropped). Stacks that read the same
 * after truncation are merged, so two native leaves under one JS caller (say
 * `now` and `sqrt` inside the same loop) rank as one stack once `depth` cuts
 * above them. Never throws on a malformed profile: a diagnostic must not take
 * down the sentinel, so a shape it cannot read yields zero samples.
 */
export function summarizeHotStacks(
  profile: CpuProfileLike,
  opts: { top?: number; depth?: number } = {},
): HotStackSummary {
  const top = opts.top ?? 3;
  const depth = opts.depth ?? 6;
  const samples = Array.isArray(profile?.samples) ? profile.samples : [];
  const nodes = Array.isArray(profile?.nodes) ? profile.nodes : [];
  if (samples.length === 0 || nodes.length === 0) return { samples: 0, hot: [] };

  const byId = new Map<number, CpuProfileLike['nodes'][number]>();
  const parentOf = new Map<number, number>();
  for (const node of nodes) {
    byId.set(node.id, node);
    for (const child of node.children ?? []) parentOf.set(child, node.id);
  }

  const selfCount = new Map<number, number>();
  for (const id of samples) selfCount.set(id, (selfCount.get(id) ?? 0) + 1);

  const byStack = new Map<string, number>();
  for (const [leafId, count] of selfCount) {
    const frames: string[] = [];
    let cur: number | undefined = leafId;
    // `seen` bounds a corrupt cyclic parent map; real profiles are trees.
    const seen = new Set<number>();
    while (cur != null && frames.length < depth && !seen.has(cur)) {
      seen.add(cur);
      const node = byId.get(cur);
      if (!node) break;
      if (node.callFrame.functionName !== '(root)') {
        // The leaf's hottest LINE. A callee V8 inlined has no node of its own
        // (measured: the probe's spin function vanished into its caller), so
        // the function's start line alone would not say where the time went.
        const hot = frames.length === 0 ? hottestLine(node.positionTicks) : null;
        frames.push(formatFrame(node.callFrame) + (hot != null ? `#L${hot}` : ''));
      }
      cur = parentOf.get(cur);
    }
    const key = frames.length ? frames.join(' < ') : '(unknown)';
    byStack.set(key, (byStack.get(key) ?? 0) + count);
  }

  const total = samples.length;
  const hot = [...byStack.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, top)
    .map(([stack, count]) => ({
      count,
      pct: Math.round((count / total) * 1000) / 10,
      stack,
    }));
  return { samples: total, hot };
}

/**
 * The journal fields for a summary: `hot1`..`hotN` as
 * `"63.1% (708) fn@file:1:2 < caller@…"`, each clipped so one profile line
 * stays readable in `journalctl`.
 */
export function hotStackFields(
  summary: HotStackSummary,
  maxChars = 400,
): Record<string, string | number> {
  const out: Record<string, string | number> = { samples: summary.samples };
  summary.hot.forEach((h, i) => {
    const text = `${h.pct}% (${h.count}) ${h.stack}`;
    out[`hot${i + 1}`] = text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
  });
  return out;
}
