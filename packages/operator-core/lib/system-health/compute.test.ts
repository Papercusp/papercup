/**
 * compute.test — the aggregator's FAIL-SOFT contract (system-health-tab-2026-06-15
 * P-006 / Phase 4, D-003). A throwing collector greys ITS panel (`unknown` + the
 * error) and never blanks the snapshot. Pure: tests `panelSafe` (the per-panel
 * isolation) directly — no DB. The full DB-backed `computeSystemHealth` is
 * exercised live by the ~30s tick + the sync-resolver dispatch test.
 */
import { describe, it, expect, vi } from 'vitest';
import { panelSafe, computeEscalationsHealth, probeGatewayHealthz, observationRole, overwatchScorecardSkipped, scoutHealthVerdict, suIdeateVerdict, tallyPlans, toolEfficiencyStatus, type EscalationAgingInput } from './compute';
import { queenPlacementStalled, countLeadingZeroTokenWakes } from './thresholds';
import { PANEL_LABELS } from './types';

describe('observationRole — per-role attribution (close-observation-attribution-gap 2026-06-21)', () => {
  it('prefers the stamped payload.filedByRole', () => {
    expect(observationRole({ payload: { filedByRole: 'kettle' }, signalOrigin: 'organic' })).toBe('kettle');
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
    expect(observationRole({ payload: { filedByRole: 'cup' } })).toBe('cup');
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

describe('suIdeateVerdict — the su-ideate partition (WI-4465)', () => {
  const now = 1_000_000_000;
  const dayMs = 24 * 60 * 60 * 1000;
  const p = (agoMs: number, filed?: number, status = 'ran') => ({ status, ideasRouted: filed, tickAt: new Date(now - agoMs).toISOString() });
  it('counts in-window passes and sums their filed ideas', () => {
    const v = suIdeateVerdict([p(60_000, 3), p(120_000, 2)], now);
    expect(v.passesInWindow).toBe(2);
    expect(v.ideasFiled).toBe(5);
    expect(v.lastPassAt).toBe(now - 60_000);
  });
  it('window-bounds the tally but lastPassAt is the newest pass overall', () => {
    const v = suIdeateVerdict([p(dayMs + 60_000, 9)], now);
    expect(v.passesInWindow).toBe(0);
    expect(v.ideasFiled).toBe(0);
    expect(v.lastPassAt).toBe(now - (dayMs + 60_000));
  });
  it('empty ledger → zeros with a null lastPassAt', () => {
    const v = suIdeateVerdict([], now);
    expect(v).toEqual({ passesInWindow: 0, ideasFiled: 0, lastPassAt: null });
  });
  it('a non-ran row never inflates the pass count', () => {
    const v = suIdeateVerdict([p(60_000, 4, 'gated'), p(120_000, 1)], now);
    expect(v.passesInWindow).toBe(1);
    expect(v.ideasFiled).toBe(1);
  });
});

describe('countLeadingZeroTokenWakes / queenPlacementStalled — Queen placement liveness (hive-loop-supervision 2026-06-21, D-009)', () => {
  const z = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const nz = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 0 };
  it('counts leading consecutive 0-token wakes (newest-first), stopping at the first non-zero', () => {
    expect(countLeadingZeroTokenWakes([z, z, z, nz, z])).toBe(3);
    expect(countLeadingZeroTokenWakes([nz, z, z])).toBe(0);
    expect(countLeadingZeroTokenWakes([])).toBe(0);
  });
  it('fires when ≥3 consecutive 0-token wakes + placeable frontier + not paused', () => {
    expect(queenPlacementStalled({ consecutiveZeroTokenWakes: 3, frontier: 7, paused: false })).toBe(true);
  });
  it('does NOT fire when frontier=0 (nothing to place)', () => {
    expect(queenPlacementStalled({ consecutiveZeroTokenWakes: 9, frontier: 0, paused: false })).toBe(false);
  });
  it('does NOT fire when a recent wake spent tokens (leading-zero count < threshold)', () => {
    const n = countLeadingZeroTokenWakes([nz, z, z, z]); // 0 — newest wake ran the LLM
    expect(queenPlacementStalled({ consecutiveZeroTokenWakes: n, frontier: 7, paused: false })).toBe(false);
  });
  it('does NOT fire when paused', () => {
    expect(queenPlacementStalled({ consecutiveZeroTokenWakes: 5, frontier: 7, paused: true })).toBe(false);
  });
  it('does NOT fire below the consecutive threshold (one-off blip)', () => {
    expect(queenPlacementStalled({ consecutiveZeroTokenWakes: 2, frontier: 7, paused: false })).toBe(false);
  });
  it('does NOT fire when the bee fleet is already full (no capacity)', () => {
    expect(queenPlacementStalled({ consecutiveZeroTokenWakes: 5, frontier: 7, paused: false, beesBusy: 24, beesCap: 24 })).toBe(false);
  });
  // WI-3597: frontierStuck subtracts long-unplaced/gated items so an all-gated
  // frontier reads as correct idle, not a placement stall.
  it('does NOT fire when the ENTIRE frontier is long-stuck/gated (fresh=0)', () => {
    expect(queenPlacementStalled({ consecutiveZeroTokenWakes: 9, frontier: 7, frontierStuck: 7, paused: false })).toBe(false);
  });
  it('STILL fires when some frontier is fresh (fresh>0) despite gated items present', () => {
    expect(queenPlacementStalled({ consecutiveZeroTokenWakes: 3, frontier: 7, frontierStuck: 5, paused: false })).toBe(true);
  });
  it('treats an absent frontierStuck as 0 (fresh=frontier — prior behaviour preserved)', () => {
    expect(queenPlacementStalled({ consecutiveZeroTokenWakes: 3, frontier: 7, paused: false })).toBe(true);
  });
});

describe('tallyPlans — queen-plan-selection signal (hive-loop-supervision 2026-06-21)', () => {
  const now = 2_000_000_000;
  it('startedDraft = plans force-started while still draft (the anti-pattern)', () => {
    const v = tallyPlans([
      { status: 'draft', opStatus: 'started' },  // force-started draft — flagged
      { status: 'active', opStatus: 'started' }, // started a ready/active plan — fine
      { status: 'draft', opStatus: null },       // a draft NOT started — fine
    ], now);
    expect(v.startedDraft).toBe(1);
    expect(v.started).toBe(2);
    expect(v.draft).toBe(2);
    expect(v.active).toBe(1);
  });
  it('counts stalled started plans past the aging window', () => {
    const v = tallyPlans([{ status: 'active', opStatus: 'started', opUpdatedAt: new Date(now - 48 * 60 * 60_000).toISOString() }], now);
    expect(v.stalledPlans).toBe(1);
  });
  it('skips archived rows', () => {
    const v = tallyPlans([{ status: 'draft', opStatus: 'started', archived: true }], now);
    expect(v.startedDraft).toBe(0);
    expect(v.started).toBe(0);
  });
  it('tallies item done/total (dropped excluded)', () => {
    const v = tallyPlans([{ status: 'active', items: [{ status: 'done' }, { status: 'todo' }, { status: 'dropped' }] }], now);
    expect(v.itemsDone).toBe(1);
    expect(v.itemsTotal).toBe(2);
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
    // 'queen' stays the stable PanelKey (PANEL_ORDER/UI consumers key on it);
    // the pot-rename shows through the LABEL ('Mug'), not the key.
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
    expect(h.agingNew).toBe(0); // both crossed the threshold DAYS ago — standing, not new
    expect(h.bySeverity).toEqual({ blocker: 1, question: 1, advisory: 1 });
  });

  it('agingNew counts only escalations that crossed the threshold in the last 24h (health-tab-v2 P-003)', () => {
    const open: EscalationAgingInput[] = [
      // aged 7h → crossed the 6h threshold ~1h ago → NEW aging
      { from: 's-agent-1', severity: 'question', ts: new Date(NOW - 7 * 60 * 60_000).toISOString() },
      // aged ~3.5d → crossed days ago → standing aging only
      { from: 's-agent-2', severity: 'warning', ts: OLD },
      { from: 's-agent-3', severity: 'info', ts: FRESH }, // not aged at all
    ];
    const h = computeEscalationsHealth(open, NOW);
    expect(h.aging).toBe(2);
    expect(h.agingNew).toBe(1);
  });

  it('no escalations → clean zeroed panel', () => {
    const h = computeEscalationsHealth([], NOW);
    expect(h).toEqual({ open: 0, oldestAgeMs: null, bySeverity: {}, aging: 0, agingNew: 0 });
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

describe('toolEfficiencyStatus — WI-839 tool-efficiency panel status fold', () => {
  it('any leg broken → crit, regardless of the others', () => {
    expect(toolEfficiencyStatus(['broken', 'healthy', 'unknown'])).toBe('crit');
    expect(toolEfficiencyStatus(['healthy', 'healthy', 'broken'])).toBe('crit');
  });
  it('no broken but any degraded → warn', () => {
    expect(toolEfficiencyStatus(['degraded', 'healthy', 'unknown'])).toBe('warn');
  });
  it('every leg unknown (all windows too small to grade) → unknown, not ok', () => {
    expect(toolEfficiencyStatus(['unknown', 'unknown', 'unknown'])).toBe('unknown');
  });
  it('all healthy (some possibly unknown) → ok', () => {
    expect(toolEfficiencyStatus(['healthy', 'healthy', 'healthy'])).toBe('ok');
    expect(toolEfficiencyStatus(['healthy', 'unknown', 'healthy'])).toBe('ok');
  });
  it('broken beats degraded beats unknown-only (precedence order)', () => {
    expect(toolEfficiencyStatus(['broken', 'degraded'])).toBe('crit');
    expect(toolEfficiencyStatus(['degraded', 'unknown'])).toBe('warn');
  });
});
