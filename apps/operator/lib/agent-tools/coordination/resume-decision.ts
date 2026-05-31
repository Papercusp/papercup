import { SID_HEARTBEAT_TTL_MS } from './identity';

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
	lastSeenAt: Date | null;
	now?: Date;
	ttlMs?: number;
}): ResumeDecision {
	const { lastSeenAt } = input;
	if (!lastSeenAt) {
		return { action: 'relaunch', reason: 'no-heartbeat' };
	}
	const now = input.now ?? new Date();
	const ttlMs = input.ttlMs ?? SID_HEARTBEAT_TTL_MS;
	const age = now.getTime() - lastSeenAt.getTime();
	if (age > ttlMs) {
		return { action: 'relaunch', reason: 'stale-heartbeat' };
	}
	return { action: 'reattach', reason: 'process-alive' };
}

export const __RESUME_DECISION_MODULE__ = true;
