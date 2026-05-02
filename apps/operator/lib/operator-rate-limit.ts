/**
 * Per-workspace rate limit + 503 circuit breaker (Phase 3e/3f of the v5
 * operator plan).
 *
 * In-process state — server-side dedup across browser tabs is handled by
 * the scan-lock; this module is the policy layer for *background* scans
 * (manual rescans bypass per §4 decision 3).
 *
 * Defaults:
 *   - 2 background scans / min / workspace
 *   - 5 consecutive PG 503s → pause for 10 min
 */

const RATE_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT = 2;
const BREAKER_FAIL_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 10 * 60_000;

interface WorkspaceRate {
  recent: number[]; // ms timestamps
  consecutive503: number;
  breakerUntilMs: number;
}

const state = new Map<string, WorkspaceRate>();

function get(workspaceId: string): WorkspaceRate {
  let s = state.get(workspaceId);
  if (!s) {
    s = { recent: [], consecutive503: 0, breakerUntilMs: 0 };
    state.set(workspaceId, s);
  }
  return s;
}

export interface RateCheck {
  allowed: boolean;
  reason?: 'rate-limit' | 'circuit-breaker';
  retryAfterSec?: number;
}

/** Check whether a *background* scan can proceed. Manual scans skip this. */
export function checkRate(workspaceId: string, limit = DEFAULT_RATE_LIMIT): RateCheck {
  const s = get(workspaceId);
  const now = Date.now();
  if (s.breakerUntilMs > now) {
    return {
      allowed: false,
      reason: 'circuit-breaker',
      retryAfterSec: Math.ceil((s.breakerUntilMs - now) / 1000),
    };
  }
  s.recent = s.recent.filter((t) => now - t < RATE_WINDOW_MS);
  if (s.recent.length >= limit) {
    const oldest = s.recent[0];
    return {
      allowed: false,
      reason: 'rate-limit',
      retryAfterSec: Math.ceil((RATE_WINDOW_MS - (now - oldest)) / 1000),
    };
  }
  s.recent.push(now);
  return { allowed: true };
}

/** Note a 503 from a downstream dep (PG, claude-bridge). Trips the breaker on N consecutive. */
export function record503(workspaceId: string): void {
  const s = get(workspaceId);
  s.consecutive503++;
  if (s.consecutive503 >= BREAKER_FAIL_THRESHOLD) {
    s.breakerUntilMs = Date.now() + BREAKER_COOLDOWN_MS;
  }
}

/** Note a successful scan — resets the consecutive-503 counter. */
export function recordSuccess(workspaceId: string): void {
  const s = get(workspaceId);
  s.consecutive503 = 0;
}

/** Manual reset (used by /api/agent-mcp/operator-circuit-breaker for ops escapes). */
export function resetBreaker(workspaceId: string): void {
  const s = get(workspaceId);
  s.consecutive503 = 0;
  s.breakerUntilMs = 0;
}

export function inspectState(workspaceId: string): WorkspaceRate {
  return { ...get(workspaceId) };
}
