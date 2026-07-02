/** queen-warm-session (L2b) — the pure rebirth decider. */
import { describe, expect, it } from 'vitest';
import { decideQueenWakeMode, QUEEN_SESSION_MAX_AGE_MS } from './queen-warm-session';

const base = {
  sessionBootId: 'boot-a',
  currentBootId: 'boot-a',
  sessionStartedMs: 1_000_000,
  nowMs: 2_000_000,
};

describe('decideQueenWakeMode', () => {
  it('warm when the session is healthy, fresh, and same boot', () => {
    expect(decideQueenWakeMode(base).mode).toBe('warm');
  });

  it('cold when nothing resumable is recorded', () => {
    expect(decideQueenWakeMode({ ...base, sessionBootId: null }).mode).toBe('cold');
    expect(decideQueenWakeMode({ ...base, sessionStartedMs: null }).mode).toBe('cold');
  });

  it('rebirth on boot-id change (the world restarted under the session)', () => {
    const d = decideQueenWakeMode({ ...base, currentBootId: 'boot-b' });
    expect(d.mode).toBe('rebirth');
    expect(d.reason).toContain('boot-id changed');
  });

  it('rebirth at the 24h scheduled boundary', () => {
    const d = decideQueenWakeMode({ ...base, nowMs: base.sessionStartedMs + QUEEN_SESSION_MAX_AGE_MS });
    expect(d.mode).toBe('rebirth');
    expect(d.reason).toContain('24h');
  });

  it('rebirth on anomaly signals — never resume into a struggling session', () => {
    expect(decideQueenWakeMode({ ...base, consecutiveErrors: 2 }).mode).toBe('rebirth');
    expect(decideQueenWakeMode({ ...base, scorecardUnhealthy: true }).mode).toBe('rebirth');
  });
});
