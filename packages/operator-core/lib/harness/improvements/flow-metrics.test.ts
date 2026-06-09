/**
 * Flow-metric computation (learning-system-audit-improvements-2026-06-09 P-041)
 * — pure over injected candidate + watchdog-tick rows, no PG. The Learning tab's
 * flow strip ("captured vs resolved 7d", median open age, watchdog liveness)
 * renders exactly these numbers, so window edges + the resolved-time
 * approximation (updated_at on state ∈ resolved/closed) are pinned here.
 */
import { describe, it, expect } from 'vitest';
import { computeImprovementFlow, type WatchdogFlowTick } from './flow-metrics';
import type { ImprovementCandidate } from './policy';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-09T12:00:00Z');

function cand(p: Partial<ImprovementCandidate> & { id: string }): ImprovementCandidate {
  return { kind: 'bug', scope: 'operator', title: `t ${p.id}`, state: 'open', ...p };
}
const daysAgo = (d: number): string => new Date(NOW - d * DAY_MS).toISOString();
const tick = (d: number, captured = 0): WatchdogFlowTick => ({ tickAtMs: NOW - d * DAY_MS, capturedCount: captured });

describe('computeImprovementFlow — captured/resolved 7d windows', () => {
  it('counts creates inside the trailing 7 days; older ones fall out', () => {
    const flow = computeImprovementFlow(
      [
        cand({ id: 'a', createdAt: daysAgo(0.5) }),
        cand({ id: 'b', createdAt: daysAgo(6.9) }),
        cand({ id: 'c', createdAt: daysAgo(7.1) }), // outside the window
        cand({ id: 'd' }), // no createdAt → uncounted
      ],
      [],
      { nowMs: NOW },
    );
    expect(flow.captured7d).toBe(2);
  });

  it('counts resolved/closed transitions by updatedAt (the resolution-time approximation)', () => {
    const flow = computeImprovementFlow(
      [
        cand({ id: 'a', state: 'resolved', createdAt: daysAgo(20), updatedAt: daysAgo(1) }),
        cand({ id: 'b', state: 'closed', createdAt: daysAgo(30), updatedAt: daysAgo(3) }),
        cand({ id: 'c', state: 'resolved', createdAt: daysAgo(30), updatedAt: daysAgo(10) }), // resolved too long ago
        cand({ id: 'd', state: 'open', createdAt: daysAgo(1), updatedAt: daysAgo(0.1) }), // open never counts as out-flow
      ],
      [],
      { nowMs: NOW },
    );
    expect(flow.resolved7d).toBe(2);
    // a + d created in-window? a=20d ago no, d=1d ago yes → captured7d = 1
    expect(flow.captured7d).toBe(1);
    expect(flow.net7d).toBe(1 - 2);
  });

  it('net7d is captured − resolved (positive = backlog grew)', () => {
    const flow = computeImprovementFlow(
      [
        cand({ id: 'a', createdAt: daysAgo(1) }),
        cand({ id: 'b', createdAt: daysAgo(2) }),
        cand({ id: 'c', state: 'resolved', createdAt: daysAgo(9), updatedAt: daysAgo(2) }),
      ],
      [],
      { nowMs: NOW },
    );
    expect(flow).toMatchObject({ captured7d: 2, resolved7d: 1, net7d: 1 });
  });
});

describe('computeImprovementFlow — median open age', () => {
  it('takes the median over OPEN items only (odd count)', () => {
    const flow = computeImprovementFlow(
      [
        cand({ id: 'a', createdAt: daysAgo(2) }),
        cand({ id: 'b', createdAt: daysAgo(10) }),
        cand({ id: 'c', createdAt: daysAgo(40) }),
        cand({ id: 'r', state: 'resolved', createdAt: daysAgo(100), updatedAt: daysAgo(90) }), // excluded
      ],
      [],
      { nowMs: NOW },
    );
    expect(flow.medianOpenAgeDays).toBe(10);
  });

  it('averages the middle pair for an even count, at 0.1-day precision', () => {
    const flow = computeImprovementFlow(
      [cand({ id: 'a', createdAt: daysAgo(2) }), cand({ id: 'b', createdAt: daysAgo(5) })],
      [],
      { nowMs: NOW },
    );
    expect(flow.medianOpenAgeDays).toBe(3.5);
  });

  it('is null when nothing is open', () => {
    const flow = computeImprovementFlow(
      [cand({ id: 'r', state: 'closed', createdAt: daysAgo(3), updatedAt: daysAgo(1) })],
      [],
      { nowMs: NOW },
    );
    expect(flow.medianOpenAgeDays).toBeNull();
  });
});

describe('computeImprovementFlow — watchdog liveness rollup', () => {
  it('reports the newest tick + counts/captures inside 24h', () => {
    const flow = computeImprovementFlow(
      [],
      [tick(0.01, 2), tick(0.5, 1), tick(0.9, 0), tick(1.5, 5)], // last one outside 24h
      { nowMs: NOW },
    );
    expect(flow.watchdog.lastTickAt).toBe(new Date(NOW - 0.01 * DAY_MS).toISOString());
    expect(flow.watchdog.ticks24h).toBe(3);
    expect(flow.watchdog.captured24h).toBe(3);
  });

  it('keeps the last tick even when it is older than 24h (ticks24h = 0)', () => {
    const flow = computeImprovementFlow([], [tick(3, 1)], { nowMs: NOW });
    expect(flow.watchdog.lastTickAt).toBe(new Date(NOW - 3 * DAY_MS).toISOString());
    expect(flow.watchdog.ticks24h).toBe(0);
    expect(flow.watchdog.captured24h).toBe(0);
  });

  it('is null/zero when the watchdog never ticked', () => {
    const flow = computeImprovementFlow([], [], { nowMs: NOW });
    expect(flow.watchdog).toEqual({ lastTickAt: null, ticks24h: 0, captured24h: 0 });
  });
});

describe('computeImprovementFlow — recurrence pass-through (reused from the digest, never re-derived)', () => {
  it('carries the injected digest count', () => {
    const flow = computeImprovementFlow([], [], { nowMs: NOW, recurringSignatureCount: 4 });
    expect(flow.recurringSignatureCount).toBe(4);
  });
  it('defaults to 0', () => {
    expect(computeImprovementFlow([], [], { nowMs: NOW }).recurringSignatureCount).toBe(0);
  });
});
