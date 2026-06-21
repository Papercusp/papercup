/**
 * compute.test — the aggregator's FAIL-SOFT contract (system-health-tab-2026-06-15
 * P-006 / Phase 4, D-003). A throwing collector greys ITS panel (`unknown` + the
 * error) and never blanks the snapshot. Pure: tests `panelSafe` (the per-panel
 * isolation) directly — no DB. The full DB-backed `computeSystemHealth` is
 * exercised live by the ~30s tick + the sync-resolver dispatch test.
 */
import { describe, it, expect, vi } from 'vitest';
import { panelSafe, computeEscalationsHealth, probeGatewayHealthz, observationRole, overwatchScorecardSkipped, scoutHealthVerdict, type EscalationAgingInput } from './compute';
import { PANEL_LABELS } from './types';

describe('observationRole — per-role attribution (close-observation-attribution-gap 2026-06-21)', () => {
  it('prefers the stamped payload.filedByRole', () => {
    expect(observationRole({ payload: { filedByRole: 'overwatch' }, signalOrigin: 'organic' })).toBe('overwatch');
  });
  it('falls back to sourceRole, then signalOrigin, then unknown', () => {
    expect(observationRole({ payload: {}, sourceRole: 'Scout' })).toBe('Scout');
    expect(observationRole({ payload: null, signalOrigin: 'organic' })).toBe('organic');
    expect(observationRole({})).toBe('unknown');
  });
  it('reads the REAL row fields, not the prior phantom `it.origin`/top-level `sourceRole`', () => {
    // EngineerIssue carries `payload` + `signalOrigin`, NEVER a top-level `origin`
    // nor (for tool captures) `sourceRole` — the old `it.sourceRole ?? it.origin`
    // read undefined on both → bucketed 100% as 'unknown'.
    expect(observationRole({ payload: { filedByRole: 'bee' } })).toBe('bee');
  });
});

describe('overwatchScorecardSkipped — monitor-the-monitor (hive-loop-supervision 2026-06-21)', () => {
  const base = { alive: true as boolean | null, lastWakeAt: 1_000_000, now: 1_000_000 + 6 * 60_000, freshnessStatus: 'stale' as const };
  it('skipped when alive + settled past grace + not fresh', () => {
    expect(overwatchScorecardSkipped(base)).toBe(true);
    expect(overwatchScorecardSkipped({ ...base, freshnessStatus: 'partial-only' })).toBe(true);
  });
  it('NOT skipped when fresh', () => {
    expect(overwatchScorecardSkipped({ ...base, freshnessStatus: 'fresh' })).toBe(false);
  });
  it('NOT skipped within the grace (turn may still be in flight — no mid-turn false positive)', () => {
    expect(overwatchScorecardSkipped({ ...base, now: base.lastWakeAt + 60_000 })).toBe(false);
  });
  it('NOT skipped when dark (alive:false) or never woke (lastWakeAt:null)', () => {
    expect(overwatchScorecardSkipped({ ...base, alive: false })).toBe(false);
    expect(overwatchScorecardSkipped({ ...base, lastWakeAt: null })).toBe(false);
  });
});

describe('scoutHealthVerdict — ideation observability (hive-loop-supervision 2026-06-21)', () => {
  const now = 1_000_000_000;
  const t = (agoMs: number, status: string, ideas?: number) => ({ status, ideasGenerated: ideas, tickAt: new Date(now - agoMs).toISOString() });
  it('transport-death: cycles RAN in-window but 0 ideas', () => {
    const v = scoutHealthVerdict([t(60_000, 'ran', 0), t(120_000, 'ran', 0)], now);
    expect(v.transportDeath).toBe(true);
    expect(v.ranInWindow).toBe(2);
    expect(v.ideasInWindow).toBe(0);
  });
  it('healthy: cycles ran with ideas (newest run + window sum)', () => {
    const v = scoutHealthVerdict([t(60_000, 'ran', 5), t(120_000, 'ran', 3)], now);
    expect(v.transportDeath).toBe(false);
    expect(v.ideasInWindow).toBe(8);
    expect(v.ideasLastRun).toBe(5);
  });
  it('only gated/idle ticks → NOT transport-death (no full cycle = unknown, not dead)', () => {
    const v = scoutHealthVerdict([t(60_000, 'gated'), t(120_000, 'gated')], now);
    expect(v.transportDeath).toBe(false);
    expect(v.ranInWindow).toBe(0);
    expect(v.lastRanAt).toBeNull();
  });
  it('window-bounds the ran tally but lastTickAt is the newest overall', () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const v = scoutHealthVerdict([t(dayMs + 60_000, 'ran', 9)], now); // older than 24h
    expect(v.ranInWindow).toBe(0);
    expect(v.transportDeath).toBe(false);
    expect(v.lastTickAt).not.toBeNull();
  });
});

