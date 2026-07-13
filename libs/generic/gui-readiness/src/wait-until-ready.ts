import type { LivenessProbe, ReadinessOutcome, ReadinessProbe, WaitOptions } from './types.js';

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

function realNow(): number {
  return Date.now();
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Race a probe call against its own bound so ONE wedged/never-resolving call
 * cannot silently consume (or blow past) the overall wait budget. A timeout is
 * treated as `false` ("not ready/not confirmed alive this round") rather than
 * an error — the caller's next poll (still governed by the OUTER deadline) tries
 * again.
 */
async function boundedProbe(call: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([call().catch(() => false), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Wait for `probe.checkReady()` to report ready, bounded by `options.timeoutMs`.
 *
 * LEVEL-triggered by construction: the very first check happens immediately (no
 * initial poll delay), so a persistent process that was ALREADY ready before this
 * call started returns instantly instead of waiting for a poll interval or — the
 * bug class this exists to prevent — an edge-triggered signal that already fired
 * in the past and will never fire again. Every subsequent check is likewise a
 * fresh read of current state, never a wait on a one-shot event.
 *
 * Bounded by construction on every axis: the overall wait never exceeds
 * `timeoutMs`; each individual probe/liveness call never exceeds `probeTimeoutMs`
 * (so one wedged call can't eat the whole budget); and a dead process (per
 * `liveness.isAlive()`) fails fast with `reason: 'process_exited'` instead of
 * waiting out the remaining deadline for a readiness signal that can no longer
 * arrive.
 */
export async function waitUntilReady(
  probe: ReadinessProbe,
  liveness: LivenessProbe | undefined,
  options: WaitOptions,
): Promise<ReadinessOutcome> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    throw new Error(`waitUntilReady: timeoutMs must be a non-negative finite number, got ${options.timeoutMs}`);
  }
  const now = options.now ?? realNow;
  const sleep = options.sleep ?? realSleep;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const probeTimeoutMs = Math.min(options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, Math.max(options.timeoutMs, 1));

  const start = now();
  const deadline = start + options.timeoutMs;

  for (;;) {
    if (liveness) {
      const alive = await boundedProbe(() => liveness.isAlive(), probeTimeoutMs);
      if (!alive) {
        return { ok: false, ready: false, elapsedMs: now() - start, reason: 'process_exited' };
      }
    }

    const ready = await boundedProbe(() => probe.checkReady(), probeTimeoutMs);
    if (ready) {
      return { ok: true, ready: true, elapsedMs: now() - start };
    }

    if (now() >= deadline) {
      return { ok: false, ready: false, elapsedMs: now() - start, reason: 'timeout' };
    }

    const remaining = deadline - now();
    await sleep(Math.max(0, Math.min(pollIntervalMs, remaining)));

    if (now() >= deadline) {
      return { ok: false, ready: false, elapsedMs: now() - start, reason: 'timeout' };
    }
  }
}
