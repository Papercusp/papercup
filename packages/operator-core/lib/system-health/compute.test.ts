/**
 * compute.test — the aggregator's FAIL-SOFT contract (system-health-tab-2026-06-15
 * P-006 / Phase 4, D-003). A throwing collector greys ITS panel (`unknown` + the
 * error) and never blanks the snapshot. Pure: tests `panelSafe` (the per-panel
 * isolation) directly — no DB. The full DB-backed `computeSystemHealth` is
 * exercised live by the ~30s tick + the sync-resolver dispatch test.
 */
import { describe, it, expect } from 'vitest';
import { panelSafe } from './compute';
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
