import { describe, expect, it } from 'vitest';
import { canTransitionSessionPort, type SessionPortStatus } from './store';

describe('session-port lifecycle', () => {
  it('allows only prepared -> pending -> delivered/failed and terminal idempotence', () => {
    const allowed: Array<[SessionPortStatus, SessionPortStatus]> = [
      ['prepared', 'pending'],
      ['prepared', 'failed'],
      ['prepared', 'expired'],
      ['pending', 'delivered'],
      ['pending', 'failed'],
      ['pending', 'expired'],
      ['delivered', 'delivered'],
      ['expired', 'expired'],
    ];
    for (const pair of allowed) expect(canTransitionSessionPort(...pair)).toBe(true);
    expect(canTransitionSessionPort('prepared', 'delivered')).toBe(false);
    expect(canTransitionSessionPort('delivered', 'pending')).toBe(false);
    expect(canTransitionSessionPort('failed', 'prepared')).toBe(false);
  });
});
