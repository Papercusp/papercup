/**
 * engine-death.test.ts — the out-of-band routine-engine-death detector
 * (self-learning-frontier P-031 / FB-20, the 06-12 DBOS incident class).
 *
 * Pins the incident signature exactly as the insight runbook states it: ALL
 * active routines overdue at once = engine dead; one stale row = that
 * routine's own problem; a quiet box (too few active routines) never alarms.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  detectRoutineEngineDeath,
  engineDeathDrillCollector,
  engineDeathSignal,
  runEngineDeathSentinelPass,
  type EngineDeathSentinelDeps,
  type RoutineLivenessRow,
} from './engine-death';
import { SANDBOX_SCOPE } from './types';
import type { CaptureImprovementResult } from '../harness/improvements/capture-core';

const NOW = Date.parse('2026-06-12T12:00:00.000Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const row = (name: string, nextFireAt: string | null, active = true): RoutineLivenessRow => ({ name, active, nextFireAt });

describe('detectRoutineEngineDeath (the 06-12 incident signature)', () => {
  it('ALL active routines overdue past grace ⇒ dead', () => {
    const v = detectRoutineEngineDeath(
      [row('git-sync', minsAgo(80)), row('watchdog', minsAgo(45)), row('release', minsAgo(30))],
      NOW,
    );
    expect(v.dead).toBe(true);
    expect(v.overdueCount).toBe(3);
    expect(v.oldestOverdueMinutes).toBe(80);
  });

  it('ONE routine inside its window ⇒ alive (a stale row is that routine\'s own problem)', () => {
    const v = detectRoutineEngineDeath(
      [row('git-sync', minsAgo(80)), row('watchdog', minsAgo(45)), row('release', minsAgo(2))],
      NOW,
    );
    expect(v.dead).toBe(false);
    expect(v.reason).toContain('release');
  });

  it('a future next_fire_at counts as alive', () => {
    const v = detectRoutineEngineDeath(
      [row('a', minsAgo(80)), row('b', minsAgo(45)), row('c', new Date(NOW + 60_000).toISOString())],
      NOW,
    );
    expect(v.dead).toBe(false);
  });

  it('too few active routines ⇒ never dead (quiet box ≠ dead engine)', () => {
    const v = detectRoutineEngineDeath([row('a', minsAgo(80)), row('b', minsAgo(70))], NOW);
    expect(v.dead).toBe(false);
    expect(v.reason).toContain('too few');
  });

  it('inactive rows and unparseable next_fire_at are excluded from the evidence', () => {
    const v = detectRoutineEngineDeath(
      [
        row('a', minsAgo(80)),
        row('b', minsAgo(70)),
        row('c', minsAgo(60)),
        row('inactive', minsAgo(500), false),
        row('no-fire', null),
      ],
      NOW,
    );
    // Every PROVABLE active routine (3 ≥ the floor) is overdue ⇒ dead. The
    // inactive row and the null-next_fire_at row prove nothing either way and
    // must neither block detection nor count toward it.
    expect(v.dead).toBe(true);
    expect(v.overdueCount).toBe(3);
  });

  it('grace window respected — overdue inside grace is alive', () => {
    const rows = [row('a', minsAgo(5)), row('b', minsAgo(6)), row('c', minsAgo(7))];
    expect(detectRoutineEngineDeath(rows, NOW, { graceMinutes: 10 }).dead).toBe(false);
    expect(detectRoutineEngineDeath(rows, NOW, { graceMinutes: 2 }).dead).toBe(true);
  });
});

describe('engineDeathSignal', () => {
  const verdict = { dead: true, activeCount: 3, overdueCount: 3, oldestOverdueMinutes: 80, reason: 'ALL 3 overdue' };

  it('builds the critical out-of-band signal with the runbook pointer', () => {
    const s = engineDeathSignal(verdict, { key: 'engine:live' });
    expect(s.source).toBe('routine-engine-death');
    expect(s.severity).toBe('critical');
    expect(s.kind).toBe('bug');
    expect(s.body).toContain('esm-dirname-tsx-file-mode-dbos-stall');
    expect(s.origin).toBeUndefined();
  });

  it('stamps drill origin + sandbox scope when asked (the drill leg)', () => {
    const s = engineDeathSignal(verdict, { key: 'engine:sb', origin: 'drill', captureScope: SANDBOX_SCOPE });
    expect(s.origin).toBe('drill');
    expect(s.scope).toBe(SANDBOX_SCOPE);
  });
});

describe('engineDeathDrillCollector (the sandbox drill leg)', () => {
  it('a dead snapshot yields ONE origin=drill signal', async () => {
    const snapshot = [row('a', minsAgo(80)), row('b', minsAgo(70)), row('c', minsAgo(60))];
    const res = await engineDeathDrillCollector(snapshot, NOW).collect();
    const signals = Array.isArray(res) ? res : res.signals;
    expect(signals).toHaveLength(1);
    expect(signals[0].origin).toBe('drill');
    expect(signals[0].scope).toBe(SANDBOX_SCOPE);
  });

  it('a healed snapshot yields nothing, with the verdict as the note', async () => {
    const future = new Date(NOW + 5 * 60_000).toISOString();
    const res = await engineDeathDrillCollector([row('a', future), row('b', future), row('c', future)], NOW).collect();
    expect(Array.isArray(res)).toBe(false);
    if (!Array.isArray(res)) {
      expect(res.signals).toHaveLength(0);
      expect(res.note).toBeTruthy();
    }
  });
});

describe('runEngineDeathSentinelPass (the live out-of-band leg)', () => {
  const captured: CaptureImprovementResult = {
    ok: true,
    created: true,
    issue: { id: 'iss-1' } as never,
    possibleDuplicates: [],
  };

  function deps(over: Partial<EngineDeathSentinelDeps> = {}) {
    const capture = vi.fn(async (..._args: unknown[]) => captured);
    const readRows = vi.fn(async () => [row('a', minsAgo(80)), row('b', minsAgo(70)), row('c', minsAgo(60))]);
    const d: EngineDeathSentinelDeps = {
      isArmed: async () => true,
      readRows,
      capture: capture as never,
      log: () => {},
      ...over,
    };
    return { d, capture, readRows };
  }

  it('dark (flag OFF) ⇒ zero PG reads, zero captures', async () => {
    const { d, capture, readRows } = deps({ isArmed: async () => false });
    const res = await runEngineDeathSentinelPass(d, {}, NOW);
    expect(res.checked).toBe(false);
    expect(readRows).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it('armed + alive ⇒ checks but never captures', async () => {
    const { d, capture } = deps({
      readRows: async () => [row('a', minsAgo(1)), row('b', minsAgo(2)), row('c', minsAgo(3))],
    });
    const res = await runEngineDeathSentinelPass(d, {}, NOW);
    expect(res.checked).toBe(true);
    expect(res.verdict?.dead).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });

  it('armed + dead ⇒ files ONE ORGANIC capture keyed for cross-pass dedup', async () => {
    const { d, capture } = deps();
    const res = await runEngineDeathSentinelPass(d, {}, NOW);
    expect(res.captured).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    const input = capture.mock.calls[0][0] as Record<string, unknown>;
    expect(input.watchdogKey).toBe('routine-engine-death:engine:live');
    expect(input.dedupScope).toBe('open');
    expect(input.severity).toBe('critical');
    // The live sentinel is an availability monitor — its signal is ORGANIC.
    expect('origin' in input).toBe(false);
  });

  it('never throws — a read failure is a logged skip', async () => {
    const logs: string[] = [];
    const { d } = deps({
      readRows: async () => { throw new Error('pg down'); },
      log: (m) => logs.push(m),
    });
    const res = await runEngineDeathSentinelPass(d, {}, NOW);
    expect(res.checked).toBe(false);
    expect(logs.some((l) => l.includes('pg down'))).toBe(true);
  });
});
