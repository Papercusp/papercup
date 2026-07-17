/**
 * deps.test — pure unit coverage for `mapHealthPanelsToRaw` (P-002,
 * curation-signal-gaps-2026-07-17). No PG: the production `readHealth()`
 * wrapper is a thin `getSystemHealth()` call + this pure mapper, so the
 * interesting logic (which panels are signal-worthy) is tested here without
 * standing up `computeSystemHealth`'s 20-collector aggregation. Mirrors the
 * `acks.test.ts` fake-`SystemHealth` convention.
 */
import { describe, it, expect } from 'vitest';
import { mapHealthPanelsToRaw } from './deps';
import type { PanelAck, PanelStatus, SystemHealth } from '../system-health/types';

const NOW = 1_752_000_000_000; // 2026-07-08T-ish, arbitrary fixed epoch

const panel = (key: string, status: PanelStatus, summary = `${key} is ${status}`, ack?: PanelAck) => ({
  key,
  label: key.toUpperCase(),
  status,
  summary,
  metrics: [],
  data: null,
  ...(ack ? { ack } : {}),
});

const snapshot = (panels: Record<string, ReturnType<typeof panel>>): SystemHealth =>
  ({
    workspaceId: 'ws-test',
    evaluatedAt: NOW,
    overall: 'unknown',
    panels,
  }) as unknown as SystemHealth;

const ACK: PanelAck = {
  status: 'crit',
  reason: 'known + accepted',
  ackedBy: 'owner',
  ackedAt: NOW - 60_000,
  snoozeUntil: null,
};

describe('mapHealthPanelsToRaw — SystemHealth panels → RawHealthPanel[] (P-002)', () => {
  it('includes crit and warn panels, carrying label + summary + a shared evaluatedAt ts', () => {
    const h = snapshot({
      queen: panel('queen', 'crit', 'stalled 47m'),
      infra: panel('infra', 'warn', 'disk at 88%'),
    });
    const out = mapHealthPanelsToRaw(h);
    expect(out).toEqual(
      expect.arrayContaining([
        { panelId: 'queen', status: 'crit', label: 'QUEEN', summary: 'stalled 47m', ts: new Date(NOW).toISOString() },
        { panelId: 'infra', status: 'warn', label: 'INFRA', summary: 'disk at 88%', ts: new Date(NOW).toISOString() },
      ]),
    );
  });

  it('excludes ok and unknown panels — stay silent, nothing to classify', () => {
    const h = snapshot({
      queen: panel('queen', 'ok'),
      infra: panel('infra', 'unknown'),
    });
    expect(mapHealthPanelsToRaw(h)).toHaveLength(0);
  });

  it('excludes a panel covered by an active owner ack (D-008) even when crit/warn', () => {
    const h = snapshot({
      queen: panel('queen', 'crit', 'stalled 47m', ACK),
      infra: panel('infra', 'warn', 'disk at 88%'),
    });
    const out = mapHealthPanelsToRaw(h);
    expect(out.map((p) => p.panelId)).toEqual(['infra']);
  });

  it('is empty over an all-ok snapshot', () => {
    const h = snapshot({ queen: panel('queen', 'ok'), infra: panel('infra', 'ok') });
    expect(mapHealthPanelsToRaw(h)).toEqual([]);
  });
});
