import { SID_HEARTBEAT_TTL_MS } from './heartbeat';

/**
 * Pure liveness decision for P-070 crash/restart resume.
 *
 * Given the last heartbeat time for a sid (or null), decide whether the
 * prior spawn is still alive (RE-ATTACH) or dead (RE-LAUNCH).
 *
 * Convention: the TTL boundary is inclusive — an age exactly equal to
 * ttlMs is treated as still-alive. Only ages strictly greater than ttlMs
 * are stale. A future-dated heartbeat (negative age) is treated as alive.
 */
export type ResumeAction = 'reattach' | 'relaunch';

export interface ResumeDecision {
	action: ResumeAction;
	reason: 'no-heartbeat' | 'process-alive' | 'stale-heartbeat';
}

export function decideResume(input: {
	/** Last heartbeat time. Accepts a Date or an ISO string (pg may return
	 *  TIMESTAMPTZ as either depending on the driver's parser config). */
	lastSeenAt: Date | string | null;
	now?: Date;
	ttlMs?: number;
}): ResumeDecision {
	const lastSeenMs = toMillis(input.lastSeenAt);
	if (lastSeenMs === null) {
		return { action: 'relaunch', reason: 'no-heartbeat' };
	}
	const now = input.now ?? new Date();
	const ttlMs = input.ttlMs ?? SID_HEARTBEAT_TTL_MS;
	const age = now.getTime() - lastSeenMs;
	if (age > ttlMs) {
		return { action: 'relaunch', reason: 'stale-heartbeat' };
	}
	return { action: 'reattach', reason: 'process-alive' };
}

/** Normalize a Date | ISO-string | null to epoch ms, or null if absent/invalid. */
function toMillis(v: Date | string | null | undefined): number | null {
	if (v == null) return null;
	const ms = v instanceof Date ? v.getTime() : new Date(v).getTime();
	return Number.isNaN(ms) ? null : ms;
}

export const __RESUME_DECISION_MODULE__ = true;
