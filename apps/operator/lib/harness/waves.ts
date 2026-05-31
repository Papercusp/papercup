/**
 * Deterministic wave-advance helpers for the `## Promote` policy
 * (promote-policy-and-waves-2026-05-30, P-008).
 *
 * All pure — the autoloop/director evaluates these per started plan; there is no
 * LLM judgment in the wave control path. A wave advances when it DRAINS; a
 * failing/stuck wave BLOCKS (and is surfaced), it never silently advances.
 *
 * Status vocabulary (matches harness-readers.ts): terminal = passed | deprecated;
 * non-terminal = todo | failing | in_progress | validating | blocked.
 */

/** A feature in one of these is "done" for drain purposes. */
export const TERMINAL_STATUSES = new Set(['passed', 'deprecated']);
/** Work is actively happening that could resolve a failure (per harness-readers). */
export const IN_PROGRESS_STATUSES = new Set(['in_progress', 'validating']);

export interface WaveFeature {
  /** The promote wave this feature belongs to (consolidated.wave); null = un-waved. */
  wave?: string | null;
  status?: string | null;
  attempts?: number | null;
}

const inWave = (features: WaveFeature[], wave: string): WaveFeature[] =>
  features.filter((f) => (f.wave ?? null) === wave);

/**
 * A wave is DRAINED when every feature in it is terminal (passed/deprecated).
 * An empty wave is trivially drained. This is the deterministic advance condition.
 */
export function isWaveDrained(features: WaveFeature[], wave: string): boolean {
  return inWave(features, wave).every((f) => TERMINAL_STATUSES.has(f.status ?? ''));
}

/**
 * A wave is BLOCKED — can't drain, so surface it — when it has a failing feature
 * and nothing in progress to resolve it (the `not_stuck` condition: failing>0 &&
 * inProgress===0), OR any non-terminal feature has reached the attempt threshold.
 * A blocked wave is by definition not drained: it stalls the advance until a human
 * fixes or deprecates the offending feature.
 */
export function isWaveBlocked(features: WaveFeature[], wave: string, attemptThreshold = 3): boolean {
  const fs = inWave(features, wave);
  const failing = fs.filter((f) => f.status === 'failing').length;
  const inProgress = fs.filter((f) => IN_PROGRESS_STATUSES.has(f.status ?? '')).length;
  const overAttempts = fs.some(
    (f) => (f.attempts ?? 0) >= attemptThreshold && !TERMINAL_STATUSES.has(f.status ?? ''),
  );
  return (failing > 0 && inProgress === 0) || overAttempts;
}

/** Per-wave deterministic counts for progress display (filtered harness-readers). */
export interface WaveCounts {
  total: number;
  passed: number;
  failing: number;
  inProgress: number;
  blocked: number;
  deprecated: number;
}
export function waveCounts(features: WaveFeature[], wave: string): WaveCounts {
  const fs = inWave(features, wave);
  return {
    total: fs.length,
    passed: fs.filter((f) => f.status === 'passed').length,
    failing: fs.filter((f) => f.status === 'failing').length,
    inProgress: fs.filter((f) => IN_PROGRESS_STATUSES.has(f.status ?? '')).length,
    blocked: fs.filter((f) => f.status === 'blocked').length,
    deprecated: fs.filter((f) => f.status === 'deprecated').length,
  };
}

export interface PromoteWaveLike {
  id: string;
  blocked_by?: string;
}

/**
 * The next wave to promote given the policy's ordered waves + the plan's
 * `current_wave` cursor: the first wave when the cursor is null (nothing promoted
 * yet), the wave after the cursor otherwise, or null if the cursor is at the end
 * or names an unknown wave (don't guess). The caller gates the *advance* on
 * `isWaveDrained(cursor)` — this only computes topological order.
 */
export function nextWaveToPromote(
  waves: PromoteWaveLike[],
  currentWave: string | null,
): PromoteWaveLike | null {
  if (waves.length === 0) return null;
  if (currentWave == null) return waves[0];
  const idx = waves.findIndex((w) => w.id === currentWave);
  if (idx < 0) return null;
  return waves[idx + 1] ?? null;
}
