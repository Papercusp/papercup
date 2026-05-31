import { describe, it, expect } from 'vitest';
import { decideResume } from './resume-decision';
import { SID_HEARTBEAT_TTL_MS } from './identity';

/**
 * Pure decision tests for P-070 liveness-driven resume.
 *
 * Convention: the TTL boundary is inclusive — an age exactly equal to
 * ttlMs counts as still-alive (reattach). Only ages strictly greater
 * than ttlMs are treated as stale.
 */
describe('decideResume', () => {
	const now = new Date('2026-05-31T12:00:00.000Z');

	it('relaunches when there is no heartbeat (lastSeenAt null)', () => {
		const d = decideResume({ lastSeenAt: null, now, ttlMs: SID_HEARTBEAT_TTL_MS });
		expect(d.action).toBe('relaunch');
		expect(d.reason).toBe('no-heartbeat');
	});

	it('reattaches when the heartbeat is fresh (age < ttl)', () => {
		const lastSeenAt = new Date(now.getTime() - 1000);
		const d = decideResume({ lastSeenAt, now, ttlMs: SID_HEARTBEAT_TTL_MS });
		expect(d.action).toBe('reattach');
		expect(d.reason).toBe('process-alive');
	});

	it('reattaches at the exact TTL boundary (age == ttl, inclusive)', () => {
		const lastSeenAt = new Date(now.getTime() - SID_HEARTBEAT_TTL_MS);
		const d = decideResume({ lastSeenAt, now, ttlMs: SID_HEARTBEAT_TTL_MS });
		expect(d.action).toBe('reattach');
		expect(d.reason).toBe('process-alive');
	});

	it('relaunches when the heartbeat is stale (age > ttl)', () => {
		const lastSeenAt = new Date(now.getTime() - (SID_HEARTBEAT_TTL_MS + 1));
		const d = decideResume({ lastSeenAt, now, ttlMs: SID_HEARTBEAT_TTL_MS });
		expect(d.action).toBe('relaunch');
		expect(d.reason).toBe('stale-heartbeat');
	});

	it('treats a future-dated heartbeat (negative age) as alive', () => {
		const lastSeenAt = new Date(now.getTime() + 5000);
		const d = decideResume({ lastSeenAt, now, ttlMs: SID_HEARTBEAT_TTL_MS });
		expect(d.action).toBe('reattach');
		expect(d.reason).toBe('process-alive');
	});
});

export const __RESUME_DECISION_TEST__ = true;
