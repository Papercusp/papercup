/**
 * own-log-fork-guard.test.ts — P-003 (WI-3535).
 *
 * The edge-triggered latch that makes a writable own-log's Hypercore
 * equivocation loop ("[hypercore] conflict detected" → SESSION_CLOSED)
 * VISIBLE instead of failing silently: the registry latch, the read-time
 * state view, `attachOwnLogForkListener`'s feature-detected wiring, and the
 * health-verdict input it feeds (mirrors replication-liveness.test.ts's
 * combined detector + health-verdict pattern).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  reportOwnLogForkConflict,
  getOwnLogForkState,
  clearOwnLogForkState,
  attachOwnLogForkListener,
  setOwnLogForkEpisodeReporterForTests,
  _resetOwnLogForkGuardForTests,
  type OwnLogForkEpisode,
} from '../own-log-fork-guard';
import { assessHarnessSubstrateHealth } from '../health';

const WS = 'ws-1';
const HS = 'harness-a';
const KEY = 'a'.repeat(64);
const KEY2 = 'b'.repeat(64);

afterEach(() => {
  _resetOwnLogForkGuardForTests();
});

function episode(overrides: Partial<OwnLogForkEpisode> = {}): OwnLogForkEpisode {
  return {
    workspaceId: WS,
    harnessSlug: HS,
    keyHex: KEY,
    detail: '[hypercore] conflict detected in own log — two conflicting signatures for length 5',
    ...overrides,
  };
}

describe('reportOwnLogForkConflict — edge-triggered latch', () => {
  it('starts healthy (no episode yet)', () => {
    expect(getOwnLogForkState(WS, HS)).toEqual({
      forked: false,
      keyHex: null,
      detectedAtMs: null,
      detail: null,
    });
  });

  it('latches on the first conflict and fires the reporter', () => {
    const seen: OwnLogForkEpisode[] = [];
    reportOwnLogForkConflict(episode(), { nowMs: 1_000, onEpisode: (e) => seen.push(e) });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.keyHex).toBe(KEY);

    const st = getOwnLogForkState(WS, HS);
    expect(st.forked).toBe(true);
    expect(st.keyHex).toBe(KEY);
    expect(st.detectedAtMs).toBe(1_000);
    expect(st.detail).toContain('conflict detected');
  });

  it('is a silent no-op for a SECOND report of the SAME key (edge-triggered, no re-fire)', () => {
    const seen: OwnLogForkEpisode[] = [];
    reportOwnLogForkConflict(episode(), { nowMs: 1_000, onEpisode: (e) => seen.push(e) });
    reportOwnLogForkConflict(episode(), { nowMs: 2_000, onEpisode: (e) => seen.push(e) });
    expect(seen).toHaveLength(1);
    // detectedAtMs stays at the FIRST latch time — the second call never overwrote it.
    expect(getOwnLogForkState(WS, HS).detectedAtMs).toBe(1_000);
  });

  it('a DIFFERENT keyHex for the same harness overwrites the latch and re-fires (a fresh log that also forks is a new episode)', () => {
    const seen: OwnLogForkEpisode[] = [];
    reportOwnLogForkConflict(episode({ keyHex: KEY }), { nowMs: 1_000, onEpisode: (e) => seen.push(e) });
    reportOwnLogForkConflict(episode({ keyHex: KEY2 }), { nowMs: 2_000, onEpisode: (e) => seen.push(e) });
    expect(seen).toHaveLength(2);
    const st = getOwnLogForkState(WS, HS);
    expect(st.keyHex).toBe(KEY2);
    expect(st.detectedAtMs).toBe(2_000);
  });

  it('never throws even when the reporter throws', () => {
    expect(() =>
      reportOwnLogForkConflict(episode(), {
        onEpisode: () => {
          throw new Error('boom');
        },
      }),
    ).not.toThrow();
    // The latch still records the episode despite the reporter failing.
    expect(getOwnLogForkState(WS, HS).forked).toBe(true);
  });

  it('is scoped per (workspaceId, harnessSlug) — a different harness stays healthy', () => {
    reportOwnLogForkConflict(episode(), { nowMs: 1_000, onEpisode: () => {} });
    expect(getOwnLogForkState(WS, 'harness-b').forked).toBe(false);
    expect(getOwnLogForkState('ws-2', HS).forked).toBe(false);
  });

  it('setOwnLogForkEpisodeReporterForTests installs a module-level default reporter', () => {
    const seen: OwnLogForkEpisode[] = [];
    setOwnLogForkEpisodeReporterForTests((e) => seen.push(e));
    try {
      reportOwnLogForkConflict(episode()); // no explicit onEpisode — uses the module default
      expect(seen).toHaveLength(1);
    } finally {
      setOwnLogForkEpisodeReporterForTests(null);
    }
  });
});

describe('clearOwnLogForkState', () => {
  it('clears a latched fork so a later report on the SAME key re-fires as a fresh episode', () => {
    const seen: OwnLogForkEpisode[] = [];
    reportOwnLogForkConflict(episode(), { nowMs: 1_000, onEpisode: (e) => seen.push(e) });
    expect(getOwnLogForkState(WS, HS).forked).toBe(true);

    clearOwnLogForkState(WS, HS);
    expect(getOwnLogForkState(WS, HS)).toEqual({
      forked: false,
      keyHex: null,
      detectedAtMs: null,
      detail: null,
    });

    reportOwnLogForkConflict(episode(), { nowMs: 2_000, onEpisode: (e) => seen.push(e) });
    expect(seen).toHaveLength(2);
  });

  it('clearing an already-healthy harness is a no-op (never throws)', () => {
    expect(() => clearOwnLogForkState(WS, 'never-forked-harness')).not.toThrow();
  });
});

describe('attachOwnLogForkListener', () => {
  it('is a no-op when the core does not expose .on (feature-detected, never throws)', () => {
    expect(() => attachOwnLogForkListener({}, WS, HS, KEY)).not.toThrow();
    expect(getOwnLogForkState(WS, HS).forked).toBe(false);
  });

  it('is a no-op when core is null/undefined', () => {
    expect(() => attachOwnLogForkListener(null, WS, HS, KEY)).not.toThrow();
    expect(() => attachOwnLogForkListener(undefined, WS, HS, KEY)).not.toThrow();
  });

  it('wires a real conflict event to the latch, with a detail mentioning SESSION_CLOSED semantics', () => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const fakeCore = {
      on(event: string, handler: (...args: unknown[]) => void) {
        handlers[event] = handler;
        return this;
      },
    };
    setOwnLogForkEpisodeReporterForTests(() => {
      /* swallow the module-default reporter's lazy EI import for this test */
    });
    try {
      attachOwnLogForkListener(fakeCore, WS, HS, KEY);
      expect(typeof handlers.conflict).toBe('function');

      handlers.conflict!(5, 1, {});
      const st = getOwnLogForkState(WS, HS);
      expect(st.forked).toBe(true);
      expect(st.keyHex).toBe(KEY);
      expect(st.detail).toContain('length 5');
      expect(st.detail).toContain('SESSION_CLOSED');
    } finally {
      setOwnLogForkEpisodeReporterForTests(null);
    }
  });

  it('a listener-attach failure (a throwing .on) never wedges the caller', () => {
    const badCore = {
      on() {
        throw new Error('attach boom');
      },
    };
    expect(() => attachOwnLogForkListener(badCore, WS, HS, KEY)).not.toThrow();
  });
});

