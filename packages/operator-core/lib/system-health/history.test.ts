/**
 * history.test — pure history semantics (health-tab-v2-2026-07-12 P-005/P-006,
 * decision D-B). No DB: diffHealthTransitions + buildHealthHistory are the pure
 * halves; recordHealthHistory / readSystemHealthHistory are thin IO wrappers.
 * Pins: transitions fire only on status CHANGE; strips are worst-per-bucket;
 * `since` is the newest transition per panel (newest-first input).
 */
import { describe, it, expect } from 'vitest';
import { diffHealthTransitions, buildHealthHistory, type HealthTransitionRow } from './history';
import type { PanelStatus, SystemHealth } from './types';

const snap = (statuses: Record<string, PanelStatus>): SystemHealth => {
  const panels: Record<string, unknown> = {};
  for (const [key, status] of Object.entries(statuses)) {
    panels[key] = { key, label: key, status, summary: `${key}: ${status}`, metrics: [], data: null };
  }
  return { workspaceId: 'ws', evaluatedAt: 0, overall: 'ok', panels } as unknown as SystemHealth;
};

describe('diffHealthTransitions — one row per panel status CHANGE', () => {
  it('no prev snapshot (first tick after boot) diffs to nothing', () => {
    expect(diffHealthTransitions(null, snap({ queen: 'ok' }))).toEqual([]);
  });
  it('a status change produces a row carrying the NEW summary', () => {
    const rows = diffHealthTransitions(snap({ queen: 'ok', infra: 'ok' }), snap({ queen: 'crit', infra: 'ok' }));
    expect(rows).toEqual([{ panel: 'queen', from: 'ok', to: 'crit', summary: 'queen: crit' }]);
  });
  it('unchanged statuses produce no rows', () => {
    expect(diffHealthTransitions(snap({ queen: 'warn' }), snap({ queen: 'warn' }))).toEqual([]);
  });
  it('a panel absent from prev (new panel key mid-deploy) is skipped, not a phantom transition', () => {
    expect(diffHealthTransitions(snap({ queen: 'ok' }), snap({ queen: 'ok', memory: 'ok' }))).toEqual([]);
  });
  it('multiple simultaneous changes each get a row', () => {
    const rows = diffHealthTransitions(
      snap({ queen: 'ok', deploy: 'ok' }),
      snap({ queen: 'warn', deploy: 'crit' }),
    );
    expect(rows.map((r) => r.panel).sort()).toEqual(['deploy', 'queen']);
  });
});

describe('buildHealthHistory — strips + since + timeline (D-B)', () => {
  const HOUR = 60 * 60_000;
  const NOW = 1_700_000_000_000;
  const tick = (agoMs: number, overall: PanelStatus, statuses: Record<string, PanelStatus>) => ({
    at: NOW - agoMs,
    overall,
    statuses,
  });

  it('buckets are worst-per-bucket, oldest first, null where no data', () => {
    const h = buildHealthHistory({
      workspaceId: 'ws',
      now: NOW,
      windowMs: 4 * HOUR,
      bucketMs: HOUR,
      ticks: [
        tick(3.5 * HOUR, 'ok', { queen: 'ok' }),      // bucket 0
        tick(2.5 * HOUR, 'ok', { queen: 'ok' }),      // bucket 1
        tick(2.4 * HOUR, 'crit', { queen: 'crit' }),  // bucket 1 — worst wins
        tick(0.5 * HOUR, 'warn', { queen: 'warn' }),  // bucket 3; bucket 2 empty
      ],
      transitions: [],
    });
    expect(h.overallStrip).toEqual(['ok', 'crit', null, 'warn']);
    expect(h.strips.queen).toEqual(['ok', 'crit', null, 'warn']);
  });

  it('ticks outside the window are ignored', () => {
    const h = buildHealthHistory({
      workspaceId: 'ws',
      now: NOW,
      windowMs: 2 * HOUR,
      bucketMs: HOUR,
      ticks: [tick(5 * HOUR, 'crit', { queen: 'crit' }), tick(0.5 * HOUR, 'ok', { queen: 'ok' })],
      transitions: [],
    });
    expect(h.overallStrip).toEqual([null, 'ok']);
  });

  it('since = the NEWEST transition per panel (transitions arrive newest-first)', () => {
    const transitions: HealthTransitionRow[] = [
      { panel: 'queen', from: 'warn', to: 'crit', summary: null, at: NOW - HOUR },     // newest
      { panel: 'queen', from: 'ok', to: 'warn', summary: null, at: NOW - 2 * HOUR },
      { panel: 'deploy', from: 'ok', to: 'warn', summary: null, at: NOW - 3 * HOUR },
    ];
    const h = buildHealthHistory({
      workspaceId: 'ws', now: NOW, windowMs: 24 * HOUR, bucketMs: HOUR, ticks: [], transitions,
    });
    expect(h.since.queen).toBe(NOW - HOUR);
    expect(h.since.deploy).toBe(NOW - 3 * HOUR);
    expect(h.since.infra).toBeUndefined(); // no transition in window — stable since before it
    expect(h.transitions).toHaveLength(3);
  });

  it('unknown never beats a real status in a bucket (severity order unknown<ok<warn<crit)', () => {
    const h = buildHealthHistory({
      workspaceId: 'ws',
      now: NOW,
      windowMs: HOUR,
      bucketMs: HOUR,
      ticks: [tick(0.5 * HOUR, 'warn', { queen: 'warn' }), tick(0.4 * HOUR, 'unknown', { queen: 'unknown' })],
      transitions: [],
    });
    expect(h.strips.queen).toEqual(['warn']);
  });
});