describe('panelSafe — per-panel fail-soft', () => {
  it('passes a healthy collector through, injecting key + label', async () => {
    const panel = await panelSafe('queen', async () => ({
      status: 'ok' as const,
      summary: 'looping',
      metrics: [{ label: 'last wake', value: '2m ago' }],
      data: { hi: true },
    }));
    expect(panel.key).toBe('queen');
    expect(panel.label).toBe(PANEL_LABELS.queen);
    expect(panel.status).toBe('ok');
    expect(panel.error).toBeUndefined();
    expect(panel.data).toEqual({ hi: true });
  });

  it('greys a throwing collector to unknown + captures the error (never throws)', async () => {
    const panel = await panelSafe('tokens', async () => {
      throw new Error('PG exploded');
    });
    expect(panel.key).toBe('tokens');
    expect(panel.label).toBe(PANEL_LABELS.tokens);
    expect(panel.status).toBe('unknown');
    expect(panel.data).toBeNull();
    expect(panel.error).toContain('PG exploded');
    expect(panel.metrics).toEqual([]);
  });

  it('a non-Error throw still degrades cleanly to unknown', async () => {
    const panel = await panelSafe('deploy', async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'string failure';
    });
    expect(panel.status).toBe('unknown');
    expect(panel.error).toBe('string failure');
  });
});

describe('computeEscalationsHealth — operational flood excluded (EI-1490)', () => {
  const NOW = Date.parse('2026-06-18T12:00:00Z');
  const OLD = '2026-06-15T00:00:00Z'; // ~3.5d old → past the 6h aging threshold
  const FRESH = '2026-06-18T11:30:00Z'; // 30m old → under the threshold

  // The live bug: ~13k system:hive-placement-watchdog escalations (system sender,
  // no options) inflate `aging` to an impossible "13,246 aging past threshold".
  function flood(n: number): EscalationAgingInput[] {
    return Array.from({ length: n }, () => ({
      from: 'system:hive-placement-watchdog',
      severity: 'advisory',
      ts: OLD,
    }));
  }

  it('excludes operational escalations from open/aging/bySeverity', () => {
    const h = computeEscalationsHealth(flood(13_246), NOW);
    expect(h.open).toBe(0);
    expect(h.aging).toBe(0);
    expect(h.oldestAgeMs).toBeNull();
    expect(h.bySeverity).toEqual({});
  });

  it('counts only genuine human-decision escalations (agent sender / options)', () => {
    const open: EscalationAgingInput[] = [
      ...flood(500),
      { from: 's-agent-1', severity: 'blocker', ts: OLD }, // aged human decision
      { from: 's-agent-2', severity: 'question', ts: FRESH }, // fresh human decision
      // a system sender WITH options is a real choice → human-attention
      { from: 'system:queen', options: [{ id: 'a', label: 'A' }], severity: 'advisory', ts: OLD },
    ];
    const h = computeEscalationsHealth(open, NOW);
    expect(h.open).toBe(3);
    expect(h.aging).toBe(2); // the two OLD ones; the FRESH one is under threshold
    expect(h.bySeverity).toEqual({ blocker: 1, question: 1, advisory: 1 });
  });

  it('no escalations → clean zeroed panel', () => {
    const h = computeEscalationsHealth([], NOW);
    expect(h).toEqual({ open: 0, oldestAgeMs: null, bySeverity: {}, aging: 0 });
  });
});

describe('probeGatewayHealthz retry (EI-1693 sibling — one transient timeout is not "down")', () => {
  const timeoutErr = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });

  it('a transient timeout THEN a success → reachable (true)', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      vi.stubGlobal('fetch', vi.fn(async () => {
        if (n++ === 0) throw timeoutErr();
        return { status: 200 } as Response;
      }));
      const p = probeGatewayHealthz([5, 50]);
      await vi.runAllTimersAsync(); // advance the inter-attempt backoff
      expect(await p).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('all escalating attempts fail → unreachable (false)', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(async () => { throw timeoutErr(); }));
      const p = probeGatewayHealthz([5, 5]);
      await vi.runAllTimersAsync();
      expect(await p).toBe(false);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
