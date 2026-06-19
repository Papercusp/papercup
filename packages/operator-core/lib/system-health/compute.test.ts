/**
 * compute.test — the aggregator's FAIL-SOFT contract (system-health-tab-2026-06-15
 * P-006 / Phase 4, D-003). A throwing collector greys ITS panel (`unknown` + the
 * error) and never blanks the snapshot. Pure: tests `panelSafe` (the per-panel
 * isolation) directly — no DB. The full DB-backed `computeSystemHealth` is
 * exercised live by the ~30s tick + the sync-resolver dispatch test.
 */
import { describe, it, expect } from 'vitest';
import { panelSafe, computeEscalationsHealth, type EscalationAgingInput } from './compute';
import { PANEL_LABELS } from './types';

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
