import type { Sql } from 'postgres';

/** Interactive transcript ingestion runs every 10 minutes; three missed passes
 *  make a spend reading too old to use as a control. */
export const INTERACTIVE_USAGE_FRESHNESS_WINDOW_MS = 30 * 60_000;

export type InteractiveUsageUnmeasuredReason = 'interactive-usage-stale' | 'interactive-usage-unavailable';

export interface InteractiveUsageFreshness {
  status: 'fresh' | 'stale' | 'unavailable';
  /** Unix milliseconds from agent_usage_samples.ingested_at, not source event ts. */
  lastIngestedAtMs: number | null;
  ageMs: number | null;
  windowMs: number;
  reason: string;
}

export function isInteractiveUsageUnmeasuredReason(
  reason: unknown,
): reason is InteractiveUsageUnmeasuredReason {
  return reason === 'interactive-usage-stale' || reason === 'interactive-usage-unavailable';
}

/** Compare the most recent ingestion stamp with the shared recent window. */
export function evaluateInteractiveUsageFreshness(
  latestIngestedAt: unknown,
  nowMs: number = Date.now(),
  windowMs: number = INTERACTIVE_USAGE_FRESHNESS_WINDOW_MS,
): InteractiveUsageFreshness {
  const unavailable = (reason: string, lastIngestedAtMs: number | null = null): InteractiveUsageFreshness => ({
    status: 'unavailable', lastIngestedAtMs, ageMs: null, windowMs, reason,
  });
  if (!Number.isFinite(nowMs) || !Number.isFinite(windowMs) || windowMs <= 0) {
    return unavailable('freshness clock or window is invalid');
  }
  if (latestIngestedAt == null) {
    return unavailable('no source=interactive usage samples are available to establish freshness');
  }
  const lastIngestedAtMs = typeof latestIngestedAt === 'number' ? latestIngestedAt : Number(latestIngestedAt);
  if (!Number.isFinite(lastIngestedAtMs) || lastIngestedAtMs < 0) {
    return unavailable('latest interactive usage ingested_at is invalid');
  }
  // Future timestamps can result from small clock skew and are not evidence of
  // stale usage. Clamp their age to zero while retaining the measured stamp.
  const ageMs = Math.max(0, nowMs - lastIngestedAtMs);
  if (ageMs > windowMs) {
    return {
      status: 'stale', lastIngestedAtMs, ageMs, windowMs,
      reason: `newest interactive usage sample was ingested ${ageMs} ms ago, outside the ${windowMs} ms freshness window`,
    };
  }
  return {
    status: 'fresh', lastIngestedAtMs, ageMs, windowMs,
    reason: `newest interactive usage sample was ingested ${ageMs} ms ago, within the ${windowMs} ms freshness window`,
  };
}

/** Read the source-wide ingestion watermark. Failure is data: callers must
 *  treat spend as unmeasured instead of reusing an older numeric floor. */
export async function readInteractiveUsageFreshness(
  sql: Sql,
  opts: { workspaceId: string; nowMs?: number; windowMs?: number },
): Promise<InteractiveUsageFreshness> {
  const nowMs = opts.nowMs ?? Date.now();
  const windowMs = opts.windowMs ?? INTERACTIVE_USAGE_FRESHNESS_WINDOW_MS;
  try {
    const rows = await sql<Array<{ latest_ingested_at: string | number | null }>>`
      SELECT MAX(ingested_at) AS latest_ingested_at
        FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${opts.workspaceId}
         AND source = 'interactive'
    `;
    return evaluateInteractiveUsageFreshness(rows[0]?.latest_ingested_at, nowMs, windowMs);
  } catch (error) {
    return {
      status: 'unavailable', lastIngestedAtMs: null, ageMs: null, windowMs,
      reason: `interactive usage freshness read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