describe('assessHarnessSubstrateHealth — ownLogFork input', () => {
  const base = { flagEnabled: true, handlePresent: true };

  it('forces unhealthy when ownLogFork.forked is true', () => {
    const { verdict, reasons } = assessHarnessSubstrateHealth({
      ...base,
      ownLogFork: { forked: true, detail: 'test fork' },
    });
    expect(verdict).toBe('unhealthy');
    expect(reasons.join(' ')).toContain('own-log forked');
    expect(reasons.join(' ')).toContain('test fork');
  });

  it('uses a default reason string when detail is omitted', () => {
    const { reasons } = assessHarnessSubstrateHealth({
      ...base,
      ownLogFork: { forked: true },
    });
    expect(reasons.join(' ')).toContain('equivocation loop');
  });

  it('does not affect the verdict when forked is false or the input is omitted', () => {
    expect(
      assessHarnessSubstrateHealth({ ...base, ownLogFork: { forked: false } }).verdict,
    ).toBe('healthy');
    expect(assessHarnessSubstrateHealth({ ...base }).verdict).toBe('healthy');
  });

  it('wins over a merely-degraded signal (worst-wins ladder)', () => {
    const { verdict } = assessHarnessSubstrateHealth({
      ...base,
      claimStats: { total: 10, won: 9, lost: 0, error: 1 }, // 10% error rate -> degraded
      ownLogFork: { forked: true },
    });
    expect(verdict).toBe('unhealthy');
  });
});
